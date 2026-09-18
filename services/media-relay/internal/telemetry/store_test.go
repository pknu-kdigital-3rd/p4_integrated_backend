package telemetry

import (
	"errors"
	"testing"
	"time"
)

var (
	identityA = StreamIdentity{TripID: 1, VehicleID: 3, RecordingSessionID: "S1"}
	identityB = StreamIdentity{TripID: 2, VehicleID: 3, RecordingSessionID: "S2"}
)

func float(value float64) *float64 { return &value }

func gpsAt(ts int64, lat float64) GPSSample {
	return GPSSample{TimestampNS: ts, Latitude: lat, Longitude: 129, SpeedMPS: float(10), BearingDeg: float(90)}
}

func accepted(identity StreamIdentity, receivedAt time.Time, gps []GPSSample, imu []IMUSample) Accepted {
	return Accepted{Identity: identity, Mode: ModeReplay, ReceivedAt: receivedAt, GPS: gps, IMU: imu}
}

func TestStoreKeepsLatestAndSnapshotMapsFields(t *testing.T) {
	store := NewStore(30 * time.Second)
	now := time.Date(2026, 9, 18, 2, 40, 15, 0, time.UTC)
	store.now = func() time.Time { return now }
	store.Activate(identityA)
	utc := int64(1787803384795)
	fix := gpsAt(2_000_000_000, 35.2)
	fix.UTCEpochMS = &utc
	fix.HorizontalAccuracyM = float(2.8)
	if err := store.Ingest(accepted(identityA, now, []GPSSample{gpsAt(1_000_000_000, 35.1), fix}, []IMUSample{{TimestampNS: 5}})); err != nil {
		t.Fatal(err)
	}
	vehicles := store.Snapshot()
	if len(vehicles) != 1 {
		t.Fatalf("expected one vehicle, got %d", len(vehicles))
	}
	vehicle := vehicles[0]
	if vehicle.ExternalID != "device:3" || vehicle.Latitude != 35.2 || vehicle.TelemetrySource != "RECORDED_GPS" {
		t.Fatalf("unexpected snapshot: %+v", vehicle)
	}
	if *vehicle.SpeedKMH != 36 || *vehicle.HeadingDeg != 90 {
		t.Fatalf("speed/heading conversion wrong: %+v", vehicle)
	}
	if *vehicle.ObservedAtUTC != "2026-08-27T04:03:04.795Z" {
		t.Fatalf("observed_at should come from the source UTC fix, got %s", *vehicle.ObservedAtUTC)
	}
	metadata := vehicle.SourceMetadata
	if metadata["tripId"] != "1" || metadata["recordingSessionId"] != "S1" || metadata["sourceTimestampNs"] != "2000000000" || metadata["mode"] != "REPLAY" {
		t.Fatalf("metadata not preserved: %+v", metadata)
	}
}

func TestStoreRejectsInactiveAndReplacedSessions(t *testing.T) {
	store := NewStore(30 * time.Second)
	now := time.Now()
	if err := store.Ingest(accepted(identityA, now, []GPSSample{gpsAt(1, 1)}, nil)); !errors.Is(err, ErrStalePublisher) {
		t.Fatalf("ingest before activation must fail, got %v", err)
	}
	store.Activate(identityA)
	store.Activate(identityB)
	if err := store.Ingest(accepted(identityA, now, []GPSSample{gpsAt(1, 1)}, nil)); !errors.Is(err, ErrStalePublisher) {
		t.Fatalf("replaced session must not be writable, got %v", err)
	}
	if gps, _ := store.History("S1"); gps != nil {
		t.Fatal("replaced session history must be removed")
	}
	store.Deactivate("S2")
	if err := store.Ingest(accepted(identityB, now, []GPSSample{gpsAt(1, 1)}, nil)); !errors.Is(err, ErrStalePublisher) {
		t.Fatalf("deactivated session must not be writable, got %v", err)
	}
}

