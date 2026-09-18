package yolofeed

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"sync"
	"time"

	"github.com/pion/rtp"
)

const (
	kStart             = 1
	kFrame             = 2
	kEnd               = 3
	kReset             = 4
	kBegin             = 10
	kPresentedAck      = 12
	kResync            = 13
	kStop              = 14
	maxRecordBytes     = 256 * 1024 * 1024
	maxPendingQREvents = 1024
	defaultAssemblyCap = 64 * 1024
	maxReusableAUCap   = 512 * 1024
	qrPairingWait      = 150 * time.Millisecond
)

// AccessUnit is the authoritative compressed frame retained by the relay.
// Data is an Annex-B H.264 access unit and is never overwritten by a newer
// frame. It remains in the backlog until Python acknowledges presentation.
type AccessUnit struct {
	Epoch        uint64
	Seq          uint64
	RTPTimestamp uint32
	PTS90K       int64
	TimestampUS  int64
	Keyframe     bool
	Data         []byte
	QR           *QREvent
	Recording    *RecordingIdentity
	receivedAt   time.Time
}

// RecordingIdentity joins Vision results to the exact trip/session recorded
// from the same access units. IDs are JSON strings to avoid lossy JS numbers.
type RecordingIdentity struct {
	TripID             int64  `json:"trip_id,string"`
	VehicleID          int64  `json:"vehicle_id,string"`
	RecordingSessionID string `json:"recording_session_id"`
}

// QREvent is emitted by the Android publisher over the reliable qr-events
// DataChannel. RTPTimestamp is the 90 kHz timestamp derived from the exact
// VideoFrame timestamp used for the paired H.264 frame.
type QREvent struct {
	RTPTimestamp       uint32 `json:"rtp_timestamp"`
	CaptureTimestampNS int64  `json:"capture_timestamp_ns"`
	SourceTimestampNS  *int64 `json:"source_timestamp_ns"`
	DecodeSuccess      bool   `json:"decode_success"`
	CaptureIndex       int64  `json:"capture_index"`
	LatencyMS          int64  `json:"latency_ms"`
	receivedAt         time.Time
}

// QRStatus reports whether publisher QR events are reaching the relay and
// whether they are being attached to the corresponding video access units.
type QRStatus struct {
	ChannelObserved                      bool   `json:"channel_observed"`
	EventsReceivedTotal                  uint64 `json:"events_received_total"`
	DecodeSuccessTotal                   uint64 `json:"decode_success_total"`
	PairedTotal                          uint64 `json:"paired_total"`
	PairedDecodeSuccessTotal             uint64 `json:"paired_decode_success_total"`
	PairedExactTimestampTotal            uint64 `json:"paired_exact_timestamp_total"`
	PairedArrivalTimeTotal               uint64 `json:"paired_arrival_time_total"`
	FramesSentTotal                      uint64 `json:"frames_sent_total"`
	FramesSentWithQREventTotal           uint64 `json:"frames_sent_with_qr_event_total"`
	FramesSentWithSuccessfulQREventTotal uint64 `json:"frames_sent_with_successful_qr_total"`
	PendingEvents                        int    `json:"pending_events"`
	LastEventAgeMS                       int64  `json:"last_event_age_ms"`
	OldestPendingEventAgeMS              int64  `json:"oldest_pending_event_age_ms"`
}

type Feed struct {
	socketPath string
	maxSeconds float64
	maxBytes   int64

	mu                    sync.Mutex
	cond                  *sync.Cond
	backlog               []*AccessUnit
	backlogBytes          int64
	epoch                 uint64
	nextSeq               uint64
	seenIDR               bool
	lastPacketSeq         uint16
	havePacketSeq         bool
	lastRTPTs             uint32
	haveRTPTs             bool
	assemblyRTPTs         uint32
	haveAssemblyTs        bool
	rtpCycles             int64
	assembly              []byte
	assemblyKey           bool
	assemblyParams        bool
	fuActive              bool
	parameterSets         []byte
	qrActive              bool
	qrEvents              map[uint32]*QREvent
	qrEventsReceived      uint64
	qrDecodeSuccess       uint64
	qrPaired              uint64
	qrPairedDecodeSuccess uint64
	qrPairedExact         uint64
	qrPairedArrival       uint64
	framesSent            uint64
	framesSentWithQR      uint64
	framesSentWithQRValid uint64
	lastQREventAt         time.Time
	recording             *RecordingIdentity
	sourceEnded           bool
	endSent               bool

	// OnClientConnect requests a fresh IDR when Python reconnects. OnResync is
	// called after an explicit or automatic reset so the publisher can recover.
	OnClientConnect func()
	OnResync        func()
}

