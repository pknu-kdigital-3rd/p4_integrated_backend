package com.example.webrtccamera

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Range
import android.util.Size
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.Surface
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.core.Camera
import androidx.camera.core.CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

private data class ResolutionOption(val label: String, val size: Size)

private val RESOLUTION_OPTIONS = listOf(
    ResolutionOption("720p (1280x720)", Size(1280, 720)),
    ResolutionOption("1080p (1920x1080)", Size(1920, 1080)),
    ResolutionOption("1440p (2560x1440)", Size(2560, 1440)),
    ResolutionOption("4K (3840x2160)", Size(3840, 2160)),
)
private const val DEFAULT_RESOLUTION_INDEX = 0 // 720p, matches the previous hardcoded behavior

// A floor on frame rate is a ceiling on exposure time, so auto-exposure must
// raise gain rather than hold the shutter open and smear motion into the pixels.
private const val TARGET_CAPTURE_FPS = 30

// QR detection does not need to run at the video frame rate. Keeping one ML
// Kit task in flight and sampling at 10 Hz prevents ImageProxy instances from
// accumulating while preserving responsive QR updates.
private const val QR_SCAN_INTERVAL_NS = 100_000_000L

// The rig points at a screen a fixed distance away. Autofocus hunts badly on a
// flat, periodic pixel pattern, so the lens is pinned rather than scanned and
// the operator pinches to find the sharp point by eye. Focus is held as a 0..1
// fraction of the lens range because many devices report LENS_FOCUS_DISTANCE as
// UNCALIBRATED, where the diopter scale is repeatable but not physically true.
private const val FOCUS_FRACTION_KEY = "focus_fraction"
private const val FOCUS_PINCH_SENSITIVITY = 2.0f

