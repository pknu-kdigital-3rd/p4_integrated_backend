package com.example.webrtccamera.telemetry.model

enum class TelemetryMode {
    REPLAY,
    LIVE,
}

/**
 * Identifies one streaming/footage attempt. A new local dataset selection or a manual
 * stop+start creates a new [recordingSessionId]; a WebRTC-internal reconnect must reuse the
 * same context so the server sees one continuous recording session.
 */
data class StreamSessionContext(
    val tripId: Long,
    val vehicleId: Long,
    val recordingSessionId: String,
    val telemetryMode: TelemetryMode,
)
