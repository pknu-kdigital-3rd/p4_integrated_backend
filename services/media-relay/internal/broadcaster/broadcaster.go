package broadcaster

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"sync/atomic"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"

	"poc-server-webrtc/relay-go/internal/recording"
	"poc-server-webrtc/relay-go/internal/telemetry"
	"poc-server-webrtc/relay-go/internal/yolofeed"
)

const (
	qrChannelLabel        = "qr-events"
	telemetryChannelLabel = "telemetry-events"
)

type Publisher struct {
	pc       *webrtc.PeerConnection
	track    *webrtc.TrackRemote
	done     chan struct{}
	identity *telemetry.StreamIdentity
}

type Broadcaster struct {
	lifecycleMu sync.Mutex
	mu          sync.RWMutex
	publisher   *Publisher
	yolo        *yolofeed.Feed
	recorder    *recording.Recorder
	telemetry   *telemetry.Service
	onLive      func(bool)
}

func New(yolo *yolofeed.Feed, onLive func(bool), recorder *recording.Recorder) *Broadcaster {
	return &Broadcaster{
		yolo:     yolo,
		recorder: recorder,
		onLive:   onLive,
	}
}

// SetTelemetry enables telemetry-events ingestion. Call before serving offers.
func (b *Broadcaster) SetTelemetry(service *telemetry.Service) {
	b.telemetry = service
}

// StreamIdentity converts a Node-validated recording context into the trusted
// telemetry identity; nil means the stream carries no trusted identity.
func StreamIdentity(recordingContext *recording.Context) *telemetry.StreamIdentity {
	if recordingContext == nil {
		return nil
	}
	return &telemetry.StreamIdentity{
		TripID:             recordingContext.TripID,
		VehicleID:          recordingContext.VehicleID,
		RecordingSessionID: recordingContext.RecordingSessionID,
	}
}

// SetPublisher installs the single active publisher. A later publisher wins.
func (b *Broadcaster) SetPublisher(pc *webrtc.PeerConnection, track *webrtc.TrackRemote, recordingContext *recording.Context) {
	b.lifecycleMu.Lock()
	// Pion normally delivers one OnTrack event per negotiated media track, but
	// a renegotiation or duplicate remote track must not replace and close the
	// publisher that belongs to this same PeerConnection. Closing old.pc below
	// in that case would tear down the SCTP DataChannels immediately after they
	// open, which looks like a telemetry transport failure on Android.
	b.mu.RLock()
	current := b.publisher
	b.mu.RUnlock()
	if current != nil && current.pc == pc {
		log.Printf("Android publisher track already active for this PeerConnection (SSRC %d)", track.SSRC())
		b.lifecycleMu.Unlock()
		return
	}
	identity := StreamIdentity(recordingContext)
	publisher := &Publisher{pc: pc, track: track, done: make(chan struct{}), identity: identity}
	old := b.replacePublisher(publisher)
	if b.telemetry != nil {
		if identity != nil {
			b.telemetry.Activate(*identity)
		} else if old != nil && old.identity != nil {
			b.telemetry.Deactivate(old.identity.RecordingSessionID)
		}
	}
	if b.yolo != nil {
		var identity *yolofeed.RecordingIdentity
		if recordingContext != nil {
			identity = &yolofeed.RecordingIdentity{
				TripID:             recordingContext.TripID,
				VehicleID:          recordingContext.VehicleID,
				RecordingSessionID: recordingContext.RecordingSessionID,
			}
		}
		b.yolo.SetRecordingIdentity(identity)
	}
	if old != nil {
		log.Printf("Android publisher replaced (SSRC %d -> %d)", old.track.SSRC(), track.SSRC())
		close(old.done)
		if b.yolo != nil {
			b.yolo.End()
		}
	} else {
		log.Printf("Android publisher connected (SSRC %d)", track.SSRC())
	}
	if b.recorder != nil {
		if recordingContext == nil {
			b.recorder.Stop("publisher connected without a validated recording context")
		} else if err := b.recorder.Start(*recordingContext); err != nil {
			log.Printf("recording context could not be started; live publishing continues: %v", err)
		}
	}
	b.lifecycleMu.Unlock()
	if old != nil {
		_ = old.pc.Close()
	}
	b.onLiveAsync(true)
	go b.readPublisher(publisher)
	// Ask for an IDR at publisher arrival as well as when Python attaches to
	// the reliable feed. This makes startup order independent: if Android
	// connects before Python, the first retained access unit is still a fresh,
	// decodable keyframe when Python eventually joins.
	go b.RequestKeyFrame()
}

