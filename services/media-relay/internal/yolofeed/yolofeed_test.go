package yolofeed

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net"
	"testing"

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
