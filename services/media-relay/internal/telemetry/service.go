package telemetry

import (
	"context"
	"time"
)

// Service is the relay-side telemetry pipeline. HandleMessage runs on the
// WebRTC DataChannel callback and never blocks on network or disk: persistence
// and Vision forwarding happen on bounded queues drained by Run.
type Service struct {
	store   *Store
	node    *NodeSink
	vision  *VisionSink
	metrics *Metrics
	logs    *rateLimitedLogger
	now     func() time.Time
}

// NewService wires the pipeline; node and vision may be nil to disable a sink.
func NewService(store *Store, node *NodeSink, vision *VisionSink, metrics *Metrics) *Service {
	return &Service{
		store:   store,
		node:    node,
		vision:  vision,
		metrics: metrics,
		logs:    newRateLimitedLogger(5 * time.Second),
		now:     time.Now,
	}
}

func (s *Service) Run(ctx context.Context) {
	if s.node != nil {
		go s.node.Run(ctx)
	}
	if s.vision != nil {
		go s.vision.Run(ctx)
	}
}

func (s *Service) Activate(identity StreamIdentity) { s.store.Activate(identity) }

func (s *Service) Deactivate(recordingSessionID string) { s.store.Deactivate(recordingSessionID) }

// HandleMessage validates one telemetry-events message against the trusted
// identity of the connection it arrived on. identity is nil when the offer had
// no validated trip/vehicle/session; such telemetry is never accepted.
func (s *Service) HandleMessage(identity *StreamIdentity, data []byte) error {
	s.metrics.BatchesReceived.Add(1)
	batch, err := Parse(data)
	if err != nil {
		s.metrics.BatchesInvalid.Add(1)
		s.logs.Printf("invalid", "telemetry: rejected batch: %v", err)
		return err
	}
	if identity == nil {
		s.metrics.StaleOrUnidentified.Add(1)
		s.logs.Printf("unidentified", "telemetry: %v", ErrNoIdentity)
		return ErrNoIdentity
	}
	if err := CheckIdentity(batch, *identity); err != nil {
		s.metrics.IdentityMismatch.Add(1)
		s.logs.Printf("mismatch", "telemetry: rejected batch for session %s: payload identity trip=%q vehicle=%q session=%q",
			identity.RecordingSessionID, batch.TripID, batch.VehicleID, batch.RecordingSessionID)
		return err
	}
	accepted := Accepted{
		Identity:   *identity,
		Mode:       batch.Mode,
		SourceNS:   batch.SourceClockNS,
		ReceivedAt: s.now(),
		GPS:        batch.GPS,
		IMU:        batch.IMU,
	}
	if err := s.store.Ingest(accepted); err != nil {
		s.metrics.StaleOrUnidentified.Add(1)
		s.logs.Printf("stale", "telemetry: rejected batch for session %s: %v", identity.RecordingSessionID, err)
		return err
	}
	s.metrics.GPSSamples.Add(uint64(len(batch.GPS)))
	s.metrics.IMUSamples.Add(uint64(len(batch.IMU)))
	if s.node != nil {
		s.node.Enqueue(accepted)
	}
	if s.vision != nil {
		s.vision.Enqueue(accepted)
	}
	return nil
}

// RejectStale records telemetry from a connection that is not the active
// publisher without parsing it.
func (s *Service) RejectStale() error {
	s.metrics.BatchesReceived.Add(1)
	s.metrics.StaleOrUnidentified.Add(1)
	s.logs.Printf("stale-pc", "telemetry: %v", ErrStalePublisher)
	return ErrStalePublisher
}

func (s *Service) Vehicles() []VehicleState { return s.store.Snapshot() }

func (s *Service) Metrics() MetricsSnapshot {
	snapshot := MetricsSnapshot{
		BatchesReceivedTotal:        s.metrics.BatchesReceived.Load(),
		BatchesInvalidTotal:         s.metrics.BatchesInvalid.Load(),
		IdentityMismatchTotal:       s.metrics.IdentityMismatch.Load(),
		StaleOrUnidentifiedTotal:    s.metrics.StaleOrUnidentified.Load(),
		GPSSamplesTotal:             s.metrics.GPSSamples.Load(),
		IMUSamplesTotal:             s.metrics.IMUSamples.Load(),
		StoreSessions:               s.store.SessionCount(),
		GPSPersistenceJobsTotal:     s.metrics.NodeJobs.Load(),
		GPSPersistenceFailuresTotal: s.metrics.NodeFailures.Load(),
		DroppedGPSPersistenceTotal:  s.metrics.NodeDropped.Load(),
		VisionForwardedTotal:        s.metrics.VisionForwarded.Load(),
		VisionDroppedTotal:          s.metrics.VisionDropped.Load(),
		VisionFailuresTotal:         s.metrics.VisionFailures.Load(),
	}
	if s.node != nil {
		snapshot.NodeQueueDepth = s.node.QueueDepth()
	}
	if s.vision != nil {
		snapshot.VisionQueueDepth = s.vision.QueueDepth()
	}
	return snapshot
}
