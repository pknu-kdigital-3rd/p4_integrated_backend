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

    @Test
    fun `explicit EOF consumes frozen timestamp tail before completing once`() {
        val batches = java.util.concurrent.CopyOnWriteArrayList<TelemetryBatch>()
        val completions = java.util.concurrent.CopyOnWriteArrayList<StreamSessionContext>()
        val completed = java.util.concurrent.CountDownLatch(1)
        val clock = QrSourceClock(nowNs = { 0L })
        clock.onQrTimestamp(1_000_000_000L, 0, 0)
        val scheduler = TelemetryReplayScheduler(
            TelemetryDataset("d", gps = listOf(gps(1_000_000_000L), gps(4_621_722_612L)), imu = emptyList()),
            clock, SESSION, onBatchReady = { batches.add(it) },
            onGpsReplayComplete = {
                assertEquals(4_621_722_612L, batches.flatMap { b -> b.gps }.last().timestampNs)
                completions.add(it)
                completed.countDown()
            }, elapsedMillis = { 0L })
        try {
            scheduler.start()
            scheduler.onReplayEndMarker(999L) // Wrong trip cannot finish the active session.
            val checked = java.util.concurrent.CountDownLatch(1)
            scheduler.updateSessionContext(SESSION) { checked.countDown() }
            assertTrue(checked.await(2, java.util.concurrent.TimeUnit.SECONDS))
            assertTrue(completions.isEmpty())
            scheduler.onReplayEndMarker(SESSION.tripId!!)
            assertTrue(completed.await(2, java.util.concurrent.TimeUnit.SECONDS))
            scheduler.onReplayEndMarker(SESSION.tripId!!)
            val drained = java.util.concurrent.CountDownLatch(1)
            scheduler.updateSessionContext(SESSION) { drained.countDown() }
            assertTrue(drained.await(2, java.util.concurrent.TimeUnit.SECONDS))
            assertEquals(listOf(SESSION), completions)
            assertEquals(listOf(1_000_000_000L, 4_621_722_612L),
                batches.flatMap { it.gps }.map { it.timestampNs }.distinct())
            assertEquals(2L, scheduler.gpsSentCount.get())
        } finally { scheduler.stop() }
    }

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
    fun `wrap between ticks flushes the final gps before resetting cursors`() {
        val second = 1_000_000_000L
        var nowNs = 0L
        val clock = QrSourceClock(nowNs = { nowNs })
        val batches = mutableListOf<TelemetryBatch>()
        val completions = mutableListOf<StreamSessionContext>()
        val scheduler = TelemetryReplayScheduler(
            TelemetryDataset("d", gps = listOf(gps(0), gps(9_900_000_000L)), imu = listOf(imu(12 * second))),
            clock, SESSION, onBatchReady = { batches.add(it) },
            onGpsReplayComplete = { completions.add(it) }, elapsedMillis = { nowNs / 1_000_000 })
        clock.onQrTimestamp(9_700_000_000L, 0, 0)
        scheduler.testResync(9_700_000_000L)
        scheduler.advanceCursors(9_700_000_000L, 0)
        assertTrue(completions.isEmpty())
        // The footage loops before another scheduled tick can consume the final fix.
        nowNs = 400_000_000L
        clock.onQrTimestamp(0, 0, 0)
        assertEquals(listOf(SESSION), completions)
        assertEquals(listOf(0L, 9_900_000_000L), batches.flatMap { it.gps }.map { it.timestampNs })
        assertEquals(0, scheduler.nextGpsIndex)
        scheduler.advanceCursors(10 * second, 500)
        assertEquals(1, completions.size)
        scheduler.stop()
    }

    @Test
    fun `rewinding in the middle does not complete a trip`() {
        val second = 1_000_000_000L
        var nowNs = 0L
        val clock = QrSourceClock(nowNs = { nowNs })
        val completions = mutableListOf<StreamSessionContext>()
        val scheduler = TelemetryReplayScheduler(
            TelemetryDataset("d", gps = listOf(gps(0), gps(20 * second)), imu = emptyList()),
            clock, SESSION, onBatchReady = {}, onGpsReplayComplete = { completions.add(it) },
            elapsedMillis = { nowNs / 1_000_000 })
        clock.onQrTimestamp(10 * second, 0, 0)
        scheduler.testResync(10 * second)
        nowNs = 100_000_000L
        clock.onQrTimestamp(0, 0, 0)
        assertTrue(completions.isEmpty())
        scheduler.stop()
    }

    @Test
    fun `gps endpoint completes once before imu end and before wrap`() {
        val dataset = TelemetryDataset("d", gps = listOf(gps(100), gps(200)), imu = listOf(imu(300)))
        val batches = mutableListOf<TelemetryBatch>()
        val completed = mutableListOf<StreamSessionContext>()
        val scheduler = TelemetryReplayScheduler(dataset, QrSourceClock(), SESSION,
            onBatchReady = { batches.add(it) },
            onGpsReplayComplete = {
                assertEquals(200L, batches.flatMap { batch -> batch.gps }.last().timestampNs)
                completed.add(it)
            }, elapsedMillis = { 0L })
        scheduler.testResync(0)
        scheduler.advanceCursors(199, 0)
        assertTrue(completed.isEmpty())
        scheduler.advanceCursors(200, 1)
        assertEquals(listOf(SESSION), completed)
        assertEquals(0, scheduler.nextImuIndex)
        scheduler.advanceCursors(300, 2)
        scheduler.testResync(0) // Wrapping must not complete the same trip again.
        scheduler.advanceCursors(200, 3)
        assertEquals(1, completed.size)
        scheduler.stop()
    }

    @Test
    fun `tripless replay does not request completion`() {
        val completed = mutableListOf<StreamSessionContext>()
        val scheduler = TelemetryReplayScheduler(
            TelemetryDataset("d", gps = listOf(gps(100)), imu = emptyList()), QrSourceClock(),
            SESSION.copy(tripId = null), onBatchReady = {},
            onGpsReplayComplete = { completed.add(it) }, elapsedMillis = { 0L })
        scheduler.testResync(0)
        scheduler.advanceCursors(100, 0)
        assertTrue(completed.isEmpty())
        scheduler.stop()
    }

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

    @Test
    fun `gps backlog is split into batches of at most 16 fixes`() {
        val dataset = TelemetryDataset("d", gps = (0L..300L).map { gps(it) }, imu = emptyList())
        val batches = mutableListOf<TelemetryBatch>()
        val scheduler = newScheduler(dataset, batches)
        scheduler.testResync(0L)

        scheduler.advanceCursors(sourceNow = 300L, nowMs = 100L)

        assertTrue(batches.all { it.gps.size <= TelemetryReplayScheduler.MAX_GPS_PER_BATCH })
        assertEquals((0L..300L).toList(), batches.flatMap { it.gps }.map { it.timestampNs })
    }

    @Test
    fun `first qr anchor mid-footage positions replay instead of releasing the backlog`() {
        val second = 1_000_000_000L
        val dataset = TelemetryDataset(
            "d",
            gps = (0L..300L).map { gps(it * second) },
            imu = (0L..3000L).map { imu(it * second / 10) },
        )
        val batches = java.util.Collections.synchronizedList(mutableListOf<TelemetryBatch>())
        val flushClockMs = java.util.concurrent.atomic.AtomicLong(0L)
        // A frozen QR clock keeps the source time exactly at the anchor; the flush clock
        // advances so pending samples are still flushed.
        val scheduler = TelemetryReplayScheduler(
            dataset = dataset,
            sourceClock = QrSourceClock(nowNs = { 0L }),
            sessionContext = SESSION,
            onBatchReady = { batches.add(it) },
            elapsedMillis = { flushClockMs.addAndGet(50L) },
        )
        scheduler.start() // before any QR: the source position is unknown
        scheduler.onQrTimestamp(sourceTimestampNs = 250 * second, captureTimestampNs = 0L, decodeLatencyMs = 0L)
        val deadline = System.currentTimeMillis() + 2_000
        while (batches.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(10)
        Thread.sleep(100)
        scheduler.stop()

        val gpsSent = batches.flatMap { it.gps }.map { it.timestampNs / second }
        val imuSent = batches.flatMap { it.imu }.map { it.timestampNs }
        // Before the anchor the dataset start point is held; after it, only the anchor fix is
        // replayed (and held while the frozen clock stands still). Nothing in between is sent.
        assertEquals("the backlog before the anchor must not be released", setOf(0L, 250L), gpsSent.toSet())
        assertTrue("the anchor fix restores the position", 250L in gpsSent)
        assertEquals(listOf(250 * second), imuSent)
    }

    @Test
    fun `holds the dataset start point before any gps fix is due`() {
        val dataset = TelemetryDataset("d", gps = listOf(gps(1000), gps(2000)), imu = listOf(imu(100)))
        val batches = mutableListOf<TelemetryBatch>()
        val scheduler = newScheduler(dataset, batches)

        scheduler.holdPosition(sourceNow = null, nowMs = 0L)

        assertEquals(listOf(1000L), batches.flatMap { it.gps }.map { it.timestampNs })
        assertEquals(1000L, batches.single().sourceClockNs)
    }

    @Test
    fun `holds at most once per interval and resends the last replayed fix`() {
        val dataset = TelemetryDataset("d", gps = listOf(gps(100), gps(200)), imu = emptyList())
        val batches = mutableListOf<TelemetryBatch>()
        val scheduler = newScheduler(dataset, batches)
        scheduler.testResync(0L)
        scheduler.advanceCursors(sourceNow = 150L, nowMs = 100L)
        batches.clear()

        scheduler.holdPosition(sourceNow = 150L, nowMs = 100L + TelemetryReplayScheduler.HOLD_INTERVAL_MS - 1)
        assertTrue("a fix was just replayed, so nothing is held yet", batches.isEmpty())

        scheduler.holdPosition(sourceNow = 150L, nowMs = 100L + TelemetryReplayScheduler.HOLD_INTERVAL_MS)
        assertEquals(listOf(100L), batches.flatMap { it.gps }.map { it.timestampNs })
    }

    @Test
    fun `holding never advances replay cursors`() {
        val dataset = TelemetryDataset("d", gps = listOf(gps(100), gps(200)), imu = emptyList())
        val batches = mutableListOf<TelemetryBatch>()
        val scheduler = newScheduler(dataset, batches)
        scheduler.testResync(0L)

        scheduler.holdPosition(sourceNow = 50L, nowMs = 0L)
        scheduler.advanceCursors(sourceNow = 200L, nowMs = 100L)

        assertEquals(listOf(100L, 100L, 200L), batches.flatMap { it.gps }.map { it.timestampNs })
    }


    @Test
    fun `trip switch flushes old samples first, then announces, then relabels`() {
        val dataset = TelemetryDataset("d", gps = listOf(gps(100), gps(200)), imu = emptyList())
        val events = java.util.Collections.synchronizedList(mutableListOf<String>())
        val scheduler = TelemetryReplayScheduler(
            dataset = dataset,
            sourceClock = QrSourceClock(nowNs = { 0L }),
            sessionContext = SESSION,
            onBatchReady = { batch -> events.add("batch:${batch.recordingSessionId}:${batch.gps.map { it.timestampNs }}") },
            elapsedMillis = { 0L },
        )
        scheduler.testResync(0L)
        // Due but not yet flushed: the flush interval has not elapsed on this frozen clock.
        scheduler.advanceCursors(sourceNow = 100L, nowMs = 0L)
        assertTrue(events.isEmpty())

        val announced = java.util.concurrent.CountDownLatch(1)
        val next = StreamSessionContext(9L, 2L, "trip-session", TelemetryMode.REPLAY)
        scheduler.updateSessionContext(next) { events.add("announce"); announced.countDown() }
        assertTrue(announced.await(2, java.util.concurrent.TimeUnit.SECONDS))
        Thread.sleep(50) // let the context swap that follows the announcement run
        scheduler.advanceCursors(sourceNow = 200L, nowMs = 1_000L)
        scheduler.stop()

        assertEquals(listOf("batch:session:[100]", "announce", "batch:trip-session:[200]"), events.toList())
    }

}
