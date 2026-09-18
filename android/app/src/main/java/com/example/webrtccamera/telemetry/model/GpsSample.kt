package com.example.webrtccamera.telemetry.model

data class GpsSample(
    val timestampNs: Long,
    val utcEpochMs: Long?,
    val latitude: Double,
    val longitude: Double,
    val altitudeM: Double?,
    val speedMps: Double?,
    val bearingDeg: Double?,
    val horizontalAccuracyM: Double?,
)
