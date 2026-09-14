package signaling

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/pion/webrtc/v4"

	"poc-server-webrtc/relay-go/internal/broadcaster"
)

type OfferModel struct {
	SDP  string
	Type string
}

type Handler struct {
	api           *webrtc.API
	configuration webrtc.Configuration
	broadcaster   *broadcaster.Broadcaster
}

func NewHandler(api *webrtc.API, configuration webrtc.Configuration, relay *broadcaster.Broadcaster) *Handler {
	return &Handler{api: api, configuration: configuration, broadcaster: relay}
}

func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/offer/android", h.offerAndroid)
	mux.HandleFunc("/internal/request-keyframe", h.requestKeyframe)
	mux.HandleFunc("/internal/status", h.status)
	mux.HandleFunc("/healthz", h.health)
	return withCORS(mux)
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
	pc, err := h.newPeerConnection()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if track.Kind() == webrtc.RTPCodecTypeVideo {
			h.broadcaster.SetPublisher(pc, track)
		}
	})
	pc.OnDataChannel(h.broadcaster.HandleDataChannel)
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
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
	writeJSON(w, http.StatusOK, answer)
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
	return state == webrtc.PeerConnectionStateFailed ||
		state == webrtc.PeerConnectionStateDisconnected ||
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
	writeJSON(w, http.StatusOK, map[string]bool{"live": h.broadcaster.IsLive()})
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
