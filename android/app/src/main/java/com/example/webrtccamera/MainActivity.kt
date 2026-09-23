package com.example.webrtccamera

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.text.Editable
import android.text.TextWatcher
import android.util.Log
import android.util.Range
import android.util.Size
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.Surface
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.core.Camera
import androidx.camera.core.CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import com.example.webrtccamera.telemetry.model.StreamSessionContext
import com.example.webrtccamera.telemetry.model.TelemetryDataset
import com.example.webrtccamera.telemetry.model.TelemetryMode
import com.example.webrtccamera.telemetry.replay.CsvReplayTelemetrySource
import com.example.webrtccamera.telemetry.replay.DatasetLoadException
import com.example.webrtccamera.telemetry.transport.TelemetryDataChannelSender
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

private data class ResolutionOption(val label: String, val size: Size)
private data class QrInput(val data: ByteArray, val width: Int, val height: Int)
private data class QrCrop(val left: Int, val top: Int, val width: Int, val height: Int)
private class QrScanAttempt(val startedAtNs: Long, val fastRetry: Boolean)

private val RESOLUTION_OPTIONS = listOf(
    ResolutionOption("720p (1280x720)", Size(1280, 720)),
    ResolutionOption("1080p (1920x1080)", Size(1920, 1080)),
    ResolutionOption("1440p (2560x1440)", Size(2560, 1440)),
    ResolutionOption("4K (3840x2160)", Size(3840, 2160)),
)
private const val DEFAULT_RESOLUTION_INDEX = 0 // 720p, matches the previous hardcoded behavior

// A floor on frame rate is a ceiling on exposure time, so auto-exposure must
// raise gain rather than hold the shutter open and smear motion into the pixels.
private const val TARGET_CAPTURE_FPS = 30

// GPS replay advances at roughly one tick per second. One QR attempt per tick
// is sufficient to re-anchor that clock while avoiding a continuous ML Kit
// workload on the camera analyzer.
private const val QR_SCAN_INTERVAL_NS = 1_000_000_000L
private const val QR_SCAN_TIMEOUT_NS = 1_500_000_000L
// The on-screen QR changes every two camera frames, so a fixed ~1 s (30-frame)
// cadence keeps sampling the same phase of that change. As the display and camera
// clocks drift, that phase slides onto the QR transition and every scan sees a
// torn code for tens of seconds. After a miss, retry immediately on alternating
// frame parity: of any two consecutive frames, one is off the transition.
private const val QR_FAST_RETRY_ATTEMPTS = 3
private const val QR_SCANNER_RESTART_FAILURE_THRESHOLD = 3
// Use the smaller input for the normal path so QR analysis does not steal
// CameraX throughput from the video publisher. A larger retry is enabled only
// after repeated misses when the QR is too small for the fast path.
private const val QR_FAST_MAX_WIDTH = 640
private const val QR_FAST_MAX_HEIGHT = 360
private const val QR_HIGH_MAX_WIDTH = 1280
private const val QR_HIGH_MAX_HEIGHT = 720
private const val QR_HIGH_RESOLUTION_MISS_THRESHOLD = 3
private const val QR_NO_DECODE_RECOVERY_NS = 4_000_000_000L
private const val QR_FAILURE_LOG_INTERVAL_NS = 250_000_000L
private const val QR_LOG_TAG = "MainActivity"

// The rig points at a screen a fixed distance away. Autofocus hunts badly on a
// flat, periodic pixel pattern, so the lens is pinned between tap-to-focus
// scans. Focus is held as a 0..1 fraction of the lens range because many devices
// report LENS_FOCUS_DISTANCE as UNCALIBRATED, where the diopter scale is
// repeatable but not physically true.
private const val FOCUS_FRACTION_KEY = "focus_fraction"
private const val RECORDING_TRIP_ID_KEY = "recording_trip_id"
private const val RECORDING_VEHICLE_ID_KEY = "recording_vehicle_id"

class MainActivity : AppCompatActivity() {
    private lateinit var viewFinder: PreviewView
    private lateinit var statusText: TextView
    private lateinit var zoomStatusText: TextView
    private lateinit var streamButton: Button
    private lateinit var serverUrl: EditText
    private lateinit var recordingTripIdInput: EditText
    private lateinit var recordingVehicleIdInput: EditText
    private lateinit var recordingContextText: TextView
    private lateinit var resolutionSpinner: Spinner
    private lateinit var actualResolutionText: TextView
    private lateinit var qrStatusText: TextView
    private lateinit var qrScanningSwitch: Switch
    private lateinit var telemetrySwitch: Switch
    private lateinit var selectDatasetButton: Button
    private lateinit var datasetSummaryText: TextView
    private lateinit var telemetryStatusText: TextView
    private lateinit var cameraExecutor: ExecutorService
    private lateinit var telemetryIoExecutor: ExecutorService

    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var publisher: WebRtcPublisher? = null
    private val streaming = AtomicBoolean(false)
    private var resumeStreamOnForeground = false
    @Volatile
    private var telemetryEnabled = false
    private var selectedTelemetryDataset: TelemetryDataset? = null
    private var telemetryReplaySource: CsvReplayTelemetrySource? = null
    private var activeSessionContext: StreamSessionContext? = null
    /**
     * The telemetry panel carries three independent facts, each updated by a
     * different producer: whether the relay accepted this stream's identity,
     * how the replay source is progressing, and whether the DataChannel is
     * actually delivering. They are kept as separate lines because the replay
     * source reports once a second and would otherwise be the only one ever
     * visible - which is exactly how a stream the relay was discarding could
     * look healthy on the device.
     */
    private var telemetrySourceStatus: String = "Telemetry: disabled"
    private var telemetryTransportStatus: String? = null
    private var telemetryIdentityWarning: String? = null

