package signaling

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"poc-server-webrtc/relay-go/internal/broadcaster"
	"poc-server-webrtc/relay-go/internal/recording"
	"poc-server-webrtc/relay-go/internal/telemetry"
)

type OfferModel struct {
	ConnectionID       string `json:"connectionId,omitempty"`
	SDP                string `json:"sdp"`
	Type               string `json:"type"`
	TripID             string `json:"tripId,omitempty"`
	VehicleID          string `json:"vehicleId,omitempty"`
	RecordingSessionID string `json:"recordingSessionId,omitempty"`
}

// StreamIdentityStatus tells the publisher whether the trip/vehicle/session it
// offered was accepted. A rejected identity is not a negotiation failure - the
// live stream is still published - but it silently disables recording and makes
// the relay drop every telemetry batch, which the publisher cannot otherwise
// observe. Only sent when the offer actually carried identity fields.
type StreamIdentityStatus struct {
	Validated bool `json:"validated"`
	// TrackingOnly means the trip was rejected but the vehicle is still tracked
	// on the map; Reason explains the trip rejection.
	TrackingOnly bool   `json:"trackingOnly,omitempty"`
	Reason       string `json:"reason,omitempty"`
}

// AnswerModel is the SDP answer plus the identity verdict.
type AnswerModel struct {
	ConnectionID   string                `json:"connectionId,omitempty"`
	Type           string                `json:"type"`
	SDP            string                `json:"sdp"`
	StreamIdentity *StreamIdentityStatus `json:"streamIdentity,omitempty"`
}

// identityVerdict is the outcome of validating one offer's stream identity.
// reason is empty exactly when the identity was accepted.
// A tracking-only verdict has a vehicle context but carries the trip rejection
// as its reason, so the publisher learns why nothing is being recorded.
type identityVerdict struct {
	offered      bool
	context      *recording.Context
	reason       string
	trackingOnly bool
}

func (v identityVerdict) status() *StreamIdentityStatus {
	if !v.offered {
		return nil
	}
	return &StreamIdentityStatus{Validated: v.context != nil && !v.trackingOnly, TrackingOnly: v.trackingOnly, Reason: v.reason}
}

type Handler struct {
	lifecycleMu   sync.Mutex
	peerMu        sync.Mutex
	peer          *webrtc.PeerConnection
	peerID        string
	api           *webrtc.API
	configuration webrtc.Configuration
	broadcaster   *broadcaster.Broadcaster
	validator     recording.ContextValidator
	telemetry     *telemetry.Service
}

func NewHandler(api *webrtc.API, configuration webrtc.Configuration, relay *broadcaster.Broadcaster, validator recording.ContextValidator) *Handler {
	handler := &Handler{api: api, configuration: configuration, broadcaster: relay, validator: validator}
	if relay != nil {
		relay.SetIdentityResolver(handler.resolveIdentity)
	}
	return handler
}

// resolveIdentity validates an in-place identity update with exactly the rules
// used for an offer, including the vehicle-only fallback for a rejected trip.
func (h *Handler) resolveIdentity(ctx context.Context, tripID, vehicleID, recordingSessionID string) broadcaster.IdentityVerdict {
	verdict := h.validateRecordingContext(ctx, OfferModel{TripID: tripID, VehicleID: vehicleID, RecordingSessionID: recordingSessionID})
	status := verdict.status()
	result := broadcaster.IdentityVerdict{Context: verdict.context, Reason: verdict.reason}
	if status != nil {
		result.Validated, result.TrackingOnly = status.Validated, status.TrackingOnly
	}
	return result
}

// SetTelemetry exposes the current-device telemetry API. Leave unset to keep
// the telemetry endpoints returning an empty, disabled snapshot.
func (h *Handler) SetTelemetry(service *telemetry.Service) {
	h.telemetry = service
}

func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/offer/android", h.offerAndroid)
	mux.HandleFunc("/internal/request-keyframe", h.requestKeyframe)
	mux.HandleFunc("/internal/status", h.status)
	mux.HandleFunc("/internal/telemetry/vehicles", h.telemetryVehicles)
	mux.HandleFunc("/internal/telemetry/status", h.telemetryStatus)
	mux.HandleFunc("/healthz", h.health)
	return withCORS(mux)
}

