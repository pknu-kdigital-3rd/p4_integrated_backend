package com.example.webrtccamera.telemetry.model

/** A parsed, validated GPS+IMU pair for one footage/session. Owned entirely by the device. */
data class TelemetryDataset(
    val displayName: String,
    val gps: List<GpsSample>,
    val imu: List<ImuSample>,
) {
    val gpsStartNs: Long? = gps.firstOrNull()?.timestampNs
    val gpsEndNs: Long? = gps.lastOrNull()?.timestampNs
    val imuStartNs: Long? = imu.firstOrNull()?.timestampNs
    val imuEndNs: Long? = imu.lastOrNull()?.timestampNs
}
