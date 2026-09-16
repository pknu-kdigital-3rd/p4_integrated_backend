package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"runtime"
	"time"

	_ "net/http/pprof"

	"github.com/pion/webrtc/v4"

	"poc-server-webrtc/relay-go/internal/broadcaster"
	"poc-server-webrtc/relay-go/internal/config"
	"poc-server-webrtc/relay-go/internal/signaling"
	"poc-server-webrtc/relay-go/internal/yolofeed"
)

func main() {
	cfg := config.Load()
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

	relay := broadcaster.New(feed, func(live bool) {
		if err := notifyPython(cfg.PythonAndroidLiveURL, live); err != nil {
			log.Printf("notify Python android_live=%t: %v", live, err)
		}
	})

	// Wired up before Run() starts accepting, so every Python feed reconnect
	// triggers a fresh keyframe for a decodable epoch.
	feed.OnClientConnect = relay.RequestKeyFrame
	feed.OnResync = relay.RequestKeyFrame
	startDiagnostics(cfg, feed)
	go func() {
		if err := feed.Run(); err != nil {
			log.Fatalf("YOLO feed: %v", err)
		}
	}()
	handler := signaling.NewHandler(api, configuration, relay)
	server := &http.Server{
		Addr:              cfg.RelayListenAddr,
		Handler:           handler.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("Pion relay listening on %s", cfg.RelayListenAddr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func startDiagnostics(cfg config.Config, feed *yolofeed.Feed) {
	if cfg.MetricsInterval > 0 {
		go logRuntimeMetrics(feed, cfg.MetricsInterval)
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

func logRuntimeMetrics(feed *yolofeed.Feed, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		epoch, backlogFrames, backlogBytes := feed.Stats()
		log.Printf(
			"[relay-mem] epoch=%d backlog=%d frames backlog_bytes=%d "+
				"heap_alloc=%dMiB heap_inuse=%dMiB heap_objects=%d "+
				"total_alloc=%dMiB mallocs=%d frees=%d num_gc=%d pause_total=%s",
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
