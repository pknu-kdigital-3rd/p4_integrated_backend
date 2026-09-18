package com.example.webrtccamera.telemetry

import com.example.webrtccamera.telemetry.model.GpsSample
import com.example.webrtccamera.telemetry.model.ImuSample
import com.example.webrtccamera.telemetry.model.TelemetryBatch
import com.example.webrtccamera.telemetry.model.TelemetryMode
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TelemetryBatchTest {

    private val gpsSample = GpsSample(100L, 1000L, 35.1, 129.1, 47.3, 0.7, 89.9, 22.7)
    private val imuSample = ImuSample(200L, -3.7, -92.8, -30.7, 3)

    @Test
    fun `serialized batch contains all required top-level fields`() {
        val batch = TelemetryBatch(
            mode = TelemetryMode.REPLAY,
            tripId = 12L,
            vehicleId = 4L,
            recordingSessionId = "session-1",
            sourceClockNs = 500L,
            gps = listOf(gpsSample),
            imu = listOf(imuSample),
        )
        val json = JSONObject(String(batch.toJsonBytes()))
        assertEquals("telemetry_batch", json.getString("type"))
        assertEquals("REPLAY", json.getString("mode"))
        assertEquals("12", json.getString("trip_id"))
        assertEquals("4", json.getString("vehicle_id"))
        assertEquals("session-1", json.getString("recording_session_id"))
        assertEquals(500L, json.getLong("source_clock_ns"))
        assertEquals(1, json.getJSONArray("gps").length())
        assertEquals(1, json.getJSONArray("imu").length())
        assertEquals(100L, json.getJSONArray("gps").getJSONObject(0).getLong("timestamp_ns"))
        assertEquals(200L, json.getJSONArray("imu").getJSONObject(0).getLong("timestamp_ns"))
    }

    @Test
    fun `gps-only batch is not empty`() {
        val batch = TelemetryBatch(TelemetryMode.REPLAY, 1L, 1L, "s", 0L, gps = listOf(gpsSample))
        assertFalse(batch.isEmpty)
    }

    @Test
    fun `imu-only batch is not empty`() {
        val batch = TelemetryBatch(TelemetryMode.REPLAY, 1L, 1L, "s", 0L, imu = listOf(imuSample))
        assertFalse(batch.isEmpty)
    }

    @Test
    fun `empty batch is marked empty`() {
        val batch = TelemetryBatch(TelemetryMode.REPLAY, 1L, 1L, "s", 0L)
        assertTrue(batch.isEmpty)
    }
}
