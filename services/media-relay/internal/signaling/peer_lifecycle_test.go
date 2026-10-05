package signaling

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pion/turn/v4"
	"github.com/pion/webrtc/v4"
	"poc-server-webrtc/relay-go/internal/broadcaster"
)

func testPeer(t *testing.T) *webrtc.PeerConnection {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	return pc
}

// Exercise native TURN allocation teardown with both allowed relay ports in
// use. The replacement must obtain a port without waiting for lease expiry.
func TestReplacementReusesTwoPortTURNPool(t *testing.T) {
	for port := 39006; port <= 39007; port++ {
		probe, err := net.ListenPacket("udp4", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Skipf("relay port %d is already in use: %v", port, err)
		}
		_ = probe.Close()
	}
	listener, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server, err := turn.NewServer(turn.ServerConfig{
		Realm: "restart-test",
		AuthHandler: func(username, realm string, _ net.Addr) ([]byte, bool) {
			return turn.GenerateAuthKey(username, realm, "test-password"), username == "restart-test"
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: listener,
			RelayAddressGenerator: &turn.RelayAddressGeneratorPortRange{
				RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1",
				MinPort: 39006, MaxPort: 39007, MaxRetries: 100,
			},
		}},
	})
	if err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	newRelayPeer := func() *webrtc.PeerConnection {
		pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
			ICETransportPolicy: webrtc.ICETransportPolicyRelay,
			ICEServers:         []webrtc.ICEServer{{URLs: []string{"turn:" + listener.LocalAddr().String() + "?transport=udp"}, Username: "restart-test", Credential: "test-password"}},
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = pc.Close() })
		return pc
	}
	gather := func(pc *webrtc.PeerConnection) int {
		_, err := pc.CreateDataChannel("test", nil)
		if err != nil {
			t.Fatal(err)
		}
		offer, err := pc.CreateOffer(nil)
		if err != nil {
			t.Fatal(err)
		}
		complete := webrtc.GatheringCompletePromise(pc)
		if err := pc.SetLocalDescription(offer); err != nil {
			t.Fatal(err)
		}
		select {
		case <-complete:
		case <-time.After(5 * time.Second):
			t.Fatal("TURN gathering timed out")
		}
		for _, line := range strings.Split(pc.LocalDescription().SDP, "\n") {
			if strings.HasPrefix(line, "a=candidate:") && strings.Contains(line, " typ relay") {
				fields := strings.Fields(line)
				var port int
				if _, err := fmt.Sscan(fields[5], &port); err != nil {
					t.Fatal(err)
				}
				if port != 39006 && port != 39007 {
					t.Fatalf("relay port outside allowed range: %d", port)
				}
				return port
			}
		}
		t.Fatal("no TURN candidate: old allocation was not released")
		return 0
	}
	h := &Handler{}
	old, android := newRelayPeer(), newRelayPeer()
	if _, err := h.replacePeer(old); err != nil {
		t.Fatal(err)
	}
	oldPort, androidPort := gather(old), gather(android)
	if oldPort == androidPort {
		t.Fatal("both peers must occupy separate relay ports")
	}
	next := newRelayPeer()
	id, err := h.replacePeer(next)
	if err != nil {
		t.Fatal(err)
	}
	defer h.closePeer(id)
	if port := gather(next); port != oldPort {
		t.Fatalf("replacement port=%d, retired port=%d", port, oldPort)
	}
}

func TestReplacementClosesOldPeerBeforeNewGathering(t *testing.T) {
	h := &Handler{}
	old, next := testPeer(t), testPeer(t)
	oldID, err := h.replacePeer(old)
	if err != nil {
		t.Fatal(err)
	}
	nextID, err := h.replacePeer(next)
	if err != nil {
		t.Fatal(err)
	}
	defer h.closePeer(nextID)
	if old.ConnectionState() != webrtc.PeerConnectionStateClosed {
		t.Fatal("old peer still owns native transports after replacement")
	}
	if oldID == nextID || len(nextID) != 64 {
		t.Fatal("replacement must have a fresh opaque stop token")
	}
	if h.closePeer(oldID) || next.ConnectionState() == webrtc.PeerConnectionStateClosed {
		t.Fatal("late Stop from the old connection closed the replacement")
	}
}

func TestExplicitStopUsesExistingOfferRouteAndIsIdempotent(t *testing.T) {
	h := &Handler{}
	pc := testPeer(t)
	id, err := h.replacePeer(pc)
	if err != nil {
		t.Fatal(err)
	}
	for index, expected := range []bool{true, false} {
		request := httptest.NewRequest(http.MethodPost, "/offer/android", strings.NewReader(`{"type":"close","connectionId":"`+id+`"}`))
		response := httptest.NewRecorder()
		h.Routes().ServeHTTP(response, request)
		var result struct {
			Closed bool `json:"closed"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || result.Closed != expected {
			t.Fatalf("Stop %d: status=%d closed=%v", index, response.Code, result.Closed)
		}
	}
	if pc.ConnectionState() != webrtc.PeerConnectionStateClosed || h.peer != nil {
		t.Fatal("Stop must close native transports and remove the registered peer")
	}
}

func TestInvalidOfferAndMissingStopTokenPreserveCurrentPeer(t *testing.T) {
	h := &Handler{}
	pc := testPeer(t)
	id, err := h.replacePeer(pc)
	if err != nil {
		t.Fatal(err)
	}
	defer h.closePeer(id)
	for _, body := range []string{`{"type":"close"}`, `{"type":"offer","sdp":"invalid"}`} {
		response := httptest.NewRecorder()
		h.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/offer/android", strings.NewReader(body)))
		if response.Code != http.StatusBadRequest || h.peer != pc || pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
			t.Fatal("invalid request must not tear down the current publisher")
		}
	}
}

func TestCanceledNegotiationDoesNotWaitForGathering(t *testing.T) {
	sender := testPeer(t)
	_, err := sender.CreateDataChannel("test", nil)
	if err != nil {
		t.Fatal(err)
	}
	offer, err := sender.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	receiver := testPeer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = (&Handler{}).negotiate(ctx, receiver, OfferModel{Type: "offer", SDP: offer.SDP})
	if err != context.Canceled {
		t.Fatalf("canceled negotiation returned %v", err)
	}
}

func TestPrivateStatusReportsActualPeerICEState(t *testing.T) {
	h := &Handler{broadcaster: broadcaster.New(nil, nil, nil)}
	pc := testPeer(t)
	id, err := h.replacePeer(pc)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	h.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/status", nil))
	if response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("private status must not grant CORS access")
	}
	var status struct {
		Peer map[string]any `json:"peer"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Peer["iceConnectionState"] != pc.ICEConnectionState().String() || status.Peer["connectionState"] != pc.ConnectionState().String() {
		t.Fatalf("incorrect native peer state: %v", status.Peer)
	}
	h.closePeer(id)
	response = httptest.NewRecorder()
	h.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/status", nil))
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Peer != nil {
		t.Fatalf("retired peer still appears: %v", status.Peer)
	}
}
