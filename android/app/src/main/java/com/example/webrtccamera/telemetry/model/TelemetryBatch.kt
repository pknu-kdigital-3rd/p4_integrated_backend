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

    private fun toJson(): JSONObject {
        val gpsArray = JSONArray()
        gps.forEach { sample ->
            gpsArray.put(
                JSONObject()
                    .put("timestamp_ns", sample.timestampNs)
                    .put("utc_epoch_ms", sample.utcEpochMs?.let { it } ?: JSONObject.NULL)
                    .put("latitude", sample.latitude)
                    .put("longitude", sample.longitude)
                    .put("altitude_m", sample.altitudeM ?: JSONObject.NULL)
                    .put("speed_mps", sample.speedMps ?: JSONObject.NULL)
                    .put("bearing_deg", sample.bearingDeg ?: JSONObject.NULL)
                    .put("horizontal_accuracy_m", sample.horizontalAccuracyM ?: JSONObject.NULL)
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
            .put("mode", mode.name)
            .put("trip_id", tripId.toString())
            .put("vehicle_id", vehicleId.toString())
            .put("recording_session_id", recordingSessionId)
            .put("source_clock_ns", sourceClockNs)
            .put("gps", gpsArray)
            .put("imu", imuArray)
    }
}