func New(socketPath string) *Feed {
	return NewWithLimits(socketPath, 30, 256*1024*1024)
}

func NewWithLimits(socketPath string, maxSeconds float64, maxBytes int64) *Feed {
	f := &Feed{
		socketPath: socketPath,
		maxSeconds: maxSeconds,
		maxBytes:   maxBytes,
		epoch:      1,
		assembly:   make([]byte, 0, defaultAssemblyCap),
		qrEvents:   make(map[uint32]*QREvent),
	}
	f.cond = sync.NewCond(&f.mu)
	return f
}

// SetQRActive tells the feed that the publisher negotiated the QR metadata
// channel. It is intentionally separate from PublishQREvent so a stream with
// no visible QR still emits explicit qr_missing metadata to Python.
func (f *Feed) SetQRActive(active bool) {
	f.mu.Lock()
	f.qrActive = active
	f.mu.Unlock()
}

func (f *Feed) QRStatus() QRStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	status := QRStatus{
		ChannelObserved:                      f.qrActive,
		EventsReceivedTotal:                  f.qrEventsReceived,
		DecodeSuccessTotal:                   f.qrDecodeSuccess,
		PairedTotal:                          f.qrPaired,
		PairedDecodeSuccessTotal:             f.qrPairedDecodeSuccess,
		PairedExactTimestampTotal:            f.qrPairedExact,
		PairedArrivalTimeTotal:               f.qrPairedArrival,
		FramesSentTotal:                      f.framesSent,
		FramesSentWithQREventTotal:           f.framesSentWithQR,
		FramesSentWithSuccessfulQREventTotal: f.framesSentWithQRValid,
		PendingEvents:                        len(f.qrEvents),
		LastEventAgeMS:                       -1,
		OldestPendingEventAgeMS:              -1,
	}
	if !f.lastQREventAt.IsZero() {
		status.LastEventAgeMS = now.Sub(f.lastQREventAt).Milliseconds()
	}
	for _, event := range f.qrEvents {
		if event == nil || event.receivedAt.IsZero() {
			continue
		}
		age := now.Sub(event.receivedAt).Milliseconds()
		if status.OldestPendingEventAgeMS < 0 || age > status.OldestPendingEventAgeMS {
			status.OldestPendingEventAgeMS = age
		}
	}
	return status
}

// SetRecordingIdentity labels subsequent frames with the publisher identity.
// Resetting the feed prevents retained frames from a previous publisher or
// recording session from being mislabeled with the new identity.
func (f *Feed) SetRecordingIdentity(identity *RecordingIdentity) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if sameRecordingIdentity(f.recording, identity) {
		return
	}
	if identity == nil {
		f.recording = nil
	} else {
		copyIdentity := *identity
		f.recording = &copyIdentity
	}
	f.resetLocked("recording_context_changed")
}

func sameRecordingIdentity(left, right *RecordingIdentity) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

