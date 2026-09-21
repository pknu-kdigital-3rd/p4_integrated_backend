package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var minioBucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

type Config struct {
	RelayListenAddr      string
	TurnURL              string
	TurnUsername         string
	TurnPassword         string
	YoloFeedSocketPath   string
	PythonAndroidLiveURL string
	BacklogMaxSeconds    float64
	BacklogMaxBytes      int64
	MetricsInterval      time.Duration
	PprofAddr            string

	RecordingEnabled        bool
	RecordingSegmentSeconds int
	RecordingQueueFrames    int
	RecordingUploadQueue    int
	RecordingSpoolDir       string
	RecordingSpoolMaxBytes  int64
	MinioEndpoint           string
	MinioAccessKey          string
	MinioSecretKey          string
	MinioUseSSL             bool
	MinioRecordingBucket    string
	NodeInternalBaseURL     string
	NodeInternalToken       string

	// Android telemetry needs a Node-validated trip/vehicle/session even when
	// video recording is disabled, so identity validation is enabled whenever
	// either feature is.
	AndroidTelemetryEnabled bool
	PythonTelemetryURL      string
	TelemetryNodeQueue      int
	TelemetryVisionQueue    int
	TelemetryCurrentMaxAge  time.Duration
}

// NodeInternalRequired reports whether a Node internal client must exist.
func (c Config) NodeInternalRequired() bool {
	return c.RecordingEnabled || c.AndroidTelemetryEnabled
}