    private var captureSummary = ""
    @Volatile
    private var captureFps = 0f
    private var captureWindowStartedNs = 0L
    private var captureWindowFrames = 0
    @Volatile
    private var qrScanningEnabled = true
    private var focusRangeDiopters: Float? = null
    private var focusFraction = 0f
    @Volatile
    private var qrScanner = createQrScanner()
    private val qrCaptureIndex = AtomicLong(0)
    private val activeQrScanAttempt = AtomicReference<QrScanAttempt?>(null)
    private val qrScannerResetRequested = AtomicBoolean(false)
    private var lastQrAttemptElapsedNs = 0L
    // Camera-analyzer-thread only: counts every analyzed frame so retries can pick
    // the opposite frame parity to the attempt that missed.
    private var qrAnalyzedFrames = 0L
    private var lastQrAttemptFrameIndex = 0L
    private val qrFastRetriesRemaining = AtomicInteger(0)
    private val qrConsecutiveFailures = AtomicInteger(0)
    private var lastQrFailureLogNs = 0L
    @Volatile
    private var lastQrSuccessElapsedNs = 0L
    @Volatile
    private var lastQrRecoveryElapsedNs = 0L
    @Volatile
    private var qrHighResolution = false
    @Volatile
    private var qrMissedResults = 0
    // Reused because only one QR task is allowed to reference this buffer at a
    // time. The camera frame itself can therefore be closed immediately after
    // this reduced-resolution copy is complete.
    private var qrImageBuffer = ByteArray(0)

    // Written from a camera thread by the session capture callback so a tap-
    // triggered scan can be read back and adopted as the new manual position.
    @Volatile
    private var lastLensPosition: Float? = null