// PublishQREvent attaches an event to a retained access unit, or holds it
// briefly until that RTP timestamp arrives. Events are tiny and keyed by RTP
// timestamp, so they do not add another unbounded media queue.
func (f *Feed) PublishQREvent(event QREvent) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.qrActive = true
	if event.receivedAt.IsZero() {
		event.receivedAt = time.Now()
	}
	f.qrEventsReceived++
	if event.DecodeSuccess && event.SourceTimestampNS != nil {
		f.qrDecodeSuccess++
	}
	f.lastQREventAt = event.receivedAt
	copyEvent := event
	for _, item := range f.backlog {
		if item.RTPTimestamp == event.RTPTimestamp {
			item.QR = &copyEvent
			f.recordQREventPairLocked(copyEvent, true)
			f.cond.Broadcast()
			return
		}
	}
	// libwebrtc may apply a random RTP timestamp offset, so the timestamp
	// derived on Android is not always byte-for-byte equal to Pion's packet
	// timestamp. When that happens, use the event's receive time and decoder
	// latency to pair it with the nearest retained access unit. This fallback is
	// bounded to one quarter second and never searches outside the current
	// retained backlog.
	target := event.receivedAt
	if event.LatencyMS >= 0 {
		target = target.Add(-time.Duration(event.LatencyMS) * time.Millisecond)
	}
	var nearest *AccessUnit
	var nearestDelta time.Duration
	for _, item := range f.backlog {
		if item.QR != nil {
			continue
		}
		delta := item.receivedAt.Sub(target)
		if delta < 0 {
			delta = -delta
		}
		if nearest == nil || delta < nearestDelta {
			nearest = item
			nearestDelta = delta
		}
	}
	if nearest != nil && nearestDelta <= 250*time.Millisecond {
		nearest.QR = &copyEvent
		f.recordQREventPairLocked(copyEvent, false)
		f.cond.Broadcast()
		return
	}
	if len(f.qrEvents) >= maxPendingQREvents {
		// The map is only a short-lived bridge for an event that arrives before
		// its access unit. If an RTP timestamp never arrives, discard an
		// arbitrary entry rather than retaining metadata
		// without a media bound.
		for timestamp := range f.qrEvents {
			delete(f.qrEvents, timestamp)
			break
		}
	}
	f.qrEvents[event.RTPTimestamp] = &copyEvent
	f.cond.Broadcast()
}

func (f *Feed) recordQREventPairLocked(event QREvent, exactTimestamp bool) {
	f.qrPaired++
	if event.DecodeSuccess && event.SourceTimestampNS != nil {
		f.qrPairedDecodeSuccess++
	}
	if exactTimestamp {
		f.qrPairedExact++
	} else {
		f.qrPairedArrival++
	}
}

