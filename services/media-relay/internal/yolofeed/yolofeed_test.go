package yolofeed

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/pion/rtp"
)

func publishSingleNAL(feed *Feed, sequence uint16, timestamp uint32, nal []byte) {
	feed.Publish(&rtp.Packet{
		Header: rtp.Header{
			SequenceNumber: sequence,
			Timestamp:      timestamp,
			Marker:         true,
		},
		Payload: nal,
	})
}

func TestPublishedAccessUnitIsNotChangedByAssemblyReuse(t *testing.T) {
	feed := NewWithLimits("", 0, 0)
	publishSingleNAL(feed, 1, 90000, []byte{0x65, 0x01, 0x02, 0x03})

	feed.mu.Lock()
	if len(feed.backlog) != 1 {
		feed.mu.Unlock()
		t.Fatalf("expected one retained access unit, got %d", len(feed.backlog))
	}
	first := append([]byte(nil), feed.backlog[0].Data...)
	assemblyCapacity := cap(feed.assembly)
	feed.mu.Unlock()

	// This second AU reuses the feed's assembly storage. Its publication must
	// not mutate the already-retained first AU.
	publishSingleNAL(feed, 2, 93000, []byte{0x41, 0x04, 0x05})

	feed.mu.Lock()
	defer feed.mu.Unlock()
	if len(feed.backlog) != 2 {
		t.Fatalf("expected two retained access units, got %d", len(feed.backlog))
	}
	if !bytes.Equal(first, feed.backlog[0].Data) {
		t.Fatalf("first access unit changed after assembly reuse")
	}
	if cap(feed.assembly) != assemblyCapacity {
		t.Fatalf("expected bounded assembly capacity reuse: before=%d after=%d", assemblyCapacity, cap(feed.assembly))
	}
}

func TestPublishReturnsTheRetainedImmutableAccessUnit(t *testing.T) {
	feed := NewWithLimits("", 0, 0)
	item := feed.Publish(&rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 7, Timestamp: 90000, Marker: true},
		Payload: []byte{0x65, 0x01, 0x02},
	})
	if item == nil {
		t.Fatal("expected marker packet to complete an IDR access unit")
	}
	feed.mu.Lock()
	defer feed.mu.Unlock()
	if len(feed.backlog) != 1 || feed.backlog[0] != item {
		t.Fatal("Publish must return the same access unit retained by the feed")
	}
	if !item.Keyframe || item.Seq != 0 || item.Epoch != feed.epoch {
		t.Fatalf("unexpected access unit identity: %+v", item)
	}
}

func TestFragmentedSlicesPreserveTheWholeAccessUnit(t *testing.T) {
	feed := NewWithLimits("", 0, 0)
	// SPS/PPS, then two fragmented IDR slices, all belonging to one frame.
	payloads := [][]byte{
		{0x67, 0x42, 0xc0, 0x28},
		{0x68, 0xce, 0x3c, 0x80},
		{0x7c, 0x85, 0x11, 0x22},
		{0x7c, 0x45, 0x33, 0x44},
		{0x7c, 0x85, 0x55, 0x66},
		{0x7c, 0x45, 0x77, 0x88},
	}
	var item *AccessUnit
	for i, payload := range payloads {
		item = feed.Publish(&rtp.Packet{
			Header:  rtp.Header{SequenceNumber: uint16(i + 1), Timestamp: 90000, Marker: i == len(payloads)-1},
			Payload: payload,
		})
	}
	want := []byte{
		0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x28,
		0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
		0, 0, 0, 1, 0x65, 0x11, 0x22, 0x33, 0x44,
		0, 0, 0, 1, 0x65, 0x55, 0x66, 0x77, 0x88,
	}
	if item == nil || !item.Keyframe {
		t.Fatal("expected a complete IDR access unit")
	}
	if !bytes.Equal(item.Data, want) {
		t.Fatalf("fragmentation discarded part of the frame: got %x, want %x", item.Data, want)
	}
}

func TestQRStatusTracksReceiptAndExactPairing(t *testing.T) {
	feed := NewWithLimits("", 0, 0)
	feed.SetQRActive(true)
	publishSingleNAL(feed, 1, 90000, []byte{0x65, 0x01})
	sourceTimestamp := int64(123456789)
	feed.PublishQREvent(QREvent{
		RTPTimestamp:      90000,
		SourceTimestampNS: &sourceTimestamp,
		DecodeSuccess:     true,
	})

	status := feed.QRStatus()
	if !status.ChannelObserved || status.EventsReceivedTotal != 1 || status.DecodeSuccessTotal != 1 {
		t.Fatalf("unexpected QR receipt status: %+v", status)
	}
	if status.PairedTotal != 1 || status.PairedDecodeSuccessTotal != 1 || status.PairedExactTimestampTotal != 1 {
		t.Fatalf("expected successful exact timestamp pairing: %+v", status)
	}
	if status.PendingEvents != 0 {
		t.Fatalf("expected no pending QR events, got %+v", status)
	}
	feed.recordFrameSent(feed.find(1, 0))
	status = feed.QRStatus()
	if status.FramesSentTotal != 1 || status.FramesSentWithQREventTotal != 1 || status.FramesSentWithSuccessfulQREventTotal != 1 {
		t.Fatalf("expected sent frame to include its successful QR event: %+v", status)
	}
}

