package broadcaster

import (
	"errors"
	"testing"

	"github.com/pion/webrtc/v4"

	"poc-server-webrtc/relay-go/internal/recording"
	"poc-server-webrtc/relay-go/internal/telemetry"
)

const telemetryPayload = `{"type":"telemetry_batch","version":1,"mode":"REPLAY","trip_id":"7","vehicle_id":"3","recording_session_id":"S1",` +
	`"source_clock_ns":1000,"gps":[{"timestamp_ns":1000,"latitude":35.1,"longitude":129.1}],"imu":[]}`

func newPeer(t *testing.T) *webrtc.PeerConnection {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	return pc
}

func newTelemetryBroadcaster(t *testing.T) (*Broadcaster, *telemetry.Service) {
	t.Helper()
	service := telemetry.NewService(telemetry.NewStore(0), nil, nil, &telemetry.Metrics{})
	relay := New(nil, nil, nil)
	relay.SetTelemetry(service)
	return relay, service
}

func installPublisher(relay *Broadcaster, pc *webrtc.PeerConnection, context *recording.Context) {
	identity := StreamIdentity(context)
	relay.mu.Lock()
	relay.publisher = &Publisher{pc: pc, done: make(chan struct{}), identity: identity}
	relay.mu.Unlock()
	if identity != nil {
		relay.telemetry.Activate(*identity)
	}
}

func TestTelemetryFromActivePublisherIsStored(t *testing.T) {
	relay, service := newTelemetryBroadcaster(t)
	pc := newPeer(t)
	context := &recording.Context{TripID: 7, VehicleID: 3, RecordingSessionID: "S1"}
	installPublisher(relay, pc, context)
	if err := relay.HandleTelemetryMessage(pc, StreamIdentity(context), []byte(telemetryPayload)); err != nil {
		t.Fatal(err)
	}
	vehicles := service.Vehicles()
	if len(vehicles) != 1 || vehicles[0].SourceMetadata["tripId"] != "7" {
		t.Fatalf("telemetry was not stored under the trusted identity: %+v", vehicles)
	}
}

func TestTelemetryFromReplacedPeerIsRejected(t *testing.T) {
	relay, service := newTelemetryBroadcaster(t)
	oldPeer, newPeerConnection := newPeer(t), newPeer(t)
	context := &recording.Context{TripID: 7, VehicleID: 3, RecordingSessionID: "S1"}
	installPublisher(relay, newPeerConnection, context)
	err := relay.HandleTelemetryMessage(oldPeer, StreamIdentity(context), []byte(telemetryPayload))
	if !errors.Is(err, telemetry.ErrStalePublisher) {
		t.Fatalf("stale peer telemetry must be rejected, got %v", err)
	}
	if len(service.Vehicles()) != 0 || service.Metrics().StaleOrUnidentifiedTotal != 1 {
		t.Fatal("stale peer must not mutate state and must be counted")
	}
}

func TestTelemetryIdentityMismatchAndMissingIdentityAreRejected(t *testing.T) {
	relay, service := newTelemetryBroadcaster(t)
	pc := newPeer(t)
	context := &recording.Context{TripID: 8, VehicleID: 3, RecordingSessionID: "S1"}
	installPublisher(relay, pc, context)
	if err := relay.HandleTelemetryMessage(pc, StreamIdentity(context), []byte(telemetryPayload)); !errors.Is(err, telemetry.ErrIdentityMismatch) {
		t.Fatalf("payload claiming another trip must be rejected, got %v", err)
	}
	if err := relay.HandleTelemetryMessage(pc, nil, []byte(telemetryPayload)); !errors.Is(err, telemetry.ErrNoIdentity) {
		t.Fatalf("stream without validated identity must not accept telemetry, got %v", err)
	}
	if err := relay.HandleTelemetryMessage(pc, StreamIdentity(context), []byte("{not json")); err == nil {
		t.Fatal("malformed JSON must be rejected")
	}
	metrics := service.Metrics()
	if metrics.IdentityMismatchTotal != 1 || metrics.BatchesInvalidTotal != 1 || len(service.Vehicles()) != 0 {
		t.Fatalf("unexpected metrics: %+v", metrics)
	}
}

func TestUnknownChannelAndDisabledTelemetryAreIgnored(t *testing.T) {
	relay := New(nil, nil, nil)
	pc := newPeer(t)
	channel, err := pc.CreateDataChannel("something-else", nil)
	if err != nil {
		t.Fatal(err)
	}
	relay.HandleDataChannel(pc, nil, channel)
	relay.HandleDataChannel(pc, nil, nil)
	if err := relay.HandleTelemetryMessage(pc, nil, []byte(telemetryPayload)); err != nil {
		t.Fatalf("telemetry disabled should be a no-op, got %v", err)
	}
}
