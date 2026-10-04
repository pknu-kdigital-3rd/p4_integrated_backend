package com.example.webrtccamera

/** Active recording identity and the terminal state awaiting driver acknowledgement. */
class TripAssignmentState {
    var active: DeviceTrip? = null
    var terminal: DeviceTrip? = null

    fun update(current: DeviceTrip?, dismissedTripId: Long) {
        if (current?.status in listOf("COMPLETED", "CANCELLED")) {
            active = null
            terminal = current?.takeUnless { it.tripId == dismissedTripId }
        } else {
            active = current
            if (current != null) terminal = null
        }
    }

    fun dismiss(): DeviceTrip? = terminal.also { terminal = null }
}
