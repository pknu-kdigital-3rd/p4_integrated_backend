package com.example.webrtccamera.telemetry.replay

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import com.example.webrtccamera.telemetry.model.StreamSessionContext
import com.example.webrtccamera.telemetry.model.TelemetryBatchSender
import com.example.webrtccamera.telemetry.model.TelemetryDataset
import com.example.webrtccamera.telemetry.model.TelemetrySource
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.ExecutorService

class DatasetLoadException(message: String) : Exception(message)

/**
 * Replays a local, on-device GPS/IMU CSV dataset as normalized telemetry batches, gated by the
 * QR-derived source clock. The CSV files never leave the device and are never referenced again
 * once [TelemetryDataset] is parsed.
 */
class CsvReplayTelemetrySource(
    dataset: TelemetryDataset,
    sessionContext: StreamSessionContext,
    sender: TelemetryBatchSender,
    onStatus: (String) -> Unit = {},
) : TelemetrySource {
    private val sourceClock = QrSourceClock()
    private val scheduler = TelemetryReplayScheduler(
        dataset = dataset,
        sourceClock = sourceClock,
        sessionContext = sessionContext,
        onBatchReady = sender::sendTelemetryBatch,
        onStatus = onStatus,
    )

    override fun start() = scheduler.start()

    override fun stop() = scheduler.stop()

    /** Only call this for a successful QR decode; a failed/absent decode must not touch the clock. */
    fun onQrTimestamp(sourceTimestampNs: Long, captureTimestampNs: Long, decodeLatencyMs: Long) {
        scheduler.onQrTimestamp(sourceTimestampNs, captureTimestampNs, decodeLatencyMs)
    }

    fun clockState(): SourceClockState = sourceClock.state()
    fun lastQrCorrectionNs(): Long = sourceClock.lastQrCorrectionNs
    fun lastEstimatedPlaybackRate(): Double = sourceClock.lastEstimatedPlaybackRate
    fun gpsSentCount(): Long = scheduler.gpsSentCount.get()
    fun imuSentCount(): Long = scheduler.imuSentCount.get()
    fun batchSentCount(): Long = scheduler.batchSentCount.get()

    companion object {

        /**
         * Runs entirely on [ioExecutor]: resolves the gps/imu CSVs inside [folderUri], parses
         * and validates them, and delivers the result back via [onResult]. [onResult] is invoked
         * on [ioExecutor]'s thread; callers marshal back to the UI thread themselves.
         */
        fun loadDatasetFromFolder(
            context: Context,
            folderUri: Uri,
            ioExecutor: ExecutorService,
            onResult: (Result<TelemetryDataset>) -> Unit,
        ) {
            val appContext = context.applicationContext
            ioExecutor.execute {
                onResult(runCatching { loadDatasetFromFolderBlocking(appContext, folderUri) })
            }
        }

        private fun loadDatasetFromFolderBlocking(
            context: Context,
            folderUri: Uri,
        ): TelemetryDataset {
            val contentResolver = context.contentResolver
            val folder = DocumentFile.fromTreeUri(context, folderUri)
                ?: throw DatasetLoadException("Could not open selected folder")
            if (!folder.isDirectory) throw DatasetLoadException("Selected item is not a folder")

            val files = folder.listFiles()
            val gpsFile = files.singleOrNull { isCsvNamed(it, prefix = "gps") }
                ?: throw DatasetLoadException(
                    when (files.count { isCsvNamed(it, prefix = "gps") }) {
                        0 -> "No gps*.csv file found in folder"
                        else -> "Multiple gps*.csv files found in folder"
                    }
                )
            val imuFile = files.singleOrNull { isCsvNamed(it, prefix = "imu") }
                ?: throw DatasetLoadException(
                    when (files.count { isCsvNamed(it, prefix = "imu") }) {
                        0 -> "No imu*.csv file found in folder"
                        else -> "Multiple imu*.csv files found in folder"
                    }
                )

            val gps = readCsv(contentResolver, gpsFile.uri) { CsvTelemetryParser.parseGps(it) }
            val imu = readCsv(contentResolver, imuFile.uri) { CsvTelemetryParser.parseImu(it) }
            val dataset = TelemetryDataset(displayName = folder.name ?: "dataset", gps = gps, imu = imu)
            validate(dataset)
            return dataset
        }

        /** True for `gps*.csv`/`imu*.csv` but not `raw_imu*.csv` or `frame*.csv`. */
        private fun isCsvNamed(file: DocumentFile, prefix: String): Boolean {
            val name = (file.name ?: return false).lowercase()
            if (!name.endsWith(".csv")) return false
            if (name.startsWith("raw_$prefix")) return false
            return name.startsWith(prefix)
        }

        private fun <T> readCsv(
            contentResolver: ContentResolver,
            uri: Uri,
            parse: (BufferedReader) -> T,
        ): T {
            val stream = contentResolver.openInputStream(uri)
                ?: throw DatasetLoadException("Could not open $uri")
            return stream.use { parse(BufferedReader(InputStreamReader(it, Charsets.UTF_8))) }
        }

        private fun validate(dataset: TelemetryDataset) {
            if (dataset.gps.isEmpty()) throw DatasetLoadException("GPS file has no data rows")
            if (dataset.imu.isEmpty()) throw DatasetLoadException("IMU file has no data rows")
            val gpsStart = dataset.gpsStartNs!!
            val gpsEnd = dataset.gpsEndNs!!
            val imuStart = dataset.imuStartNs!!
            val imuEnd = dataset.imuEndNs!!
            val overlapStart = maxOf(gpsStart, imuStart)
            val overlapEnd = minOf(gpsEnd, imuEnd)
            if (overlapStart > overlapEnd) {
                throw DatasetLoadException(
                    "Telemetry: dataset timestamp mismatch - GPS and IMU ranges do not overlap"
                )
            }
        }
    }
}
