package com.example.webrtccamera.telemetry.model

data class ImuSample(
    val timestampNs: Long,
    val pitchDeg: Double,
    val rollDeg: Double,
    val yawDeg: Double,
    val accuracy: Int?,
)
