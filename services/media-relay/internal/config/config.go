package config

import (
	"os"
	"strconv"
)

type Config struct {
	RelayListenAddr      string
	TurnURL              string
	TurnUsername         string
	TurnPassword         string
	YoloFeedSocketPath   string
	PythonAndroidLiveURL string
	BacklogMaxSeconds   float64
	BacklogMaxBytes     int64
}

func Load() Config {
	return Config{
        RelayListenAddr:      env("RELAY_LISTEN_ADDR", "127.0.0.1:39012"),
		TurnURL:              env("TURN_URL", "turn:10.174.96.95:3478?transport=udp"),
		TurnUsername:         env("TURN_USERNAME", "user"),
		TurnPassword:         env("TURN_PASSWORD", "pass"),
		// A filesystem path, not host:port - renamed from the old
		// YOLO_FEED_ADDR (TCP) so a stale env var fails loudly instead of
		// being silently misinterpreted as a path.
		YoloFeedSocketPath:   env("YOLO_FEED_SOCKET", "/tmp/poc-relay-yolo.sock"),
        PythonAndroidLiveURL: env("PY_ANDROID_LIVE_URL", "http://127.0.0.1:39011/internal/android-live"),
		BacklogMaxSeconds:   envFloat("BACKLOG_MAX_SECONDS", 30),
		BacklogMaxBytes:     envInt64("BACKLOG_MAX_BYTES", 256*1024*1024),
	}
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envFloat(name string, fallback float64) float64 {
	if value := os.Getenv(name); value != "" {
		if parsed, err := strconv.ParseFloat(value, 64); err == nil {
			return parsed
		}
	}
	return fallback
}

func envInt64(name string, fallback int64) int64 {
	if value := os.Getenv(name); value != "" {
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
			return parsed
		}
	}
	return fallback
}