func (b *Broadcaster) RemovePublisher(pc *webrtc.PeerConnection) {
	b.lifecycleMu.Lock()
	defer b.lifecycleMu.Unlock()
	b.mu.Lock()
	if b.publisher == nil || b.publisher.pc != pc {
		b.mu.Unlock()
		return
	}
	old := b.publisher
	b.publisher = nil
	b.mu.Unlock()

	log.Printf("Android publisher disconnected (SSRC %d)", old.track.SSRC())
	close(old.done)
	if b.telemetry != nil && old.identity != nil {
		b.telemetry.Deactivate(old.identity.RecordingSessionID)
	}
	if b.recorder != nil {
		b.recorder.Stop("publisher disconnected")
	}
	if b.yolo != nil {
		b.yolo.SetRecordingIdentity(nil)
		b.yolo.End()
	}
	b.onLiveAsync(false)
}

func (b *Broadcaster) replacePublisher(publisher *Publisher) *Publisher {
	b.mu.Lock()
	old := b.publisher
	b.publisher = publisher
	b.mu.Unlock()
	return old
}

// RequestKeyFrame asks the current Android publisher for a fresh IDR by
// sending a PLI addressed to the publisher's track SSRC. Python calls this
// when the reliable feed starts or a playback epoch must be resynchronized.
func (b *Broadcaster) RequestKeyFrame() {
	b.mu.RLock()
	publisher := b.publisher
	b.mu.RUnlock()
	if publisher == nil {
		return
	}
	mediaSSRC := uint32(publisher.track.SSRC())
	if err := publisher.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: mediaSSRC}}); err != nil {
		log.Printf("RequestKeyFrame: %v", err)
	}
}

// HandleDataChannel routes Android's DataChannels. pc and recordingContext are
// the peer connection the channel belongs to and its Node-validated identity;
// telemetry is bound to that identity, never to identity fields in the payload.
// Unknown labels are ignored.
func (b *Broadcaster) HandleDataChannel(pc *webrtc.PeerConnection, recordingContext *recording.Context, channel *webrtc.DataChannel) {
	if channel == nil {
		return
	}
	switch channel.Label() {
	case qrChannelLabel:
		b.handleQRChannel(channel)
	case telemetryChannelLabel:
		if b.telemetry == nil {
			log.Printf("Android telemetry DataChannel received while telemetry is disabled")
			return
		}
		identity := StreamIdentity(recordingContext)
		log.Printf("Android telemetry DataChannel registered (identity=%s)", telemetryIdentityLabel(identity))
		channel.OnOpen(func() {
			log.Printf("Android telemetry DataChannel opened (identity=%s)", telemetryIdentityLabel(identity))
		})
		channel.OnClose(func() {
			log.Printf("Android telemetry DataChannel closed (identity=%s)", telemetryIdentityLabel(identity))
		})
		var messages atomic.Uint64
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			if messages.Add(1) == 1 {
				log.Printf("Android telemetry DataChannel received first batch (bytes=%d, identity=%s)", len(message.Data), telemetryIdentityLabel(identity))
			}
			_ = b.HandleTelemetryMessage(pc, identity, message.Data)
		})
	}
}

func telemetryIdentityLabel(identity *telemetry.StreamIdentity) string {
	if identity == nil {
		return "none"
	}
	return fmt.Sprintf("trip=%d vehicle=%d session=%s", identity.TripID, identity.VehicleID, identity.RecordingSessionID)
}

// HandleTelemetryMessage ingests one telemetry-events message. It returns
// without blocking: persistence and Vision forwarding are queued. Messages from
// a peer connection that is not the active publisher are rejected so a
// replaced or reconnecting peer cannot inject telemetry into the live stream.
func (b *Broadcaster) HandleTelemetryMessage(pc *webrtc.PeerConnection, identity *telemetry.StreamIdentity, data []byte) error {
	if b.telemetry == nil {
		return nil
	}
	b.mu.RLock()
	active := b.publisher != nil && b.publisher.pc == pc
	b.mu.RUnlock()
	if !active {
		return b.telemetry.RejectStale()
	}
	return b.telemetry.HandleMessage(identity, data)
}

