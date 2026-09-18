// Package telemetry ingests Android GPS/IMU telemetry-events batches, keeps a
// bounded per-session source-time history, and fans validated observations out
// to Node (authoritative GPS persistence) and Vision (video synchronization).
//
// The relay never learns whether telemetry came from a CSV replay or from real
// sensors; `mode` is carried only as a diagnostic/persistence classification.
package telemetry

import (
	"strconv"
	"time"
)

type Mode string

const (
	ModeReplay Mode = "REPLAY"
	ModeLive   Mode = "LIVE"
)

// TelemetrySource maps a mode onto vehicle_position.telemetry_source.
func (m Mode) TelemetrySource() string {
	if m == ModeLive {
		return "DEVICE_GPS"
	}
	return "RECORDED_GPS"
}

type GPSSample struct {
	TimestampNS         int64    `json:"timestamp_ns"`
	UTCEpochMS          *int64   `json:"utc_epoch_ms"`
	Latitude            float64  `json:"latitude"`
	Longitude           float64  `json:"longitude"`
	AltitudeM           *float64 `json:"altitude_m"`
	SpeedMPS            *float64 `json:"speed_mps"`
	BearingDeg          *float64 `json:"bearing_deg"`
	HorizontalAccuracyM *float64 `json:"horizontal_accuracy_m"`
}

type IMUSample struct {
	TimestampNS int64   `json:"timestamp_ns"`
	PitchDeg    float64 `json:"pitch_deg"`
	RollDeg     float64 `json:"roll_deg"`
	YawDeg      float64 `json:"yaw_deg"`
	Accuracy    *int    `json:"accuracy"`
}

// Batch is the decoded Android DataChannel payload. Identity fields are
// diagnostic only; the trusted identity comes from the validated SDP offer.
type Batch struct {
	Type               string      `json:"type"`
	Version            *int        `json:"version"`
	Mode               Mode        `json:"mode"`
	TripID             string      `json:"trip_id"`
	VehicleID          string      `json:"vehicle_id"`
	RecordingSessionID string      `json:"recording_session_id"`
	SourceClockNS      int64       `json:"source_clock_ns"`
	GPS                []GPSSample `json:"gps"`
	IMU                []IMUSample `json:"imu"`
}

// StreamIdentity is the Node-validated publisher identity for one stream.
type StreamIdentity struct {
	TripID             int64
	VehicleID          int64
	RecordingSessionID string
}

func (i StreamIdentity) tripString() string    { return strconv.FormatInt(i.TripID, 10) }
func (i StreamIdentity) vehicleString() string { return strconv.FormatInt(i.VehicleID, 10) }

// Accepted is a validated batch bound to its trusted identity.
type Accepted struct {
	Identity   StreamIdentity
	Mode       Mode
	SourceNS   int64
	ReceivedAt time.Time
	GPS        []GPSSample
	IMU        []IMUSample
}

// VehicleState is one entry of GET /internal/telemetry/vehicles, shaped like
// the routing/tracking normalized observation contract.
type VehicleState struct {
	ExternalID       string         `json:"external_id"`
	Latitude         float64        `json:"latitude"`
	Longitude        float64        `json:"longitude"`
	SpeedKMH         *float64       `json:"speed_kmh"`
	HeadingDeg       *float64       `json:"heading_deg"`
	TelemetrySource  string         `json:"telemetry_source"`
	ObservedAtUTC    *string        `json:"observed_at_utc"`
	RouteProgressPct *float64       `json:"route_progress_pct"`
	SourceMetadata   map[string]any `json:"source_metadata"`
}

func formatUTC(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z07:00") }