    private val tapFocusDetector by lazy {
        GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onSingleTapUp(event: MotionEvent): Boolean {
                autoFocusAt(event.x, event.y)
                return true
            }
        })
    }

    private val zoomGestureDetector by lazy {
        ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val activeCamera = camera ?: return true
                val zoomState = activeCamera.cameraInfo.zoomState.value ?: return true
                val zoomRatio = (zoomState.zoomRatio * detector.scaleFactor)
                    .coerceIn(zoomState.minZoomRatio, zoomState.maxZoomRatio)
                activeCamera.cameraControl.setZoomRatio(zoomRatio).addListener(
                    { runOnUiThread(::updateZoomStatus) },
                    ContextCompat.getMainExecutor(this@MainActivity),
                )
                return true
            }
        })
    }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startStreaming() else setStatus("Camera permission is required")
        }

    private val datasetFolderLauncher =
        registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
            if (uri != null) onDatasetFolderSelected(uri)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        viewFinder = findViewById(R.id.viewFinder)
        statusText = findViewById(R.id.statusText)
        zoomStatusText = findViewById(R.id.zoomStatusText)
        streamButton = findViewById(R.id.streamButton)
        serverUrl = findViewById(R.id.serverUrl)
        serverUrl.setText(BuildConfig.DEFAULT_SERVER_URL)
        recordingTripIdInput = findViewById(R.id.recordingTripId)
        recordingVehicleIdInput = findViewById(R.id.recordingVehicleId)
        recordingContextText = findViewById(R.id.recordingContextText)
        recordingTripIdInput.setText(getPreferences(MODE_PRIVATE).getString(RECORDING_TRIP_ID_KEY, ""))
        recordingVehicleIdInput.setText(getPreferences(MODE_PRIVATE).getString(RECORDING_VEHICLE_ID_KEY, ""))
        val recordingContextWatcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) = updateRecordingContextText()
        }
        recordingTripIdInput.addTextChangedListener(recordingContextWatcher)
        recordingVehicleIdInput.addTextChangedListener(recordingContextWatcher)
        updateRecordingContextText()
        resolutionSpinner = findViewById(R.id.resolutionSpinner)
        actualResolutionText = findViewById(R.id.actualResolutionText)
        qrStatusText = findViewById(R.id.qrStatusText)
        qrScanningSwitch = findViewById(R.id.qrScanningSwitch)
        qrScanningSwitch.setOnCheckedChangeListener { _, enabled ->
            qrScanningEnabled = enabled
            setQrStatus(if (enabled) "QR: waiting for scan…" else "QR: disabled")
        }
        telemetrySwitch = findViewById(R.id.telemetrySwitch)
        selectDatasetButton = findViewById(R.id.selectDatasetButton)
        datasetSummaryText = findViewById(R.id.datasetSummaryText)
        telemetryStatusText = findViewById(R.id.telemetryStatusText)
        telemetrySwitch.setOnCheckedChangeListener { _, enabled ->
            telemetryEnabled = enabled
            setTelemetryStatus(
                when {
                    !enabled -> "Telemetry: disabled"
                    selectedTelemetryDataset != null -> "Telemetry: dataset ready"
                    else -> "Telemetry: no dataset selected"
                }
            )
        }
        selectDatasetButton.setOnClickListener { datasetFolderLauncher.launch(null) }
        focusFraction = getPreferences(MODE_PRIVATE).getFloat(FOCUS_FRACTION_KEY, 0f)
        updateZoomStatus()
        viewFinder.setOnTouchListener { view, event ->
            zoomGestureDetector.onTouchEvent(event)
            // Suppress the tap while a pinch is running, so lifting two fingers
            // cannot fire a focus scan when the user intended to zoom.
            if (!zoomGestureDetector.isInProgress) tapFocusDetector.onTouchEvent(event)
            if (event.actionMasked == MotionEvent.ACTION_UP) view.performClick()
            true
        }
        // The system spinner layouts use the app theme's default text color, which
        // reads as near-black against this dark panel - force it white to match
        // statusText/serverUrl instead.
        resolutionSpinner.adapter = object : ArrayAdapter<String>(
            this,
            android.R.layout.simple_spinner_item,
            RESOLUTION_OPTIONS.map { it.label },
        ) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getView(position, convertView, parent) as TextView).apply {
                    setTextColor(Color.WHITE)
                }

            override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getDropDownView(position, convertView, parent) as TextView).apply {
                    setTextColor(Color.WHITE)
                }
        }.also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        resolutionSpinner.setSelection(DEFAULT_RESOLUTION_INDEX)
        streamButton.setOnClickListener {
            if (streaming.get()) stopStreaming() else startStreaming()
        }

        cameraExecutor = Executors.newSingleThreadExecutor()
        telemetryIoExecutor = Executors.newSingleThreadExecutor()
        setStatus("Ready")
    }

    override fun onStart() {
        super.onStart()
        if (resumeStreamOnForeground) {
            resumeStreamOnForeground = false
            startStreaming()
        }
    }

    /** Runs entirely on [telemetryIoExecutor]; parsing a 54k-row IMU CSV must stay off the UI thread. */
    private fun onDatasetFolderSelected(folderUri: Uri) {
        try {
            contentResolver.takePersistableUriPermission(folderUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
            // Persisting is best-effort; the folder is still usable for this session.
        }
        selectedTelemetryDataset = null
        datasetSummaryText.text = "Loading dataset…"
        setTelemetryStatus("Telemetry: loading dataset…")
        CsvReplayTelemetrySource.loadDatasetFromFolder(this, folderUri, telemetryIoExecutor) { result ->
            runOnUiThread {
                result.onSuccess { dataset ->
                    selectedTelemetryDataset = dataset
                    datasetSummaryText.text =
                        "${dataset.displayName}\n" +
                            "gps: ${dataset.gps.size} samples (${dataset.gpsStartNs} .. ${dataset.gpsEndNs})\n" +
                            "imu: ${dataset.imu.size} samples (${dataset.imuStartNs} .. ${dataset.imuEndNs})"
                    if (telemetryEnabled) setTelemetryStatus("Telemetry: dataset ready")
                }.onFailure { error ->
                    selectedTelemetryDataset = null
                    datasetSummaryText.text = "Failed to load dataset: ${error.message}"
                    if (telemetryEnabled) {
                        val mismatch = error is DatasetLoadException && error.message?.contains("mismatch") == true
                        setTelemetryStatus(
                            if (mismatch) "Telemetry: dataset timestamp mismatch" else "Telemetry: dataset error"
                        )
                    }
                }
            }
        }
    }

    private fun startStreaming() {
        if (streaming.get()) return
        val endpoint = normalizeServerUrl(serverUrl.text.toString())
        if (endpoint == null) {
            setStatus("Enter a valid server URL or host:port")
            return
        }
        val tripText = recordingTripIdInput.text.toString().trim()
        val vehicleText = recordingVehicleIdInput.text.toString().trim()
        val recordingTripId: Long?
        val recordingVehicleId: Long?
        if (tripText.isEmpty() && vehicleText.isEmpty()) {
            recordingTripId = null
            recordingVehicleId = null
        } else {
            recordingTripId = tripText.toLongOrNull()?.takeIf { it > 0 }
            recordingVehicleId = vehicleText.toLongOrNull()?.takeIf { it > 0 }
            if (recordingTripId == null || recordingVehicleId == null) {
                setStatus("Enter positive trip and vehicle IDs, or leave both blank")
                return
            }
        }
        if (telemetryEnabled && (recordingTripId == null || recordingVehicleId == null)) {
            setStatus("Enter Trip ID and Vehicle ID to enable telemetry simulation")
            return
        }
        val telemetryDataset = selectedTelemetryDataset
        if (telemetryEnabled && telemetryDataset == null) {
            setStatus("Select a telemetry dataset folder first")
            return
        }
        getPreferences(MODE_PRIVATE).edit {
            putString(RECORDING_TRIP_ID_KEY, tripText)
            putString(RECORDING_VEHICLE_ID_KEY, vehicleText)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
            return
        }

        streaming.set(true)
        qrCaptureIndex.set(0)
        activeQrScanAttempt.set(null)
        cameraExecutor.execute { if (streaming.get()) resetQrScanner() }
        lastQrAttemptElapsedNs = 0L
        qrFastRetriesRemaining.set(0)
        qrConsecutiveFailures.set(0)
        lastQrFailureLogNs = 0L
        lastQrSuccessElapsedNs = 0L
        lastQrRecoveryElapsedNs = 0L
        qrHighResolution = false
        qrMissedResults = 0
        captureFps = 0f
        captureWindowStartedNs = 0L
        captureWindowFrames = 0
        resolutionSpinner.isEnabled = false
        telemetrySwitch.isEnabled = false
        selectDatasetButton.isEnabled = false
        streamButton.setText(R.string.stop_streaming)
        setStatus("Starting WebRTC…")
        val sessionContext = if (recordingTripId != null && recordingVehicleId != null) {
            StreamSessionContext(
                tripId = recordingTripId,
                vehicleId = recordingVehicleId,
                recordingSessionId = UUID.randomUUID().toString(),
                telemetryMode = TelemetryMode.REPLAY,
            )
        } else {
            null
        }
        activeSessionContext = sessionContext
        publisher = WebRtcPublisher(
            context = this,
            offerEndpoint = endpoint,
            sessionContext = sessionContext,
            onStatus = { message ->
                runOnUiThread { if (streaming.get()) setStatus(message) }
            },
            onTelemetryStatus = { message ->
                runOnUiThread { if (streaming.get()) setTelemetryTransportStatus(message) }
            },
            onStreamIdentity = { warning ->
                runOnUiThread { if (streaming.get()) setTelemetryIdentityWarning(warning) }
            },
        )
        recordingTripIdInput.isEnabled = false
        recordingVehicleIdInput.isEnabled = false
        publisher?.start()
        telemetryReplaySource = if (telemetryEnabled && sessionContext != null && telemetryDataset != null) {
            CsvReplayTelemetrySource(
                dataset = telemetryDataset,
                sessionContext = sessionContext,
                sender = TelemetryDataChannelSender(publisher!!),
                onStatus = { message -> runOnUiThread { if (streaming.get()) setTelemetryStatus(message) } },
            ).also {
                it.start()
                setTelemetryStatus("Telemetry: waiting for QR…")
            }
        } else {
            null
        }
        bindCamera()
    }

    private fun bindCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            if (!streaming.get()) return@addListener
            try {
                val provider = future.get()
                val selectedResolution = RESOLUTION_OPTIONS
                    .getOrElse(resolutionSpinner.selectedItemPosition) { RESOLUTION_OPTIONS[DEFAULT_RESOLUTION_INDEX] }
                    .size
                val resolutionSelector = ResolutionSelector.Builder()
                    // ResolutionSelector defaults to RATIO_4_3_FALLBACK_AUTO_STRATEGY
                    // when unset, which CameraX ranks above closeness-to-target when
                    // picking an output size - so a 16:9 target (all current presets)
                    // could still lose to an available 4:3 mode without this.
                    .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
                    .setResolutionStrategy(
                        ResolutionStrategy(
                            selectedResolution,
                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                        )
                    )
                    .build()
                val preview = Preview.Builder()
                    .setTargetRotation(viewFinder.display?.rotation ?: Surface.ROTATION_0)
                    .build()
                    .also { it.setSurfaceProvider(viewFinder.surfaceProvider) }
                val analysisBuilder = ImageAnalysis.Builder()
                    .setTargetRotation(viewFinder.display?.rotation ?: Surface.ROTATION_0)
                    .setResolutionSelector(resolutionSelector)
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                val cameraInfo = CameraSelector.DEFAULT_BACK_CAMERA
                    .filter(provider.availableCameraInfos)
                    .firstOrNull()
                val exposureCap = cameraInfo?.let(::selectExposureCappingFpsRange)
                if (exposureCap != null) applyExposureCap(analysisBuilder, exposureCap)
                focusRangeDiopters = cameraInfo?.let(::manualFocusRangeDiopters)
                observeLensPosition(analysisBuilder)
                val analysis = analysisBuilder
                    .build()
                    .also { it.setAnalyzer(cameraExecutor, ::publishFrame) }

                provider.unbindAll()
                val bound = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                cameraProvider = provider
                camera = bound
                applyFocus(bound)
                updateZoomStatus()
                // The requested Size is only a target - the camera HAL may not offer
                // that exact size/aspect ratio, so show what was actually bound. This
                // gets its own label rather than statusText, since WebRtcPublisher's
                // onStatus callback fires concurrently on another thread and would
                // otherwise overwrite this within milliseconds of it being set.
                val actual = analysis.resolutionInfo?.resolution
                val capNote = exposureCap?.let { " · ≥${it.lower} fps" }.orEmpty()
                captureSummary = "Streaming at: ${actual?.width}x${actual?.height}$capNote"
                updateCaptureLabel()
                setStatus("Camera ready; waiting for WebRTC answer…")
            } catch (error: Exception) {
                setStatus("Camera setup failed: ${error.message ?: "unknown error"}")
                stopStreaming()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun selectExposureCappingFpsRange(cameraInfo: CameraInfo): Range<Int>? =
        Camera2CameraInfo.from(cameraInfo)
            .getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
            // A faster range would feed more frames to a pipeline that infers every one.
            ?.filter { it.upper == TARGET_CAPTURE_FPS }
            ?.maxByOrNull { it.lower }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun applyExposureCap(builder: ImageAnalysis.Builder, range: Range<Int>) {
        Camera2Interop.Extender(builder)
            .setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, range)
    }

    /**
     * Diopters at the lens's near limit, or null when focus cannot be driven
     * manually. Used to pin focus after a tap-to-focus scan.
     */
    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun manualFocusRangeDiopters(cameraInfo: CameraInfo): Float? {
        val info = Camera2CameraInfo.from(cameraInfo)
        val supportsManualFocus = info
            .getCameraCharacteristic(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)
            ?.contains(CameraMetadata.CONTROL_AF_MODE_OFF) == true
        // Zero means a fixed-focus lens, which has no position to set.
        val closest = info
            .getCameraCharacteristic(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE)
            ?: 0f
        return if (supportsManualFocus && closest > 0f) closest else null
    }

    /**
     * Pins the lens at the position found by tap-to-focus. Applied through
     * Camera2CameraControl so the running session can keep that position.
     */
    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun applyFocus(camera: Camera) {
        val range = focusRangeDiopters ?: return
        Camera2CameraControl.from(camera.cameraControl).setCaptureRequestOptions(
            CaptureRequestOptions.Builder()
                .setCaptureRequestOption(
                    CaptureRequest.CONTROL_AF_MODE,
                    CameraMetadata.CONTROL_AF_MODE_OFF,
                )
                .setCaptureRequestOption(
                    CaptureRequest.LENS_FOCUS_DISTANCE,
                    focusFraction * range,
                )
                .build()
        )
        updateCaptureLabel()
    }

    private fun updateZoomStatus() {
        if (!::zoomStatusText.isInitialized) return
        val state = camera?.cameraInfo?.zoomState?.value
        zoomStatusText.text = if (state == null) {
            "Pinch to zoom  |  Tap to focus"
        } else {
            "Pinch to zoom · %.1f×  |  Tap to focus".format(state.zoomRatio)
        }
    }

    /**
     * Runs one autofocus scan at the tapped point, then re-pins the lens where
     * it settled when manual focus is supported.
     */
    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun autoFocusAt(x: Float, y: Float) {
        val camera = camera ?: return
        val action = FocusMeteringAction
            .Builder(viewFinder.meteringPointFactory.createPoint(x, y), FocusMeteringAction.FLAG_AF)
            .disableAutoCancel()
            .build()
        // The manual pin has to come off first: CONTROL_AF_MODE_OFF is in force
        // between scans, and the lens cannot move while it is.
        Camera2CameraControl.from(camera.cameraControl).clearCaptureRequestOptions()
        setStatus("Focusing…")
        val scan = camera.cameraControl.startFocusAndMetering(action)
        scan.addListener({
            val range = focusRangeDiopters
            val settled = lastLensPosition
            if (range == null || settled == null) return@addListener
            // Adopt the scan's position so focus is retained after the tap.
            focusFraction = (settled / range).coerceIn(0f, 1f)
            getPreferences(MODE_PRIVATE).edit { putFloat(FOCUS_FRACTION_KEY, focusFraction) }
            applyFocus(camera)
        }, ContextCompat.getMainExecutor(this))
    }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun observeLensPosition(builder: ImageAnalysis.Builder) {
        Camera2Interop.Extender(builder).setSessionCaptureCallback(
            object : CameraCaptureSession.CaptureCallback() {
                override fun onCaptureCompleted(
                    session: CameraCaptureSession,
                    request: CaptureRequest,
                    result: TotalCaptureResult,
                ) {
                    result.get(CaptureResult.LENS_FOCUS_DISTANCE)?.let { lastLensPosition = it }
                }
            }
        )
    }

    private fun updateCaptureLabel() {
        val range = focusRangeDiopters
        val diopters = if (range == null) 0f else focusFraction * range
        val focusNote = when {
            range == null -> " · autofocus"
            diopters <= 0f -> " · focus ∞"
            else -> " · focus %.2f m".format(1f / diopters)
        }
        val fpsNote = if (captureFps > 0f) " · capture %.1f fps".format(captureFps) else ""
        actualResolutionText.text = captureSummary + focusNote + fpsNote
    }

    // QR decoding runs on the exact same frame this pushes as video, instead
    // of a second concurrent ImageAnalysis stream: binding preview + analysis
    // + a QR-only analysis stream together let CameraX report success while
    // the camera HAL silently never delivered a single frame to the third
    // stream (confirmed via a call counter that never moved past zero) -
    // apparently a real stream-count limit on this device/HAL that CameraX's
    // own combination check didn't catch. Sharing one frame also removes the
    // separate concern of whether the QR reading and the published video
    // frame actually corresponded to the same instant.
    @androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
    private fun publishFrame(image: ImageProxy) {
        if (!streaming.get()) {
            image.close()
            return
        }
        recordCaptureFrame()
        qrAnalyzedFrames++
        val timestamp = image.imageInfo.timestamp.takeIf { it > 0 } ?: SystemClock.elapsedRealtimeNanos()
        // scanQrFrame takes over closing `image` once handed off, since ML
        // Kit reads it asynchronously. Only one sampled frame may be held by
        // ML Kit at a time; all other frames close immediately so CameraX can
        // keep delivering the full-rate video stream.
        var handedOffToQrScan = false
        try {
            publisher?.push(image, timestamp)
            val qrAttempt = if (qrScanningEnabled) tryStartQrScan() else null
            if (qrAttempt != null) {
                handedOffToQrScan = true
                scanQrFrame(image, timestamp, qrAttempt)
            }
        } finally {
            if (!handedOffToQrScan) image.close()
        }
    }

    private fun tryStartQrScan(): QrScanAttempt? {
        val now = SystemClock.elapsedRealtimeNanos()
        if (activeQrScanAttempt.get() == null && qrScannerResetRequested.compareAndSet(true, false)) {
            resetQrScanner()
            setQrStatus("QR: restarting scanner after repeated errors")
        }
        // ML Kit can keep returning successful empty results while its native
        // scanner has lost the small on-screen QR. Recreate it occasionally
        // after a real decode has gone stale, without resetting on every frame
        // when the QR is simply out of view.
        if (activeQrScanAttempt.get() == null &&
            lastQrSuccessElapsedNs > 0L &&
            now - lastQrSuccessElapsedNs >= QR_NO_DECODE_RECOVERY_NS &&
            now - lastQrRecoveryElapsedNs >= QR_NO_DECODE_RECOVERY_NS
        ) {
            resetQrScanner()
            lastQrRecoveryElapsedNs = now
            setQrStatus("QR: refreshing scanner after missed decodes")
        }
        val activeAttempt = activeQrScanAttempt.get()
        if (activeAttempt != null) {
            if (now - activeAttempt.startedAtNs <= QR_SCAN_TIMEOUT_NS) return null
            if (!activeQrScanAttempt.compareAndSet(activeAttempt, null)) return null

            // ML Kit normally completes each task. If it stops calling back,
            // invalidate that scanner and its reusable input buffer so late
            // work cannot block or corrupt subsequent scans.
            resetQrScanner()
            reportQrFailure(
                "ML Kit timeout",
                IllegalStateException("scan did not complete within ${QR_SCAN_TIMEOUT_NS / 1_000_000}ms"),
            )
            setQrStatus("QR: scan timed out; restarting scanner")
        }

        val fastRetry = qrFastRetriesRemaining.get() > 0
        if (fastRetry) {
            // Only frames an odd distance from the missed attempt sit on the other
            // side of the QR's two-frame change cycle.
            if ((qrAnalyzedFrames - lastQrAttemptFrameIndex) % 2L == 0L) return null
        } else if (lastQrAttemptElapsedNs > 0L && now - lastQrAttemptElapsedNs < QR_SCAN_INTERVAL_NS) {
            return null
        }
        val attempt = QrScanAttempt(startedAtNs = now, fastRetry = fastRetry)
        return if (activeQrScanAttempt.compareAndSet(null, attempt)) {
            lastQrAttemptElapsedNs = now
            lastQrAttemptFrameIndex = qrAnalyzedFrames
            if (fastRetry) qrFastRetriesRemaining.decrementAndGet()
            attempt
        } else null
    }

    /** A regular 1 s attempt that misses starts a short burst of parity-alternating retries. */
    private fun onQrMiss(attempt: QrScanAttempt) {
        if (!attempt.fastRetry) qrFastRetriesRemaining.compareAndSet(0, QR_FAST_RETRY_ATTEMPTS)
    }

    /** Measures frames delivered to CameraX before WebRTC encoding or server processing. */
    private fun recordCaptureFrame() {
        val now = SystemClock.elapsedRealtimeNanos()
        if (captureWindowStartedNs == 0L) captureWindowStartedNs = now
        captureWindowFrames += 1
        val elapsed = now - captureWindowStartedNs
        if (elapsed < 1_000_000_000L) return
        captureFps = captureWindowFrames * 1_000_000_000f / elapsed
        captureWindowStartedNs = now
        captureWindowFrames = 0
        runOnUiThread { if (streaming.get()) updateCaptureLabel() }
    }

    private fun scanQrFrame(image: ImageProxy, timestamp: Long, attempt: QrScanAttempt) {
        val captureIndex = qrCaptureIndex.getAndIncrement()
        val start = System.nanoTime()
        val rotation = image.imageInfo.rotationDegrees
        val qrInput = try {
            createQrInput(
                image,
                if (qrHighResolution) QR_HIGH_MAX_WIDTH else QR_FAST_MAX_WIDTH,
                if (qrHighResolution) QR_HIGH_MAX_HEIGHT else QR_FAST_MAX_HEIGHT,
            )
        } catch (error: Exception) {
            activeQrScanAttempt.compareAndSet(attempt, null)
            image.close()
            onQrMiss(attempt)
            reportQrFailure("image conversion", error)
            publisher?.sendQrEvent(
                timestamp,
                null,
                false,
                captureIndex,
                (System.nanoTime() - start) / 1_000_000,
            )
            return
        }
        // The QR scanner receives an owned byte-array copy, so release the
        // CameraX image before ML Kit starts. This prevents QR processing from
        // holding CameraX's analysis stream open and throttling video capture.
        image.close()
        try {
            val input = InputImage.fromByteArray(
                qrInput.data,
                qrInput.width,
                qrInput.height,
                rotation,
                ImageFormat.NV21,
            )
            qrScanner.process(input)
                .addOnSuccessListener { barcodes ->
                    if (activeQrScanAttempt.get() !== attempt) return@addOnSuccessListener
                    val raw = barcodes.firstOrNull()?.rawValue
                    val decoded = raw?.toLongOrNull()
                    qrConsecutiveFailures.set(0)
                    val latencyMs = (System.nanoTime() - start) / 1_000_000
                    publisher?.sendQrEvent(timestamp, decoded, decoded != null, captureIndex, latencyMs)
                    // A failed/absent/malformed decode must not touch the replay clock.
                    if (decoded != null) {
                        qrFastRetriesRemaining.set(0)
                        qrMissedResults = 0
                        qrHighResolution = false
                        lastQrSuccessElapsedNs = SystemClock.elapsedRealtimeNanos()
                        setQrStatus("QR: ts=$decoded")
                        telemetryReplaySource?.onQrTimestamp(
                            sourceTimestampNs = decoded,
                            captureTimestampNs = timestamp,
                            decodeLatencyMs = latencyMs,
                        )
                    } else {
                        onQrMiss(attempt)
                        qrMissedResults++
                        if (qrMissedResults >= QR_HIGH_RESOLUTION_MISS_THRESHOLD) {
                            qrHighResolution = true
                        }
                    }
                }
                .addOnFailureListener { error ->
                    if (activeQrScanAttempt.get() !== attempt) return@addOnFailureListener
                    onQrMiss(attempt)
                    reportQrFailure("ML Kit", error)
                    publisher?.sendQrEvent(
                        timestamp,
                        null,
                        false,
                        captureIndex,
                        (System.nanoTime() - start) / 1_000_000,
                    )
                    qrMissedResults++
                    if (qrMissedResults >= QR_HIGH_RESOLUTION_MISS_THRESHOLD) {
                        qrHighResolution = true
                    }
                }
                .addOnCompleteListener {
                    activeQrScanAttempt.compareAndSet(attempt, null)
                }
        } catch (error: Exception) {
            activeQrScanAttempt.compareAndSet(attempt, null)
            reportQrFailure("ML Kit setup", error)
        }
    }

    private fun createQrScanner() = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
    )

    private fun resetQrScanner() {
        activeQrScanAttempt.set(null)
        qrScannerResetRequested.set(false)
        qrConsecutiveFailures.set(0)
        qrImageBuffer = ByteArray(0)
        val oldScanner = qrScanner
        qrScanner = createQrScanner()
        oldScanner.close()
    }

    private fun reportQrFailure(stage: String, error: Throwable) {
        val consecutiveFailures = qrConsecutiveFailures.incrementAndGet()
        if ((stage == "ML Kit" || stage == "ML Kit setup") &&
            consecutiveFailures >= QR_SCANNER_RESTART_FAILURE_THRESHOLD
        ) {
            qrScannerResetRequested.set(true)
        }
        // Keep the last valid timestamp visible during short scanner misses.
        // The source clock is already frozen after its stale timeout, so this
        // avoids making the UI flicker between success and failure for normal
        // QR redraw transitions.
        if (lastQrSuccessElapsedNs == 0L ||
            SystemClock.elapsedRealtimeNanos() - lastQrSuccessElapsedNs >= QR_NO_DECODE_RECOVERY_NS
        ) {
            setQrStatus("QR: $stage error; retrying")
        }
        val now = SystemClock.elapsedRealtimeNanos()
        if (now - lastQrFailureLogNs < QR_FAILURE_LOG_INTERVAL_NS) return
        lastQrFailureLogNs = now
        Log.w(
            QR_LOG_TAG,
            "QR $stage failed; retrying (consecutive=$consecutiveFailures): " +
                (error.message ?: error.javaClass.simpleName),
        )
    }

    /**
     * Converts a camera YUV_420_888 frame to a reusable, downsampled NV21
     * buffer for QR detection. Video still uses the original full-resolution
     * ImageProxy in WebRtcPublisher; this reduced copy is QR-only.
     */
    private fun createQrInput(image: ImageProxy, maxWidth: Int, maxHeight: Int): QrInput {
        val sourceWidth = image.width
        val sourceHeight = image.height
        val crop = qrCrop(sourceWidth, sourceHeight, image.imageInfo.rotationDegrees)
        val scale = maxOf(
            1,
            (crop.width + maxWidth - 1) / maxWidth,
            (crop.height + maxHeight - 1) / maxHeight,
        )
        val width = (crop.width / scale).and(-2).coerceAtLeast(2)
        val height = (crop.height / scale).and(-2).coerceAtLeast(2)
        val chromaWidth = width / 2
        val chromaHeight = height / 2
        val required = width * height + width * height / 2
        if (qrImageBuffer.size != required) qrImageBuffer = ByteArray(required)

        val yPlane = image.planes[0]
        val uPlane = image.planes[1]
        val vPlane = image.planes[2]
        val y = yPlane.buffer.duplicate()
        val u = uPlane.buffer.duplicate()
        val v = vPlane.buffer.duplicate()

        var destination = 0
        for (row in 0 until height) {
            val sourceRow = (crop.top + row * scale).coerceAtMost(sourceHeight - 1)
            val rowOffset = sourceRow * yPlane.rowStride
            for (column in 0 until width) {
                val sourceColumn = (crop.left + column * scale).coerceAtMost(sourceWidth - 1)
                qrImageBuffer[destination++] = y.get(rowOffset + sourceColumn * yPlane.pixelStride)
            }
        }
        for (row in 0 until chromaHeight) {
            val sourceChromaRow = (crop.top / 2 + row * scale).coerceAtMost(sourceHeight / 2 - 1)
            for (column in 0 until chromaWidth) {
                val sourceChromaColumn = (crop.left / 2 + column * scale).coerceAtMost(sourceWidth / 2 - 1)
                // NV21 stores chroma as VU pairs.
                qrImageBuffer[destination++] = v.get(sourceChromaRow * vPlane.rowStride + sourceChromaColumn * vPlane.pixelStride)
                qrImageBuffer[destination++] = u.get(sourceChromaRow * uPlane.rowStride + sourceChromaColumn * uPlane.pixelStride)
            }
        }
        return QrInput(qrImageBuffer, width, height)
    }

    /**
     * Returns a generous bottom-center crop in the displayed orientation,
     * mapped back into the camera sensor's unrotated YUV coordinates.
     */
    private fun qrCrop(sourceWidth: Int, sourceHeight: Int, rotationDegrees: Int): QrCrop {
        val rotation = ((rotationDegrees % 360) + 360) % 360
        val displayedWidth = if (rotation == 90 || rotation == 270) sourceHeight else sourceWidth
        val displayedHeight = if (rotation == 90 || rotation == 270) sourceWidth else sourceHeight
        val displayLeft = (displayedWidth * 10 / 100).and(-2)
        val displayRight = (displayedWidth * 90 / 100).and(-2).coerceAtMost(displayedWidth)
        val displayTop = (displayedHeight * 40 / 100).and(-2)
        val displayBottom = displayedHeight.and(-2)
        val points = arrayOf(
            displayLeft to displayTop,
            displayRight to displayTop,
            displayLeft to displayBottom,
            displayRight to displayBottom,
        ).map { (x, y) ->
            when (rotation) {
                90 -> y to (sourceHeight - x)
                180 -> (sourceWidth - x) to (sourceHeight - y)
                270 -> (sourceWidth - y) to x
                else -> x to y
            }
        }
        val left = points.minOf { it.first }.coerceIn(0, sourceWidth - 2).and(-2)
        val top = points.minOf { it.second }.coerceIn(0, sourceHeight - 2).and(-2)
        val right = points.maxOf { it.first }.coerceIn(left + 2, sourceWidth).and(-2)
        val bottom = points.maxOf { it.second }.coerceIn(top + 2, sourceHeight).and(-2)
        return QrCrop(left, top, (right - left).coerceAtLeast(2), (bottom - top).coerceAtLeast(2))
    }

    private fun setQrStatus(text: String) {
        if (::qrStatusText.isInitialized) runOnUiThread { qrStatusText.text = text }
    }

    private fun setTelemetryStatus(text: String) {
        telemetrySourceStatus = text
        renderTelemetryStatus()
    }

    private fun setTelemetryTransportStatus(text: String?) {
        telemetryTransportStatus = text
        renderTelemetryStatus()
    }

    private fun setTelemetryIdentityWarning(text: String?) {
        telemetryIdentityWarning = text
        renderTelemetryStatus()
    }

    private fun renderTelemetryStatus() {
        if (!::telemetryStatusText.isInitialized) return
        val text = listOfNotNull(telemetryIdentityWarning, telemetrySourceStatus, telemetryTransportStatus)
            .joinToString("\n")
        runOnUiThread { telemetryStatusText.text = text }
    }

    private fun stopStreaming() {
        if (!streaming.getAndSet(false)) return
        cameraProvider?.unbindAll()
        cameraProvider = null
        camera = null
        updateZoomStatus()
        telemetryReplaySource?.stop()
        telemetryReplaySource = null
        activeSessionContext = null
        publisher?.dispose()
        publisher = null
        recordingTripIdInput.isEnabled = true
        recordingVehicleIdInput.isEnabled = true
        resolutionSpinner.isEnabled = true
        telemetrySwitch.isEnabled = true
        selectDatasetButton.isEnabled = true
        actualResolutionText.text = ""
        streamButton.setText(R.string.start_streaming)
        setTelemetryTransportStatus(null)
        setTelemetryIdentityWarning(null)
        setTelemetryStatus(
            when {
                !telemetryEnabled -> "Telemetry: disabled"
                selectedTelemetryDataset != null -> "Telemetry: dataset ready"
                else -> "Telemetry: no dataset selected"
            }
        )
        setStatus("Stopped")
    }

    private fun normalizeServerUrl(value: String): String? {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) return null
        val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            trimmed
        } else {
            "https://$trimmed"
        }
        val parsed = Uri.parse(withScheme)
        if (parsed.host.isNullOrBlank() || parsed.port == 0) return null
        return withScheme.trimEnd('/').let {
            if (it.endsWith("/offer/android")) it else "$it/offer/android"
        }
    }

    private fun setStatus(message: String) {
        if (::statusText.isInitialized) statusText.text = message
    }

    private fun updateRecordingContextText() {
        if (!::recordingContextText.isInitialized) return
        val tripText = recordingTripIdInput.text.toString().trim()
        val vehicleText = recordingVehicleIdInput.text.toString().trim()
        if (tripText.isEmpty() && vehicleText.isEmpty()) {
            recordingContextText.text = "No recording IDs. This stream will be live-only."
            return
        }
        val tripId = tripText.toLongOrNull()?.takeIf { it > 0 }
        val vehicleId = vehicleText.toLongOrNull()?.takeIf { it > 0 }
        if (tripId == null || vehicleId == null) {
            recordingContextText.text = "Enter positive Trip ID and Vehicle ID values to enable recording."
            return
        }
        recordingContextText.text = "Will send to relay: Trip ID $tripId · Vehicle ID $vehicleId"
    }

    override fun onStop() {
        // CameraX and the publisher are stopped while Android has the screen
        // locked or the app is backgrounded. Remember the operator's intent so
        // the stream (and its map GPS marker) comes back automatically on wake.
        resumeStreamOnForeground = streaming.get()
        stopStreaming()
        super.onStop()
    }

    override fun onDestroy() {
        qrScanner.close()
        cameraExecutor.shutdownNow()
        telemetryIoExecutor.shutdownNow()
        super.onDestroy()
    }
}
