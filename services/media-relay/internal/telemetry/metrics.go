package telemetry

import (
	"log"
	"sync"
	"sync/atomic"
	"time"
)

type Metrics struct {
	BatchesReceived     atomic.Uint64
	BatchesInvalid      atomic.Uint64
	IdentityMismatch    atomic.Uint64
	StaleOrUnidentified atomic.Uint64
	GPSSamples          atomic.Uint64
	IMUSamples          atomic.Uint64
	NodeJobs            atomic.Uint64
	NodeFailures        atomic.Uint64
	NodeDropped         atomic.Uint64
	VisionForwarded     atomic.Uint64
	VisionDropped       atomic.Uint64
	VisionFailures      atomic.Uint64
}

// MetricsSnapshot uses the metric names from the implementation plan.
type MetricsSnapshot struct {
	BatchesReceivedTotal        uint64 `json:"telemetry_batches_received_total"`
	BatchesInvalidTotal         uint64 `json:"telemetry_batches_invalid_total"`
	IdentityMismatchTotal       uint64 `json:"telemetry_identity_mismatch_total"`
	StaleOrUnidentifiedTotal    uint64 `json:"telemetry_stale_or_unidentified_total"`
	GPSSamplesTotal             uint64 `json:"telemetry_gps_samples_total"`
	IMUSamplesTotal             uint64 `json:"telemetry_imu_samples_total"`
	StoreSessions               int    `json:"telemetry_store_sessions"`
	NodeQueueDepth              int    `json:"telemetry_node_queue_depth"`
	GPSPersistenceJobsTotal     uint64 `json:"gps_persistence_jobs_total"`
	GPSPersistenceFailuresTotal uint64 `json:"gps_persistence_failures_total"`
	DroppedGPSPersistenceTotal  uint64 `json:"dropped_gps_persistence_total"`
	VisionQueueDepth            int    `json:"telemetry_vision_queue_depth"`
	VisionForwardedTotal        uint64 `json:"telemetry_batches_forwarded_vision_total"`
	VisionDroppedTotal          uint64 `json:"telemetry_batches_dropped_vision_total"`
	VisionFailuresTotal         uint64 `json:"telemetry_vision_failures_total"`
}

// rateLimitedLogger keeps a misbehaving publisher from flooding the relay log
// at DataChannel message rate.
type rateLimitedLogger struct {
	mu       sync.Mutex
	interval time.Duration
	last     map[string]time.Time
	now      func() time.Time
}

func newRateLimitedLogger(interval time.Duration) *rateLimitedLogger {
	return &rateLimitedLogger{interval: interval, last: make(map[string]time.Time), now: time.Now}
}

func (l *rateLimitedLogger) Printf(key, format string, args ...any) {
	l.mu.Lock()
	now := l.now()
	if previous, ok := l.last[key]; ok && now.Sub(previous) < l.interval {
		l.mu.Unlock()
		return
	}
	l.last[key] = now
	l.mu.Unlock()
	log.Printf(format, args...)
}
