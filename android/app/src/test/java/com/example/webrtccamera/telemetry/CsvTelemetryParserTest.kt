package com.example.webrtccamera.telemetry

import com.example.webrtccamera.telemetry.replay.CsvParseException
import com.example.webrtccamera.telemetry.replay.CsvTelemetryParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.BufferedReader
import java.io.StringReader

private fun reader(text: String): BufferedReader = BufferedReader(StringReader(text))

class CsvTelemetryParserTest {

    @Test
    fun `parses valid gps csv`() {
        val csv = """
            timestamp_ns,utc_epoch_ms,latitude,longitude,altitude_m,speed_mps,bearing_deg,horizontal_accuracy_m
            100,1000,35.1,129.1,47.3,0.7,89.9,22.7
            200,1100,35.2,129.2,47.4,0.8,90.0,22.8
        """.trimIndent()
        val samples = CsvTelemetryParser.parseGps(reader(csv))
        assertEquals(2, samples.size)
        assertEquals(100L, samples[0].timestampNs)
        assertEquals(35.1, samples[0].latitude, 0.0)
        assertEquals(1000L, samples[0].utcEpochMs)
    }

    @Test
    fun `parses valid imu csv`() {
        val csv = """
            timestamp_ns,pitch_deg,roll_deg,yaw_deg,accuracy
            100,-3.7,-92.8,-30.7,3
            200,-3.8,-92.9,-30.6,3
        """.trimIndent()
        val samples = CsvTelemetryParser.parseImu(reader(csv))
        assertEquals(2, samples.size)
        assertEquals(3, samples[0].accuracy)
    }

    @Test
    fun `missing required header throws`() {
        val csv = """
            timestamp_ns,latitude
            100,35.1
        """.trimIndent()
        assertThrows(CsvParseException::class.java) { CsvTelemetryParser.parseGps(reader(csv)) }
    }

    @Test
    fun `malformed timestamp throws`() {
        val csv = """
            timestamp_ns,latitude,longitude
            not-a-number,35.1,129.1
        """.trimIndent()
        assertThrows(CsvParseException::class.java) { CsvTelemetryParser.parseGps(reader(csv)) }
    }

    @Test
    fun `blank lines are skipped`() {
        val csv = "timestamp_ns,latitude,longitude\n100,35.1,129.1\n\n200,35.2,129.2\n"
        val samples = CsvTelemetryParser.parseGps(reader(csv))
        assertEquals(2, samples.size)
    }

    @Test
    fun `optional numeric field can be blank`() {
        val csv = """
            timestamp_ns,latitude,longitude,altitude_m
            100,35.1,129.1,
        """.trimIndent()
        val samples = CsvTelemetryParser.parseGps(reader(csv))
        assertNull(samples[0].altitudeM)
    }

    @Test
    fun `unsorted timestamps throw`() {
        val csv = """
            timestamp_ns,latitude,longitude
            200,35.1,129.1
            100,35.2,129.2
        """.trimIndent()
        assertThrows(CsvParseException::class.java) { CsvTelemetryParser.parseGps(reader(csv)) }
    }

    @Test
    fun `empty file throws`() {
        assertThrows(CsvParseException::class.java) { CsvTelemetryParser.parseGps(reader("")) }
    }

    @Test
    fun `timestamps larger than 32-bit range parse correctly`() {
        val csv = """
            timestamp_ns,latitude,longitude
            1445671933514811,35.1,129.1
        """.trimIndent()
        val samples = CsvTelemetryParser.parseGps(reader(csv))
        assertEquals(1445671933514811L, samples[0].timestampNs)
    }
}
