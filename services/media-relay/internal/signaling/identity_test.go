package signaling

import (
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
