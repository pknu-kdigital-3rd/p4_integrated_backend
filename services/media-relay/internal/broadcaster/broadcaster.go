package broadcaster

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"

	"poc-server-webrtc/relay-go/internal/recording"
	"poc-server-webrtc/relay-go/internal/yolofeed"
)

type Publisher struct {
	pc    *webrtc.PeerConnection
	track *webrtc.TrackRemote
	done  chan struct{}
}

type Broadcaster struct {
	lifecycleMu sync.Mutex
	mu          sync.RWMutex
	publisher   *Publisher
	yolo        *yolofeed.Feed
	recorder    *recording.Recorder
	onLive      func(bool)
}

func New(yolo *yolofeed.Feed, onLive func(bool), recorder *recording.Recorder) *Broadcaster {
	return &Broadcaster{
		yolo:     yolo,
		recorder: recorder,
		onLive:   onLive,
	}
}

// SetPublisher installs the single active publisher. A later publisher wins.
func (b *Broadcaster) SetPublisher(pc *webrtc.PeerConnection, track *webrtc.TrackRemote, recordingContext *recording.Context) {
	b.lifecycleMu.Lock()
	publisher := &Publisher{pc: pc, track: track, done: make(chan struct{})}
	old := b.replacePublisher(publisher)
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

// HandleDataChannel receives Android's QR decode events. The channel is
// reliable/ordered by default; media remains on the RTP track and is never
// blocked by a slow QR scanner.
func (b *Broadcaster) HandleDataChannel(channel *webrtc.DataChannel) {
	if channel == nil || channel.Label() != "qr-events" {
		return
	}
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
