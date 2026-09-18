package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type statusError struct{ status int }

func (e statusError) Error() string   { return "status" }
func (e statusError) StatusCode() int { return e.status }

type recordingPoster struct {
	mu       sync.Mutex
	paths    []string
	bodies   []nodeGPSRequest
	failures []error
}

func (p *recordingPoster) PostJSON(_ context.Context, path string, value any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.paths = append(p.paths, path)
	p.bodies = append(p.bodies, value.(nodeGPSRequest))
	if len(p.failures) > 0 {
		err := p.failures[0]
		p.failures = p.failures[1:]
		return err
	}
	return nil
}

func newTestNodeSink(poster JSONPoster, capacity int) *NodeSink {
	sink := NewNodeSink(poster, capacity, &Metrics{})
	sink.sleep = func(context.Context, time.Duration) bool { return true }
	return sink
}

func TestNodeSinkForwardsGPSOnlyWithTrustedIdentityAndMode(t *testing.T) {
	poster := &recordingPoster{}
	sink := newTestNodeSink(poster, 8)
	receivedAt := time.Date(2026, 9, 18, 2, 40, 15, 123_000_000, time.UTC)
	utc := int64(1787803384795)
	fix := gpsAt(1445245922681115, 35.1)
	fix.UTCEpochMS = &utc
	sink.Enqueue(Accepted{Identity: identityA, Mode: ModeReplay, ReceivedAt: receivedAt, IMU: []IMUSample{{TimestampNS: 1}}})
	if sink.QueueDepth() != 0 {
		t.Fatal("IMU-only batches must not create GPS persistence jobs")
	}
	sink.Enqueue(Accepted{Identity: identityA, Mode: ModeReplay, ReceivedAt: receivedAt, GPS: []GPSSample{fix}})
	sink.Enqueue(Accepted{Identity: identityA, Mode: ModeLive, ReceivedAt: receivedAt, GPS: []GPSSample{fix}})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { sink.Run(ctx); close(done) }()
	waitFor(t, func() bool { poster.mu.Lock(); defer poster.mu.Unlock(); return len(poster.bodies) == 2 })
	cancel()
	<-done

	request := poster.bodies[0]
	if poster.paths[0] != "/internal/telemetry/gps" || request.TripID != "1" || request.VehicleID != "3" || request.RecordingSessionID != "S1" {
		t.Fatalf("unexpected request: %s %+v", poster.paths[0], request)
	}
	if request.Mode != ModeReplay || poster.bodies[1].Mode != ModeLive {
		t.Fatal("mode must be forwarded so Node can map REPLAY->RECORDED_GPS and LIVE->DEVICE_GPS")
	}
	encoded, _ := json.Marshal(request)
	var generic map[string]any
	_ = json.Unmarshal(encoded, &generic)
	sample := generic["samples"].([]any)[0].(map[string]any)
	if sample["sourceTimestampNs"] != "1445245922681115" || sample["utcEpochMs"] != "1787803384795" {
		t.Fatalf("64-bit values must be JSON strings: %s", encoded)
	}
	if generic["receivedAt"] != "2026-09-18T02:40:15.123Z" {
		t.Fatalf("receivedAt not encoded: %v", generic["receivedAt"])
	}
	if ModeReplay.TelemetrySource() != "RECORDED_GPS" || ModeLive.TelemetrySource() != "DEVICE_GPS" {
		t.Fatal("mode mapping changed")
	}
}

func TestNodeSinkRetriesTransientFailuresOnly(t *testing.T) {
	poster := &recordingPoster{failures: []error{errors.New("connection refused"), statusError{503}}}
	sink := newTestNodeSink(poster, 8)
	if err := sink.deliver(context.Background(), gpsJob{identity: identityA, mode: ModeReplay, samples: []GPSSample{gpsAt(1, 1)}}); err != nil {
		t.Fatalf("transient failures should be retried to success: %v", err)
	}
	if len(poster.bodies) != 3 {
		t.Fatalf("expected 3 attempts, got %d", len(poster.bodies))
	}

	rejected := &recordingPoster{failures: []error{statusError{409}}}
	sink = newTestNodeSink(rejected, 8)
	if err := sink.deliver(context.Background(), gpsJob{identity: identityA, samples: []GPSSample{gpsAt(1, 1)}}); err == nil {
		t.Fatal("a rejected observation should fail")
	}
	if len(rejected.bodies) != 1 {
		t.Fatalf("4xx rejection must not be retried, got %d attempts", len(rejected.bodies))
	}
}

func TestNodeSinkQueueIsBoundedAndDropsOldest(t *testing.T) {
	sink := newTestNodeSink(&recordingPoster{}, 2)
	for ts := int64(1); ts <= 3; ts++ {
		sink.Enqueue(Accepted{Identity: identityA, Mode: ModeReplay, GPS: []GPSSample{gpsAt(ts, 1)}})
	}
	if sink.QueueDepth() != 2 || sink.metrics.NodeDropped.Load() != 1 {
		t.Fatalf("queue depth=%d dropped=%d", sink.QueueDepth(), sink.metrics.NodeDropped.Load())
	}
	job, _ := sink.queue.Pop(context.Background())
	if job.samples[0].TimestampNS != 2 {
		t.Fatalf("oldest job should be dropped first, next was %d", job.samples[0].TimestampNS)
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met before timeout")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
