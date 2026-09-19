package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	_ "net/http/pprof"

	"github.com/pion/webrtc/v4"

	"poc-server-webrtc/relay-go/internal/broadcaster"
	"poc-server-webrtc/relay-go/internal/config"
	"poc-server-webrtc/relay-go/internal/recording"
	"poc-server-webrtc/relay-go/internal/signaling"
	"poc-server-webrtc/relay-go/internal/telemetry"
	"poc-server-webrtc/relay-go/internal/yolofeed"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("configuration: %v", err)
	}
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		log.Fatalf("register codecs: %v", err)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))

	iceServers := []webrtc.ICEServer{}
	if cfg.TurnURL != "" {
		iceServers = append(iceServers, webrtc.ICEServer{
			URLs:       []string{cfg.TurnURL},
			Username:   cfg.TurnUsername,
			Credential: cfg.TurnPassword,
		})
	}
	configuration := webrtc.Configuration{ICEServers: iceServers}

	feed := yolofeed.NewWithLimits(cfg.YoloFeedSocketPath, cfg.BacklogMaxSeconds, cfg.BacklogMaxBytes)
	var recorderInstance *recording.Recorder
	var nodeClient *recording.NodeClient
	if cfg.NodeInternalRequired() {
		nodeClient, err = recording.NewNodeClient(cfg.NodeInternalBaseURL, cfg.NodeInternalToken)
		if err != nil {
			log.Fatalf("Node internal client: %v", err)
		}
	}
	if cfg.RecordingEnabled {
		store, err := recording.NewMinioStore(cfg.MinioEndpoint, cfg.MinioAccessKey, cfg.MinioSecretKey, cfg.MinioUseSSL)
		if err != nil {
			log.Fatalf("recording MinIO client: %v", err)
		}
		recorderInstance, err = recording.New(recording.Config{
			SegmentDuration: time.Duration(cfg.RecordingSegmentSeconds) * time.Second,
			QueueFrames:     cfg.RecordingQueueFrames,
			UploadQueue:     cfg.RecordingUploadQueue,
			SpoolDir:        cfg.RecordingSpoolDir,
			SpoolMaxBytes:   cfg.RecordingSpoolMaxBytes,
			Bucket:          cfg.MinioRecordingBucket,
		}, store, nodeClient, nil)
		if err != nil {
			log.Fatalf("recording spool: %v", err)
		}
		log.Printf("recording enabled: bucket=%s segment_seconds=%d spool=%s", cfg.MinioRecordingBucket, cfg.RecordingSegmentSeconds, cfg.RecordingSpoolDir)
	}

	relay := broadcaster.New(feed, func(live bool) {
		if err := notifyPython(cfg.PythonAndroidLiveURL, live); err != nil {
			log.Printf("notify Python android_live=%t: %v", live, err)
		}
	}, recorderInstance)
	if recorderInstance != nil {
		recorderInstance.SetRequestKeyframe(relay.RequestKeyFrame)
	}

	telemetryContext, stopTelemetry := context.WithCancel(context.Background())
	defer stopTelemetry()
	var telemetryService *telemetry.Service
	if cfg.AndroidTelemetryEnabled {
		metrics := &telemetry.Metrics{}
		telemetryService = telemetry.NewService(
			telemetry.NewStore(cfg.TelemetryCurrentMaxAge),
			telemetry.NewNodeSink(nodeClient, cfg.TelemetryNodeQueue, metrics),
			telemetry.NewVisionSink(telemetry.HTTPPoster{
				URL:    cfg.PythonTelemetryURL,
				Client: &http.Client{Timeout: 3 * time.Second},
			}, cfg.TelemetryVisionQueue, metrics),
			metrics,
		)
		telemetryService.Run(telemetryContext)
		relay.SetTelemetry(telemetryService)
		log.Printf("android telemetry enabled: vision=%s node=%s", cfg.PythonTelemetryURL, cfg.NodeInternalBaseURL)
	} else {
		log.Printf("android telemetry disabled: set ANDROID_TELEMETRY_ENABLED=true to accept telemetry-events")
	}

	// Wired up before Run() starts accepting, so every Python feed reconnect
	// triggers a fresh keyframe for a decodable epoch.
	feed.OnClientConnect = relay.RequestKeyFrame
	feed.OnResync = relay.RequestKeyFrame
	startDiagnostics(cfg, feed, recorderInstance, telemetryService)
	go func() {
		if err := feed.Run(); err != nil {
			log.Fatalf("YOLO feed: %v", err)
		}
	}()
	var validator recording.ContextValidator
	if nodeClient != nil {
		validator = nodeClient
	}
	handler := signaling.NewHandler(api, configuration, relay, validator)
	handler.SetTelemetry(telemetryService)
	server := &http.Server{
		Addr:              cfg.RelayListenAddr,
		Handler:           handler.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	shutdownContext, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	serverErrors := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErrors <- err
		}
	}()
	log.Printf("Pion relay listening on %s", cfg.RelayListenAddr)
	select {
	case <-shutdownContext.Done():
		log.Printf("relay shutdown signal received")
	case err := <-serverErrors:
		log.Printf("relay HTTP server failed: %v", err)
	}
	shutdownTimeout, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	if err := server.Shutdown(shutdownTimeout); err != nil {
		log.Printf("relay HTTP shutdown: %v", err)
	}
	relay.Close()
	if recorderInstance != nil {
		if err := recorderInstance.Close(); err != nil {
			log.Printf("recording shutdown: %v", err)
		}
	}
}