func TestQRStatusTracksPendingArrivalTimePairing(t *testing.T) {
	feed := NewWithLimits("", 0, 0)
	sourceTimestamp := int64(123456789)
	feed.PublishQREvent(QREvent{
		RTPTimestamp:      1,
		SourceTimestampNS: &sourceTimestamp,
		DecodeSuccess:     true,
	})
	if status := feed.QRStatus(); status.PendingEvents != 1 || status.PairedTotal != 0 {
		t.Fatalf("expected QR event to wait for its video frame: %+v", status)
	}

	publishSingleNAL(feed, 1, 90000, []byte{0x65, 0x01})
	status := feed.QRStatus()
	if status.PendingEvents != 0 || status.PairedTotal != 1 || status.PairedArrivalTimeTotal != 1 {
		t.Fatalf("expected pending QR event to pair by arrival time: %+v", status)
	}
}

func TestFrameWaitsBrieflyForQRMetadataBeforeSending(t *testing.T) {
	feed := NewWithLimits("", 0, 0)
	feed.SetQRActive(true)
	item := feed.Publish(&rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 1, Timestamp: 90000, Marker: true},
		Payload: []byte{0x65, 0x01},
	})
	if item == nil {
		t.Fatal("expected a retained video access unit")
	}
	if copyItem, wait := feed.findForSend(item.Epoch, item.Seq, time.Now()); !wait || copyItem != nil {
		t.Fatal("an unpaired frame should wait briefly for its QR event")
	}

	sourceTimestamp := int64(123456789)
	feed.PublishQREvent(QREvent{
		RTPTimestamp:      item.RTPTimestamp,
		SourceTimestampNS: &sourceTimestamp,
		DecodeSuccess:     true,
	})
	copyItem, wait := feed.findForSend(item.Epoch, item.Seq, time.Now())
	if wait || copyItem == nil || copyItem.QR == nil {
		t.Fatal("a frame already paired with QR must not wait")
	}
}

func TestFrameStopsWaitingAfterQRPairingWindow(t *testing.T) {
	feed := NewWithLimits("", 0, 0)
	feed.SetQRActive(true)
	item := feed.Publish(&rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 1, Timestamp: 90000, Marker: true},
		Payload: []byte{0x65, 0x01},
	})
	if item == nil {
		t.Fatal("expected a retained video access unit")
	}
	if copyItem, wait := feed.findForSend(item.Epoch, item.Seq, item.receivedAt.Add(qrPairingWait)); wait || copyItem == nil {
		t.Fatal("frame must be released after the bounded QR pairing window")
	}
}

func TestSendFrameScatterWritePreservesWireFormat(t *testing.T) {
	item := &AccessUnit{
		Epoch:        4,
		Seq:          12,
		RTPTimestamp: 1234,
		PTS90K:       1234,
		TimestampUS:  13711,
		Keyframe:     true,
		Data:         []byte{0, 0, 0, 1, 0x65, 0x01, 0x02},
	}
	metadataValue := map[string]any{
		"epoch": item.Epoch, "seq": item.Seq, "rtp_timestamp": item.RTPTimestamp,
		"pts_90k": item.PTS90K, "timestamp_us": item.TimestampUS,
		"keyframe": item.Keyframe,
		"qr":       map[string]any{"decode_success": false},
	}
	metadata, err := json.Marshal(metadataValue)
	if err != nil {
		t.Fatal(err)
	}
	body := make([]byte, 4+len(metadata)+len(item.Data))
	binary.BigEndian.PutUint32(body[:4], uint32(len(metadata)))
	copy(body[4:], metadata)
	copy(body[4+len(metadata):], item.Data)
	var expected bytes.Buffer
	if err := writeRecord(&expected, kFrame, body); err != nil {
		t.Fatal(err)
	}

	server, client := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- (&Feed{}).sendFrame(client, item)
	}()
	_, actualBody, err := readRecord(server)
	if err != nil {
		server.Close()
		client.Close()
		t.Fatal(err)
	}
	server.Close()
	client.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	actual := append([]byte{0, 0, 0, 0, kFrame}, actualBody...)
	binary.BigEndian.PutUint32(actual[:4], uint32(len(actualBody)+1))
	if !bytes.Equal(expected.Bytes(), actual) {
		t.Fatalf("scatter/gather wire output differs from contiguous output")
	}
}

func TestSendFrameCarriesValidatedRecordingIdentity(t *testing.T) {
	feed := NewWithLimits("", 0, 0)
	feed.SetRecordingIdentity(&RecordingIdentity{
		TripID:             12,
		VehicleID:          3,
		RecordingSessionID: "session-a",
	})
	item := feed.Publish(&rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 7, Timestamp: 90000, Marker: true},
		Payload: []byte{0x65, 0x01, 0x02},
	})
	if item == nil || item.Recording == nil {
		t.Fatal("expected recording identity on a published access unit")
	}

	server, client := net.Pipe()
	done := make(chan error, 1)
	go func() { done <- feed.sendFrame(client, item) }()
	_, body, err := readRecord(server)
	if err != nil {
		server.Close()
		client.Close()
		t.Fatal(err)
	}
	server.Close()
	client.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	metadataLength := int(binary.BigEndian.Uint32(body[:4]))
	var metadata struct {
		Recording struct {
			TripID             string `json:"trip_id"`
			VehicleID          string `json:"vehicle_id"`
			RecordingSessionID string `json:"recording_session_id"`
		} `json:"recording"`
	}
	if err := json.Unmarshal(body[4:4+metadataLength], &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata.Recording.TripID != "12" || metadata.Recording.VehicleID != "3" || metadata.Recording.RecordingSessionID != "session-a" {
		t.Fatalf("unexpected recording identity metadata: %+v", metadata.Recording)
	}
}
