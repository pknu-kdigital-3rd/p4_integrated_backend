package telemetry

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"
)

const (
	DefaultNodeQueue   = 512
	nodeGPSPath        = "/internal/telemetry/gps"
	nodeRetryBase      = 250 * time.Millisecond
	nodeRetryMax       = 5 * time.Second
	nodeMaxAttempts    = 8
	nodeRequestTimeout = 5 * time.Second
)

// JSONPoster posts to a path on the Node internal API with service
// authentication. recording.NodeClient implements it.
type JSONPoster interface {
	PostJSON(ctx context.Context, path string, value any) error
}

// StatusCoder is implemented by errors that carry an HTTP status.
type StatusCoder interface {
	StatusCode() int
}

type gpsJob struct {
	identity   StreamIdentity
	mode       Mode
	receivedAt time.Time
	samples    []GPSSample
}

type nodeGPSSample struct {
	SourceTimestampNS   string   `json:"sourceTimestampNs"`
	UTCEpochMS          *string  `json:"utcEpochMs"`
	Latitude            float64  `json:"latitude"`
	Longitude           float64  `json:"longitude"`
	AltitudeM           *float64 `json:"altitudeM"`
	SpeedMPS            *float64 `json:"speedMps"`
	BearingDeg          *float64 `json:"bearingDeg"`
	HorizontalAccuracyM *float64 `json:"horizontalAccuracyM"`
}

type nodeGPSRequest struct {
	Mode               Mode            `json:"mode"`
	TripID             string          `json:"tripId"`
	VehicleID          string          `json:"vehicleId"`
	RecordingSessionID string          `json:"recordingSessionId"`
	ReceivedAt         string          `json:"receivedAt"`
	Samples            []nodeGPSSample `json:"samples"`
}

// NodeSink persists authoritative GPS fixes through Node as they arrive, so
// history never depends on a browser polling the tracking API. GPS is ~1 Hz, so
// the default queue holds several minutes of fixes during a Node outage.
type NodeSink struct {
	poster  JSONPoster
	queue   *boundedQueue[gpsJob]
	metrics *Metrics
	logs    *rateLimitedLogger
	sleep   func(context.Context, time.Duration) bool
}

func NewNodeSink(poster JSONPoster, capacity int, metrics *Metrics) *NodeSink {
	return &NodeSink{
		poster:  poster,
		queue:   newBoundedQueue(capacity, evictOldest[gpsJob]),
		metrics: metrics,
		logs:    newRateLimitedLogger(5 * time.Second),
		sleep:   sleepContext,
	}
}

func (s *NodeSink) Enqueue(accepted Accepted) {
	if len(accepted.GPS) == 0 {
		return
	}
	job := gpsJob{
		identity:   accepted.Identity,
		mode:       accepted.Mode,
		receivedAt: accepted.ReceivedAt,
		samples:    append([]GPSSample(nil), accepted.GPS...),
	}
	if s.queue.Push(job) {
		s.metrics.NodeDropped.Add(1)
		s.logs.Printf("node-drop", "telemetry: GPS persistence queue full; dropped oldest job (dropped_gps_persistence_total=%d)", s.metrics.NodeDropped.Load())
	}
}

func (s *NodeSink) QueueDepth() int { return s.queue.Len() }

func (s *NodeSink) Run(ctx context.Context) {
	for {
		job, ok := s.queue.Pop(ctx)
		if !ok {
			return
		}
		s.metrics.NodeJobs.Add(1)
		if err := s.deliver(ctx, job); err != nil {
			s.metrics.NodeFailures.Add(1)
			s.logs.Printf("node-fail", "telemetry: GPS persistence failed for session %s: %v", job.identity.RecordingSessionID, err)
		}
	}
}

func (s *NodeSink) deliver(ctx context.Context, job gpsJob) error {
	request := buildNodeRequest(job)
	delay := nodeRetryBase
	var lastErr error
	for attempt := 0; attempt < nodeMaxAttempts; attempt++ {
		requestContext, cancel := context.WithTimeout(ctx, nodeRequestTimeout)
		lastErr = s.poster.PostJSON(requestContext, nodeGPSPath, request)
		cancel()
		if lastErr == nil || !retryable(lastErr) {
			return lastErr
		}
		if !s.sleep(ctx, delay) {
			return lastErr
		}
		delay = min(delay*2, nodeRetryMax)
	}
	return lastErr
}

// retryable treats network errors, timeouts, 408, 429 and 5xx as transient.
// Other 4xx responses mean Node rejected the observation itself (for example
// a trip/vehicle mismatch), so retrying cannot succeed.
func retryable(err error) bool {
	var coded StatusCoder
	if errors.As(err, &coded) {
		status := coded.StatusCode()
		return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= 500
	}
	return !errors.Is(err, context.Canceled)
}

func buildNodeRequest(job gpsJob) nodeGPSRequest {
	samples := make([]nodeGPSSample, 0, len(job.samples))
	for _, sample := range job.samples {
		var utc *string
		if sample.UTCEpochMS != nil {
			value := strconv.FormatInt(*sample.UTCEpochMS, 10)
			utc = &value
		}
		samples = append(samples, nodeGPSSample{
			SourceTimestampNS:   strconv.FormatInt(sample.TimestampNS, 10),
			UTCEpochMS:          utc,
			Latitude:            sample.Latitude,
			Longitude:           sample.Longitude,
			AltitudeM:           sample.AltitudeM,
			SpeedMPS:            sample.SpeedMPS,
			BearingDeg:          sample.BearingDeg,
			HorizontalAccuracyM: sample.HorizontalAccuracyM,
		})
	}
	return nodeGPSRequest{
		Mode:               job.mode,
		TripID:             job.identity.tripString(),
		VehicleID:          job.identity.vehicleString(),
		RecordingSessionID: job.identity.RecordingSessionID,
		ReceivedAt:         formatUTC(job.receivedAt),
		Samples:            samples,
	}
}

func sleepContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
