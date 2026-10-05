package com.example.webrtccamera.telemetry.replay

/** An EOF QR is only valid after this trip has observed its own dataset's timestamps. */
class ReplayEndMarkerGate {
    private var armedTripId: Long? = null
    private var completedTripId: Long? = null

    fun observeTimestamp(tripId: Long?, sourceNs: Long, startNs: Long?, endNs: Long?) {
        armedTripId = tripId?.takeIf {
            startNs != null && endNs != null && sourceNs >= startNs - 1_000_000_000L && sourceNs <= endNs + 1_000_000_000L
        }
    }

    fun consume(tripId: Long?): Boolean {
        if (tripId == null || tripId != armedTripId || tripId == completedTripId) return false
        completedTripId = tripId
        armedTripId = null
        return true
    }

    companion object { const val PAYLOAD = "P4_REPLAY_END_V1" }
}