// Publish converts one RTP packet into an access unit. It deliberately has no
// non-blocking send or drop branch: the only bounded retention is the explicit
// source-time/byte backlog, whose overflow creates a labeled new epoch.
func (f *Feed) Publish(packet *rtp.Packet) *AccessUnit {
	if packet == nil {
		return nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sourceEnded {
		f.resetLocked("source_restart")
		f.sourceEnded = false
		f.endSent = false
	}

	if f.havePacketSeq {
		expected := f.lastPacketSeq + 1
		if packet.SequenceNumber != expected {
			// RTP over UDP routinely reorders a handful of packets, especially
			// during a keyframe's initial burst (which can span dozens of
			// packets sent back-to-back) - this is normal, recoverable
			// network behavior, not source corruption. A packet whose
			// sequence number is behind what's expected merely arrived late;
			// drop only that one packet rather than treating ordinary
			// reordering as a discontinuity. Only a packet ahead of expected
			// is an actual gap (loss) the current access unit cannot be
			// completed without. int16 handles the uint16 sequence wraparound
			// correctly via twos-complement subtraction.
			if delta := int16(packet.SequenceNumber - expected); delta < 0 {
				return nil
			}
			f.resetLocked("source_discontinuity")
		}
	}
	f.lastPacketSeq = packet.SequenceNumber
	f.havePacketSeq = true
	if len(f.assembly) > 0 && f.haveAssemblyTs && packet.Header.Timestamp != f.assemblyRTPTs {
		f.resetLocked("incomplete_access_unit")
	}
	if len(f.assembly) == 0 {
		f.assemblyRTPTs = packet.Header.Timestamp
		f.haveAssemblyTs = true
	}

	f.consumePayloadLocked(packet.Payload)
	if packet.Header.Marker {
		return f.finishAccessUnitLocked(packet.Header.Timestamp)
	}
	return nil
}

// End marks the source complete without deleting already accepted media. The
// connected Python reader receives END after the retained sequence drains.
func (f *Feed) End() {
	f.mu.Lock()
	f.sourceEnded = true
	f.endSent = false
	f.cond.Broadcast()
	f.mu.Unlock()
}

func (f *Feed) consumePayloadLocked(payload []byte) {
	if len(payload) == 0 {
		return
	}
	nalType := payload[0] & 0x1f
	switch nalType {
	case 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12:
		f.appendNALLocked(payload)
	case 24: // STAP-A
		for offset := 1; offset+2 <= len(payload); {
			length := int(binary.BigEndian.Uint16(payload[offset : offset+2]))
			offset += 2
			if length <= 0 || offset+length > len(payload) {
				return
			}
			f.appendNALLocked(payload[offset : offset+length])
			offset += length
		}
	case 28: // FU-A
		if len(payload) < 2 {
			return
		}
		indicator, header := payload[0], payload[1]
		start := header&0x80 != 0
		end := header&0x40 != 0
		if start {
			// Publish assigned the access-unit timestamp before payload parsing;
			// reuse only the bytes here so FU-A continuation packets still remain
			// associated with that timestamp.
			f.reuseAssemblyBufferLocked()
			f.assemblyKey = false
			f.assemblyParams = false
			f.fuActive = true
			reconstructed := (indicator & 0xe0) | (header & 0x1f)
			f.appendNALLocked([]byte{reconstructed})
		}
		if !f.fuActive {
			return
		}
		f.assembly = append(f.assembly, payload[2:]...)
		if end {
			f.fuActive = false
		}
	}
}

func (f *Feed) appendNALLocked(nal []byte) {
	if len(nal) == 0 {
		return
	}
	nalType := nal[0] & 0x1f
	f.assembly = append(f.assembly, 0, 0, 0, 1)
	f.assembly = append(f.assembly, nal...)
	if nalType == 5 {
		f.assemblyKey = true
	}
	if nalType == 7 || nalType == 8 {
		f.assemblyParams = true
		f.parameterSets = append(f.parameterSets, 0, 0, 0, 1)
		f.parameterSets = append(f.parameterSets, nal...)
		if len(f.parameterSets) > 1<<20 {
			f.parameterSets = f.parameterSets[len(f.parameterSets)-(1<<20):]
		}
	}
}

func (f *Feed) finishAccessUnitLocked(rtpTS uint32) *AccessUnit {
	if len(f.assembly) == 0 {
		f.resetAssemblyLocked()
		return nil
	}
	if !f.seenIDR && !f.assemblyKey {
		f.resetAssemblyLocked()
		return nil
	}
	data := append([]byte(nil), f.assembly...)
	if f.assemblyKey {
		f.seenIDR = true
		if !f.assemblyParams && len(f.parameterSets) > 0 {
			data = append(append([]byte(nil), f.parameterSets...), data...)
		}
	}
	pts := f.extendTimestampLocked(rtpTS)
	item := &AccessUnit{
		Epoch:        f.epoch,
		Seq:          f.nextSeq,
		RTPTimestamp: rtpTS,
		PTS90K:       pts,
		TimestampUS:  pts * 1000000 / 90000,
		Keyframe:     f.assemblyKey,
		Data:         data,
		receivedAt:   time.Now(),
	}
	if f.recording != nil {
		identity := *f.recording
		item.Recording = &identity
	}
	if event, ok := f.qrEvents[rtpTS]; ok {
		item.QR = event
		f.recordQREventPairLocked(*event, true)
		delete(f.qrEvents, rtpTS)
	} else {
		// The data channel can beat the first RTP packet by a few milliseconds.
		// Pair that case with the same bounded arrival-time rule used when the
		// event arrives after the access unit.
		var nearestKey uint32
		var nearest *QREvent
		var nearestDelta time.Duration
		for key, candidate := range f.qrEvents {
			target := candidate.receivedAt
			if candidate.LatencyMS >= 0 {
				target = target.Add(-time.Duration(candidate.LatencyMS) * time.Millisecond)
			}
			delta := item.receivedAt.Sub(target)
			if delta < 0 {
				delta = -delta
			}
			if nearest == nil || delta < nearestDelta {
				nearestKey, nearest, nearestDelta = key, candidate, delta
			}
		}
		if nearest != nil && nearestDelta <= 250*time.Millisecond {
			item.QR = nearest
			f.recordQREventPairLocked(*nearest, false)
			delete(f.qrEvents, nearestKey)
		}
	}
	f.nextSeq++
	f.backlog = append(f.backlog, item)
	f.backlogBytes += int64(len(data))
	f.resetAssemblyLocked()
	if f.overflowLocked() {
		f.resetLocked("backlog_overflow")
	}
	f.cond.Broadcast()
	return item
}

func (f *Feed) extendTimestampLocked(ts uint32) int64 {
	if f.haveRTPTs {
		if ts < f.lastRTPTs && f.lastRTPTs-ts > (1<<31) {
			f.rtpCycles++
		} else if ts > f.lastRTPTs && ts-f.lastRTPTs > (1<<31) {
			f.rtpCycles--
		}
	}
	f.lastRTPTs = ts
	f.haveRTPTs = true
	return int64(uint64(ts)) + f.rtpCycles*(1<<32)
}

func (f *Feed) overflowLocked() bool {
	if f.maxBytes > 0 && f.backlogBytes > f.maxBytes {
		return true
	}
	if f.maxSeconds <= 0 || len(f.backlog) < 2 {
		return false
	}
	duration := float64(f.backlog[len(f.backlog)-1].PTS90K-f.backlog[0].PTS90K) / 90000
	return duration > f.maxSeconds
}

// keyframeRetryInterval is how often watchKeyframe re-requests a PLI while no
// IDR has been seen since the last reset. A PLI travels as RTCP, which is not
// retransmitted and can be rate-limited or dropped by the encoder; a single
// request from resetLocked has no way to notice that and never retries, which
// left the relay stuck waiting for a keyframe that was never coming again
// until a viewer forced another explicit resync.
const keyframeRetryInterval = 1 * time.Second

// watchKeyframe re-requests a keyframe on an interval for as long as none has
// been seen since the last reset. It runs for the lifetime of the process;
// RequestKeyFrame is a no-op with no publisher connected, so idling here
// between streams costs nothing but one lock check per tick.
func (f *Feed) watchKeyframe() {
	ticker := time.NewTicker(keyframeRetryInterval)
	defer ticker.Stop()
	var waitingSince time.Time
	var retries int
	for range ticker.C {
		f.mu.Lock()
		needsKeyframe := !f.seenIDR
		epoch := f.epoch
		f.mu.Unlock()
		if !needsKeyframe {
			waitingSince = time.Time{}
			retries = 0
			continue
		}
		if waitingSince.IsZero() {
			waitingSince = time.Now()
		}
		retries++
		if f.OnResync != nil {
			// Dispatched the same way resetLocked fires it: WriteRTCP should be
			// fast, but this ticker must never stall waiting on it regardless.
			go f.OnResync()
		}
		// Diagnostic for how long a keyframe request can go unanswered; drop
		// this once real-world retry/latency behavior is understood.
		log.Printf(
			"YOLO feed keyframe watchdog: still waiting for IDR (epoch=%d, retries=%d, waiting=%s)",
			epoch, retries, time.Since(waitingSince).Round(time.Second),
		)
	}
}

func (f *Feed) resetLocked(reason string) {
	f.backlog = nil
	f.backlogBytes = 0
	f.epoch++
	f.nextSeq = 0
	f.seenIDR = false
	f.resetAssemblyLocked()
	f.parameterSets = nil
	f.qrEvents = make(map[uint32]*QREvent)
	f.havePacketSeq = false
	f.haveAssemblyTs = false
	f.sourceEnded = false
	f.endSent = false
	f.cond.Broadcast()
	if f.OnResync != nil {
		go f.OnResync()
	}
	log.Printf("YOLO feed reset: epoch=%d reason=%s", f.epoch, reason)
}

// resetAssemblyLocked releases the current access-unit contents while
// retaining a bounded amount of capacity for the next frame. Published
// AccessUnits own a separate copy, so reusing this slice cannot mutate the
// backlog. Very large I-frames are intentionally discarded instead of making
// every later frame retain their peak capacity.
func (f *Feed) resetAssemblyLocked() {
	f.reuseAssemblyBufferLocked()
	f.assemblyKey = false
	f.assemblyParams = false
	f.fuActive = false
	f.haveAssemblyTs = false
}

func (f *Feed) reuseAssemblyBufferLocked() {
	if cap(f.assembly) > maxReusableAUCap {
		f.assembly = make([]byte, 0, defaultAssemblyCap)
	} else if f.assembly != nil {
		f.assembly = f.assembly[:0]
	}
}

func (f *Feed) acknowledge(epoch, seq uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if epoch != f.epoch {
		return
	}
	cut := 0
	for cut < len(f.backlog) && f.backlog[cut].Seq <= seq {
		f.backlogBytes -= int64(len(f.backlog[cut].Data))
		cut++
	}
	if cut > 0 {
		f.backlog = append([]*AccessUnit(nil), f.backlog[cut:]...)
	}
}

func (f *Feed) oldestAndEpoch() (uint64, uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.backlog) == 0 {
		return f.epoch, f.nextSeq
	}
	return f.epoch, f.backlog[0].Seq
}

