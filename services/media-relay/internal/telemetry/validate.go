package telemetry

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
)

const (
	SupportedVersion = 1
	MaxGPSPerBatch   = 16
	MaxIMUPerBatch   = 64
	// Android batches at most 16 IMU samples per 40 ms; this leaves ample room
	// while keeping a hostile message from allocating unbounded memory.
	MaxMessageBytes = 64 * 1024
	// Orientation angles outside this band indicate a corrupt serializer, not
	// an unusual pose.
	maxAbsAngleDeg = 720.0
)

var (
	ErrMalformed        = errors.New("malformed telemetry batch")
	ErrInvalid          = errors.New("invalid telemetry batch")
	ErrIdentityMismatch = errors.New("telemetry identity does not match the validated stream")
	ErrNoIdentity       = errors.New("telemetry received on a stream without a validated identity")
	ErrStalePublisher   = errors.New("telemetry received from a non-active publisher")
)

// Parse decodes and structurally validates one DataChannel message. A missing
// `version` is accepted as version 1: the first Android replay build omitted
// it, and treating it as v1 keeps that build compatible without widening the
// accepted contract.
func Parse(data []byte) (Batch, error) {
	var batch Batch
	if len(data) == 0 || len(data) > MaxMessageBytes {
		return batch, fmt.Errorf("%w: size %d outside 1..%d bytes", ErrMalformed, len(data), MaxMessageBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&batch); err != nil {
		return batch, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if err := validateBatch(batch); err != nil {
		return batch, err
	}
	return batch, nil
}

func validateBatch(batch Batch) error {
	if batch.Type != "telemetry_batch" {
		return fmt.Errorf("%w: type %q", ErrInvalid, batch.Type)
	}
	if batch.Version != nil && *batch.Version != SupportedVersion {
		return fmt.Errorf("%w: unsupported version %d", ErrInvalid, *batch.Version)
	}
	if batch.Mode != ModeReplay && batch.Mode != ModeLive {
		return fmt.Errorf("%w: unsupported mode %q", ErrInvalid, batch.Mode)
	}
	if len(batch.GPS) == 0 && len(batch.IMU) == 0 {
		return fmt.Errorf("%w: empty batch", ErrInvalid)
	}
	if len(batch.GPS) > MaxGPSPerBatch {
		return fmt.Errorf("%w: %d GPS samples exceeds %d", ErrInvalid, len(batch.GPS), MaxGPSPerBatch)
	}
	if len(batch.IMU) > MaxIMUPerBatch {
		return fmt.Errorf("%w: %d IMU samples exceeds %d", ErrInvalid, len(batch.IMU), MaxIMUPerBatch)
	}
	for index, sample := range batch.GPS {
		if err := validateGPS(sample); err != nil {
			return fmt.Errorf("%w: gps[%d]: %v", ErrInvalid, index, err)
		}
	}
	for index, sample := range batch.IMU {
		if err := validateIMU(sample); err != nil {
			return fmt.Errorf("%w: imu[%d]: %v", ErrInvalid, index, err)
		}
	}
	return nil
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func optionalFinite(value *float64) bool { return value == nil || finite(*value) }

// validateGPS rejects impossible values only. Poor horizontal accuracy is kept:
// it is still an authoritative observation and is surfaced as a quality flag
// downstream.
func validateGPS(sample GPSSample) error {
	switch {
	case sample.TimestampNS <= 0:
		return errors.New("timestamp_ns must be positive")
	case !finite(sample.Latitude) || sample.Latitude < -90 || sample.Latitude > 90:
		return errors.New("latitude out of range")
	case !finite(sample.Longitude) || sample.Longitude < -180 || sample.Longitude > 180:
		return errors.New("longitude out of range")
	case sample.UTCEpochMS != nil && *sample.UTCEpochMS <= 0:
		return errors.New("utc_epoch_ms must be positive")
	case !optionalFinite(sample.AltitudeM):
		return errors.New("altitude_m must be finite")
	case !optionalFinite(sample.SpeedMPS) || (sample.SpeedMPS != nil && *sample.SpeedMPS < 0):
		return errors.New("speed_mps must be a finite non-negative number")
	case !optionalFinite(sample.BearingDeg) || (sample.BearingDeg != nil && (*sample.BearingDeg < 0 || *sample.BearingDeg >= 360)):
		return errors.New("bearing_deg must be in [0, 360)")
	case !optionalFinite(sample.HorizontalAccuracyM) || (sample.HorizontalAccuracyM != nil && *sample.HorizontalAccuracyM < 0):
		return errors.New("horizontal_accuracy_m must be a finite non-negative number")
	}
	return nil
}

func validateIMU(sample IMUSample) error {
	if sample.TimestampNS <= 0 {
		return errors.New("timestamp_ns must be positive")
	}
	for _, angle := range []float64{sample.PitchDeg, sample.RollDeg, sample.YawDeg} {
		if !finite(angle) || math.Abs(angle) > maxAbsAngleDeg {
			return errors.New("orientation angles must be finite and bounded")
		}
	}
	return nil
}

// CheckIdentity rejects a batch whose self-declared identity disagrees with
// the trusted stream identity. Empty payload fields are allowed because the
// payload identity is only diagnostic.
func CheckIdentity(batch Batch, identity StreamIdentity) error {
	if batch.TripID != "" && batch.TripID != identity.tripString() {
		return ErrIdentityMismatch
	}
	if batch.VehicleID != "" && batch.VehicleID != identity.vehicleString() {
		return ErrIdentityMismatch
	}
	if batch.RecordingSessionID != "" && batch.RecordingSessionID != identity.RecordingSessionID {
		return ErrIdentityMismatch
	}
	return nil
}
