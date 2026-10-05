package com.example.webrtccamera.telemetry

import com.example.webrtccamera.telemetry.replay.ReplayEndMarkerGate
import org.junit.Assert.*
import org.junit.Test

class ReplayEndMarkerGateTest {
    @Test fun `held marker cannot complete a new trip without timestamps`() {
        val gate = ReplayEndMarkerGate()
        assertFalse(gate.consume(1))
        gate.observeTimestamp(1, 10_000_000_000, 0, 20_000_000_000)
        assertTrue(gate.consume(1))
        assertFalse(gate.consume(1))
        assertFalse(gate.consume(2))
        gate.observeTimestamp(2, 10_000_000_000, 0, 20_000_000_000)
        assertTrue(gate.consume(2))
    }
    @Test fun `wrong dataset or missing assignment disarms marker`() {
        val gate = ReplayEndMarkerGate()
        gate.observeTimestamp(1, 10_000_000_000, 0, 20_000_000_000)
        gate.observeTimestamp(1, 30_000_000_000, 0, 20_000_000_000)
        assertFalse(gate.consume(1))
        gate.observeTimestamp(1, 10_000_000_000, 0, 20_000_000_000)
        gate.observeTimestamp(null, 10_000_000_000, 0, 20_000_000_000)
        assertFalse(gate.consume(1))
    }
    @Test fun `marker must match armed trip and known dataset bounds`() {
        val gate = ReplayEndMarkerGate()
        gate.observeTimestamp(1, 100, null, null)
        assertFalse(gate.consume(1))
        gate.observeTimestamp(1, 100, 0, 200)
        assertFalse(gate.consume(2))
        assertTrue(gate.consume(1))
    }
}
