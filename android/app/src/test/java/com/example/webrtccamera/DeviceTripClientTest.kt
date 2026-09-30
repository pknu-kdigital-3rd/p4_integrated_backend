package com.example.webrtccamera

import com.example.webrtccamera.telemetry.model.GpsSample
import org.junit.Assert.assertEquals
import org.junit.Test

private fun fix(timestampNs: Long, accuracyM: Double?) =
    GpsSample(timestampNs, null, 35.0, 129.0, null, null, null, accuracyM)

class DeviceTripClientTest {

    @Test
    fun `preview leaves out tunnel fixes with hundreds of metres of accuracy`() {
        val gps = listOf(fix(1, 5.0), fix(2, 16.3), fix(3, 402.1), fix(4, 300.0), fix(5, 22.0), fix(6, null))
        assertEquals(listOf(1L, 2L, 5L, 6L), DeviceTripClient.previewFixes(gps).map { it.timestampNs })
    }

    @Test
    fun `preview keeps every fix when too few accurate ones remain`() {
        val gps = listOf(fix(1, 5.0), fix(2, 300.0), fix(3, 300.0))
        assertEquals(gps, DeviceTripClient.previewFixes(gps))
    }
}
