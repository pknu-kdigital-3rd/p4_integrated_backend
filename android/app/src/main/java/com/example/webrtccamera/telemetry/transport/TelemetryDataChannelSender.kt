package com.example.webrtccamera.telemetry.transport

import com.example.webrtccamera.WebRtcPublisher
import com.example.webrtccamera.telemetry.model.TelemetryBatch
import com.example.webrtccamera.telemetry.model.TelemetryBatchSender

/**
 * Adapts [WebRtcPublisher]'s `telemetry-events` DataChannel to [TelemetryBatchSender], so
 * [com.example.webrtccamera.telemetry.replay.CsvReplayTelemetrySource] depends only on the
 * narrow sending contract and not on WebRtcPublisher/WebRTC directly - the same contract a
 * future live sensor source would use.
 */
class TelemetryDataChannelSender(private val publisher: WebRtcPublisher) : TelemetryBatchSender {
    override fun sendTelemetryBatch(batch: TelemetryBatch) {
        publisher.sendTelemetryBatch(batch)
    }
}