// telemetryVehicles is the source-neutral current device snapshot read by the
// routing/tracking service. external_id is only a tracking-contract key; the
// real vehicle identity is in source_metadata.
func (h *Handler) telemetryVehicles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET required")
		return
	}
	vehicles := []telemetry.VehicleState{}
	if h.telemetry != nil {
		vehicles = h.telemetry.Vehicles()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":          h.telemetry != nil,
		"generated_at_utc": time.Now().UTC().Format(time.RFC3339Nano),
		"vehicles":         vehicles,
		"warnings":         []string{},
	})
}

func (h *Handler) telemetryStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET required")
		return
	}
	if h.telemetry == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	response := map[string]any{
		"enabled": true,
		"metrics": h.telemetry.Metrics(),
	}
	if h.broadcaster != nil {
		response["qr_events"] = h.broadcaster.QRStatus()
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) offerAndroid(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var offer OfferModel
	if err := json.NewDecoder(r.Body).Decode(&offer); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if offer.Type == "close" {
		if offer.ConnectionID == "" {
			writeError(w, http.StatusBadRequest, "connectionId required")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"closed": h.closePeer(offer.ConnectionID)})
		return
	}
	if offer.Type != "offer" || offer.SDP == "" {
		writeError(w, http.StatusBadRequest, "valid SDP offer required")
		return
	}
	// Validate SDP before retiring the working publisher for a malformed offer.
	var parsed webrtc.SessionDescription
	parsed.Type, parsed.SDP = webrtc.SDPTypeOffer, offer.SDP
	if _, err := parsed.Unmarshal(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid SDP offer")
		return
	}
	verdict := h.validateRecordingContext(r.Context(), offer)
	recordingContext := verdict.context
	pc, err := h.newPeerConnection()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	connectionID, err := h.replacePeer(pc)
	if err != nil {
		_ = pc.Close()
		writeError(w, http.StatusInternalServerError, "could not register connection")
		return
	}
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if track.Kind() == webrtc.RTPCodecTypeVideo {
			h.peerMu.Lock()
			if h.peer == pc {
				h.broadcaster.SetPublisher(pc, track, recordingContext)
			}
			h.peerMu.Unlock()
		}
	})
	pc.OnDataChannel(func(channel *webrtc.DataChannel) {
		h.peerMu.Lock()
		if h.peer == pc {
			h.broadcaster.HandleDataChannel(pc, recordingContext, channel)
		}
		h.peerMu.Unlock()
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("Android PeerConnection state=%s", state)
		if isGone(state) {
			h.closePeer(connectionID)
		}
	})

	answer, err := h.negotiate(r.Context(), pc, offer)
	if err != nil {
		h.closePeer(connectionID)
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(AnswerModel{
		ConnectionID:   connectionID,
		Type:           answer.Type.String(),
		SDP:            answer.SDP,
		StreamIdentity: verdict.status(),
	}); err != nil {
		h.closePeer(connectionID)
	}
}

// Only one Android publisher is supported. Retire its previous negotiated or
// pending peer before gathering for a new offer, rather than waiting for ICE
// failure or first RTP. This frees its TURN allocation within the fixed pool.
func (h *Handler) replacePeer(pc *webrtc.PeerConnection) (string, error) {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	var token [32]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", err
	}
	id := hex.EncodeToString(token[:])
	h.peerMu.Lock()
	old := h.peer
	h.peer, h.peerID = pc, id
	if old != nil && h.broadcaster != nil {
		h.broadcaster.RemovePublisher(old)
	}
	h.peerMu.Unlock()
	if old != nil {
		log.Printf("Android previous peer retired before new ICE gathering")
		_ = old.Close()
	}
	return id, nil
}

func (h *Handler) closePeer(id string) bool {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	h.peerMu.Lock()
	if id == "" || h.peerID != id || h.peer == nil {
		h.peerMu.Unlock()
		return false
	}
	pc := h.peer
	h.peer, h.peerID = nil, ""
	if h.broadcaster != nil {
		h.broadcaster.RemovePublisher(pc)
	}
	h.peerMu.Unlock()
	_ = pc.Close()
	log.Printf("Android peer explicitly released")
	return true
}