// keyframeStart returns the newest retained keyframe at or before seq. Python
// creates a fresh PyAV decoder on every feed connection, so replaying from that
// keyframe is required before delivering the requested delta frame.
func (f *Feed) keyframeStart(epoch, seq uint64) (uint64, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if epoch != f.epoch {
		return 0, false
	}
	var candidate uint64
	found := false
	for _, item := range f.backlog {
		if item.Seq > seq {
			break
		}
		if item.Keyframe {
			candidate = item.Seq
			found = true
		}
	}
	return candidate, found
}

func (f *Feed) find(epoch, seq uint64) *AccessUnit {
	f.mu.Lock()
	defer f.mu.Unlock()
	if epoch != f.epoch {
		return nil
	}
	for _, item := range f.backlog {
		if item.Seq == seq {
			copyItem := *item
			return &copyItem
		}
	}
	return nil
}

// findForSend gives the asynchronous Android QR scanner a short window to
// attach metadata before this access unit is copied for Vision. The pairing
// decision and copy happen under the same lock, so an event cannot slip
// between a separate wait check and the metadata snapshot.
func (f *Feed) findForSend(epoch, seq uint64, now time.Time) (*AccessUnit, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, item := range f.backlog {
		if item.Epoch == epoch && item.Seq == seq {
			if f.qrActive && item.QR == nil && now.Sub(item.receivedAt) < qrPairingWait {
				return nil, true
			}
			copyItem := *item
			return &copyItem, false
		}
	}
	return nil, false
}

