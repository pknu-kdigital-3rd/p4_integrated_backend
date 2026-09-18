package com.example.webrtccamera.telemetry.model

/**
 * A source of normalized telemetry samples/batches. [CsvReplayTelemetrySource] implements this
 * today; a future `AndroidLiveTelemetrySource` backed by FusedLocationProvider/SensorManager can
 * implement the same interface without changing the transport or server.
 */
interface TelemetrySource {
    fun start()
    fun stop()
}

/** Where a [TelemetrySource] hands off batches for network transport. */
fun interface TelemetryBatchSender {
    fun sendTelemetryBatch(batch: TelemetryBatch)
}