// validateRecordingContext resolves the offer's stream identity. A rejection is
// never fatal - the live stream is still published - but the reason travels back
// to the publisher in the answer, because a publisher that believes it is
// sending telemetry has no other way to learn that the relay is dropping it.
func (h *Handler) validateRecordingContext(requestContext context.Context, offer OfferModel) identityVerdict {
	if offer.TripID == "" && offer.VehicleID == "" && offer.RecordingSessionID == "" {
		return identityVerdict{}
	}
	if h.validator == nil {
		const reason = "the relay has no Node connection, so recording and telemetry are disabled"
		log.Printf("stream identity supplied while recording and Android telemetry are disabled; accepting live publisher without identity")
		return identityVerdict{offered: true, reason: reason}
	}
	if offer.TripID == "" {
		return h.validateVehicleContext(requestContext, offer)
	}
	tripID, tripErr := strconv.ParseInt(offer.TripID, 10, 64)
	vehicleID, vehicleErr := strconv.ParseInt(offer.VehicleID, 10, 64)
	if tripErr != nil || vehicleErr != nil || offer.RecordingSessionID == "" {
		const reason = "the trip, vehicle, or recording session id was missing or malformed"
		log.Printf("recording identity is incomplete or malformed; accepting live publisher without recording")
		return h.trackVehicleWithoutTrip(requestContext, offer, reason)
	}
	requested := recording.Context{
		TripID:             tripID,
		VehicleID:          vehicleID,
		RecordingSessionID: offer.RecordingSessionID,
	}
	validationContext, cancel := context.WithTimeout(requestContext, 3*time.Second)
	defer cancel()
	validated, err := h.validator.ValidateRecordingContext(validationContext, requested)
	if err != nil {
		log.Printf("recording identity validation failed; accepting live publisher without recording: %v", err)
		return h.trackVehicleWithoutTrip(requestContext, offer, identityRejectionReason(err))
	}
	return identityVerdict{offered: true, context: &validated}
}

// trackVehicleWithoutTrip keeps a publisher on the operator map when its trip
// is rejected - for example a stale saved Trip ID - but its vehicle is valid.
// Nothing is recorded; the trip rejection still reaches the publisher.
func (h *Handler) trackVehicleWithoutTrip(requestContext context.Context, offer OfferModel, tripReason string) identityVerdict {
	vehicle := h.validateVehicleContext(requestContext, OfferModel{VehicleID: offer.VehicleID, RecordingSessionID: offer.RecordingSessionID})
	if vehicle.context == nil {
		return identityVerdict{offered: true, reason: tripReason}
	}
	log.Printf("trip rejected; tracking vehicle %d without recording", vehicle.context.VehicleID)
	return identityVerdict{offered: true, context: vehicle.context, reason: tripReason, trackingOnly: true}
}

// validateVehicleContext accepts a publisher that names its vehicle but has no
// active trip. The vehicle is tracked on the map like a BIMS vehicle; the
// returned context has TripID 0, so nothing is recorded for it.
func (h *Handler) validateVehicleContext(requestContext context.Context, offer OfferModel) identityVerdict {
	validator, ok := h.validator.(recording.VehicleContextValidator)
	if !ok {
		const reason = "the relay cannot validate a vehicle without a trip"
		log.Printf("vehicle-only stream identity is unsupported by the validator; accepting live publisher without identity")
		return identityVerdict{offered: true, reason: reason}
	}
	vehicleID, err := strconv.ParseInt(offer.VehicleID, 10, 64)
	if err != nil || offer.RecordingSessionID == "" {
		const reason = "the vehicle or recording session id was missing or malformed"
		log.Printf("vehicle identity is incomplete or malformed; accepting live publisher without identity")
		return identityVerdict{offered: true, reason: reason}
	}
	validationContext, cancel := context.WithTimeout(requestContext, 3*time.Second)
	defer cancel()
	validated, err := validator.ValidateVehicleContext(validationContext, vehicleID, offer.RecordingSessionID)
	if err != nil {
		log.Printf("vehicle identity validation failed; accepting live publisher without identity: %v", err)
		return identityVerdict{offered: true, reason: identityRejectionReason(err)}
	}
	return identityVerdict{offered: true, context: &validated}
}

