package com.example.webrtccamera.telemetry.model

import org.json.JSONArray
import org.json.JSONObject

/**
 * One outbound telemetry-events message. Batches network transport of individually-timestamped
 * samples; each sample keeps its original CSV `timestamp_ns` regardless of batching.
 */
data class TelemetryBatch(
    val mode: TelemetryMode,
    val tripId: Long,
    val vehicleId: Long,
    val recordingSessionId: String,
    val sourceClockNs: Long,
    val gps: List<GpsSample> = emptyList(),
    val imu: List<ImuSample> = emptyList(),
) {
    val isEmpty: Boolean get() = gps.isEmpty() && imu.isEmpty()

    fun toJsonBytes(): ByteArray = toJson().toString().toByteArray(Charsets.UTF_8)

    /**
     * Encodes this batch as one or more DataChannel messages that each fit the relay's limits.
     * The relay's WebRTC stack reads messages into a 65,535-byte buffer and closes the whole
     * channel on a larger one, and rejects batches over its per-message sample counts, so an
     * oversized batch is split in half (recursively) rather than sent. Samples are only
     * regrouped; their timestamps are unchanged.
     */
    fun toJsonMessages(maxBytes: Int = MAX_MESSAGE_BYTES): List<ByteArray> {
        if (isEmpty) return emptyList()
        val bytes = toJsonBytes()
        val withinLimits = bytes.size <= maxBytes && gps.size <= MAX_GPS_PER_MESSAGE && imu.size <= MAX_IMU_PER_MESSAGE
        if (withinLimits || gps.size + imu.size <= 1) return listOf(bytes)
        val (first, second) = split()
        return first.toJsonMessages(maxBytes) + second.toJsonMessages(maxBytes)
    }

    private fun split(): Pair<TelemetryBatch, TelemetryBatch> =
        if (gps.size >= 2 || imu.size >= 2) {
            copy(gps = gps.take(gps.size / 2), imu = imu.take(imu.size / 2)) to
                copy(gps = gps.drop(gps.size / 2), imu = imu.drop(imu.size / 2))
        } else {
            copy(imu = emptyList()) to copy(gps = emptyList())
        }

    private fun toJson(): JSONObject {
        val gpsArray = JSONArray()
        gps.forEach { sample ->
            gpsArray.put(
                JSONObject()
                    .put("timestamp_ns", sample.timestampNs)
                    .put("utc_epoch_ms", sample.utcEpochMs?.let { it } ?: JSONObject.NULL)
                    .put("latitude", sample.latitude)
                    .put("longitude", sample.longitude)
                    .put("altitude_m", sample.altitudeM?.takeIf { it.isFinite() } ?: JSONObject.NULL)
                    .put("speed_mps", sample.speedMps?.takeIf { it.isFinite() } ?: JSONObject.NULL)
                    .put("bearing_deg", sample.bearingDeg?.takeIf { it.isFinite() } ?: JSONObject.NULL)
                    .put(
                        "horizontal_accuracy_m",
                        sample.horizontalAccuracyM?.takeIf { it.isFinite() } ?: JSONObject.NULL
                    )
            )
        }
        val imuArray = JSONArray()
        imu.forEach { sample ->
            imuArray.put(
                JSONObject()
                    .put("timestamp_ns", sample.timestampNs)
                    .put("pitch_deg", sample.pitchDeg)
                    .put("roll_deg", sample.rollDeg)
                    .put("yaw_deg", sample.yawDeg)
                    .put("accuracy", sample.accuracy ?: JSONObject.NULL)
            )
        }
        return JSONObject()
            .put("type", "telemetry_batch")
            .put("version", PROTOCOL_VERSION)
            .put("mode", mode.name)
            .put("trip_id", tripId.toString())
            .put("vehicle_id", vehicleId.toString())
            .put("recording_session_id", recordingSessionId)
            .put("source_clock_ns", sourceClockNs)
            .put("gps", gpsArray)
            .put("imu", imuArray)
    }

    companion object {
        const val PROTOCOL_VERSION = 1
        // Headroom below the relay's 65,535-byte DataChannel read buffer and 64 KiB cap.
        const val MAX_MESSAGE_BYTES = 60_000
        // Relay limits per telemetry-events message.
        const val MAX_GPS_PER_MESSAGE = 16
        const val MAX_IMU_PER_MESSAGE = 64
    }
}
