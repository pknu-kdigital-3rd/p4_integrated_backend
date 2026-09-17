package recording

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"poc-server-webrtc/relay-go/internal/yolofeed"
)

var testSPS = []byte{
	0x67, 0x42, 0xc0, 0x28, 0xd9, 0x00, 0x78, 0x02,
	0x27, 0xe5, 0x84, 0x00, 0x00, 0x03, 0x00, 0x04,
	0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc9,
	0x20,
}

func testAccessUnit(epoch, seq uint64, pts int64, keyframe bool) *yolofeed.AccessUnit {
	var data []byte
	appendNAL := func(nal []byte, fourByteStart bool) {
		if fourByteStart {
			data = append(data, 0, 0, 0, 1)
		} else {
			data = append(data, 0, 0, 1)
		}
		data = append(data, nal...)
	}
	if keyframe {
		appendNAL(testSPS, true)
		appendNAL([]byte{0x08}, false)
		appendNAL([]byte{0x65, 0x88, 0x84, 0x21}, true)
	} else {
		appendNAL([]byte{0x41, 0x9a, 0x22, 0x11}, true)
	}
	return &yolofeed.AccessUnit{
		Epoch: epoch, Seq: seq, PTS90K: pts, TimestampUS: pts * 1_000_000 / 90_000,
		Keyframe: keyframe, Data: data,
	}
}

func TestParseAnnexBNALUsAcceptsMixedStartCodes(t *testing.T) {
	item := testAccessUnit(1, 0, 0, true)
	nalus, err := parseAnnexBNALUs(item.Data)
	if err != nil {
		t.Fatal(err)
	}
	if len(nalus) != 3 {
		t.Fatalf("expected SPS, PPS, and IDR; got %d NAL units", len(nalus))
	}
	sps, pps, hasIDR := h264Parameters(nalus)
	if !bytes.Equal(sps, testSPS) || len(pps) != 1 || !hasIDR {
		t.Fatalf("parameter extraction failed: SPS=%t PPS=%x IDR=%t", bytes.Equal(sps, testSPS), pps, hasIDR)
	}
}