func (f *Feed) recordFrameSent(item *AccessUnit) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.framesSent++
	if item.QR == nil {
		return
	}
	f.framesSentWithQR++
	if item.QR.DecodeSuccess && item.QR.SourceTimestampNS != nil {
		f.framesSentWithQRValid++
	}
}

func (f *Feed) sourceComplete(epoch, nextSeq uint64) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if epoch != f.epoch || !f.sourceEnded || f.endSent || nextSeq < f.nextSeq {
		return false
	}
	f.endSent = true
	return true
}

// Stats exposes the current retention counters for health/metrics hooks.
func (f *Feed) Stats() (epoch uint64, frames int, bytes int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.epoch, len(f.backlog), f.backlogBytes
}

func (f *Feed) Run() error {
	if err := os.Remove(f.socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	listener, err := net.Listen("unix", f.socketPath)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(f.socketPath)
	log.Printf("YOLO H.264 feed listening on %s", f.socketPath)
	go f.watchKeyframe()
	for {
		conn, err := listener.Accept()
		if err != nil {
			return err
		}
		if err := f.serve(conn); err != nil {
			log.Printf("YOLO feed client ended: %v", err)
		}
	}
}

type control struct {
	kind byte
	body []byte
}

func (f *Feed) serve(conn net.Conn) error {
	defer conn.Close()
	commands := make(chan control, 16)
	go func() {
		for {
			kind, body, err := readRecord(conn)
			if err != nil {
				close(commands)
				return
			}
			commands <- control{kind: kind, body: body}
		}
	}()

	epoch, nextSeq := f.oldestAndEpoch()
	// Wait briefly for Python's BEGIN so reconnect starts at its last ACK.
	select {
	case cmd, ok := <-commands:
		if ok && cmd.kind == kBegin {
			var begin struct {
				Epoch            uint64 `json:"epoch"`
				LastPresentedSeq int64  `json:"last_presented_seq"`
			}
			_ = json.Unmarshal(cmd.body, &begin)
			if begin.Epoch == epoch && begin.LastPresentedSeq >= -1 {
				nextSeq = uint64(begin.LastPresentedSeq + 1)
			}
		}
	case <-time.After(2 * time.Second):
	}
	// A fresh Python decoder cannot resume from a delta access unit. Rewind to
	// the nearest retained IDR when possible; if the retention window no longer
	// contains one, begin a new epoch and ask Android for a fresh IDR.
	if startSeq, ok := f.keyframeStart(epoch, nextSeq); ok {
		// Rewind only the feed decoder; Python will discard already-completed
		// sequence keys while still decoding the keyframe through the requested
		// sequence. This preserves resume data whenever the keyframe is retained.
		nextSeq = startSeq
	} else {
		f.mu.Lock()
		// Reset only if this epoch is still current and already has a
		// keyframe we're failing to find at this seq (e.g. the resume point
		// was evicted). If seenIDR is already false, a reset already has this
		// epoch waiting on a fresh IDR; bumping the epoch again here would
		// just restart that wait, which is exactly how a burst of reconnects
		// perpetually cancels each other's progress instead of any one of
		// them ever landing a keyframe. Still fire a PLI for this attempt
		// either way - suppressing the redundant reset must not also
		// suppress this connection's own request for a keyframe, or recovery
		// is left waiting on the watchdog's next tick instead of asking now.
		if epoch == f.epoch && f.seenIDR {
			f.resetLocked("client_start_requires_idr")
		} else if f.OnResync != nil {
			go f.OnResync()
		}
		epoch, nextSeq = f.epoch, 0
		f.mu.Unlock()
	}
	if err := f.sendStart(conn, epoch); err != nil {
		return err
	}
	if f.OnClientConnect != nil {
		go f.OnClientConnect()
	}

	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case cmd, ok := <-commands:
			if !ok {
				return io.EOF
			}
			switch cmd.kind {
			case kPresentedAck:
				var ack struct {
					Epoch uint64 `json:"epoch"`
					Seq   uint64 `json:"seq"`
				}
				if json.Unmarshal(cmd.body, &ack) == nil {
					f.acknowledge(ack.Epoch, ack.Seq)
				}
			case kResync:
				// Python always sends {"type":"resync","reason":"<cause>"} -
				// surface that cause instead of the generic "explicit_resync"
				// so the log can tell a fresh viewer_start apart from a
				// user's Jump to Live, a decode_error, or a browser
				// reconnecting on its own after an epoch changed underneath
				// it, all of which land on this same code path.
				var resyncCmd struct {
					Reason string `json:"reason"`
				}
				_ = json.Unmarshal(cmd.body, &resyncCmd)
				reason := resyncCmd.Reason
				if reason == "" {
					reason = "explicit_resync"
				}
				f.mu.Lock()
				// Same idempotency as the handshake's reset: a resync request
				// that arrives while we're already waiting on a fresh IDR
				// (seenIDR false) joins that wait instead of bumping the
				// epoch again and restarting it - see the comment at the
				// handshake's client_start_requires_idr reset above. Still
				// fire a PLI for this attempt either way, same reasoning.
				if f.seenIDR {
					f.resetLocked(reason)
				} else if f.OnResync != nil {
					go f.OnResync()
				}
				epoch, nextSeq = f.epoch, 0
				f.mu.Unlock()
				if err := f.sendReset(conn, epoch, reason); err != nil {
					return err
				}
			case kStop:
				return nil
			}
		case <-ticker.C:
			currentEpoch, oldestSeq := f.oldestAndEpoch()
			if currentEpoch != epoch {
				epoch, nextSeq = currentEpoch, 0
				if err := f.sendReset(conn, epoch, "epoch_changed"); err != nil {
					return err
				}
			} else if nextSeq < oldestSeq {
				// The requested resume point was evicted. A new IDR epoch is
				// explicit and observable; never silently jump over unseen data.
				f.mu.Lock()
				f.resetLocked("resume_unavailable")
				epoch, nextSeq = f.epoch, 0
				f.mu.Unlock()
				if err := f.sendReset(conn, epoch, "resume_unavailable"); err != nil {
					return err
				}
			}
			for {
				item, waitForQR := f.findForSend(epoch, nextSeq, time.Now())
				if waitForQR {
					break
				}
				if item == nil {
					break
				}
				if err := f.sendFrame(conn, item); err != nil {
					return err
				}
				f.recordFrameSent(item)
				nextSeq++
			}
			if f.sourceComplete(epoch, nextSeq) {
				if err := writeRecord(conn, kEnd, nil); err != nil {
					return err
				}
			}
		}
	}
}

