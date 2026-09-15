package com.example.webrtccamera

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.camera.core.ImageProxy
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStatsCollectorCallback
import org.webrtc.RTCStatsReport
import org.webrtc.RtpParameters
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoFrame
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.JavaI420Buffer
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Sends CameraX YUV frames to FastAPI's /offer/android WebRTC endpoint. */
class WebRtcPublisher(
    context: Context,
    private val offerEndpoint: String,
    private val onStatus: (String) -> Unit,
) {
    private val appContext = context.applicationContext
    private val stopped = AtomicBoolean(true)
    private val disposed = AtomicBoolean(false)
    private val rtcExecutor = Executors.newSingleThreadExecutor { task ->
        Thread(task, "webrtc-publisher").apply { isDaemon = true }
    }
    private val httpClient = OkHttpClient()
    private val captureLock = Any()
    private val eglBase = EglBase.create()
    private val factory: PeerConnectionFactory
    private val videoSource: VideoSource
    private val videoTrack: VideoTrack
    private var peer: PeerConnection? = null
    private var localDescriptionReady = false
    private var offerPosted = false
    private var capturerStarted = false
    private var videoSender: RtpSender? = null
    private var qrChannel: DataChannel? = null
    private val pendingQrEvents = ArrayDeque<ByteArray>()
    private val bitrateCapApplied = AtomicBoolean(false)
    // Reused by the CameraX analyzer thread to avoid allocating conversion
    // buffers for every frame.
    private var planeRowScratch = ByteArray(0)
    private var planeRotationScratch = ByteArray(0)

    init {
        if (factoryInitialized.compareAndSet(false, true)) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions()
            )
        }
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
        videoSource = factory.createVideoSource(false)
        videoTrack = factory.createVideoTrack("camera", videoSource)
    }

    fun start() {
        if (disposed.get() || !stopped.compareAndSet(true, false)) return
        rtcExecutor.execute { startPeer() }
    }

    private fun startPeer() {
        if (stopped.get() || disposed.get()) return
        // The observer must be built before createPeerConnection() returns the
        // connection it observes, so onConnectionChange can't close over that
        // local val directly (Kotlin has no forward reference to it yet). This
        // var is assigned immediately below once the connection exists - always
        // before WebRTC could actually invoke the observer - giving the
        // callback the same frozen per-attempt identity the offer/SDP callbacks
        // get for free by running after that assignment point.
        var connectionRef: PeerConnection? = null
        val observer = object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                // The FastAPI endpoint has no trickle-ICE route. Candidates are sent in SDP
                // after gathering completes, so individual candidates are intentionally ignored.
            }

            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                if (state == PeerConnection.IceGatheringState.COMPLETE) postRtc {
                    sendOfferWhenReady()
                }
            }

            override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                onStatus("WebRTC ${state.name.lowercase()}")
                // DISCONNECTED is often transient (ICE consent checks recovering on
                // their own) and reacting to it would tear down connections that
                // would have healed by themselves. FAILED is the terminal state -
                // notably also what a relay restart looks like, since the old
                // process's ICE agent is simply gone and can never come back on
                // this same PeerConnection - so only that triggers a reconnect.
                if (state == PeerConnection.PeerConnectionState.FAILED) {
                    postRtc { restartPeerConnection(connectionRef, "Connection lost") }
                }
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onAddStream(stream: MediaStream) = Unit
            override fun onRemoveStream(stream: MediaStream) = Unit
            override fun onDataChannel(channel: DataChannel) = channel.dispose()
            override fun onRenegotiationNeeded() = Unit
            override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) = Unit
            override fun onTrack(transceiver: RtpTransceiver) = Unit
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
            override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) = Unit
        }

        val configuration = PeerConnection.RTCConfiguration(createIceServers())
        configuration.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        val connection = factory.createPeerConnection(configuration, observer)
        if (connection == null) {
            onStatus("Could not create WebRTC peer")
            return
        }
        connectionRef = connection
        peer = connection
        qrChannel = connection.createDataChannel("qr-events", DataChannel.Init()).also { channel ->
            channel.registerObserver(object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) = Unit

                override fun onStateChange() {
                    if (channel.state() == DataChannel.State.OPEN) postRtc { flushQrEvents() }
                }

                override fun onMessage(buffer: DataChannel.Buffer) = Unit
            })
        }
        videoTrack.setEnabled(true)
        val sender = connection.addTrack(videoTrack, listOf("camera-stream"))
        // Do not force a 16:9 output here. Some CameraX devices provide a 4:3
        // analysis buffer (for example 1440x1080); forcing 1280x720 can crop
        // the outgoing video while detections are still based on the full frame.
        // Keeping the input aspect ratio makes server and browser coordinates match.
        // libwebrtc's default degradation preference (BALANCED) lets the native
        // encoder silently transmit at a lower resolution than captured - most
        // visibly right after a fresh connection, when bandwidth estimation
        // hasn't converged yet and starts conservative, then ramps up over a
        // few seconds. MAINTAIN_RESOLUTION keeps the actually-selected
        // resolution's pixel count fixed and lets framerate/bitrate absorb
        // bandwidth constraints instead.
        videoSender = sender
        bitrateCapApplied.set(false)
        if (sender != null) {
            val parameters = sender.parameters
            parameters.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
            sender.parameters = parameters
            applyPreferredCodecs(connection, sender)
        }
        videoSource.capturerObserver.onCapturerStarted(true)
        capturerStarted = true
        onStatus("Creating SDP offer…")

        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
        }
        connection.createOffer(SimpleSdpObserver(
            createSuccess = { offer ->
                postRtc {
                    if (peer !== connection || stopped.get()) return@postRtc
                    connection.setLocalDescription(SimpleSdpObserver(
                        setSuccess = {
                            postRtc {
                                localDescriptionReady = true
                                sendOfferWhenReady()
                            }
                        },
                        setFailure = { error -> onStatus("Setting local SDP failed: $error") },
                    ), offer)
                }
            },
            createFailure = { error -> onStatus("Creating SDP offer failed: $error") },
        ), constraints)
    }

    fun push(image: ImageProxy, timestampNs: Long) {
        if (stopped.get() || disposed.get()) return
        // A one-time static ceiling (not a dynamic override) based on the actual
        // negotiated frame size, applied once real frames start flowing rather than
        // whatever the resolution picker's target Size was (CameraX can fall back
        // to something else). Left untouched afterward - GCC still freely adapts
        // downward from this under real congestion, this just bounds the upside.
        if (bitrateCapApplied.compareAndSet(false, true)) {
            val frameWidth = image.width
            val frameHeight = image.height
            postRtc { applyBitrateCap(frameWidth, frameHeight) }
        }
        // Rotate the buffer to upright here instead of shipping it with rotation
        // metadata attached. WebRTC normally lets the *receiver* apply that rotation
        // via the CVO RTP header extension (urn:3gpp:video-orientation), but aiortc
        // (the Python server) does not implement CVO, so a non-zero rotation value
        // was being silently dropped: the server analyzed and relayed sensor-orientation
        // pixels, and whether that lined up with what the phone displayed depended on
        // whether the sender happened to pre-rotate for other reasons. Pre-rotating
        // unconditionally makes the transmitted frame's orientation deterministic
        // regardless of receiver CVO support or the activity's screen-orientation lock.
        val rotation = image.imageInfo.rotationDegrees
        val outWidth = if (rotation == 90 || rotation == 270) image.height else image.width
        val outHeight = if (rotation == 90 || rotation == 270) image.width else image.height
        val buffer = JavaI420Buffer.allocate(outWidth, outHeight)
        copyRotatedPlane(image.planes[0].buffer, image.planes[0].rowStride, image.planes[0].pixelStride, buffer.dataY, buffer.strideY, image.width, image.height, rotation)
        copyRotatedPlane(image.planes[1].buffer, image.planes[1].rowStride, image.planes[1].pixelStride, buffer.dataU, buffer.strideU, image.width / 2, image.height / 2, rotation)
        copyRotatedPlane(image.planes[2].buffer, image.planes[2].rowStride, image.planes[2].pixelStride, buffer.dataV, buffer.strideV, image.width / 2, image.height / 2, rotation)
        val frame = VideoFrame(buffer, 0, timestampNs)
        synchronized(captureLock) {
            if (!stopped.get() && !disposed.get()) videoSource.capturerObserver.onFrameCaptured(frame)
            frame.release()
        }
    }

    /**
     * Sends the QR value associated with a CameraX frame. The event carries the
     * same timestamp passed to VideoFrame plus its equivalent 90 kHz RTP clock
     * value, allowing relay-go to pair metadata with the compressed access unit.
     */
    fun sendQrEvent(
        captureTimestampNs: Long,
        sourceTimestampNs: Long?,
        decodeSuccess: Boolean,
        captureIndex: Long,
        latencyMs: Long,
    ) {
        val rtpTimestamp = captureTimestampToRtp(captureTimestampNs)
        val payload = JSONObject()
            .put("type", "qr")
            .put("rtp_timestamp", rtpTimestamp)
            .put("capture_timestamp_ns", captureTimestampNs)
            .put("source_timestamp_ns", sourceTimestampNs ?: JSONObject.NULL)
            .put("decode_success", decodeSuccess)
            .put("capture_index", captureIndex)
            .put("latency_ms", latencyMs)
            .toString()
            .toByteArray(Charsets.UTF_8)
        postRtc {
            if (pendingQrEvents.size >= MAX_PENDING_QR_EVENTS) pendingQrEvents.removeFirst()
            pendingQrEvents.addLast(payload)
            flushQrEvents()
        }
    }

    private fun applyBitrateCap(frameWidth: Int, frameHeight: Int) {
        val sender = videoSender ?: return
        val capBps = (frameWidth.toLong() * frameHeight * BITRATE_TARGET_FPS * BITS_PER_PIXEL_PER_FRAME)
            .toInt()
            .coerceIn(MIN_BITRATE_CAP_BPS, MAX_BITRATE_CAP_BPS)
        val parameters = sender.parameters
        parameters.encodings.forEach { it.maxBitrateBps = capBps }
        sender.parameters = parameters
    }

    // DefaultVideoEncoderFactory(..., enableH264HighProfile = true) makes the device
    // advertise codecs in whatever order its MediaCodecList enumeration happens to
    // produce, with no guarantee hardware H.264 sorts ahead of software VP8. The
    // FastAPI server's aiortc only understands H.264 at profile-level-id 42001f or
    // 42e01f (baseline / constrained-baseline, packetization-mode=1) - a high-profile
    // entry (640c1f) doesn't match anything aiortc recognizes and would be dropped
    // during negotiation regardless. Pinning the offer's codec order here (H.264
    // baseline first, VP8 as the only fallback) makes hardware H.264 encoding land on
    // the wire deterministically instead of depending on device-specific enumeration
    // order.
    private fun applyPreferredCodecs(connection: PeerConnection, sender: RtpSender) {
        val capabilities = factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO)
            ?: return
        Log.i(TAG, "Sender video capabilities: " + capabilities.codecs.joinToString {
            "${it.mimeType}(${it.parameters["profile-level-id"]})"
        })
        val h264 = capabilities.codecs.filter { codec ->
            codec.mimeType.equals("video/H264", ignoreCase = true) &&
                AIORTC_COMPATIBLE_H264_PROFILE_LEVEL_IDS.any {
                    it.equals(codec.parameters["profile-level-id"], ignoreCase = true)
                }
        }
        if (h264.isEmpty()) {
            // No aiortc-compatible H.264 entry on this device - leave the offer's
            // default (device-native) codec order untouched rather than forcing a
            // VP8-only preference, which would be strictly worse than doing nothing.
            Log.i(TAG, "No aiortc-compatible H.264 codec found; leaving default codec order")
            return
        }
        val rtx = capabilities.codecs.filter { it.mimeType.equals("video/rtx", ignoreCase = true) }
        val vp8 = capabilities.codecs.filter { it.mimeType.equals("video/VP8", ignoreCase = true) }
        val preferred = h264 + rtx + vp8
        // Compare by id(), not reference equality: the Java bindings can hand back a
        // different RtpSender wrapper object per call even for the same native sender,
        // so `it.sender === sender` never matches.
        val transceiver = connection.transceivers.firstOrNull { it.sender.id() == sender.id() }
        if (transceiver == null) {
            Log.w(TAG, "applyPreferredCodecs: no matching transceiver found for sender")
            return
        }
        val result = transceiver.setCodecPreferences(preferred)
        if (result.isError) {
            val message = "setCodecPreferences failed: ${result.error()?.message}"
            Log.w(TAG, message)
            onStatus(message)
        } else {
            Log.i(TAG, "setCodecPreferences applied: " + preferred.joinToString {
                "${it.mimeType}(${it.parameters["profile-level-id"]})"
            })
        }
    }

    private fun logNegotiatedCodec(connection: PeerConnection, sender: RtpSender) {
        connection.getStats(sender, RTCStatsCollectorCallback { report -> logCodecFromStats(report) })
    }

    private fun logCodecFromStats(report: RTCStatsReport) {
        val outbound = report.statsMap.values.firstOrNull { it.type == "outbound-rtp" && it.members["kind"] == "video" }
        val codecId = outbound?.members?.get("codecId") as? String
        val codec = codecId?.let { report.statsMap[it] }
        val mimeType = codec?.members?.get("mimeType")
        val fmtp = codec?.members?.get("sdpFmtpLine")
        Log.i(TAG, "Negotiated video codec: mimeType=$mimeType fmtp=$fmtp")
    }

    private fun sendOfferWhenReady() {
        val connection = peer ?: return
        if (!localDescriptionReady || offerPosted || stopped.get()) return
        if (connection.iceGatheringState() != PeerConnection.IceGatheringState.COMPLETE) {
            onStatus("Gathering ICE candidates…")
            return
        }
        val local = connection.localDescription ?: return
        offerPosted = true
        onStatus("Sending offer to server…")
        val json = JSONObject()
            .put("sdp", local.description)
            .put("type", local.type.canonicalForm())
        val request = Request.Builder()
            .url(offerEndpoint)
            .post(json.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: java.io.IOException) {
                // Covers the relay not being up yet (connection refused) as well as a
                // mid-stream restart - either way, the fix is the same full redo below.
                postRtc { restartPeerConnection(connection, "Server request failed: ${e.message ?: "network error"}") }
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { httpResponse ->
                    val body = httpResponse.body?.string().orEmpty()
                    if (!httpResponse.isSuccessful) {
                        postRtc { restartPeerConnection(connection, "Server returned HTTP ${httpResponse.code}") }
                        return
                    }
                    val answer = runCatching { JSONObject(body) }.getOrNull()
                    if (answer == null) {
                        postRtc { restartPeerConnection(connection, "Server returned invalid JSON") }
                        return
                    }
                    postRtc {
                        val current = peer ?: return@postRtc
                        val type = answer.optString("type", "answer")
                        val sdp = answer.optString("sdp")
                        if (sdp.isBlank()) {
                            restartPeerConnection(current, "Server answer did not contain SDP")
                            return@postRtc
                        }
                        current.setRemoteDescription(SimpleSdpObserver(
                            setSuccess = {
                                onStatus("Connected to FastAPI")
                                // outbound-rtp stats have no codecId until the encoder has
                                // produced at least one packet, so check once immediately
                                // (may be empty) and once more after the encoder warms up.
                                videoSender?.let { logNegotiatedCodec(current, it) }
                                Handler(Looper.getMainLooper()).postDelayed({
                                    videoSender?.let { logNegotiatedCodec(current, it) }
                                }, 3000)
                            },
                            setFailure = { error ->
                                postRtc { restartPeerConnection(current, "Setting server SDP failed: $error") }
                            },
                        ), SessionDescription(SessionDescription.Type.fromCanonicalForm(type), sdp))
                    }
                }
            }
        })
    }

    /**
     * Tears down a dead/failed PeerConnection and schedules a full redo (new
     * PeerConnection, new offer, fresh ICE gathering) after a delay - the same
     * fix regardless of whether the failure was the relay not being up yet,
     * the relay restarting mid-stream, or the negotiation itself failing.
     * Must run on rtcExecutor (call via postRtc), since it mutates the same
     * fields startPeer() does.
     */
    private fun restartPeerConnection(deadConnection: PeerConnection?, reason: String) {
        // Ignore a stale failure from a connection already replaced by an
        // earlier restart.
        if (deadConnection != null && peer !== deadConnection) return
        if (stopped.get() || disposed.get()) return
        onStatus("$reason - reconnecting…")
        // The data channel belongs to the failed PeerConnection. Dispose it
        // before creating the replacement so QR events cannot be delivered to
        // a stale SCTP association or remain queued across a new RTP epoch.
        qrChannel?.dispose()
        qrChannel = null
        pendingQrEvents.clear()
        peer?.close()
        peer?.dispose()
        peer = null
        localDescriptionReady = false
        offerPosted = false
        videoSender = null
        bitrateCapApplied.set(false)
        Handler(Looper.getMainLooper()).postDelayed({ postRtc { startPeer() } }, RECONNECT_DELAY_MS)
    }

    fun dispose() {
        if (!disposed.compareAndSet(false, true)) return
        stopped.set(true)
        val finished = CountDownLatch(1)
        rtcExecutor.execute {
            try {
                peer?.close()
                peer?.dispose()
                peer = null
                qrChannel?.dispose()
                qrChannel = null
                pendingQrEvents.clear()
                synchronized(captureLock) {
                    if (capturerStarted) videoSource.capturerObserver.onCapturerStopped()
                    videoTrack.dispose()
                    videoSource.dispose()
                    factory.dispose()
                    eglBase.release()
                }
            } finally {
                finished.countDown()
            }
        }
        finished.await(2, TimeUnit.SECONDS)
        rtcExecutor.shutdown()

        // OkHttp closes pooled TLS sockets synchronously from evictAll().
        // dispose() is normally called by MainActivity on the UI thread, and
        // doing that work here raises NetworkOnMainThreadException. Queue the
        // eviction on OkHttp's own executor before shutting it down; executor
        // shutdown still lets already-queued work finish.
        val httpExecutor = httpClient.dispatcher.executorService
        try {
            httpExecutor.execute { httpClient.connectionPool.evictAll() }
        } catch (_: RejectedExecutionException) {
            // A request callback may have raced disposal and shut the executor
            // down already. The process can safely reclaim the remaining pool.
        }
        httpExecutor.shutdown()
    }

    private fun postRtc(action: () -> Unit) {
        if (rtcExecutor.isShutdown) return
        try {
            rtcExecutor.execute {
                if (!disposed.get()) action()
            }
        } catch (_: RejectedExecutionException) {
            // Disposal can race with an OkHttp or WebRTC callback.
        }
    }

    private fun flushQrEvents() {
        val channel = qrChannel ?: return
        if (channel.state() != DataChannel.State.OPEN) return
        while (pendingQrEvents.isNotEmpty()) {
            val event = pendingQrEvents.first()
            if (!channel.send(DataChannel.Buffer(ByteBuffer.wrap(event), false))) return
            pendingQrEvents.removeFirst()
        }
    }

    private fun captureTimestampToRtp(timestampNs: Long): Long {
        val safe = timestampNs.coerceAtLeast(0L)
        val seconds = safe / NANOS_PER_SECOND
        val remainder = safe % NANOS_PER_SECOND
        val ticks = seconds * RTP_CLOCK_RATE + remainder * RTP_CLOCK_RATE / NANOS_PER_SECOND
        return ticks and 0xffffffffL
    }

    private fun createIceServers(): List<PeerConnection.IceServer> {
        val url = BuildConfig.TURN_URL.trim()
        if (url.isEmpty()) return emptyList()
        return listOf(
            PeerConnection.IceServer.builder(url)
                .setUsername(BuildConfig.TURN_USERNAME)
                .setPassword(BuildConfig.TURN_PASSWORD)
                .createIceServer()
        )
    }

    /**
     * Copies one YUV plane from [source] into [target], rotating it clockwise by
     * [rotationDegrees] (0/90/180/270 - the only values CameraX reports). [srcWidth]/
     * [srcHeight] describe the plane as laid out in [source]; for a 90/270 rotation the
     * written region is srcHeight x srcWidth, matching how the caller sized [target].
     */
    private fun copyRotatedPlane(
        source: ByteBuffer,
        rowStride: Int,
        pixelStride: Int,
        target: ByteBuffer,
        targetStride: Int,
        srcWidth: Int,
        srcHeight: Int,
        rotationDegrees: Int,
    ) {
        val input = source.duplicate()
        val outputWidth = if (rotationDegrees == 90 || rotationDegrees == 270) srcHeight else srcWidth
        val outputHeight = if (rotationDegrees == 90 || rotationDegrees == 270) srcWidth else srcHeight
        val sourceRowBytes = (srcWidth - 1) * pixelStride + 1
        if (planeRowScratch.size < sourceRowBytes) planeRowScratch = ByteArray(sourceRowBytes)

        fun readRow(row: Int) {
            input.position(row * rowStride)
            input.get(planeRowScratch, 0, sourceRowBytes)
        }

        // The common landscape/Y plane case is contiguous. Copy whole rows
        // instead of performing one absolute ByteBuffer read per pixel.
        if (rotationDegrees == 0 && pixelStride == 1) {
            val output = target.duplicate()
            for (row in 0 until srcHeight) {
                readRow(row)
                output.position(row * targetStride)
                output.put(planeRowScratch, 0, srcWidth)
            }
            return
        }

        when (rotationDegrees) {
            90 -> {
                val required = targetStride * outputHeight
                if (planeRotationScratch.size < required) planeRotationScratch = ByteArray(required)
                for (sourceRow in 0 until srcHeight) {
                    readRow(sourceRow)
                    for (sourceColumn in 0 until srcWidth) {
                        val destinationRow = sourceColumn
                        val destinationColumn = srcHeight - 1 - sourceRow
                        planeRotationScratch[destinationRow * targetStride + destinationColumn] =
                            planeRowScratch[sourceColumn * pixelStride]
                    }
                }
                val output = target.duplicate()
                for (row in 0 until outputHeight) {
                    output.position(row * targetStride)
                    output.put(planeRotationScratch, row * targetStride, outputWidth)
                }
            }
            180 -> {
                val output = target.duplicate()
                for (sourceRow in 0 until srcHeight) {
                    readRow(sourceRow)
                    output.position((srcHeight - 1 - sourceRow) * targetStride)
                    for (sourceColumn in srcWidth - 1 downTo 0) {
                        output.put(planeRowScratch[sourceColumn * pixelStride])
                    }
                }
            }
            270 -> {
                val required = targetStride * outputHeight
                if (planeRotationScratch.size < required) planeRotationScratch = ByteArray(required)
                for (sourceRow in 0 until srcHeight) {
                    readRow(sourceRow)
                    for (sourceColumn in 0 until srcWidth) {
                        val destinationRow = srcWidth - 1 - sourceColumn
                        val destinationColumn = sourceRow
                        planeRotationScratch[destinationRow * targetStride + destinationColumn] =
                            planeRowScratch[sourceColumn * pixelStride]
                    }
                }
                val output = target.duplicate()
                for (row in 0 until outputHeight) {
                    output.position(row * targetStride)
                    output.put(planeRotationScratch, row * targetStride, outputWidth)
                }
            }
            else -> {
                val output = target.duplicate()
                for (row in 0 until srcHeight) {
                    readRow(row)
                    output.position(row * targetStride)
                    for (column in 0 until srcWidth) {
                        // This branch is retained for defensive handling of
                        // unexpected rotation values; CameraX supplies 0/90/
                        // 180/270 in normal operation.
                        output.put(planeRowScratch[column * pixelStride])
                    }
                }
            }
        }
    }

    private class SimpleSdpObserver(
        private val createSuccess: (SessionDescription) -> Unit = {},
        private val setSuccess: () -> Unit = {},
        private val createFailure: (String) -> Unit = {},
        private val setFailure: (String) -> Unit = {},
    ) : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = createSuccess(description)
        override fun onSetSuccess() = setSuccess()
        override fun onCreateFailure(error: String) = createFailure(error)
        override fun onSetFailure(error: String) = setFailure(error)
    }

    companion object {
        private const val TAG = "WebRtcPublisher"
        private val factoryInitialized = AtomicBoolean(false)
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        // aiortc (server/app) only recognizes these two H.264 profile-level-ids
        // (server/.venv/Lib/site-packages/aiortc/codecs/__init__.py); see
        // applyPreferredCodecs().
        private val AIORTC_COMPATIBLE_H264_PROFILE_LEVEL_IDS = setOf("42e01f", "42001f")

        // Static bitrate ceiling, scaled by resolution and set once - GCC (libwebrtc's
        // own congestion control, driven by real REMB feedback from the server) still
        // freely adapts downward from this under actual network conditions; this only
        // bounds the upside so a strong network doesn't push an arbitrarily large
        // bitrate for a given resolution. ~0.08 bits/pixel/frame at 30fps works out to
        // roughly 2.2 Mbps at 720p, 5 Mbps at 1080p, 20 Mbps at 4K.
        private const val BITS_PER_PIXEL_PER_FRAME = 0.08
        private const val BITRATE_TARGET_FPS = 30
        private const val MIN_BITRATE_CAP_BPS = 500_000 // 500 kbps
        private const val MAX_BITRATE_CAP_BPS = 20_000_000 // 20 Mbps
        private const val NANOS_PER_SECOND = 1_000_000_000L
        private const val RTP_CLOCK_RATE = 90_000L
        private const val MAX_PENDING_QR_EVENTS = 300

        // Fixed retry interval rather than exponential backoff - matches this
        // project's other reconnect loops (the relay feed retry in yolo.py), and a
        // full PeerConnection redo is heavy enough that this is not too aggressive.
        private const val RECONNECT_DELAY_MS = 2000L
    }
}
