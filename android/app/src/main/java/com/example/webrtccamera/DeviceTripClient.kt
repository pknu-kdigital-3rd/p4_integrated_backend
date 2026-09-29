package com.example.webrtccamera

import com.example.webrtccamera.telemetry.model.TelemetryDataset
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.security.MessageDigest
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

data class DeviceTrip(
    val tripId: Long,
    val vehicleId: Long,
    val status: String,
    val routeMode: String,
    val destinationName: String,
    val fingerprint: String?,
    val datasetName: String?,
)

/** The Android-facing nginx port forwards only /api/v1/device to Node. */
class DeviceTripClient(serverUrl: String) {
    private val http = sharedHttp
    private val base = serverUrl.trim().trimEnd('/').removeSuffix("/offer/android")
    private val jsonType = "application/json".toMediaType()

    private fun call(path: String, method: String = "GET", body: JSONObject? = null): JSONObject? {
        val url = "$base/api/v1/device$path"
        val request = Request.Builder().url(url).apply {
            when (method) {
                "PUT" -> put((body ?: JSONObject()).toString().toRequestBody(jsonType))
                "POST" -> post((body ?: JSONObject()).toString().toRequestBody(jsonType))
            }
        }.build()
        http.newCall(request).execute().use { response ->
            val payload = JSONObject(response.body?.string() ?: "{}")
            if (!response.isSuccessful) {
                throw IllegalStateException(payload.optJSONObject("error")?.optString("message") ?: "HTTP ${response.code}")
            }
            return payload.optJSONObject("data")
        }
    }

    fun current(vehicleId: Long): DeviceTrip? = call("/vehicles/$vehicleId/trip")?.let(::parseTrip)

    fun change(vehicleId: Long, tripId: Long, action: String, fingerprint: String?): DeviceTrip {
        val body = JSONObject().apply { if (fingerprint != null) put("fingerprint", fingerprint) }
        val data = call("/vehicles/$vehicleId/trips/$tripId/$action", "POST", body)
            ?: throw IllegalStateException("Empty trip response")
        return parseTrip(data)
    }

    fun uploadPreview(vehicleId: Long, dataset: TelemetryDataset): String {
        val gps = dataset.gps
        if (gps.size < 2) throw IllegalStateException("GPS dataset needs at least two fixes")
        val digest = MessageDigest.getInstance("SHA-256")
        var distance = 0.0
        val distances = DoubleArray(gps.size)
        gps.forEachIndexed { index, fix ->
            digest.update(ByteBuffer.allocate(24).putLong(fix.timestampNs).putDouble(fix.latitude).putDouble(fix.longitude).array())
            if (index > 0) {
                val previous = gps[index - 1]
                val dLat = Math.toRadians(fix.latitude - previous.latitude)
                val dLon = Math.toRadians(fix.longitude - previous.longitude)
                val a = sin(dLat / 2).let { it * it } + cos(Math.toRadians(previous.latitude)) *
                    cos(Math.toRadians(fix.latitude)) * sin(dLon / 2).let { it * it }
                distance += 2 * 6371000 * asin(min(1.0, sqrt(a)))
            }
            distances[index] = distance
        }
        val fingerprint = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val points = JSONArray()
        val count = min(gps.size, 1500)
        for (slot in 0 until count) {
            val index = if (slot == count - 1) gps.lastIndex.toLong() else slot.toLong() * gps.lastIndex / (count - 1).toLong()
            val fix = gps[index.toInt()]
            points.put(JSONArray().put(fix.timestampNs.toString()).put(fix.longitude).put(fix.latitude).put(distances[index.toInt()]))
        }
        val payload = JSONObject().put("fingerprint", fingerprint)
            .put("datasetName", dataset.displayName.take(150))
            .put("points", points).put("totalDistanceM", distance.roundToInt())
        call("/vehicles/$vehicleId/replay-preview", "PUT", payload)
        return fingerprint
    }

    companion object {
        // One client for all trip calls: a new OkHttpClient per request would pay a fresh
        // HTTPS connection and TLS handshake every time, which the driver feels on Start Trip.
        private val sharedHttp = OkHttpClient()
    }

    private fun parseTrip(data: JSONObject): DeviceTrip = DeviceTrip(
        tripId = data.getString("tripId").toLong(),
        vehicleId = data.getString("vehicleId").toLong(),
        status = data.getString("tripStatus"),
        routeMode = data.optString("routeMode", "DUAL"),
        destinationName = data.optString("destinationName"),
        fingerprint = data.optJSONObject("replayPreview")?.optString("fingerprint"),
        datasetName = data.optJSONObject("replayPreview")?.optString("datasetName"),
    )
}