func (f *Feed) sendStart(conn net.Conn, epoch uint64) error {
	body, _ := json.Marshal(map[string]any{
		"epoch": epoch, "codec": "avc1.42E01F", "clock_rate": 90000,
	})
	return writeRecord(conn, kStart, body)
}

func (f *Feed) sendReset(conn net.Conn, epoch uint64, reason string) error {
	body, _ := json.Marshal(map[string]any{"new_epoch": epoch, "reason": reason})
	if err := writeRecord(conn, kReset, body); err != nil {
		return err
	}
	return f.sendStart(conn, epoch)
}

func (f *Feed) sendFrame(conn net.Conn, item *AccessUnit) error {
	metadataValue := map[string]any{
		"epoch": item.Epoch, "seq": item.Seq, "rtp_timestamp": item.RTPTimestamp,
		"pts_90k": item.PTS90K, "timestamp_us": item.TimestampUS,
		"keyframe": item.Keyframe,
		"qr":       map[string]any{"decode_success": false},
	}
	if item.Recording != nil {
		metadataValue["recording"] = item.Recording
	}
	if item.QR != nil {
		metadataValue["qr"] = item.QR
	}
	metadata, _ := json.Marshal(metadataValue)
	metadataLength := make([]byte, 4)
	binary.BigEndian.PutUint32(metadataLength, uint32(len(metadata)))
	return writeRecordBuffers(
		conn,
		kFrame,
		metadataLength,
		metadata,
		item.Data,
	)
}

