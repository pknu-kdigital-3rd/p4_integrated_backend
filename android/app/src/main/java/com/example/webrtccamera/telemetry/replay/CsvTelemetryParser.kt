package com.example.webrtccamera.telemetry.replay

import com.example.webrtccamera.telemetry.model.GpsSample
import com.example.webrtccamera.telemetry.model.ImuSample
import java.io.BufferedReader

class CsvParseException(message: String) : Exception(message)

/**
 * Parses the on-device GPS/IMU CSV schema. Columns are resolved by header name (not fixed
 * index) so column order or extra columns in the source export cannot silently corrupt values.
 */
object CsvTelemetryParser {

    private val GPS_REQUIRED_COLUMNS = listOf(
        "timestamp_ns", "latitude", "longitude",
    )
    private val IMU_REQUIRED_COLUMNS = listOf(
        "timestamp_ns", "pitch_deg", "roll_deg", "yaw_deg",
    )

    fun parseGps(reader: BufferedReader): List<GpsSample> {
        val rows = parseRows(reader, GPS_REQUIRED_COLUMNS)
        val samples = ArrayList<GpsSample>(rows.size)
        var previousTimestamp = Long.MIN_VALUE
        for ((lineNumber, columns) in rows) {
            val timestampNs = requireLong(columns, "timestamp_ns", lineNumber)
            if (timestampNs < previousTimestamp) {
                throw CsvParseException("GPS timestamps not ascending at line $lineNumber")
            }
            previousTimestamp = timestampNs
            samples.add(
                GpsSample(
                    timestampNs = timestampNs,
                    utcEpochMs = optionalLong(columns, "utc_epoch_ms"),
                    latitude = requireDouble(columns, "latitude", lineNumber),
                    longitude = requireDouble(columns, "longitude", lineNumber),
                    altitudeM = optionalDouble(columns, "altitude_m"),
                    speedMps = optionalDouble(columns, "speed_mps"),
                    bearingDeg = optionalDouble(columns, "bearing_deg"),
                    horizontalAccuracyM = optionalDouble(columns, "horizontal_accuracy_m"),
                )
            )
        }
        return samples
    }

    fun parseImu(reader: BufferedReader): List<ImuSample> {
        val rows = parseRows(reader, IMU_REQUIRED_COLUMNS)
        val samples = ArrayList<ImuSample>(rows.size)
        var previousTimestamp = Long.MIN_VALUE
        for ((lineNumber, columns) in rows) {
            val timestampNs = requireLong(columns, "timestamp_ns", lineNumber)
            if (timestampNs < previousTimestamp) {
                throw CsvParseException("IMU timestamps not ascending at line $lineNumber")
            }
            previousTimestamp = timestampNs
            samples.add(
                ImuSample(
                    timestampNs = timestampNs,
                    pitchDeg = requireDouble(columns, "pitch_deg", lineNumber),
                    rollDeg = requireDouble(columns, "roll_deg", lineNumber),
                    yawDeg = requireDouble(columns, "yaw_deg", lineNumber),
                    accuracy = optionalInt(columns, "accuracy"),
                )
            )
        }
        return samples
    }

    /** Returns each non-blank data row as a lineNumber (1-based, header is line 1) to column-name→value map. */
    private fun parseRows(
        reader: BufferedReader,
        requiredColumns: List<String>,
    ): List<Pair<Int, Map<String, String>>> {
        val headerLine = reader.readLine()
            ?: throw CsvParseException("CSV file is empty")
        val headers = headerLine.split(",").map { it.trim() }
        val missing = requiredColumns.filter { it !in headers }
        if (missing.isNotEmpty()) {
            throw CsvParseException("CSV missing required columns: ${missing.joinToString()}")
        }

        val rows = ArrayList<Pair<Int, Map<String, String>>>()
        var lineNumber = 1
        reader.forEachLine { line ->
            lineNumber += 1
            if (line.isBlank()) return@forEachLine
            val values = line.split(",")
            if (values.size != headers.size) {
                throw CsvParseException(
                    "Malformed row at line $lineNumber: expected ${headers.size} columns, got ${values.size}"
                )
            }
            val columns = headers.indices.associate { headers[it] to values[it].trim() }
            rows.add(lineNumber to columns)
        }
        return rows
    }

    private fun requireLong(columns: Map<String, String>, name: String, lineNumber: Int): Long =
        columns[name]?.toLongOrNull()
            ?: throw CsvParseException("Invalid or missing '$name' at line $lineNumber")

    private fun requireDouble(columns: Map<String, String>, name: String, lineNumber: Int): Double {
        val value = columns[name]?.toDoubleOrNull()
        if (value == null || !value.isFinite()) {
            throw CsvParseException("Invalid or missing '$name' at line $lineNumber")
        }
        return value
    }

    private fun optionalLong(columns: Map<String, String>, name: String): Long? =
        columns[name]?.takeIf { it.isNotEmpty() }?.toLongOrNull()

    private fun optionalDouble(columns: Map<String, String>, name: String): Double? =
        columns[name]?.takeIf { it.isNotEmpty() }?.toDoubleOrNull()?.takeIf { it.isFinite() }

    private fun optionalInt(columns: Map<String, String>, name: String): Int? =
        columns[name]?.takeIf { it.isNotEmpty() }?.toIntOrNull()
}