func TestStoreSessionIsolationWithOverlappingTimestamps(t *testing.T) {
	store := NewStore(30 * time.Second)
	now := time.Now()
	store.now = func() time.Time { return now }
	store.Activate(identityA)
	_ = store.Ingest(accepted(identityA, now, []GPSSample{gpsAt(1_000, 10)}, nil))
	store.Deactivate("S1")
	store.Activate(identityB)
	_ = store.Ingest(accepted(identityB, now.Add(time.Second), []GPSSample{gpsAt(1_000, 20)}, nil))
	gpsA, _ := store.History("S1")
	gpsB, _ := store.History("S2")
	if len(gpsA) != 1 || gpsA[0].Latitude != 10 || len(gpsB) != 1 || gpsB[0].Latitude != 20 {
		t.Fatalf("sessions mixed: A=%+v B=%+v", gpsA, gpsB)
	}
	vehicles := store.Snapshot()
	if len(vehicles) != 1 || vehicles[0].SourceMetadata["recordingSessionId"] != "S2" {
		t.Fatalf("same vehicle must appear once with the newest session: %+v", vehicles)
	}
}

func TestStoreReconnectSameSessionPreservesHistory(t *testing.T) {
	store := NewStore(30 * time.Second)
	now := time.Now()
	store.Activate(identityA)
	_ = store.Ingest(accepted(identityA, now, []GPSSample{gpsAt(1_000, 10)}, nil))
	store.Deactivate("S1")
	store.Activate(identityA)
	_ = store.Ingest(accepted(identityA, now, []GPSSample{gpsAt(2_000, 11)}, nil))
	if gps, _ := store.History("S1"); len(gps) != 2 {
		t.Fatalf("reconnect with the same identity should keep history, got %d", len(gps))
	}
	sameSessionOtherTrip := StreamIdentity{TripID: 9, VehicleID: 3, RecordingSessionID: "S1"}
	store.Activate(sameSessionOtherTrip)
	if gps, _ := store.History("S1"); len(gps) != 0 {
		t.Fatal("a different trip under the same session id must not inherit history")
	}
}

func TestStoreHistoryIsBoundedAndDeduplicated(t *testing.T) {
	store := NewStore(30 * time.Second)
	now := time.Now()
	store.Activate(identityA)
	for second := int64(0); second < 120; second++ {
		_ = store.Ingest(accepted(identityA, now, []GPSSample{gpsAt(second*int64(time.Second), 1)}, nil))
	}
	_ = store.Ingest(accepted(identityA, now, []GPSSample{gpsAt(119*int64(time.Second), 2)}, nil))
	gps, _ := store.History("S1")
	if len(gps) != 31 {
		t.Fatalf("GPS history should keep 30 s of source time, got %d samples", len(gps))
	}
	if gps[len(gps)-1].Latitude != 2 {
		t.Fatal("duplicate source timestamp should replace, not append")
	}
	imu := make([]IMUSample, 0, 64)
	for index := int64(0); index < 3000; index++ {
		imu = append(imu, IMUSample{TimestampNS: index * int64(time.Millisecond)})
		if len(imu) == 64 {
			_ = store.Ingest(accepted(identityA, now, nil, imu))
			imu = imu[:0]
		}
	}
	_, retained := store.History("S1")
	if len(retained) > maxIMUHistorySamples || retained[len(retained)-1].TimestampNS-retained[0].TimestampNS > int64(DefaultIMUHistory) {
		t.Fatalf("IMU history unbounded: %d samples", len(retained))
	}
}

func TestStoreBackwardSeekDropsOldInterval(t *testing.T) {
	store := NewStore(30 * time.Second)
	store.Activate(identityA)
	now := time.Now()
	_ = store.Ingest(accepted(identityA, now, []GPSSample{gpsAt(100*int64(time.Second), 1)}, nil))
	_ = store.Ingest(accepted(identityA, now, []GPSSample{gpsAt(25*int64(time.Second), 2)}, nil))
	gps, _ := store.History("S1")
	if len(gps) != 1 || gps[0].Latitude != 2 {
		t.Fatalf("a rewind must not mix the previous interval: %+v", gps)
	}
}

func TestStoreSnapshotExpiresStaleState(t *testing.T) {
	store := NewStore(10 * time.Second)
	now := time.Now()
	store.now = func() time.Time { return now }
	store.Activate(identityA)
	_ = store.Ingest(accepted(identityA, now, []GPSSample{gpsAt(1, 1)}, nil))
	store.Deactivate("S1")
	now = now.Add(11 * time.Second)
	if vehicles := store.Snapshot(); len(vehicles) != 0 {
		t.Fatalf("stale device state should not be reported: %+v", vehicles)
	}
	if store.SessionCount() != 0 {
		t.Fatal("expired inactive session should be removed")
	}
}