func Load() (Config, error) {
	cfg := Config{
		RelayListenAddr: env("RELAY_LISTEN_ADDR", "127.0.0.1:39012"),
		// An explicitly empty TURN_URL is meaningful: it disables the TURN
		// server and leaves ICE to direct host candidates. Keep the default
		// for deployments that do not set the variable at all.
		TurnURL:      envAllowEmpty("TURN_URL", "turn:10.174.96.119:39004?transport=udp"),
		TurnUsername: env("TURN_USERNAME", "user"),
		TurnPassword: env("TURN_PASSWORD", "pass"),
		// A filesystem path, not host:port - renamed from the old
		// YOLO_FEED_ADDR (TCP) so a stale env var fails loudly instead of
		// being silently misinterpreted as a path.
		YoloFeedSocketPath:      env("YOLO_FEED_SOCKET", "/tmp/poc-relay-yolo.sock"),
		PythonAndroidLiveURL:    env("PY_ANDROID_LIVE_URL", "http://127.0.0.1:39011/internal/android-live"),
		BacklogMaxSeconds:       envFloat("BACKLOG_MAX_SECONDS", 30),
		BacklogMaxBytes:         envInt64("BACKLOG_MAX_BYTES", 256*1024*1024),
		MetricsInterval:         time.Duration(envFloat("RELAY_METRICS_INTERVAL_SECONDS", 5) * float64(time.Second)),
		PprofAddr:               env("RELAY_PPROF_ADDR", ""),
		RecordingSegmentSeconds: 60,
		RecordingQueueFrames:    180,
		RecordingUploadQueue:    8,
		RecordingSpoolDir:       filepath.Join(os.TempDir(), "p4-recordings"),
		RecordingSpoolMaxBytes:  10 * 1024 * 1024 * 1024,
		MinioEndpoint:           env("MINIO_ENDPOINT", "127.0.0.1:9000"),
		MinioAccessKey:          os.Getenv("MINIO_ACCESS_KEY"),
		MinioSecretKey:          os.Getenv("MINIO_SECRET_KEY"),
		MinioRecordingBucket:    env("MINIO_RECORDING_BUCKET", "p4-trip-recordings"),
		NodeInternalBaseURL:     env("NODE_INTERNAL_BASE_URL", "http://127.0.0.1:3000"),
		NodeInternalToken:       os.Getenv("NODE_INTERNAL_SERVICE_TOKEN"),
		PythonTelemetryURL:      env("PY_TELEMETRY_URL", "http://127.0.0.1:39011/internal/telemetry"),
		TelemetryNodeQueue:      512,
		TelemetryVisionQueue:    64,
		TelemetryCurrentMaxAge:  30 * time.Second,
	}
	var parseErrors []error

	if value, ok := os.LookupEnv("ANDROID_TELEMETRY_ENABLED"); ok {
		parsed, err := parseBool("ANDROID_TELEMETRY_ENABLED", value)
		if err != nil {
			parseErrors = append(parseErrors, err)
		} else {
			cfg.AndroidTelemetryEnabled = parsed
		}
	}
	if value, ok := os.LookupEnv("TELEMETRY_NODE_QUEUE"); ok {
		parsed, err := parseInt("TELEMETRY_NODE_QUEUE", value)
		if err != nil {
			parseErrors = append(parseErrors, err)
		} else {
			cfg.TelemetryNodeQueue = parsed
		}
	}
	if value, ok := os.LookupEnv("TELEMETRY_VISION_QUEUE"); ok {
		parsed, err := parseInt("TELEMETRY_VISION_QUEUE", value)
		if err != nil {
			parseErrors = append(parseErrors, err)
		} else {
			cfg.TelemetryVisionQueue = parsed
		}
	}
	if value, ok := os.LookupEnv("TELEMETRY_CURRENT_MAX_AGE_SECONDS"); ok {
		parsed, err := parseInt("TELEMETRY_CURRENT_MAX_AGE_SECONDS", value)
		if err != nil {
			parseErrors = append(parseErrors, err)
		} else {
			cfg.TelemetryCurrentMaxAge = time.Duration(parsed) * time.Second
		}
	}

	if value, ok := os.LookupEnv("RECORDING_ENABLED"); ok {
		parsed, err := parseBool("RECORDING_ENABLED", value)
		if err != nil {
			parseErrors = append(parseErrors, err)
		} else {
			cfg.RecordingEnabled = parsed
		}
	}
	if value, ok := os.LookupEnv("RECORDING_SEGMENT_SECONDS"); ok {
		parsed, err := parseInt("RECORDING_SEGMENT_SECONDS", value)
		if err != nil {
			parseErrors = append(parseErrors, err)
		} else {
			cfg.RecordingSegmentSeconds = parsed
		}
	}
	if value, ok := os.LookupEnv("RECORDING_QUEUE_FRAMES"); ok {
		parsed, err := parseInt("RECORDING_QUEUE_FRAMES", value)
		if err != nil {
			parseErrors = append(parseErrors, err)
		} else {
			cfg.RecordingQueueFrames = parsed
		}
	}
	if value, ok := os.LookupEnv("RECORDING_UPLOAD_QUEUE"); ok {
		parsed, err := parseInt("RECORDING_UPLOAD_QUEUE", value)
		if err != nil {
			parseErrors = append(parseErrors, err)
		} else {
			cfg.RecordingUploadQueue = parsed
		}
	}
	if value, ok := os.LookupEnv("RECORDING_SPOOL_DIR"); ok {
		cfg.RecordingSpoolDir = strings.TrimSpace(value)
	}
	if value, ok := os.LookupEnv("RECORDING_SPOOL_MAX_BYTES"); ok {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			parseErrors = append(parseErrors, fmt.Errorf("RECORDING_SPOOL_MAX_BYTES must be an integer: %w", err))
		} else {
			cfg.RecordingSpoolMaxBytes = parsed
		}
	}
	if value, ok := os.LookupEnv("MINIO_USE_SSL"); ok {
		parsed, err := parseBool("MINIO_USE_SSL", value)
		if err != nil {
			parseErrors = append(parseErrors, err)
		} else {
			cfg.MinioUseSSL = parsed
		}
	}
	if len(parseErrors) > 0 {
		return cfg, errors.Join(parseErrors...)
	}
	if err := cfg.Validate(); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	var validationErrors []error
	if c.RecordingEnabled {
		validationErrors = append(validationErrors, c.validateRecording()...)
	}
	if c.AndroidTelemetryEnabled {
		validationErrors = append(validationErrors, c.validateTelemetry()...)
	}
	if c.NodeInternalRequired() {
		validationErrors = append(validationErrors, c.validateNodeInternal()...)
	}
	return errors.Join(validationErrors...)
}

