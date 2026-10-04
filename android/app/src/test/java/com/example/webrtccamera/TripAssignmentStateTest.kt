package com.example.webrtccamera

import org.junit.Assert.*
import org.junit.Test

class TripAssignmentStateTest {
    private fun trip(status: String, id: Long = 1) = DeviceTrip(id, 2, status, "REPLAY_ONLY", "Destination", "fingerprint", "dataset")

    @Test fun `completion and cancellation stop recording and remain until dismissed`() {
        for (status in listOf("COMPLETED", "CANCELLED")) {
            val state = TripAssignmentState()
            state.update(trip("IN_PROGRESS"), -1)
            state.update(trip(status), -1)
            assertNull(state.active)
            assertEquals(status, state.terminal?.status)
            state.update(null, -1)
            assertEquals(status, state.terminal?.status)
            val dismissed = state.dismiss()!!
            assertNull(state.active)
            assertNull(state.terminal)
            // A reconnect must not resurrect the acknowledged final state.
            state.update(trip(status), dismissed.tripId)
            assertNull(state.terminal)
        }
    }

    @Test fun `new assignment replaces undismissed terminal state`() {
        val state = TripAssignmentState()
        state.update(trip("CANCELLED"), -1)
        state.update(trip("READY", 3), -1)
        assertEquals(3L, state.active?.tripId)
        assertNull(state.terminal)
        state.update(trip("IN_PROGRESS", 3), -1)
        assertEquals("IN_PROGRESS", state.active?.status)
    }
}