// identityRejectionReason turns a Node rejection into one short sentence for the
// publisher's UI. Node answers with {"error":{"code","message"}}; anything else
// (an outage, a timeout) is reported as an unreachable Node rather than as a
// rejected trip, because the two need opposite fixes.
func identityRejectionReason(err error) string {
	var coded *recording.HTTPStatusError
	if !errors.As(err, &coded) {
		return "the relay could not reach Node to validate it"
	}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if jsonErr := json.Unmarshal([]byte(coded.Message), &envelope); jsonErr == nil && envelope.Error.Message != "" {
		return fmt.Sprintf("Node rejected it: %s", envelope.Error.Message)
	}
	return fmt.Sprintf("Node rejected it with HTTP %d", coded.Status)
}

func (h *Handler) newPeerConnection() (*webrtc.PeerConnection, error) {
	return h.api.NewPeerConnection(h.configuration)
}

func (h *Handler) negotiate(ctx context.Context, pc *webrtc.PeerConnection, offer OfferModel) (webrtc.SessionDescription, error) {
	if err := ctx.Err(); err != nil {
		return webrtc.SessionDescription{}, err
	}
	if offer.Type != "offer" || offer.SDP == "" {
		return webrtc.SessionDescription{}, errors.New("valid SDP offer required")
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		return webrtc.SessionDescription{}, err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		return webrtc.SessionDescription{}, err
	}
	select {
	case <-gatherComplete:
	case <-ctx.Done():
		return webrtc.SessionDescription{}, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return webrtc.SessionDescription{}, err
	}
	if pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
		return webrtc.SessionDescription{}, errors.New("peer was replaced during negotiation")
	}
	local := pc.LocalDescription()
	if local == nil {
		return webrtc.SessionDescription{}, errors.New("local SDP was not created")
	}
	return *local, nil
}

func isGone(state webrtc.PeerConnectionState) bool {
	// Disconnected is a transient ICE state. Closing the peer immediately here
	// tears down SCTP just as Android's DataChannels open, which loses the
	// first telemetry batches and prevents the connection from recovering.
	// Pion will transition to Failed if connectivity does not recover.
	return state == webrtc.PeerConnectionStateFailed ||
		state == webrtc.PeerConnectionStateClosed
}

// requestKeyframe lets Python ask Android for a fresh keyframe without
// tearing down its TCP feed connection - used when a decode error is
// recoverable by just resetting decoder state, not by reconnecting (see
// frame_receiver in yolo.py).
func (h *Handler) requestKeyframe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	h.broadcaster.RequestKeyFrame()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// status lets Python resync its own android_live state - see
// Broadcaster.IsLive for why this is needed at all.
func (h *Handler) status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET required")
		return
	}
	h.peerMu.Lock()
	pc := h.peer
	h.peerMu.Unlock()
	var peerStatus map[string]any
	if pc != nil {
		peerStatus = map[string]any{
			"connectionState":    pc.ConnectionState().String(),
			"iceConnectionState": pc.ICEConnectionState().String(),
			"iceGatheringState":  pc.ICEGatheringState().String(),
			"signalingState":     pc.SignalingState().String(),
		}
		if sctp := pc.SCTP(); sctp != nil && sctp.Transport() != nil {
			ice := sctp.Transport().ICETransport()
			if ice != nil {
				if pair, err := ice.GetSelectedCandidatePair(); err == nil && pair != nil {
					peerStatus["localCandidate"] = pair.Local
					peerStatus["remoteCandidate"] = pair.Remote
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"live":      h.broadcaster.IsLive(),
		"recording": h.broadcaster.RecordingStatus(),
		"peer":      peerStatus,
	})
}

func (h *Handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Private status is also loopback-accessible when administration is enabled.
		// Only signaling is browser-facing; never grant websites CORS access to status.
		if r.URL.Path == "/offer/android" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		fmt.Printf("response encoding error: %v\n", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"detail": message})
}