class MainActivity : AppCompatActivity() {
    private lateinit var viewFinder: PreviewView
    private lateinit var statusText: TextView
    private lateinit var streamButton: Button
    private lateinit var serverUrl: EditText
    private lateinit var resolutionSpinner: Spinner
    private lateinit var actualResolutionText: TextView
    private lateinit var qrStatusText: TextView
    private lateinit var qrScanningSwitch: Switch
    private lateinit var cameraExecutor: ExecutorService

    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var publisher: WebRtcPublisher? = null
    private val streaming = AtomicBoolean(false)
    private var captureSummary = ""
    @Volatile
    private var captureFps = 0f
    private var captureWindowStartedNs = 0L
    private var captureWindowFrames = 0
    @Volatile
    private var qrScanningEnabled = true
    private var focusRangeDiopters: Float? = null
    private var focusFraction = 0f
    private val qrScanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
    )
    private val qrCaptureIndex = AtomicLong(0)
    private val qrScanInFlight = AtomicBoolean(false)
    private var lastQrScanStartedNs = 0L

    // Written from a camera thread by the session capture callback so a tap-
    // triggered scan can be read back and adopted as the new manual position.
    @Volatile
    private var lastLensPosition: Float? = null

    private val tapFocusDetector by lazy {
        GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onSingleTapUp(event: MotionEvent): Boolean {
                autoFocusAt(event.x, event.y)
                return true
            }
        })
    }

    private val focusGestureDetector by lazy {
        ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                if (focusRangeDiopters == null) return false
                focusFraction =
                    (focusFraction + (detector.scaleFactor - 1f) * FOCUS_PINCH_SENSITIVITY)
                        .coerceIn(0f, 1f)
                camera?.let(::applyFocus)
                return true
            }

            override fun onScaleEnd(detector: ScaleGestureDetector) {
                getPreferences(MODE_PRIVATE).edit { putFloat(FOCUS_FRACTION_KEY, focusFraction) }
            }
        })
    }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startStreaming() else setStatus("Camera permission is required")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        viewFinder = findViewById(R.id.viewFinder)
        statusText = findViewById(R.id.statusText)
        streamButton = findViewById(R.id.streamButton)
        serverUrl = findViewById(R.id.serverUrl)
        serverUrl.setText(BuildConfig.DEFAULT_SERVER_URL)
        resolutionSpinner = findViewById(R.id.resolutionSpinner)
        actualResolutionText = findViewById(R.id.actualResolutionText)
        qrStatusText = findViewById(R.id.qrStatusText)
        qrScanningSwitch = findViewById(R.id.qrScanningSwitch)
        qrScanningSwitch.setOnCheckedChangeListener { _, enabled ->
            qrScanningEnabled = enabled
            setQrStatus(if (enabled) "QR: waiting for scan…" else "QR: disabled")
        }
        focusFraction = getPreferences(MODE_PRIVATE).getFloat(FOCUS_FRACTION_KEY, 0f)
        viewFinder.setOnTouchListener { view, event ->
            focusGestureDetector.onTouchEvent(event)
            // Suppress the tap while a pinch is running, so lifting two fingers
            // cannot fire a scan that undoes the adjustment just made.
            if (!focusGestureDetector.isInProgress) tapFocusDetector.onTouchEvent(event)
            if (event.actionMasked == MotionEvent.ACTION_UP) view.performClick()
            true
        }
        // The system spinner layouts use the app theme's default text color, which
        // reads as near-black against this dark panel - force it white to match
        // statusText/serverUrl instead.
        resolutionSpinner.adapter = object : ArrayAdapter<String>(
            this,
            android.R.layout.simple_spinner_item,
            RESOLUTION_OPTIONS.map { it.label },
        ) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getView(position, convertView, parent) as TextView).apply {
                    setTextColor(Color.WHITE)
                }

            override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getDropDownView(position, convertView, parent) as TextView).apply {
                    setTextColor(Color.WHITE)
                }
        }.also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        resolutionSpinner.setSelection(DEFAULT_RESOLUTION_INDEX)
        streamButton.setOnClickListener {
            if (streaming.get()) stopStreaming() else startStreaming()
        }

        cameraExecutor = Executors.newSingleThreadExecutor()
        setStatus("Ready")
    }

    private fun startStreaming() {
        if (streaming.get()) return
        val endpoint = normalizeServerUrl(serverUrl.text.toString())
        if (endpoint == null) {
            setStatus("Enter a valid server URL or host:port")
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
            return
        }

        streaming.set(true)
        qrCaptureIndex.set(0)
        qrScanInFlight.set(false)
        lastQrScanStartedNs = 0L
        captureFps = 0f
        captureWindowStartedNs = 0L
        captureWindowFrames = 0
        resolutionSpinner.isEnabled = false
        streamButton.setText(R.string.stop_streaming)
        setStatus("Starting WebRTC…")
        publisher = WebRtcPublisher(this, endpoint) { message ->
            runOnUiThread { if (streaming.get()) setStatus(message) }
        }
        publisher?.start()
        bindCamera()
    }

    private fun bindCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            if (!streaming.get()) return@addListener
            try {
                val provider = future.get()
                val selectedResolution = RESOLUTION_OPTIONS
                    .getOrElse(resolutionSpinner.selectedItemPosition) { RESOLUTION_OPTIONS[DEFAULT_RESOLUTION_INDEX] }
                    .size
                val resolutionSelector = ResolutionSelector.Builder()
                    // ResolutionSelector defaults to RATIO_4_3_FALLBACK_AUTO_STRATEGY
                    // when unset, which CameraX ranks above closeness-to-target when
                    // picking an output size - so a 16:9 target (all current presets)
                    // could still lose to an available 4:3 mode without this.
                    .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
                    .setResolutionStrategy(
                        ResolutionStrategy(
                            selectedResolution,
                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                        )
                    )
                    .build()
                val preview = Preview.Builder()
                    .setTargetRotation(viewFinder.display?.rotation ?: Surface.ROTATION_0)
                    .build()
                    .also { it.setSurfaceProvider(viewFinder.surfaceProvider) }
                val analysisBuilder = ImageAnalysis.Builder()
                    .setTargetRotation(viewFinder.display?.rotation ?: Surface.ROTATION_0)
                    .setResolutionSelector(resolutionSelector)
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                val cameraInfo = CameraSelector.DEFAULT_BACK_CAMERA
                    .filter(provider.availableCameraInfos)
                    .firstOrNull()
                val exposureCap = cameraInfo?.let(::selectExposureCappingFpsRange)
                if (exposureCap != null) applyExposureCap(analysisBuilder, exposureCap)
                focusRangeDiopters = cameraInfo?.let(::manualFocusRangeDiopters)
                observeLensPosition(analysisBuilder)
                val analysis = analysisBuilder
                    .build()
                    .also { it.setAnalyzer(cameraExecutor, ::publishFrame) }

                provider.unbindAll()
                val bound = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                cameraProvider = provider
                camera = bound
                applyFocus(bound)
                // The requested Size is only a target - the camera HAL may not offer
                // that exact size/aspect ratio, so show what was actually bound. This
                // gets its own label rather than statusText, since WebRtcPublisher's
                // onStatus callback fires concurrently on another thread and would
                // otherwise overwrite this within milliseconds of it being set.
                val actual = analysis.resolutionInfo?.resolution
                val capNote = exposureCap?.let { " · ≥${it.lower} fps" }.orEmpty()
                captureSummary = "Streaming at: ${actual?.width}x${actual?.height}$capNote"
                updateCaptureLabel()
                setStatus("Camera ready; waiting for WebRTC answer…")
            } catch (error: Exception) {
                setStatus("Camera setup failed: ${error.message ?: "unknown error"}")
                stopStreaming()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun selectExposureCappingFpsRange(cameraInfo: CameraInfo): Range<Int>? =
        Camera2CameraInfo.from(cameraInfo)
            .getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
            // A faster range would feed more frames to a pipeline that infers every one.
            ?.filter { it.upper == TARGET_CAPTURE_FPS }
            ?.maxByOrNull { it.lower }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun applyExposureCap(builder: ImageAnalysis.Builder, range: Range<Int>) {
        Camera2Interop.Extender(builder)
            .setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, range)
    }

    /**
     * Diopters at the lens's near limit, or null when focus cannot be driven
     * manually. Doubles as the top of the pinch range.
     */
    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun manualFocusRangeDiopters(cameraInfo: CameraInfo): Float? {
        val info = Camera2CameraInfo.from(cameraInfo)
        val supportsManualFocus = info
            .getCameraCharacteristic(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)
            ?.contains(CameraMetadata.CONTROL_AF_MODE_OFF) == true
        // Zero means a fixed-focus lens, which has no position to set.
        val closest = info
            .getCameraCharacteristic(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE)
            ?: 0f
        return if (supportsManualFocus && closest > 0f) closest else null
    }

    /**
     * Pins the lens at the current pinch position. Applied through
     * Camera2CameraControl rather than the use-case builder so a pinch takes
     * effect on the running session instead of needing a rebind.
     */
    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun applyFocus(camera: Camera) {
        val range = focusRangeDiopters ?: return
        Camera2CameraControl.from(camera.cameraControl).setCaptureRequestOptions(
            CaptureRequestOptions.Builder()
                .setCaptureRequestOption(
                    CaptureRequest.CONTROL_AF_MODE,
                    CameraMetadata.CONTROL_AF_MODE_OFF,
                )
                .setCaptureRequestOption(
                    CaptureRequest.LENS_FOCUS_DISTANCE,
                    focusFraction * range,
                )
                .build()
        )
        updateCaptureLabel()
    }

    /**
     * Runs one autofocus scan at the tapped point, then re-pins the lens where
     * it settled. The scan is a starting point; pinch still fine-tunes from
     * whatever it found.
     */
    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun autoFocusAt(x: Float, y: Float) {
        val camera = camera ?: return
        val action = FocusMeteringAction
            .Builder(viewFinder.meteringPointFactory.createPoint(x, y), FocusMeteringAction.FLAG_AF)
            .disableAutoCancel()
            .build()
        // The manual pin has to come off first: CONTROL_AF_MODE_OFF is in force
        // between scans, and the lens cannot move while it is.
        Camera2CameraControl.from(camera.cameraControl).clearCaptureRequestOptions()
        setStatus("Focusing…")
        val scan = camera.cameraControl.startFocusAndMetering(action)
        scan.addListener({
            val range = focusRangeDiopters
            val settled = lastLensPosition
            if (range == null || settled == null) return@addListener
            // Adopting the scan's position keeps pinch continuous instead of
            // snapping back to the fraction held before the tap.
            focusFraction = (settled / range).coerceIn(0f, 1f)
            getPreferences(MODE_PRIVATE).edit { putFloat(FOCUS_FRACTION_KEY, focusFraction) }
            applyFocus(camera)
        }, ContextCompat.getMainExecutor(this))
    }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun observeLensPosition(builder: ImageAnalysis.Builder) {
        Camera2Interop.Extender(builder).setSessionCaptureCallback(
            object : CameraCaptureSession.CaptureCallback() {
                override fun onCaptureCompleted(
                    session: CameraCaptureSession,
                    request: CaptureRequest,
                    result: TotalCaptureResult,
                ) {
                    result.get(CaptureResult.LENS_FOCUS_DISTANCE)?.let { lastLensPosition = it }
                }
            }
        )
    }

    private fun updateCaptureLabel() {
        val range = focusRangeDiopters
        val diopters = if (range == null) 0f else focusFraction * range
        val focusNote = when {
            range == null -> " · autofocus"
            diopters <= 0f -> " · focus ∞"
            else -> " · focus %.2f m".format(1f / diopters)
        }
        val fpsNote = if (captureFps > 0f) " · capture %.1f fps".format(captureFps) else ""
        actualResolutionText.text = captureSummary + focusNote + fpsNote
    }

    // QR decoding runs on the exact same frame this pushes as video, instead
    // of a second concurrent ImageAnalysis stream: binding preview + analysis
    // + a QR-only analysis stream together let CameraX report success while
    // the camera HAL silently never delivered a single frame to the third
    // stream (confirmed via a call counter that never moved past zero) -
    // apparently a real stream-count limit on this device/HAL that CameraX's
    // own combination check didn't catch. Sharing one frame also removes the
    // separate concern of whether the QR reading and the published video
    // frame actually corresponded to the same instant.
    @androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
    private fun publishFrame(image: ImageProxy) {
        if (!streaming.get()) {
            image.close()
            return
        }
        recordCaptureFrame()
        val timestamp = image.imageInfo.timestamp.takeIf { it > 0 } ?: SystemClock.elapsedRealtimeNanos()
        // scanQrFrame takes over closing `image` once handed off, since ML
        // Kit reads it asynchronously. Only one sampled frame may be held by
        // ML Kit at a time; all other frames close immediately so CameraX can
        // keep delivering the full-rate video stream.
        var handedOffToQrScan = false
        try {
            publisher?.push(image, timestamp)
            if (qrScanningEnabled && tryStartQrScan()) {
                handedOffToQrScan = true
                scanQrFrame(image, timestamp)
            }
        } finally {
            if (!handedOffToQrScan) image.close()
        }
    }

    private fun tryStartQrScan(): Boolean {
        val now = SystemClock.elapsedRealtimeNanos()
        if (now - lastQrScanStartedNs < QR_SCAN_INTERVAL_NS) return false
        if (!qrScanInFlight.compareAndSet(false, true)) return false
        lastQrScanStartedNs = now
        return true
    }

    /** Measures frames delivered to CameraX before WebRTC encoding or server processing. */
    private fun recordCaptureFrame() {
        val now = SystemClock.elapsedRealtimeNanos()
        if (captureWindowStartedNs == 0L) captureWindowStartedNs = now
        captureWindowFrames += 1
        val elapsed = now - captureWindowStartedNs
        if (elapsed < 1_000_000_000L) return
        captureFps = captureWindowFrames * 1_000_000_000f / elapsed
        captureWindowStartedNs = now
        captureWindowFrames = 0
        runOnUiThread { if (streaming.get()) updateCaptureLabel() }
    }

    @androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
    private fun scanQrFrame(image: ImageProxy, timestamp: Long) {
        val captureIndex = qrCaptureIndex.getAndIncrement()
        val start = System.nanoTime()
        val mediaImage = image.image
        if (mediaImage == null) {
            qrScanInFlight.set(false)
            setQrStatus("QR: no frame (image unavailable)")
            publisher?.sendQrEvent(
                timestamp,
                null,
                false,
                captureIndex,
                (System.nanoTime() - start) / 1_000_000,
            )
            image.close()
            return
        }
        val input = InputImage.fromMediaImage(mediaImage, image.imageInfo.rotationDegrees)
        try {
            qrScanner.process(input)
                .addOnSuccessListener { barcodes ->
                    val raw = barcodes.firstOrNull()?.rawValue
                    val decoded = raw?.toLongOrNull()
                    setQrStatus(
                        when {
                            raw == null -> "QR: none visible"
                            decoded == null -> "QR: unreadable content \"$raw\""
                            else -> "QR: ts=$decoded"
                        }
                    )
                    publisher?.sendQrEvent(
                        timestamp,
                        decoded,
                        decoded != null,
                        captureIndex,
                        (System.nanoTime() - start) / 1_000_000,
                    )
                }
                .addOnFailureListener { error ->
                    setQrStatus("QR: scan failed (${error.message ?: "unknown error"})")
                    publisher?.sendQrEvent(
                        timestamp,
                        null,
                        false,
                        captureIndex,
                        (System.nanoTime() - start) / 1_000_000,
                    )
                }
                .addOnCompleteListener {
                    qrScanInFlight.set(false)
                    image.close()
                }
        } catch (error: Exception) {
            qrScanInFlight.set(false)
            image.close()
            setQrStatus("QR: scan failed (${error.message ?: "unknown error"})")
        }
    }

    private fun setQrStatus(text: String) {
        if (::qrStatusText.isInitialized) runOnUiThread { qrStatusText.text = text }
    }

    private fun stopStreaming() {
        if (!streaming.getAndSet(false)) return
        cameraProvider?.unbindAll()
        cameraProvider = null
        camera = null
        publisher?.dispose()
        publisher = null
        resolutionSpinner.isEnabled = true
        actualResolutionText.text = ""
        streamButton.setText(R.string.start_streaming)
        setStatus("Stopped")
    }

    private fun normalizeServerUrl(value: String): String? {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) return null
        val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            trimmed
        } else {
            "https://$trimmed"
        }
        val parsed = Uri.parse(withScheme)
        if (parsed.host.isNullOrBlank() || parsed.port == 0) return null
        return withScheme.trimEnd('/').let {
            if (it.endsWith("/offer/android")) it else "$it/offer/android"
        }
    }

    private fun setStatus(message: String) {
        if (::statusText.isInitialized) statusText.text = message
    }

    override fun onStop() {
        stopStreaming()
        super.onStop()
    }

    override fun onDestroy() {
        qrScanner.close()
        cameraExecutor.shutdownNow()
        super.onDestroy()
    }
}
