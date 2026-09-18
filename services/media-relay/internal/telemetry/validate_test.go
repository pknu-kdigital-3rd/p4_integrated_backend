package telemetry

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func gpsJSON(fields string) string {
	return `{"type":"telemetry_batch","version":1,"mode":"REPLAY","trip_id":"102","vehicle_id":"3","recording_session_id":"abc-123",` +
		`"source_clock_ns":1445245922681115,"gps":[{"timestamp_ns":1445245922681115,"utc_epoch_ms":1787803384795,` +
		`"latitude":35.1329082,"longitude":129.1070557,"altitude_m":47.3,"speed_mps":0.7153028,"bearing_deg":89.954605,"horizontal_accuracy_m":2.8` +
		fields + `}],"imu":[]}`
}

func TestParseAcceptsCanonicalBatch(t *testing.T) {
	batch, err := Parse([]byte(gpsJSON("")))
	if err != nil {
		t.Fatal(err)
	}
	if batch.GPS[0].TimestampNS != 1445245922681115 || *batch.GPS[0].UTCEpochMS != 1787803384795 {
		t.Fatalf("64-bit values were not decoded exactly: %+v", batch.GPS[0])
	}
}

func TestParseAcceptsMissingVersionAsV1(t *testing.T) {
	payload := `{"type":"telemetry_batch","mode":"LIVE","imu":[{"timestamp_ns":1,"pitch_deg":1,"roll_deg":2,"yaw_deg":-30,"accuracy":3}]}`
	if _, err := Parse([]byte(payload)); err != nil {
		t.Fatal(err)
	}
}

func TestParseRejectsInvalidBatches(t *testing.T) {
	imu := `{"timestamp_ns":1,"pitch_deg":0,"roll_deg":0,"yaw_deg":0}`
	cases := map[string]string{
		"malformed json":      `{"type":`,
		"wrong type":          `{"type":"qr","mode":"REPLAY","imu":[` + imu + `]}`,
		"unsupported version": `{"type":"telemetry_batch","version":2,"mode":"REPLAY","imu":[` + imu + `]}`,
		"unsupported mode":    `{"type":"telemetry_batch","mode":"SIM","imu":[` + imu + `]}`,
		"empty batch":         `{"type":"telemetry_batch","mode":"REPLAY","gps":[],"imu":[]}`,
		"latitude":            strings.Replace(gpsJSON(""), `"latitude":35.1329082`, `"latitude":91`, 1),
		"longitude":           strings.Replace(gpsJSON(""), `"longitude":129.1070557`, `"longitude":-180.5`, 1),
		"negative speed":      strings.Replace(gpsJSON(""), `"speed_mps":0.7153028`, `"speed_mps":-1`, 1),
		"bearing 360":         strings.Replace(gpsJSON(""), `"bearing_deg":89.954605`, `"bearing_deg":360`, 1),
		"negative accuracy":   strings.Replace(gpsJSON(""), `"horizontal_accuracy_m":2.8`, `"horizontal_accuracy_m":-0.1`, 1),
		"zero timestamp":      strings.Replace(gpsJSON(""), `"timestamp_ns":1445245922681115,"utc`, `"timestamp_ns":0,"utc`, 1),
		"unbounded imu angle": `{"type":"telemetry_batch","mode":"REPLAY","imu":[{"timestamp_ns":1,"pitch_deg":1e9,"roll_deg":0,"yaw_deg":0}]}`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(payload)); err == nil {
				t.Fatalf("expected rejection for %s", name)
			}
		})
	}
}

func TestParseRejectsOversizedArrays(t *testing.T) {
	samples := make([]string, MaxIMUPerBatch+1)
	for index := range samples {
		samples[index] = fmt.Sprintf(`{"timestamp_ns":%d,"pitch_deg":0,"roll_deg":0,"yaw_deg":0}`, index+1)
	}
	payload := `{"type":"telemetry_batch","mode":"REPLAY","imu":[` + strings.Join(samples, ",") + `]}`
	if _, err := Parse([]byte(payload)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized IMU array should be invalid, got %v", err)
	}
	gps := make([]string, MaxGPSPerBatch+1)
	for index := range gps {
		gps[index] = fmt.Sprintf(`{"timestamp_ns":%d,"latitude":0,"longitude":0}`, index+1)
	}
	payload = `{"type":"telemetry_batch","mode":"REPLAY","gps":[` + strings.Join(gps, ",") + `]}`
	if _, err := Parse([]byte(payload)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized GPS array should be invalid, got %v", err)
	}
	if _, err := Parse(make([]byte, MaxMessageBytes+1)); !errors.Is(err, ErrMalformed) {
		t.Fatalf("oversized message should be malformed, got %v", err)
	}
}

func TestPoorAccuracyIsPreserved(t *testing.T) {
	payload := strings.Replace(gpsJSON(""), `"horizontal_accuracy_m":2.8`, `"horizontal_accuracy_m":85`, 1)
	if _, err := Parse([]byte(payload)); err != nil {
		t.Fatalf("poor accuracy must not reject an authoritative fix: %v", err)
	}
}

func TestCheckIdentity(t *testing.T) {
	identity := StreamIdentity{TripID: 102, VehicleID: 3, RecordingSessionID: "abc-123"}
	batch, err := Parse([]byte(gpsJSON("")))
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckIdentity(batch, identity); err != nil {
		t.Fatalf("matching identity rejected: %v", err)
	}
	for _, other := range []StreamIdentity{
		{TripID: 101, VehicleID: 3, RecordingSessionID: "abc-123"},
		{TripID: 102, VehicleID: 4, RecordingSessionID: "abc-123"},
		{TripID: 102, VehicleID: 3, RecordingSessionID: "other"},
	} {
		if err := CheckIdentity(batch, other); !errors.Is(err, ErrIdentityMismatch) {
			t.Fatalf("mismatch not detected for %+v", other)
		}
	}
	batch.TripID, batch.VehicleID, batch.RecordingSessionID = "", "", ""
	if err := CheckIdentity(batch, identity); err != nil {
		t.Fatalf("omitted diagnostic identity should be accepted: %v", err)
	}
}
