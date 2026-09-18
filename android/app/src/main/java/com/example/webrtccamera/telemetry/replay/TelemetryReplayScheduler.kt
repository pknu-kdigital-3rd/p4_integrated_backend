package com.example.webrtccamera.telemetry.replay

import android.os.SystemClock
import com.example.webrtccamera.telemetry.model.GpsSample
import com.example.webrtccamera.telemetry.model.ImuSample
import com.example.webrtccamera.telemetry.model.StreamSessionContext
import com.example.webrtccamera.telemetry.model.TelemetryBatch
import com.example.webrtccamera.telemetry.model.TelemetryDataset
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Emits due GPS/IMU samples from [dataset] as the QR-derived source clock advances, batching
 * them for network transport without altering per-sample timestamps. Never interpolates: a
 * batch only ever contains samples whose original CSV timestamp has already become due.
 *
 * All mutable cursor/batching state is touched only from [executor]'s single thread, including
 * QR-driven clock updates (routed through [onQrTimestamp]) and discontinuity resets - this is
 * what makes a QR update racing a scheduled tick safe without extra locking.
 */
class TelemetryReplayScheduler(
    private val dataset: TelemetryDataset,
    private val sourceClock: QrSourceClock,
    private val sessionContext: StreamSessionContext,
    private val onBatchReady: (TelemetryBatch) -> Unit,
    private val onStatus: (String) -> Unit = {},
    private val elapsedMillis: () -> Long = SystemClock::elapsedRealtime,
) {
    private val executor = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "telemetry-replay").apply { isDaemon = true }
    }
    private var tickFuture: ScheduledFuture<*>? = null

    internal var nextGpsIndex = 0
        private set
    internal var nextImuIndex = 0
        private set
    private val pendingGps = ArrayList<GpsSample>()
    private val pendingImu = ArrayList<ImuSample>()
    private var lastFlushElapsedMs = 0L
    @Volatile private var running = false
    private var endOfDatasetLogged = false

    val gpsSentCount = AtomicLong(0)
    val imuSentCount = AtomicLong(0)
    val batchSentCount = AtomicLong(0)

    init {
        sourceClock.setOnDiscontinuityListener { oldSourceNs, newSourceNs ->
            resyncCursors(newSourceNs)
            onStatus("Telemetry: seek detected (${oldSourceNs}ns -> ${newSourceNs}ns); cursors reset")
        }
    }

    fun start() {
        postOrRun {
            if (running) return@postOrRun
            running = true
            endOfDatasetLogged = false
            pendingGps.clear()
            pendingImu.clear()
            lastFlushElapsedMs = elapsedMillis()
            val sourceNow = sourceClock.currentSourceTimestampNs()
            if (sourceNow != null) {
                resyncCursors(sourceNow)
            } else {
                nextGpsIndex = 0
                nextImuIndex = 0
            }
            tickFuture = executor.scheduleWithFixedDelay(::tick, 0, TICK_INTERVAL_MS, TimeUnit.MILLISECONDS)
        }
    }

    fun stop() {
        running = false
        tickFuture?.cancel(false)
        tickFuture = null
        executor.shutdown()
    }

    /** Only call for a successful QR decode. */
    fun onQrTimestamp(sourceTimestampNs: Long, captureTimestampNs: Long, decodeLatencyMs: Long) {
        postOrRun { sourceClock.onQrTimestamp(sourceTimestampNs, captureTimestampNs, decodeLatencyMs) }
    }

    private fun postOrRun(action: () -> Unit) {
        if (executor.isShutdown) return
        try {
            executor.execute(action)
        } catch (_: RejectedExecutionException) {
            // Disposal can race with a QR callback or the tick loop.
        }
    }

    private fun resyncCursors(sourceNs: Long) {
        nextGpsIndex = firstIndexAtOrAfter(dataset.gps, sourceNs) { it.timestampNs }
        nextImuIndex = firstIndexAtOrAfter(dataset.imu, sourceNs) { it.timestampNs }
        pendingGps.clear()
        pendingImu.clear()
        endOfDatasetLogged = false
    }

    private fun tick() {
        if (!running) return
        val sourceNow = sourceClock.currentSourceTimestampNs() ?: return
        advanceCursors(sourceNow, elapsedMillis())
    }

    /** Core due-sample selection and batching, factored out so tests can drive it directly. */
    internal fun advanceCursors(sourceNow: Long, nowMs: Long) {
        while (nextGpsIndex < dataset.gps.size && dataset.gps[nextGpsIndex].timestampNs <= sourceNow) {
            pendingGps.add(dataset.gps[nextGpsIndex])
            nextGpsIndex++
        }
        while (nextImuIndex < dataset.imu.size && dataset.imu[nextImuIndex].timestampNs <= sourceNow) {
            pendingImu.add(dataset.imu[nextImuIndex])
            nextImuIndex++
            if (pendingImu.size >= MAX_IMU_PER_BATCH) flush(sourceNow, nowMs)
        }
        if (!endOfDatasetLogged && nextGpsIndex >= dataset.gps.size && nextImuIndex >= dataset.imu.size) {
            endOfDatasetLogged = true
            flush(sourceNow, nowMs)
            onStatus("Telemetry: end of dataset")
        }
        if ((pendingGps.isNotEmpty() || pendingImu.isNotEmpty()) && nowMs - lastFlushElapsedMs >= FLUSH_INTERVAL_MS) {
            flush(sourceNow, nowMs)
        }
    }

    private fun flush(sourceNow: Long, nowMs: Long) {
        if (pendingGps.isEmpty() && pendingImu.isEmpty()) return
        val batch = TelemetryBatch(
            mode = sessionContext.telemetryMode,
            tripId = sessionContext.tripId,
            vehicleId = sessionContext.vehicleId,
            recordingSessionId = sessionContext.recordingSessionId,
            sourceClockNs = sourceNow,
            gps = ArrayList(pendingGps),
            imu = ArrayList(pendingImu),
        )
        gpsSentCount.addAndGet(pendingGps.size.toLong())
        imuSentCount.addAndGet(pendingImu.size.toLong())
        batchSentCount.incrementAndGet()
        pendingGps.clear()
        pendingImu.clear()
        lastFlushElapsedMs = nowMs
        onBatchReady(batch)
    }

    /** Test-only: position cursors without a real QR clock/executor round-trip. */
    internal fun testResync(sourceNs: Long) = resyncCursors(sourceNs)

    companion object {
        // Much faster than the network batch interval so due samples are never held back by
        // tick granularity - the source timestamps, not the tick time, decide what is due.
        const val TICK_INTERVAL_MS = 10L
        const val FLUSH_INTERVAL_MS = 40L
        const val MAX_IMU_PER_BATCH = 16

        internal fun <T> firstIndexAtOrAfter(list: List<T>, target: Long, selector: (T) -> Long): Int {
            var lo = 0
            var hi = list.size
            while (lo < hi) {
                val mid = (lo + hi) ushr 1
                if (selector(list[mid]) < target) lo = mid + 1 else hi = mid
            }
            return lo
        }
    }
}