func startDiagnostics(cfg config.Config, feed *yolofeed.Feed, recorderInstance *recording.Recorder, telemetryService *telemetry.Service) {
	if cfg.MetricsInterval > 0 {
		go logRuntimeMetrics(feed, recorderInstance, cfg.MetricsInterval)
		if telemetryService != nil {
			go logTelemetryMetrics(telemetryService, cfg.MetricsInterval)
		}
	}
	if cfg.PprofAddr != "" {
		go func() {
			log.Printf("relay pprof listening on %s", cfg.PprofAddr)
			if err := http.ListenAndServe(cfg.PprofAddr, nil); err != nil {
				log.Printf("relay pprof stopped: %v", err)
			}
		}()
	}
}

func logRuntimeMetrics(feed *yolofeed.Feed, recorderInstance *recording.Recorder, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		epoch, backlogFrames, backlogBytes := feed.Stats()
		recordingStatus := recording.Status{Enabled: false}
		if recorderInstance != nil {
			recordingStatus = recorderInstance.Status()
		}
		log.Printf(
			"[relay-mem] epoch=%d backlog=%d frames backlog_bytes=%d "+
				"heap_alloc=%dMiB heap_inuse=%dMiB heap_objects=%d "+
				"total_alloc=%dMiB mallocs=%d frees=%d num_gc=%d pause_total=%s "+
				"recording_active=%t recording_session_id=%s recording_segment_index=%v "+
				"recording_segment_frames=%d recording_segment_bytes=%d "+
				"recording_queue_depth=%d recording_upload_queue_depth=%d recording_spool_bytes=%d "+
				"recording_segments_uploaded_total=%d recording_upload_failures_total=%d "+
				"recording_dropped_segments_total=%d recording_last_upload_ms=%d",
			epoch,
			backlogFrames,
			backlogBytes,
			mem.HeapAlloc/(1024*1024),
			mem.HeapInuse/(1024*1024),
			mem.HeapObjects,
			mem.TotalAlloc/(1024*1024),
			mem.Mallocs,
			mem.Frees,
			mem.NumGC,
			time.Duration(mem.PauseTotalNs),
			recordingStatus.Active,
			recordingStatus.RecordingSession,
			recordingStatus.SegmentIndex,
			recordingStatus.SegmentFrames,
			recordingStatus.SegmentBytes,
			recordingStatus.InputQueue,
			recordingStatus.UploadQueue,
			recordingStatus.SpoolBytes,
			recordingStatus.UploadedTotal,
			recordingStatus.UploadFailures,
			recordingStatus.DroppedSegments,
			recordingStatus.LastUploadMS,
		)
	}
}

func logTelemetryMetrics(service *telemetry.Service, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		m := service.Metrics()
		log.Printf(
			"[relay-telemetry] telemetry_batches_received_total=%d telemetry_batches_invalid_total=%d "+
				"telemetry_identity_mismatch_total=%d telemetry_stale_or_unidentified_total=%d "+
				"telemetry_gps_samples_total=%d telemetry_imu_samples_total=%d telemetry_store_sessions=%d "+
				"telemetry_node_queue_depth=%d gps_persistence_jobs_total=%d telemetry_node_failures_total=%d "+
				"dropped_gps_persistence_total=%d telemetry_vision_queue_depth=%d "+
				"telemetry_batches_forwarded_vision_total=%d telemetry_vision_dropped_total=%d telemetry_vision_failures_total=%d",
			m.BatchesReceivedTotal, m.BatchesInvalidTotal, m.IdentityMismatchTotal, m.StaleOrUnidentifiedTotal,
			m.GPSSamplesTotal, m.IMUSamplesTotal, m.StoreSessions,
			m.NodeQueueDepth, m.GPSPersistenceJobsTotal, m.GPSPersistenceFailuresTotal,
			m.DroppedGPSPersistenceTotal, m.VisionQueueDepth,
			m.VisionForwardedTotal, m.VisionDroppedTotal, m.VisionFailuresTotal,
		)
	}
}

// notifyPythonClient deliberately disables keep-alive. This call is rare
// (only on android_live edge transitions), so a fresh connection every time
// costs nothing - and avoids the classic net/http race where the pooled
// keep-alive connection is closed by the peer (Python/uvicorn) at the exact
// moment this client tries to reuse it, which surfaces as a bare EOF here
// with no automatic retry.
var notifyPythonClient = &http.Client{
	Timeout:   3 * time.Second,
	Transport: &http.Transport{DisableKeepAlives: true},
}

func notifyPython(url string, live bool) error {
	body, err := json.Marshal(map[string]bool{"live": live})
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := notifyPythonClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &httpError{status: response.StatusCode}
	}
	return nil
}

type httpError struct{ status int }

func (e *httpError) Error() string { return http.StatusText(e.status) }
