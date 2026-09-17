package config

import (
	"testing"
)

func TestRecordingConfigIsStrictAndValidatesRequiredSettings(t *testing.T) {
	t.Setenv("RECORDING_ENABLED", "true")
	t.Setenv("RECORDING_SEGMENT_SECONDS", "30")
	t.Setenv("RECORDING_QUEUE_FRAMES", "64")
	t.Setenv("RECORDING_UPLOAD_QUEUE", "4")
	t.Setenv("RECORDING_SPOOL_DIR", t.TempDir())
	t.Setenv("RECORDING_SPOOL_MAX_BYTES", "1048576")
	t.Setenv("MINIO_ENDPOINT", "127.0.0.1:9000")
	t.Setenv("MINIO_ACCESS_KEY", "relay")
	t.Setenv("MINIO_SECRET_KEY", "relay-secret")
	t.Setenv("MINIO_RECORDING_BUCKET", "p4-trip-recordings")
	t.Setenv("NODE_INTERNAL_BASE_URL", "http://127.0.0.1:3000")
	t.Setenv("NODE_INTERNAL_SERVICE_TOKEN", "0123456789abcdef0123456789abcdef")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.RecordingEnabled || cfg.RecordingSegmentSeconds != 30 || cfg.RecordingQueueFrames != 64 {
		t.Fatalf("recording settings were not parsed: %+v", cfg)
	}

	t.Setenv("RECORDING_SEGMENT_SECONDS", "not-a-number")
	if _, err := Load(); err == nil {
		t.Fatal("invalid recording interval should fail configuration loading")
	}
}
