package signaling

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/pion/webrtc/v4"

	"poc-server-webrtc/relay-go/internal/broadcaster"
	"poc-server-webrtc/relay-go/internal/recording"
	"poc-server-webrtc/relay-go/internal/telemetry"
)

type OfferModel struct {
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
	Validated bool   `json:"validated"`
	Reason    string `json:"reason,omitempty"`
}

// AnswerModel is the SDP answer plus the identity verdict.
type AnswerModel struct {
	Type           string                `json:"type"`
	SDP            string                `json:"sdp"`
	StreamIdentity *StreamIdentityStatus `json:"streamIdentity,omitempty"`
}

// identityVerdict is the outcome of validating one offer's stream identity.
// reason is empty exactly when the identity was accepted.
type identityVerdict struct {
	offered bool
	context *recording.Context
	reason  string
}

func (v identityVerdict) status() *StreamIdentityStatus {
	if !v.offered {
		return nil
	}
	return &StreamIdentityStatus{Validated: v.context != nil, Reason: v.reason}
}

type Handler struct {
	api           *webrtc.API
	configuration webrtc.Configuration
	broadcaster   *broadcaster.Broadcaster
	validator     recording.ContextValidator
	telemetry     *telemetry.Service
}

func NewHandler(api *webrtc.API, configuration webrtc.Configuration, relay *broadcaster.Broadcaster, validator recording.ContextValidator) *Handler {
	return &Handler{api: api, configuration: configuration, broadcaster: relay, validator: validator}
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
	verdict := h.validateRecordingContext(r.Context(), offer)
	recordingContext := verdict.context
	pc, err := h.newPeerConnection()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if track.Kind() == webrtc.RTPCodecTypeVideo {
			h.broadcaster.SetPublisher(pc, track, recordingContext)
		}
	})
	pc.OnDataChannel(func(channel *webrtc.DataChannel) {
		h.broadcaster.HandleDataChannel(pc, recordingContext, channel)
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("Android PeerConnection state=%s", state)
		if isGone(state) {
			h.broadcaster.RemovePublisher(pc)
			_ = pc.Close()
		}
	})

	answer, err := h.negotiate(pc, offer)
	if err != nil {
		_ = pc.Close()
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, AnswerModel{
		Type:           answer.Type.String(),
		SDP:            answer.SDP,
		StreamIdentity: verdict.status(),
	})
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
	tripID, tripErr := strconv.ParseInt(offer.TripID, 10, 64)
	vehicleID, vehicleErr := strconv.ParseInt(offer.VehicleID, 10, 64)
	if tripErr != nil || vehicleErr != nil || offer.RecordingSessionID == "" {
		const reason = "the trip, vehicle, or recording session id was missing or malformed"
		log.Printf("recording identity is incomplete or malformed; accepting live publisher without recording")
		return identityVerdict{offered: true, reason: reason}
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

func (h *Handler) negotiate(pc *webrtc.PeerConnection, offer OfferModel) (webrtc.SessionDescription, error) {
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
	<-gatherComplete
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
	writeJSON(w, http.StatusOK, map[string]any{
		"live":      h.broadcaster.IsLive(),
		"recording": h.broadcaster.RecordingStatus(),
	})
}

func (h *Handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
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