// writeRecordBuffers preserves the record wire format while allowing a
// net.Conn to use writev for the record header, metadata length, JSON, and
// immutable H.264 access unit. The generic writeRecord path remains for the
// small control records.
func writeRecordBuffers(w io.Writer, kind byte, bodies ...[]byte) error {
	bodyLength := 0
	for _, body := range bodies {
		bodyLength += len(body)
	}
	length := 1 + bodyLength
	if length > maxRecordBytes {
		return fmt.Errorf("record too large: %d", length)
	}
	recordHeader := make([]byte, 4)
	binary.BigEndian.PutUint32(recordHeader, uint32(length))
	kindBuffer := []byte{kind}
	buffers := net.Buffers{recordHeader, kindBuffer}
	for _, body := range bodies {
		if len(body) > 0 {
			buffers = append(buffers, body)
		}
	}
	written, err := buffers.WriteTo(w)
	if err != nil {
		return err
	}
	if written != int64(len(recordHeader)+1+bodyLength) {
		return io.ErrShortWrite
	}
	return nil
}

func writeRecord(w io.Writer, kind byte, body []byte) error {
	length := 1 + len(body)
	if length > maxRecordBytes {
		return fmt.Errorf("record too large: %d", length)
	}
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(length))
	if err := writeAll(w, header); err != nil {
		return err
	}
	if err := writeAll(w, []byte{kind}); err != nil {
		return err
	}
	return writeAll(w, body)
}

func writeAll(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

func readRecord(r io.Reader) (byte, []byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return 0, nil, err
	}
	length := binary.BigEndian.Uint32(header[:])
	if length < 1 || length > maxRecordBytes {
		return 0, nil, fmt.Errorf("invalid record length %d", length)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	return payload[0], payload[1:], nil
}
