package broadcaster

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"

	"poc-server-webrtc/relay-go/internal/recording"
	"poc-server-webrtc/relay-go/internal/telemetry"
	"poc-server-webrtc/relay-go/internal/yolofeed"
)

// IdentityVerdict is the outcome of validating a stream identity, as used for
// an offer: Context is nil when nothing could be accepted, and TrackingOnly
// means the trip was rejected but the vehicle is still tracked.
type IdentityVerdict struct {
	Context      *recording.Context
	Validated    bool
	TrackingOnly bool
	Reason       string
}

// IdentityResolver validates a requested identity with Node using the same
// rules as an offer. Signaling installs it; the broadcaster cannot import
// signaling.
type IdentityResolver func(ctx context.Context, tripID, vehicleID, recordingSessionID string) IdentityVerdict

// SetIdentityResolver enables in-place identity updates on the telemetry channel.
func (b *Broadcaster) SetIdentityResolver(resolver IdentityResolver) {
	b.identityResolver = resolver
}

// identityUpdate is the control message Android sends on telemetry-events when
// a trip starts or ends, so the stream keeps running while its identity changes.
type identityUpdate struct {
	Type               string `json:"type"`
	TripID             string `json:"trip_id"`
	VehicleID          string `json:"vehicle_id"`
	RecordingSessionID string `json:"recording_session_id"`
}

type identityUpdateResult struct {
	Type               string `json:"type"`
	RecordingSessionID string `json:"recording_session_id"`
	Validated          bool   `json:"validated"`
	TrackingOnly       bool   `json:"trackingOnly,omitempty"`
	Reason             string `json:"reason,omitempty"`
}

const identityUpdateType = "stream_identity"

// isIdentityUpdate cheaply recognises the control message without fully
// parsing every ~25 Hz telemetry batch.
func isIdentityUpdate(data []byte) bool {
	return len(data) < 4096 && strings.Contains(string(data), `"`+identityUpdateType+`"`)
}

// handleIdentityUpdate validates and applies a new identity for the publisher
// that owns pc, then reports the verdict on the same channel. It runs inside
// the channel's message callback, so telemetry sent after the update is only
// processed once the new identity is in place.
func (b *Broadcaster) handleIdentityUpdate(pc *webrtc.PeerConnection, channel *webrtc.DataChannel, data []byte) {
	var update identityUpdate
	if err := json.Unmarshal(data, &update); err != nil || update.Type != identityUpdateType {
		log.Printf("stream identity update ignored: malformed message")
		return
	}
	result := identityUpdateResult{Type: "stream_identity_result", RecordingSessionID: update.RecordingSessionID}
	if b.identityResolver == nil {
		result.Reason = "the relay cannot validate identity updates"
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		verdict := b.identityResolver(ctx, update.TripID, update.VehicleID, update.RecordingSessionID)
		cancel()
		if !b.applyIdentity(pc, verdict.Context) {
			result.Reason = "the stream is no longer the active publisher"
		} else {
			result.Validated, result.TrackingOnly, result.Reason = verdict.Validated, verdict.TrackingOnly, verdict.Reason
		}
	}
	body, err := json.Marshal(result)
	if err == nil {
		err = channel.SendText(string(body))
	}
	if err != nil {
		log.Printf("stream identity result not delivered: %v", err)
	}
}

// applyIdentity switches the active publisher to a new identity without
// touching its media: telemetry moves to the new session, recording follows
// the trip (a trip-less identity records nothing), and Vision frames are
// relabelled from the next access unit without resetting the live feed.
func (b *Broadcaster) applyIdentity(pc *webrtc.PeerConnection, recordingContext *recording.Context) bool {
	b.lifecycleMu.Lock()
	defer b.lifecycleMu.Unlock()
	identity := StreamIdentity(recordingContext)
	b.mu.Lock()
	publisher := b.publisher
	if publisher == nil || publisher.pc != pc {
		b.mu.Unlock()
		return false
	}
	old := publisher.identity
	publisher.identity = identity
	b.mu.Unlock()

	if b.telemetry != nil {
		if old != nil && (identity == nil || old.RecordingSessionID != identity.RecordingSessionID) {
			b.telemetry.Deactivate(old.RecordingSessionID)
		}
		if identity != nil {
			b.telemetry.Activate(*identity)
		}
	}
	if b.yolo != nil {
		var feedIdentity *yolofeed.RecordingIdentity
		if recordingContext != nil {
			feedIdentity = &yolofeed.RecordingIdentity{
				TripID:             recordingContext.TripID,
				VehicleID:          recordingContext.VehicleID,
				RecordingSessionID: recordingContext.RecordingSessionID,
			}
		}
		b.yolo.RelabelRecordingIdentity(feedIdentity)
	}
	if b.recorder != nil {
		switch {
		case recordingContext == nil:
			b.recorder.Stop("stream identity was not accepted")
		case recordingContext.TripID == 0:
			b.recorder.Stop("trip ended; tracking without recording")
		default:
			if err := b.recorder.Start(*recordingContext); err != nil {
				log.Printf("recording context could not be started; live publishing continues: %v", err)
			} else {
				// The new recording starts at the next IDR; ask for one now.
				go b.RequestKeyFrame()
			}
		}
	}
	log.Printf("stream identity updated in place (%s)", telemetryIdentityLabel(identity))
	return true
}

// currentIdentity is the active identity of the publisher that owns pc.
func (b *Broadcaster) currentIdentity(pc *webrtc.PeerConnection) *telemetry.StreamIdentity {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.publisher == nil || b.publisher.pc != pc {
		return nil
	}
	return b.publisher.identity
}
