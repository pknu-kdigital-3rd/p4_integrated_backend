package com.example.webrtccamera.telemetry.replay

import android.os.SystemClock
import kotlin.math.abs

enum class SourceClockState {
    WAITING_FOR_QR,
    RUNNING,
    STALE,
}

data class QrAnchor(
    val sourceTimestampNs: Long,
    val localElapsedNs: Long,
)

/**
 * Estimates the current position in the externally displayed footage from decoded QR
 * `source_timestamp_ns` values plus Android's local monotonic clock. Re-anchors on every
 * successful QR decode so local-clock drift never accumulates; a QR decode failure must not
 * touch this clock (callers simply do not call [onQrTimestamp]).
 */
class QrSourceClock(
    private val nowNs: () -> Long = SystemClock::elapsedRealtimeNanos,
    private val staleTimeoutNs: Long = QR_STALE_TIMEOUT_NS,
    private val minPlaybackRate: Double = MIN_PLAYBACK_RATE,
    private val maxPlaybackRate: Double = MAX_PLAYBACK_RATE,
    private val seekThresholdNs: Long = SEEK_THRESHOLD_NS,
) {
    private var anchor: QrAnchor? = null
    private var playbackRate: Double = 1.0
    private var onDiscontinuity: ((oldSourceNs: Long, newSourceNs: Long) -> Unit)? = null

    var lastQrCorrectionNs: Long = 0L
        private set
    var lastEstimatedPlaybackRate: Double = 1.0
        private set

    fun setOnDiscontinuityListener(listener: (oldSourceNs: Long, newSourceNs: Long) -> Unit) {
        onDiscontinuity = listener
    }

    /** Feed a successful QR decode. Never call this for a failed/absent/malformed decode. */
    fun onQrTimestamp(sourceTimestampNs: Long, captureTimestampNs: Long, decodeLatencyMs: Long) {
        val decodeLatencyNs = decodeLatencyMs * 1_000_000L
        val newLocalElapsedNs = nowNs() - decodeLatencyNs
        val previousAnchor = anchor

        if (previousAnchor == null) {
            anchor = QrAnchor(sourceTimestampNs, newLocalElapsedNs)
            playbackRate = 1.0
            lastEstimatedPlaybackRate = 1.0
            lastQrCorrectionNs = 0L
            return
        }

        val predictedSourceNs = estimateAt(newLocalElapsedNs, previousAnchor, playbackRate)
        lastQrCorrectionNs = sourceTimestampNs - predictedSourceNs

        val sourceDelta = sourceTimestampNs - previousAnchor.sourceTimestampNs
        val localDelta = newLocalElapsedNs - previousAnchor.localElapsedNs

        if (abs(sourceDelta) > seekThresholdNs) {
            // A jump this large is treated as a seek/footage-change/restart rather than an
            // implausible playback-rate estimate; the caller resets cursors instead of
            // backfilling the skipped interval.
            playbackRate = 1.0
            lastEstimatedPlaybackRate = 1.0
            anchor = QrAnchor(sourceTimestampNs, newLocalElapsedNs)
            onDiscontinuity?.invoke(previousAnchor.sourceTimestampNs, sourceTimestampNs)
            return
        }

        if (localDelta > 0) {
            val rawRate = sourceDelta.toDouble() / localDelta.toDouble()
            playbackRate = rawRate.coerceIn(minPlaybackRate, maxPlaybackRate)
            lastEstimatedPlaybackRate = playbackRate
        }

        anchor = QrAnchor(sourceTimestampNs, newLocalElapsedNs)
    }

    fun state(nowElapsedNs: Long = nowNs()): SourceClockState {
        val currentAnchor = anchor ?: return SourceClockState.WAITING_FOR_QR
        return if (nowElapsedNs - currentAnchor.localElapsedNs > staleTimeoutNs) {
            SourceClockState.STALE
        } else {
            SourceClockState.RUNNING
        }
    }

    /**
     * Null while [SourceClockState.WAITING_FOR_QR]. Frozen at the estimate as of the moment
     * staleness began while [SourceClockState.STALE], so telemetry emission stops advancing
     * rather than drifting away from what the footage last showed.
     */
    fun currentSourceTimestampNs(nowElapsedNs: Long = nowNs()): Long? {
        val currentAnchor = anchor ?: return null
        val effectiveNow = if (state(nowElapsedNs) == SourceClockState.STALE) {
            currentAnchor.localElapsedNs + staleTimeoutNs
        } else {
            nowElapsedNs
        }
        return estimateAt(effectiveNow, currentAnchor, playbackRate)
    }

    fun reset() {
        anchor = null
        playbackRate = 1.0
        lastEstimatedPlaybackRate = 1.0
        lastQrCorrectionNs = 0L
    }

    private fun estimateAt(nowElapsedNs: Long, anchor: QrAnchor, rate: Double): Long {
        val deltaNs = nowElapsedNs - anchor.localElapsedNs
        return anchor.sourceTimestampNs + (deltaNs * rate).toLong()
    }

    companion object {
        // Plan section 8.7: initial proposal is 1..2s; kept as a named constant rather than
        // buried in logic.
        const val QR_STALE_TIMEOUT_NS = 1_500_000_000L
        const val MIN_PLAYBACK_RATE = 0.0
        const val MAX_PLAYBACK_RATE = 4.0
        // Beyond this, a jump is treated as a seek/restart rather than fast/slow playback.
        const val SEEK_THRESHOLD_NS = 5_000_000_000L
    }
}
