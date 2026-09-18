package com.example.webrtccamera.telemetry

import com.example.webrtccamera.telemetry.replay.QrSourceClock
import com.example.webrtccamera.telemetry.replay.SourceClockState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NS_PER_SECOND = 1_000_000_000L

class QrSourceClockTest {

    private class FakeClock(var nowNs: Long = 0L) {
        fun advance(deltaNs: Long) {
            nowNs += deltaNs
        }
    }

    @Test
    fun `waiting for first qr returns null`() {
        val clock = FakeClock()
        val sourceClock = QrSourceClock(nowNs = { clock.nowNs })
        assertEquals(SourceClockState.WAITING_FOR_QR, sourceClock.state())
        assertNull(sourceClock.currentSourceTimestampNs())
    }

    @Test
    fun `normal 1x playback estimates rate near 1`() {
        val clock = FakeClock()
        val sourceClock = QrSourceClock(nowNs = { clock.nowNs })
        sourceClock.onQrTimestamp(sourceTimestampNs = 0L, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        clock.advance(NS_PER_SECOND)
        sourceClock.onQrTimestamp(sourceTimestampNs = NS_PER_SECOND, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        assertEquals(1.0, sourceClock.lastEstimatedPlaybackRate, 0.01)
    }

    @Test
    fun `2x playback estimates rate near 2`() {
        val clock = FakeClock()
        val sourceClock = QrSourceClock(nowNs = { clock.nowNs })
        sourceClock.onQrTimestamp(sourceTimestampNs = 0L, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        clock.advance(NS_PER_SECOND)
        sourceClock.onQrTimestamp(sourceTimestampNs = 2 * NS_PER_SECOND, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        assertEquals(2.0, sourceClock.lastEstimatedPlaybackRate, 0.01)
    }

    @Test
    fun `repeated source timestamp drives rate toward zero`() {
        val clock = FakeClock()
        val sourceClock = QrSourceClock(nowNs = { clock.nowNs })
        sourceClock.onQrTimestamp(sourceTimestampNs = 5_000_000_000L, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        clock.advance(NS_PER_SECOND)
        sourceClock.onQrTimestamp(sourceTimestampNs = 5_000_000_000L, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        assertEquals(0.0, sourceClock.lastEstimatedPlaybackRate, 0.01)
    }

    @Test
    fun `backward seek resets and fires discontinuity`() {
        val clock = FakeClock()
        val sourceClock = QrSourceClock(nowNs = { clock.nowNs })
        var discontinuity: Pair<Long, Long>? = null
        sourceClock.setOnDiscontinuityListener { old, new -> discontinuity = old to new }
        sourceClock.onQrTimestamp(sourceTimestampNs = 100 * NS_PER_SECOND, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        clock.advance(NS_PER_SECOND)
        sourceClock.onQrTimestamp(sourceTimestampNs = 25 * NS_PER_SECOND, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        assertEquals(100 * NS_PER_SECOND to 25 * NS_PER_SECOND, discontinuity)
        assertEquals(25 * NS_PER_SECOND, sourceClock.currentSourceTimestampNs())
    }

    @Test
    fun `large forward seek is treated as discontinuity`() {
        val clock = FakeClock()
        val sourceClock = QrSourceClock(nowNs = { clock.nowNs })
        var discontinuityFired = false
        sourceClock.setOnDiscontinuityListener { _, _ -> discontinuityFired = true }
        sourceClock.onQrTimestamp(sourceTimestampNs = 0L, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        clock.advance(NS_PER_SECOND)
        sourceClock.onQrTimestamp(sourceTimestampNs = 200 * NS_PER_SECOND, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        assertTrue(discontinuityFired)
    }

    @Test
    fun `clock freezes once stale`() {
        val clock = FakeClock()
        val sourceClock = QrSourceClock(nowNs = { clock.nowNs }, staleTimeoutNs = 1_000_000_000L)
        sourceClock.onQrTimestamp(sourceTimestampNs = 0L, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        clock.advance(500_000_000L)
        val beforeStale = sourceClock.currentSourceTimestampNs()
        clock.advance(2_000_000_000L)
        assertEquals(SourceClockState.STALE, sourceClock.state())
        val frozen = sourceClock.currentSourceTimestampNs()
        clock.advance(1_000_000_000L)
        assertEquals(frozen, sourceClock.currentSourceTimestampNs())
        assertTrue(frozen!! > beforeStale!!)
    }

    @Test
    fun `reacquisition after stale re-anchors and resumes`() {
        val clock = FakeClock()
        val sourceClock = QrSourceClock(nowNs = { clock.nowNs }, staleTimeoutNs = 1_000_000_000L)
        sourceClock.onQrTimestamp(sourceTimestampNs = 0L, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        clock.advance(3_000_000_000L)
        assertEquals(SourceClockState.STALE, sourceClock.state())
        sourceClock.onQrTimestamp(sourceTimestampNs = 50 * NS_PER_SECOND, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        assertEquals(SourceClockState.RUNNING, sourceClock.state())
        assertEquals(50 * NS_PER_SECOND, sourceClock.currentSourceTimestampNs())
    }
}
