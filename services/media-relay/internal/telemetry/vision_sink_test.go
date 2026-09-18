package telemetry

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

type capturePoster struct {
	mu     sync.Mutex
	bodies [][]byte
}

func (p *capturePoster) Post(_ context.Context, body []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.bodies = append(p.bodies, body)
	return nil
}

func TestVisionSinkForwardsFullBatchWithTrustedIdentity(t *testing.T) {
	poster := &capturePoster{}
	sink := NewVisionSink(poster, 4, &Metrics{})
	accuracy := 3
	sink.Enqueue(Accepted{
		Identity:   identityA,
		Mode:       ModeReplay,
		SourceNS:   1445245922681115,
		ReceivedAt: time.Now(),
		GPS:        []GPSSample{gpsAt(1445245922681115, 35)},
		IMU:        []IMUSample{{TimestampNS: 1445245922620000, PitchDeg: -3.7, RollDeg: -2.1, YawDeg: -30.7, Accuracy: &accuracy}},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sink.Run(ctx)
	waitFor(t, func() bool { poster.mu.Lock(); defer poster.mu.Unlock(); return len(poster.bodies) == 1 })

	var body map[string]any
	if err := json.Unmarshal(poster.bodies[0], &body); err != nil {
		t.Fatal(err)
	}
	if body["tripId"] != "1" || body["vehicleId"] != "3" || body["recordingSessionId"] != "S1" || body["sourceClockNs"] != "1445245922681115" {
		t.Fatalf("unexpected identity/clock: %v", body)
	}
	gps := body["gps"].([]any)[0].(map[string]any)
	imu := body["imu"].([]any)[0].(map[string]any)
	if gps["timestamp_ns"] != "1445245922681115" || imu["timestamp_ns"] != "1445245922620000" || imu["yaw_deg"] != -30.7 {
		t.Fatalf("samples not preserved: gps=%v imu=%v", gps, imu)
	}
	if sink.metrics.VisionForwarded.Load() != 1 {
		t.Fatal("forwarded metric not incremented")
	}
}

func TestVisionSinkDropsStaleIMUBeforeGPS(t *testing.T) {
	sink := NewVisionSink(&capturePoster{}, 2, &Metrics{})
	gpsBatch := Accepted{Identity: identityA, Mode: ModeReplay, SourceNS: 1, GPS: []GPSSample{gpsAt(1, 1)}}
	imuBatch := func(ts int64) Accepted {
		return Accepted{Identity: identityA, Mode: ModeReplay, SourceNS: ts, IMU: []IMUSample{{TimestampNS: ts}}}
	}
	sink.Enqueue(gpsBatch)
	sink.Enqueue(imuBatch(2))
	sink.Enqueue(imuBatch(3))
	if sink.QueueDepth() != 2 || sink.metrics.VisionDropped.Load() != 1 {
		t.Fatalf("depth=%d dropped=%d", sink.QueueDepth(), sink.metrics.VisionDropped.Load())
	}
	first, _ := sink.queue.Pop(context.Background())
	second, _ := sink.queue.Pop(context.Background())
	if !first.hasGPS || second.hasGPS {
		t.Fatal("the GPS batch must survive; the stale IMU-only batch is dropped")
	}
	var body map[string]any
	_ = json.Unmarshal(second.body, &body)
	if body["sourceClockNs"] != "3" {
		t.Fatalf("the newest IMU batch should be retained, got %v", body["sourceClockNs"])
	}
}
