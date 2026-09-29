package signaling

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"poc-server-webrtc/relay-go/internal/recording"
)

func TestIdentityRejectionReasonUsesNodeMessage(t *testing.T) {
	err := &recording.HTTPStatusError{
		Status:  409,
		Message: `{"error":{"code":"RECORDING_TRIP_MISMATCH","message":"Trip is not active for this vehicle"}}`,
	}
	const want = "Node rejected it: Trip is not active for this vehicle"
	if got := identityRejectionReason(err); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestIdentityRejectionReasonFallsBackToStatus(t *testing.T) {
	err := &recording.HTTPStatusError{Status: 409, Message: "not json"}
	const want = "Node rejected it with HTTP 409"
	if got := identityRejectionReason(err); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// An outage and a rejected trip need opposite fixes, so they must not read alike.
func TestIdentityRejectionReasonSeparatesUnreachableNode(t *testing.T) {
	const want = "the relay could not reach Node to validate it"
	if got := identityRejectionReason(errors.New("dial tcp: connection refused")); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestIdentityVerdictStatus(t *testing.T) {
	if status := (identityVerdict{}).status(); status != nil {
		t.Fatalf("an offer without identity must not carry a verdict: %+v", status)
	}
	validated := identityVerdict{offered: true, context: &recording.Context{TripID: 1, VehicleID: 2, RecordingSessionID: "s"}}
	if status := validated.status(); status == nil || !status.Validated || status.Reason != "" {
		t.Fatalf("unexpected accepted status: %+v", status)
	}
	rejected := identityVerdict{offered: true, reason: "Node rejected it: Trip is not active for this vehicle"}
	status := rejected.status()
	if status == nil || status.Validated || status.Reason != rejected.reason {
		t.Fatalf("unexpected rejected status: %+v", status)
	}
}

func TestAnswerModelOmitsVerdictWhenNoIdentityOffered(t *testing.T) {
	body, err := json.Marshal(AnswerModel{Type: "answer", SDP: "v=0", StreamIdentity: (identityVerdict{}).status()})
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"type":"answer","sdp":"v=0"}` {
		t.Fatalf("answer shape changed: %s", body)
	}
}

type fakeValidator struct {
	vehicleCalls int
	vehicleErr   error
}

func (f *fakeValidator) ValidateRecordingContext(_ context.Context, requested recording.Context) (recording.Context, error) {
	return requested, nil
}

func (f *fakeValidator) ValidateVehicleContext(_ context.Context, vehicleID int64, sessionID string) (recording.Context, error) {
	f.vehicleCalls++
	if f.vehicleErr != nil {
		return recording.Context{}, f.vehicleErr
	}
	return recording.Context{VehicleID: vehicleID, RecordingSessionID: sessionID}, nil
}

// A vehicle streaming without an active trip is tracked but never recorded.
func TestVehicleOnlyOfferIsTrackedWithoutTrip(t *testing.T) {
	validator := &fakeValidator{}
	handler := &Handler{validator: validator}
	verdict := handler.validateRecordingContext(context.Background(), OfferModel{VehicleID: "7", RecordingSessionID: "session-1"})
	if validator.vehicleCalls != 1 || verdict.context == nil {
		t.Fatalf("vehicle-only offer was not validated: %+v", verdict)
	}
	if *verdict.context != (recording.Context{VehicleID: 7, RecordingSessionID: "session-1"}) {
		t.Fatalf("unexpected vehicle-only context: %+v", *verdict.context)
	}
	if status := verdict.status(); status == nil || !status.Validated {
		t.Fatalf("vehicle-only identity must be reported as validated: %+v", status)
	}
}

func TestVehicleOnlyOfferRejectionKeepsStreamLive(t *testing.T) {
	handler := &Handler{validator: &fakeValidator{vehicleErr: &recording.HTTPStatusError{
		Status: 404, Message: `{"error":{"code":"VEHICLE_NOT_FOUND","message":"Active vehicle not found"}}`,
	}}}
	verdict := handler.validateRecordingContext(context.Background(), OfferModel{VehicleID: "7", RecordingSessionID: "session-1"})
	if verdict.context != nil || verdict.reason != "Node rejected it: Active vehicle not found" {
		t.Fatalf("unexpected verdict: %+v", verdict)
	}
	malformed := handler.validateRecordingContext(context.Background(), OfferModel{VehicleID: "x", RecordingSessionID: "session-1"})
	if malformed.context != nil || malformed.reason == "" {
		t.Fatalf("malformed vehicle id accepted: %+v", malformed)
	}
}
