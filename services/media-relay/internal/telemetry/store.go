package telemetry

import (
	"sort"
	"strconv"
	"sync"
	"time"
)

const (
	DefaultGPSHistory    = 30 * time.Second
	DefaultIMUHistory    = 10 * time.Second
	DefaultCurrentMaxAge = 30 * time.Second
	maxGPSHistorySamples = 256
	maxIMUHistorySamples = 2048
	maxRetainedSessions  = 16
)

type session struct {
	identity     StreamIdentity
	mode         Mode
	active       bool
	gps          []GPSSample
	imu          []IMUSample
	latestGPS    *GPSSample
	latestGPSAt  time.Time
	latestIMU    *IMUSample
	lastReceived time.Time
}

// Store keeps a bounded source-timestamp history per recordingSessionId. Only
// the currently active publisher session may be written.
type Store struct {
	mu            sync.Mutex
	sessions      map[string]*session
	activeID      string
	gpsHistory    time.Duration
	imuHistory    time.Duration
	currentMaxAge time.Duration
	now           func() time.Time
}

func NewStore(currentMaxAge time.Duration) *Store {
	if currentMaxAge <= 0 {
		currentMaxAge = DefaultCurrentMaxAge
	}
	return &Store{
		sessions:      make(map[string]*session),
		gpsHistory:    DefaultGPSHistory,
		imuHistory:    DefaultIMUHistory,
		currentMaxAge: currentMaxAge,
		now:           time.Now,
	}
}

// Activate makes identity the only writable session. A WebRTC reconnect with
// the same logical identity keeps its short history; any other identity under
// the same recordingSessionId is treated as a different stream and reset, and
// a replaced session is removed so its data cannot leak into the new stream.
func (s *Store) Activate(identity StreamIdentity) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeID != "" && s.activeID != identity.RecordingSessionID {
		delete(s.sessions, s.activeID)
	}
	existing := s.sessions[identity.RecordingSessionID]
	if existing == nil || existing.identity != identity {
		existing = &session{identity: identity}
		s.sessions[identity.RecordingSessionID] = existing
	}
	existing.active = true
	s.activeID = identity.RecordingSessionID
	s.evictLocked()
}

// Deactivate stops writes for a session whose publisher disconnected. Its last
// state stays readable until it ages out of the current-state window.
func (s *Store) Deactivate(recordingSessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if current := s.sessions[recordingSessionID]; current != nil {
		current.active = false
	}
	if s.activeID == recordingSessionID {
		s.activeID = ""
	}
}

func (s *Store) Ingest(accepted Accepted) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.sessions[accepted.Identity.RecordingSessionID]
	if current == nil || !current.active || s.activeID != accepted.Identity.RecordingSessionID || current.identity != accepted.Identity {
		return ErrStalePublisher
	}
	current.mode = accepted.Mode
	current.lastReceived = accepted.ReceivedAt
	for index := range accepted.GPS {
		sample := accepted.GPS[index]
		current.gps = insertGPS(current.gps, sample, s.gpsHistory)
		current.latestGPS = &sample
		current.latestGPSAt = accepted.ReceivedAt
	}
	for index := range accepted.IMU {
		sample := accepted.IMU[index]
		current.imu = insertIMU(current.imu, sample, s.imuHistory)
		current.latestIMU = &sample
	}
	return nil
}

// insertGPS keeps samples sorted by source time, drops exact duplicates, and
// retains only `window` of source time behind the newest sample. A sample
// older than the window is a backward seek; the old interval is discarded
// instead of being mixed with the new one.
func insertGPS(history []GPSSample, sample GPSSample, window time.Duration) []GPSSample {
	if len(history) > 0 && sample.TimestampNS < history[len(history)-1].TimestampNS-window.Nanoseconds() {
		history = history[:0]
	}
	index := sort.Search(len(history), func(i int) bool { return history[i].TimestampNS >= sample.TimestampNS })
	if index < len(history) && history[index].TimestampNS == sample.TimestampNS {
		history[index] = sample
		return history
	}
	history = append(history, GPSSample{})
	copy(history[index+1:], history[index:])
	history[index] = sample
	newest := history[len(history)-1].TimestampNS
	cut := sort.Search(len(history), func(i int) bool { return history[i].TimestampNS >= newest-window.Nanoseconds() })
	if excess := len(history) - maxGPSHistorySamples; excess > cut {
		cut = excess
	}
	return append(history[:0], history[cut:]...)
}