// handleQRChannel receives Android's QR decode events. The channel is
// reliable/ordered by default; media remains on the RTP track and is never
// blocked by a slow QR scanner.
func (b *Broadcaster) handleQRChannel(channel *webrtc.DataChannel) {
	if b.yolo != nil {
		b.yolo.SetQRActive(true)
	}
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		var envelope struct {
			Type               string `json:"type"`
			RTPTimestamp       uint32 `json:"rtp_timestamp"`
			CaptureTimestampNS int64  `json:"capture_timestamp_ns"`
			SourceTimestampNS  *int64 `json:"source_timestamp_ns"`
			DecodeSuccess      bool   `json:"decode_success"`
			CaptureIndex       int64  `json:"capture_index"`
			LatencyMS          int64  `json:"latency_ms"`
		}
		if err := json.Unmarshal(message.Data, &envelope); err != nil || envelope.Type != "qr" {
			return
		}
		if b.yolo != nil {
			b.yolo.PublishQREvent(yolofeed.QREvent{
				RTPTimestamp:       envelope.RTPTimestamp,
				CaptureTimestampNS: envelope.CaptureTimestampNS,
				SourceTimestampNS:  envelope.SourceTimestampNS,
				DecodeSuccess:      envelope.DecodeSuccess,
				CaptureIndex:       envelope.CaptureIndex,
				LatencyMS:          envelope.LatencyMS,
			})
		}
	})
}

// IsLive reports whether a publisher is currently connected. Exposed over
// HTTP (GET /internal/status) so Python can resync its own android_live
// state on startup - without this, a Python restart while Android is
// already streaming has no way to learn that: Go only pushes
// /internal/android-live on connect/disconnect edges via onLive, not as a
// periodic heartbeat, so a fresh Python process would otherwise sit at its
// default android_live=false forever (the next edge transition may never
// come), and every browser reconnect immediately sees android_live=false
// and loops reconnecting for nothing.
func (b *Broadcaster) IsLive() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.publisher != nil
}

func (b *Broadcaster) RecordingStatus() recording.Status {
	if b.recorder == nil {
		return recording.Status{Enabled: false}
	}
	return b.recorder.Status()
}

// QRStatus reports publisher QR event receipt and pairing with video frames.
func (b *Broadcaster) QRStatus() yolofeed.QRStatus {
	if b.yolo == nil {
		return yolofeed.QRStatus{LastEventAgeMS: -1, OldestPendingEventAgeMS: -1}
	}
	return b.yolo.QRStatus()
}

func (b *Broadcaster) Close() {
	b.lifecycleMu.Lock()
	b.mu.Lock()
	publisher := b.publisher
	b.publisher = nil
	b.mu.Unlock()
	if b.recorder != nil {
		b.recorder.Stop("relay shutdown")
	}
	b.lifecycleMu.Unlock()
	if publisher != nil {
		close(publisher.done)
		_ = publisher.pc.Close()
		if b.yolo != nil {
			b.yolo.End()
		}
		b.onLiveAsync(false)
	}
}

func (b *Broadcaster) readPublisher(publisher *Publisher) {
	for {
		packet, _, err := publisher.track.ReadRTP()
		if err != nil {
			b.RemovePublisher(publisher.pc)
			return
		}

		b.mu.RLock()
		if b.publisher != publisher {
			b.mu.RUnlock()
			return
		}
		// Feed first: Publish performs ordered depacketization and retains the
		// compressed access unit. The recorder receives that same immutable
		// object through a bounded non-blocking queue.
		if b.yolo != nil {
			item := b.yolo.Publish(packet)
			if item != nil && b.recorder != nil {
				b.recorder.Publish(item)
			}
		}
		b.mu.RUnlock()
	}
}

func (b *Broadcaster) onLiveAsync(live bool) {
	if b.onLive != nil {
		go b.onLive(live)
	}
}