func (c Config) validateTelemetry() []error {
	var validationErrors []error
	parsedURL, err := url.Parse(c.PythonTelemetryURL)
	if err != nil || parsedURL == nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.Host == "" {
		validationErrors = append(validationErrors, errors.New("PY_TELEMETRY_URL must be an absolute http(s) URL"))
	}
	if c.TelemetryNodeQueue < 1 || c.TelemetryNodeQueue > 100000 {
		validationErrors = append(validationErrors, errors.New("TELEMETRY_NODE_QUEUE must be between 1 and 100000"))
	}
	if c.TelemetryVisionQueue < 1 || c.TelemetryVisionQueue > 10000 {
		validationErrors = append(validationErrors, errors.New("TELEMETRY_VISION_QUEUE must be between 1 and 10000"))
	}
	if c.TelemetryCurrentMaxAge < time.Second || c.TelemetryCurrentMaxAge > time.Hour {
		validationErrors = append(validationErrors, errors.New("TELEMETRY_CURRENT_MAX_AGE_SECONDS must be between 1 and 3600"))
	}
	return validationErrors
}

func (c Config) validateNodeInternal() []error {
	var validationErrors []error
	parsedURL, err := url.Parse(c.NodeInternalBaseURL)
	if err != nil || parsedURL == nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.Host == "" || parsedURL.RawQuery != "" || parsedURL.Fragment != "" {
		validationErrors = append(validationErrors, errors.New("NODE_INTERNAL_BASE_URL must be an absolute http(s) URL without query or fragment"))
	}
	if len(c.NodeInternalToken) < 32 {
		validationErrors = append(validationErrors, errors.New("NODE_INTERNAL_SERVICE_TOKEN must contain at least 32 characters"))
	} else if strings.HasPrefix(c.NodeInternalToken, "replace-") {
		validationErrors = append(validationErrors, errors.New("NODE_INTERNAL_SERVICE_TOKEN must be replaced before recording or Android telemetry is enabled"))
	}
	return validationErrors
}

func (c Config) validateRecording() []error {
	var validationErrors []error
	if c.RecordingSegmentSeconds < 1 || c.RecordingSegmentSeconds > 3600 {
		validationErrors = append(validationErrors, errors.New("RECORDING_SEGMENT_SECONDS must be between 1 and 3600"))
	}
	if c.RecordingQueueFrames < 1 || c.RecordingQueueFrames > 10000 {
		validationErrors = append(validationErrors, errors.New("RECORDING_QUEUE_FRAMES must be between 1 and 10000"))
	}
	if c.RecordingUploadQueue < 1 || c.RecordingUploadQueue > 1024 {
		validationErrors = append(validationErrors, errors.New("RECORDING_UPLOAD_QUEUE must be between 1 and 1024"))
	}
	if strings.TrimSpace(c.RecordingSpoolDir) == "" {
		validationErrors = append(validationErrors, errors.New("RECORDING_SPOOL_DIR is required when recording is enabled"))
	}
	if c.RecordingSpoolMaxBytes < 1 {
		validationErrors = append(validationErrors, errors.New("RECORDING_SPOOL_MAX_BYTES must be positive"))
	}
	if len(strings.TrimSpace(c.MinioAccessKey)) < 3 || len(strings.TrimSpace(c.MinioSecretKey)) < 12 {
		validationErrors = append(validationErrors, errors.New("MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required when recording is enabled"))
	}
	if strings.HasPrefix(c.MinioSecretKey, "replace-") {
		validationErrors = append(validationErrors, errors.New("MINIO_SECRET_KEY must be replaced before recording is enabled"))
	}
	if !minioBucketPattern.MatchString(c.MinioRecordingBucket) || strings.Contains(c.MinioRecordingBucket, "..") {
		validationErrors = append(validationErrors, errors.New("MINIO_RECORDING_BUCKET must be a valid 3-63 character S3 bucket name"))
	}
	if host, port, err := net.SplitHostPort(c.MinioEndpoint); err != nil || host == "" || port == "" {
		validationErrors = append(validationErrors, errors.New("MINIO_ENDPOINT must be a host:port address"))
	} else if numericPort, err := strconv.Atoi(port); err != nil || numericPort < 1 || numericPort > 65535 {
		validationErrors = append(validationErrors, errors.New("MINIO_ENDPOINT port must be between 1 and 65535"))
	}
	return validationErrors
}

func parseBool(name, value string) (bool, error) {
	if value != "true" && value != "false" {
		return false, fmt.Errorf("%s must be true or false", name)
	}
	return value == "true", nil
}

func parseInt(name, value string) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", name, err)
	}
	return parsed, nil
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// envAllowEmpty distinguishes an explicitly empty environment variable from
// an unset one. This is needed for optional settings such as TURN_URL where an
// empty value is the documented way to disable the feature.
func envAllowEmpty(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok {
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
