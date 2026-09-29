package broadcaster

import (
	"testing"

	"poc-server-webrtc/relay-go/internal/recording"
)

const tripLessPayload = `{"type":"telemetry_batch","version":1,"mode":"REPLAY","vehicle_id":"3","recording_session_id":"S-live",` +
	`"source_clock_ns":1000,"gps":[{"timestamp_ns":1000,"latitude":35.1,"longitude":129.1}],"imu":[]}`

// Starting a trip mid-stream moves telemetry to the trip's session without a
// new publisher; the old session's batches are then rejected.
func TestIdentityUpdateSwitchesTelemetryInPlace(t *testing.T) {
	relay, service := newTelemetryBroadcaster(t)
	pc := newPeer(t)
	installPublisher(relay, pc, &recording.Context{VehicleID: 3, RecordingSessionID: "S-live"})
	if err := relay.HandleTelemetryMessage(pc, relay.currentIdentity(pc), []byte(tripLessPayload)); err != nil {
		t.Fatalf("trip-less telemetry rejected before the switch: %v", err)
	}

	if !relay.applyIdentity(pc, &recording.Context{TripID: 7, VehicleID: 3, RecordingSessionID: "S1"}) {
		t.Fatal("identity update was refused for the active publisher")
	}
	if err := relay.HandleTelemetryMessage(pc, relay.currentIdentity(pc), []byte(telemetryPayload)); err != nil {
		t.Fatalf("telemetry for the new trip session rejected: %v", err)
	}
	vehicles := service.Vehicles()
	if len(vehicles) != 1 || vehicles[0].SourceMetadata["tripId"] != "7" || vehicles[0].SourceMetadata["recordingSessionId"] != "S1" {
		t.Fatalf("snapshot did not follow the new identity: %+v", vehicles)
	}
	if err := relay.HandleTelemetryMessage(pc, relay.currentIdentity(pc), []byte(tripLessPayload)); err == nil {
		t.Fatal("a late batch from the previous session was accepted")
	}
}

func TestIdentityUpdateFromAnotherPeerIsRefused(t *testing.T) {
	relay, _ := newTelemetryBroadcaster(t)
	active, stale := newPeer(t), newPeer(t)
	installPublisher(relay, active, &recording.Context{VehicleID: 3, RecordingSessionID: "S-live"})
	if relay.applyIdentity(stale, &recording.Context{TripID: 7, VehicleID: 3, RecordingSessionID: "S1"}) {
		t.Fatal("a non-active peer changed the stream identity")
	}
	if identity := relay.currentIdentity(active); identity == nil || identity.RecordingSessionID != "S-live" {
		t.Fatalf("active identity changed: %+v", identity)
	}
}

func TestIdentityUpdateIsRecognisedWithoutParsingBatches(t *testing.T) {
	if !isIdentityUpdate([]byte(`{"type":"stream_identity","vehicle_id":"3","recording_session_id":"S1"}`)) {
		t.Fatal("control message not recognised")
	}
	if isIdentityUpdate([]byte(telemetryPayload)) {
		t.Fatal("a telemetry batch was mistaken for an identity update")
	}
}
