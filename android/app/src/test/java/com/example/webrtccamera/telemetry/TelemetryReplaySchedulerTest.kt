package com.example.webrtccamera.telemetry

import com.example.webrtccamera.telemetry.model.GpsSample
import com.example.webrtccamera.telemetry.model.ImuSample
import com.example.webrtccamera.telemetry.model.StreamSessionContext
import com.example.webrtccamera.telemetry.model.TelemetryBatch
import com.example.webrtccamera.telemetry.model.TelemetryDataset
import com.example.webrtccamera.telemetry.model.TelemetryMode
import com.example.webrtccamera.telemetry.replay.QrSourceClock
import com.example.webrtccamera.telemetry.replay.TelemetryReplayScheduler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private fun gps(ts: Long) = GpsSample(ts, null, 0.0, 0.0, null, null, null, null)
private fun imu(ts: Long) = ImuSample(ts, 0.0, 0.0, 0.0, null)

private val SESSION = StreamSessionContext(1L, 2L, "session", TelemetryMode.REPLAY)

class TelemetryReplaySchedulerTest {

    private fun newScheduler(
        dataset: TelemetryDataset,
        batches: MutableList<TelemetryBatch>,
    ): TelemetryReplayScheduler =
        TelemetryReplayScheduler(
            dataset = dataset,
            sourceClock = QrSourceClock(),
            sessionContext = SESSION,
            onBatchReady = { batches.add(it) },
            elapsedMillis = { 0L },
        )

    @Test
    fun `each sample emitted once during normal progression`() {
        val dataset = TelemetryDataset(
            "d",
            gps = listOf(gps(100), gps(200), gps(300)),
            imu = listOf(imu(100), imu(150), imu(200), imu(250), imu(300)),
        )
        val batches = mutableListOf<TelemetryBatch>()
        val scheduler = newScheduler(dataset, batches)
        scheduler.testResync(0L)

        scheduler.advanceCursors(sourceNow = 150L, nowMs = 0L)
        scheduler.advanceCursors(sourceNow = 300L, nowMs = 100L)

        val allGps = batches.flatMap { it.gps }
        val allImu = batches.flatMap { it.imu }
        assertEquals(listOf(100L, 200L, 300L), allGps.map { it.timestampNs })
        assertEquals(listOf(100L, 150L, 200L, 250L, 300L), allImu.map { it.timestampNs })
    }

    @Test
    fun `no future sample is emitted early`() {
        val dataset = TelemetryDataset("d", gps = listOf(gps(100), gps(200)), imu = listOf(imu(100), imu(200)))
        val batches = mutableListOf<TelemetryBatch>()
        val scheduler = newScheduler(dataset, batches)
        scheduler.testResync(0L)

        scheduler.advanceCursors(sourceNow = 150L, nowMs = 100L)

        val allGps = batches.flatMap { it.gps }
        val allImu = batches.flatMap { it.imu }
        assertEquals(listOf(100L), allGps.map { it.timestampNs })
        assertEquals(listOf(100L), allImu.map { it.timestampNs })
    }

    @Test
    fun `start before first gps fix works correctly`() {
        val dataset = TelemetryDataset("d", gps = listOf(gps(1000)), imu = listOf(imu(100), imu(200)))
        val batches = mutableListOf<TelemetryBatch>()
        val scheduler = newScheduler(dataset, batches)
        scheduler.testResync(0L)

        scheduler.advanceCursors(sourceNow = 200L, nowMs = 100L)

        val allGps = batches.flatMap { it.gps }
        val allImu = batches.flatMap { it.imu }
        assertTrue(allGps.isEmpty())
        assertEquals(listOf(100L, 200L), allImu.map { it.timestampNs })
    }

    @Test
    fun `resync repositions cursors without replaying skipped samples`() {
        val dataset = TelemetryDataset(
            "d",
            gps = listOf(gps(0), gps(100), gps(200), gps(300)),
            imu = listOf(imu(0), imu(100), imu(200), imu(300)),
        )
        val batches = mutableListOf<TelemetryBatch>()
        val scheduler = newScheduler(dataset, batches)
        scheduler.testResync(0L)
        scheduler.advanceCursors(sourceNow = 50L, nowMs = 0L)

        // Simulate a large forward seek: reposition to timestamp 300 directly.
        scheduler.testResync(300L)
        scheduler.advanceCursors(sourceNow = 300L, nowMs = 100L)

        val allGps = batches.flatMap { it.gps }.map { it.timestampNs }
        val allImu = batches.flatMap { it.imu }.map { it.timestampNs }
        assertTrue(100L !in allGps)
        assertTrue(200L !in allGps)
        assertTrue(300L in allGps)
        assertTrue(100L !in allImu)
        assertTrue(200L !in allImu)
        assertTrue(300L in allImu)
    }

    @Test
    fun `gps and imu cursors are independent`() {
        val dataset = TelemetryDataset(
            "d",
            gps = listOf(gps(1000)),
            imu = listOf(imu(100), imu(200), imu(300), imu(400)),
        )
        val batches = mutableListOf<TelemetryBatch>()
        val scheduler = newScheduler(dataset, batches)
        scheduler.testResync(0L)

        scheduler.advanceCursors(sourceNow = 250L, nowMs = 0L)
        assertEquals(2, scheduler.nextImuIndex)
        assertEquals(0, scheduler.nextGpsIndex)
    }

    @Test
    fun `timestamps are unchanged through the batch`() {
        val dataset = TelemetryDataset("d", gps = listOf(gps(12345L)), imu = listOf(imu(6789L)))
        val batches = mutableListOf<TelemetryBatch>()
        val scheduler = newScheduler(dataset, batches)
        scheduler.testResync(0L)

        scheduler.advanceCursors(sourceNow = 12345L, nowMs = 0L)

        assertEquals(12345L, batches.flatMap { it.gps }.single().timestampNs)
        assertEquals(6789L, batches.flatMap { it.imu }.single().timestampNs)
    }
}