func insertIMU(history []IMUSample, sample IMUSample, window time.Duration) []IMUSample {
	if len(history) > 0 && sample.TimestampNS < history[len(history)-1].TimestampNS-window.Nanoseconds() {
		history = history[:0]
	}
	index := sort.Search(len(history), func(i int) bool { return history[i].TimestampNS >= sample.TimestampNS })
	if index < len(history) && history[index].TimestampNS == sample.TimestampNS {
		history[index] = sample
		return history
	}
	history = append(history, IMUSample{})
	copy(history[index+1:], history[index:])
	history[index] = sample
	newest := history[len(history)-1].TimestampNS
	cut := sort.Search(len(history), func(i int) bool { return history[i].TimestampNS >= newest-window.Nanoseconds() })
	if excess := len(history) - maxIMUHistorySamples; excess > cut {
		cut = excess
	}
	return append(history[:0], history[cut:]...)
}

func (s *Store) evictLocked() {
	for len(s.sessions) > maxRetainedSessions {
		var oldestID string
		var oldest time.Time
		for id, current := range s.sessions {
			if id == s.activeID {
				continue
			}
			if oldestID == "" || current.lastReceived.Before(oldest) {
				oldestID, oldest = id, current.lastReceived
			}
		}
		if oldestID == "" {
			return
		}
		delete(s.sessions, oldestID)
	}
}

// Snapshot returns the most recently received GPS fix of every session that
// received one within the current-state window. "Most recent" means server
// receive order, not source UTC: a replay can legitimately carry an older
// source date than a previously received observation.
func (s *Store) Snapshot() []VehicleState {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	// One entry per vehicle: a finished session and its successor for the same
	// vehicle must not appear as two markers with one external_id.
	newestByVehicle := make(map[int64]*session)
	for id, current := range s.sessions {
		if current.latestGPS == nil {
			continue
		}
		if now.Sub(current.latestGPSAt) > s.currentMaxAge {
			if !current.active {
				delete(s.sessions, id)
			}
			continue
		}
		previous := newestByVehicle[current.identity.VehicleID]
		if previous == nil || current.latestGPSAt.After(previous.latestGPSAt) {
			newestByVehicle[current.identity.VehicleID] = current
		}
	}
	vehicles := make([]VehicleState, 0, len(newestByVehicle))
	for _, current := range newestByVehicle {
		vehicles = append(vehicles, vehicleState(current))
	}
	sort.Slice(vehicles, func(i, j int) bool { return vehicles[i].ExternalID < vehicles[j].ExternalID })
	return vehicles
}

func vehicleState(current *session) VehicleState {
	fix := current.latestGPS
	var observedAt *string
	if fix.UTCEpochMS != nil {
		value := formatUTC(time.UnixMilli(*fix.UTCEpochMS))
		observedAt = &value
	} else {
		value := formatUTC(current.latestGPSAt)
		observedAt = &value
	}
	var speedKMH *float64
	if fix.SpeedMPS != nil {
		value := *fix.SpeedMPS * 3.6
		speedKMH = &value
	}
	metadata := map[string]any{
		"vehicleId":           current.identity.vehicleString(),
		"tripId":              current.identity.tripString(),
		"recordingSessionId":  current.identity.RecordingSessionID,
		"sourceTimestampNs":   strconv.FormatInt(fix.TimestampNS, 10),
		"horizontalAccuracyM": fix.HorizontalAccuracyM,
		"altitudeM":           fix.AltitudeM,
		"receivedAt":          formatUTC(current.latestGPSAt),
		"mode":                string(current.mode),
		"active":              current.active,
	}
	return VehicleState{
		ExternalID:      "device:" + current.identity.vehicleString(),
		Latitude:        fix.Latitude,
		Longitude:       fix.Longitude,
		SpeedKMH:        speedKMH,
		HeadingDeg:      fix.BearingDeg,
		TelemetrySource: current.mode.TelemetrySource(),
		ObservedAtUTC:   observedAt,
		SourceMetadata:  metadata,
	}
}

// SessionCount is exposed for diagnostics.
func (s *Store) SessionCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

// History returns copies of the retained history for a session (diagnostics/tests).
func (s *Store) History(recordingSessionID string) ([]GPSSample, []IMUSample) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.sessions[recordingSessionID]
	if current == nil {
		return nil, nil
	}
	return append([]GPSSample(nil), current.gps...), append([]IMUSample(nil), current.imu...)
}