func TestSegmentIsFragmentedMP4AndStartsWithIDR(t *testing.T) {
	directory := t.TempDir()
	ctx := Context{TripID: 312, VehicleID: 27, RecordingSessionID: "01234567-89ab-cdef"}
	writer, err := newSegmentWriter(directory, "p4-trip-recordings", ctx, 0, testAccessUnit(3, 9, 90000, true))
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.append(testAccessUnit(3, 10, 93000, false)); err != nil {
		t.Fatal(err)
	}
	manifest, err := writer.finalize(nil)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.StorageBucket != "p4-trip-recordings" || manifest.RelayEpoch != 3 || manifest.StartSeq != 9 || manifest.EndSeq != 10 {
		t.Fatalf("unexpected segment identity: %+v", manifest)
	}
	if err := writer.commitFile(); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(writer.finalPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, box := range [][]byte{[]byte("ftyp"), []byte("moov"), []byte("moof"), []byte("mdat")} {
		if !bytes.Contains(content, box) {
			t.Fatalf("fMP4 segment is missing %q box", box)
		}
	}
}

func TestSegmentRejectsAnAccessUnitSequenceGap(t *testing.T) {
	writer, err := newSegmentWriter(
		t.TempDir(), "p4-trip-recordings",
		Context{TripID: 312, VehicleID: 27, RecordingSessionID: "01234567-89ab-cdef"},
		0, testAccessUnit(1, 10, 90000, true),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.discard()
	if err := writer.append(testAccessUnit(1, 12, 96000, false)); err == nil {
		t.Fatal("segment accepted a sequence gap and would bridge a dropped access unit")
	}
}

func TestRecorderWaitsForIDRAndRolloverWaitsForNextIDR(t *testing.T) {
	store := &testObjectStore{}
	registrar := &testRegistrar{segments: make(chan Manifest, 4)}
	requests := make(chan struct{}, 4)
	recorder, err := New(Config{
		SegmentDuration: time.Second,
		QueueFrames:     8,
		UploadQueue:     4,
		SpoolDir:        t.TempDir(),
		SpoolMaxBytes:   1 << 20,
		Bucket:          "p4-trip-recordings",
	}, store, registrar, func() { requests <- struct{}{} })
	if err != nil {
		t.Fatal(err)
	}
	defer recorder.Close()
	ctx := Context{TripID: 312, VehicleID: 27, RecordingSessionID: "01234567-89ab-cdef"}
	if err := recorder.Start(ctx); err != nil {
		t.Fatal(err)
	}
	recorder.Publish(testAccessUnit(1, 0, 90000, false))
	waitFor(t, func() bool { return recorder.Status().InputQueue == 0 })
	if recorder.Status().SegmentActive {
		t.Fatal("recording started before an IDR access unit")
	}

	recorder.Publish(testAccessUnit(1, 1, 93000, true))
	waitFor(t, func() bool { return recorder.Status().SegmentActive })
	firstIndex := *recorder.Status().SegmentIndex
	recorder.Publish(testAccessUnit(1, 2, 183000, false))
	waitFor(t, func() bool { return recorder.Status().InputQueue == 0 })
	if got := *recorder.Status().SegmentIndex; got != firstIndex {
		t.Fatalf("segment rolled on a P-frame: index changed from %d to %d", firstIndex, got)
	}
	select {
	case <-requests:
	case <-time.After(time.Second):
		t.Fatal("segment boundary did not request an IDR")
	}

	recorder.Publish(testAccessUnit(1, 3, 186000, true))
	waitFor(t, func() bool {
		status := recorder.Status()
		return status.SegmentActive && status.SegmentIndex != nil && *status.SegmentIndex == firstIndex+1
	})
	recorder.Stop("test complete")
	waitFor(t, func() bool { return len(registrar.segments) >= 2 })
	if store.uploadCount() < 2 {
		t.Fatal("finalized segments were not uploaded")
	}
}

func TestRecorderStartsANewSegmentAfterEpochChange(t *testing.T) {
	store := &testObjectStore{}
	registrar := &testRegistrar{segments: make(chan Manifest, 2)}
	recorder, err := New(Config{
		SegmentDuration: time.Hour,
		QueueFrames:     8,
		UploadQueue:     4,
		SpoolDir:        t.TempDir(),
		SpoolMaxBytes:   1 << 20,
		Bucket:          "p4-trip-recordings",
	}, store, registrar, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer recorder.Close()
	if err := recorder.Start(Context{TripID: 312, VehicleID: 27, RecordingSessionID: "01234567-89ab-cdef"}); err != nil {
		t.Fatal(err)
	}
	recorder.Publish(testAccessUnit(1, 0, 90000, true))
	waitFor(t, func() bool { return recorder.Status().SegmentActive })
	recorder.Publish(testAccessUnit(2, 0, 0, false))
	waitFor(t, func() bool { return !recorder.Status().SegmentActive })
	recorder.Publish(testAccessUnit(2, 1, 3000, true))
	waitFor(t, func() bool {
		status := recorder.Status()
		return status.SegmentActive && status.SegmentIndex != nil && *status.SegmentIndex == 1
	})
	recorder.Stop("epoch test complete")
	waitFor(t, func() bool { return len(registrar.segments) == 2 })
	first, second := <-registrar.segments, <-registrar.segments
	if first.RelayEpoch != 1 || first.StartSeq != 0 || first.EndSeq != 0 {
		t.Fatalf("old epoch segment was not finalized independently: %+v", first)
	}
	if second.RelayEpoch != 2 || second.StartSeq != 1 {
		t.Fatalf("new epoch segment did not start at the new IDR: %+v", second)
	}
}

func TestPublishQueueOverflowIsNonBlocking(t *testing.T) {
	recorder := &Recorder{events: make(chan recorderEvent, 1)}
	recorder.Publish(testAccessUnit(1, 0, 90000, true))
	start := time.Now()
	recorder.Publish(testAccessUnit(1, 1, 93000, false))
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("Publish blocked for %s when its queue was full", elapsed)
	}
	if !recorder.busy.Load() || recorder.counters.droppedFrames.Load() != 1 {
		t.Fatalf("queue overflow was not recorded: busy=%t dropped=%d", recorder.busy.Load(), recorder.counters.droppedFrames.Load())
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition was not reached before timeout")
}

type testObjectStore struct {
	mu      sync.Mutex
	uploads int
}

func (s *testObjectStore) Upload(_ context.Context, _, _, filePath, _ string) (ObjectInfo, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return ObjectInfo{}, err
	}
	s.mu.Lock()
	s.uploads++
	s.mu.Unlock()
	return ObjectInfo{ETag: "test-etag", SizeBytes: info.Size()}, nil
}

func (s *testObjectStore) uploadCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.uploads
}

type testRegistrar struct {
	segments chan Manifest
}

func (r *testRegistrar) RegisterSegment(_ context.Context, segment Manifest) error {
	r.segments <- segment
	return nil
}

func TestRecoverSpoolRemovesIncompleteAndPreservesFinalized(t *testing.T) {
	directory := t.TempDir()
	incomplete := filepath.Join(directory, "session-incomplete.mp4.tmp")
	if err := os.WriteFile(incomplete, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "orphan.mp4"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := recoverSpool(directory); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(incomplete); !os.IsNotExist(err) {
		t.Fatal("incomplete temporary segment was not removed")
	}
	if _, err := os.Stat(filepath.Join(directory, "orphan.mp4")); err != nil {
		t.Fatal("finalized orphan without a manifest must be retained", err)
	}
}

func TestRecoverSpoolCleansAcknowledgedSegmentArtifacts(t *testing.T) {
	directory := t.TempDir()
	base := filepath.Join(directory, "acknowledged")
	for path, content := range map[string]string{
		base + ".mp4":            "object",
		base + ".json":           "manifest",
		base + ".uploaded.json":  "uploaded",
		base + ".committed.json": "acknowledged",
	} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := recoverSpool(directory); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("acknowledged segment cleanup left files in the spool: %v", entries)
	}
}

func TestUploaderRetriesMinIOAndNodeOutagesWithoutReupload(t *testing.T) {
	directory := t.TempDir()
	basePath := filepath.Join(directory, "session-01234567-89ab-cdef-segment-000000")
	filePath := basePath + ".mp4"
	manifestPath := basePath + ".json"
	if err := os.WriteFile(filePath, []byte("fMP4 object bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{
		TripID: 312, VehicleID: 27, RecordingSessionID: "01234567-89ab-cdef",
		SegmentIndex: 0, StorageBucket: "p4-trip-recordings",
		ObjectKey:   "trips/312/sessions/01234567-89ab-cdef/segment-000000.mp4",
		ContentType: contentTypeMP4, SizeBytes: 17, RelayEpoch: 1,
		StartSeq: 0, EndSeq: 1, StartPTS90K: 90000, EndPTS90K: 93000,
		StartedAt: time.Now().UTC(), EndedAt: time.Now().UTC(), DurationSec: 0,
	}
	if _, err := writeJSONAtomic(manifestPath, manifest); err != nil {
		t.Fatal(err)
	}
	store := &outageObjectStore{failuresRemaining: 1}
	registrar := &outageRegistrar{failuresRemaining: 1, registered: make(chan Manifest, 1)}
	spoolBytes, err := directorySize(directory)
	if err != nil {
		t.Fatal(err)
	}
	var spool atomic.Int64
	spool.Store(spoolBytes)
	counters := &uploadCounters{}
	upload, err := newUploader(directory, 2, store, registrar, &spool, counters)
	if err != nil {
		t.Fatal(err)
	}
	defer upload.Close()
	select {
	case <-registrar.registered:
	case <-time.After(6 * time.Second):
		t.Fatal("uploader did not recover after MinIO and Node errors")
	}
	waitFor(t, func() bool {
		_, statErr := os.Stat(filePath)
		return errors.Is(statErr, os.ErrNotExist)
	})
	if got := store.callCount(); got != 2 {
		t.Fatalf("expected one failed upload and one successful upload, got %d calls", got)
	}
	if got := registrar.callCount(); got != 2 {
		t.Fatalf("expected one failed registration and one successful registration, got %d calls", got)
	}
}

type outageObjectStore struct {
	mu                sync.Mutex
	failuresRemaining int
	calls             int
}

func (s *outageObjectStore) Upload(_ context.Context, _, _, filePath, _ string) (ObjectInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.failuresRemaining > 0 {
		s.failuresRemaining--
		return ObjectInfo{}, errors.New("simulated MinIO outage")
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return ObjectInfo{}, err
	}
	return ObjectInfo{ETag: "retry-etag", SizeBytes: info.Size()}, nil
}

func (s *outageObjectStore) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

type outageRegistrar struct {
	mu                sync.Mutex
	failuresRemaining int
	calls             int
	registered        chan Manifest
}

func (r *outageRegistrar) RegisterSegment(_ context.Context, segment Manifest) error {
	r.mu.Lock()
	r.calls++
	if r.failuresRemaining > 0 {
		r.failuresRemaining--
		r.mu.Unlock()
		return errors.New("simulated Node outage")
	}
	r.mu.Unlock()
	r.registered <- segment
	return nil
}

func (r *outageRegistrar) callCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}
