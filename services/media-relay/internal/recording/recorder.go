package recording

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"poc-server-webrtc/relay-go/internal/yolofeed"
)

var recordingSessionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`)

type eventKind uint8

const (
	eventAccessUnit eventKind = iota
	eventStart
	eventStop
	eventClose
)

type recorderEvent struct {
	kind      eventKind
	item      *yolofeed.AccessUnit
	context   Context
	reason    string
	completed chan error
}

type uploadCounters struct {
	uploadedTotal   atomic.Uint64
	uploadFailures  atomic.Uint64
	droppedSegments atomic.Uint64
	droppedFrames   atomic.Uint64
	lastUploadMS    atomic.Int64
}

type Recorder struct {
	config Config
	upload *uploader
	events chan recorderEvent
	done   chan struct{}

	pushMu   sync.RWMutex
	closed   bool
	busy     atomic.Bool
	spool    atomic.Int64
	counters uploadCounters

	callbackMu      sync.RWMutex
	requestKeyframe func()
	statusMu        sync.RWMutex
	status          Status

	activeContext Context
	segment       *segmentWriter
	segmentIndex  int
	epoch         uint64
	haveEpoch     bool
	needKeyframe  bool
	rolloverSent  bool
}

func New(cfg Config, store ObjectStore, registrar SegmentRegistrar, requestKeyframe func()) (*Recorder, error) {
	if cfg.SegmentDuration <= 0 || cfg.QueueFrames < 1 || cfg.UploadQueue < 1 || cfg.SpoolDir == "" || cfg.SpoolMaxBytes < 1 || cfg.Bucket == "" {
		return nil, errors.New("invalid recording configuration")
	}
	if store == nil || registrar == nil {
		return nil, errors.New("recording object store and Node registrar are required")
	}
	if err := os.MkdirAll(cfg.SpoolDir, 0o700); err != nil {
		return nil, fmt.Errorf("create recording spool directory: %w", err)
	}
	if err := os.Chmod(cfg.SpoolDir, 0o700); err != nil {
		return nil, fmt.Errorf("restrict recording spool directory permissions: %w", err)
	}
	spoolBytes, err := recoverSpool(cfg.SpoolDir)
	if err != nil {
		return nil, fmt.Errorf("recover recording spool: %w", err)
	}
	r := &Recorder{
		config:          cfg,
		events:          make(chan recorderEvent, cfg.QueueFrames),
		done:            make(chan struct{}),
		requestKeyframe: requestKeyframe,
		status:          Status{Enabled: true},
	}
	r.spool.Store(spoolBytes)
	upload, err := newUploader(cfg.SpoolDir, cfg.UploadQueue, store, registrar, &r.spool, &r.counters)
	if err != nil {
		return nil, err
	}
	r.upload = upload
	go r.run()
	return r, nil
}

func (r *Recorder) SetRequestKeyframe(requestKeyframe func()) {
	r.callbackMu.Lock()
	r.requestKeyframe = requestKeyframe
	r.callbackMu.Unlock()
}

func (r *Recorder) Start(recordingContext Context) error {
	if err := validateRecordingContext(recordingContext); err != nil {
		return err
	}
	completed := make(chan error, 1)
	r.pushMu.RLock()
	defer r.pushMu.RUnlock()
	if r.closed {
		return errors.New("recorder is closed")
	}
	r.events <- recorderEvent{kind: eventStart, context: recordingContext, completed: completed}
	return <-completed
}

func (r *Recorder) Publish(item *yolofeed.AccessUnit) {
	if item == nil {
		return
	}
	r.pushMu.RLock()
	defer r.pushMu.RUnlock()
	if r.closed || r.busy.Load() {
		if !r.closed {
			r.counters.droppedFrames.Add(1)
		}
		return
	}
	select {
	case r.events <- recorderEvent{kind: eventAccessUnit, item: item}:
	default:
		r.counters.droppedFrames.Add(1)
		if r.busy.CompareAndSwap(false, true) {
			log.Printf("recording input queue full; dropping queued recording media and requesting an IDR")
			r.requestKeyframeAsync()
		}
	}
}

func (r *Recorder) Stop(reason string) {
	completed := make(chan error, 1)
	r.pushMu.RLock()
	if r.closed {
		r.pushMu.RUnlock()
		return
	}
	r.events <- recorderEvent{kind: eventStop, reason: reason, completed: completed}
	r.pushMu.RUnlock()
	if err := <-completed; err != nil {
		log.Printf("recording stop (%s): %v", reason, err)
	}
}

func (r *Recorder) Close() error {
	completed := make(chan error, 1)
	r.pushMu.Lock()
	if r.closed {
		r.pushMu.Unlock()
		return nil
	}
	r.closed = true
	r.events <- recorderEvent{kind: eventClose, reason: "relay shutdown", completed: completed}
	r.pushMu.Unlock()
	segmentErr := <-completed
	<-r.done
	uploadErr := r.upload.Close()
	return errors.Join(segmentErr, uploadErr)
}

func (r *Recorder) Status() Status {
	r.statusMu.RLock()
	status := r.status
	r.statusMu.RUnlock()
	status.InputQueue = len(r.events)
	status.UploadQueue = r.upload.QueueDepth()
	status.SpoolBytes = r.spool.Load()
	status.LastUploadMS = r.counters.lastUploadMS.Load()
	status.UploadedTotal = r.counters.uploadedTotal.Load()
	status.UploadFailures = r.counters.uploadFailures.Load()
	status.DroppedSegments = r.counters.droppedSegments.Load()
	status.DroppedFrames = r.counters.droppedFrames.Load()
	return status
}

func (r *Recorder) run() {
	defer close(r.done)
	for {
		if r.busy.Swap(false) {
			r.abortSegment("recorder input queue overflow")
			r.needKeyframe = true
		}
		event := <-r.events
		var err error
		switch event.kind {
		case eventAccessUnit:
			err = r.publish(event.item)
		case eventStart:
			err = r.start(event.context)
		case eventStop:
			err = r.stop(event.reason)
		case eventClose:
			err = r.stop(event.reason)
			if event.completed != nil {
				event.completed <- err
			}
			return
		}
		if err != nil {
			log.Printf("recording worker: %v", err)
		}
		if event.completed != nil {
			event.completed <- err
		}
	}
}

func (r *Recorder) start(recordingContext Context) error {
	if err := r.stop("publisher replaced"); err != nil {
		log.Printf("recording: finalizing previous publisher segment: %v", err)
	}
	r.activeContext = recordingContext
	r.haveEpoch = false
	r.needKeyframe = true
	r.rolloverSent = false
	r.updateStatus()
	log.Printf("recording armed trip=%d session=%s; waiting for an IDR", recordingContext.TripID, recordingContext.RecordingSessionID)
	return nil
}

func (r *Recorder) stop(reason string) error {
	var err error
	if r.segment != nil {
		err = r.finalizeSegment(nil)
	}
	r.segment = nil
	r.activeContext = Context{}
	r.needKeyframe = true
	r.rolloverSent = false
	r.updateStatus()
	if reason != "" {
		log.Printf("recording stopped: %s", reason)
	}
	return err
}

func (r *Recorder) publish(item *yolofeed.AccessUnit) error {
	if item == nil || r.activeContext.TripID == 0 {
		return nil
	}
	if !r.haveEpoch || r.epoch != item.Epoch {
		if r.segment != nil {
			if err := r.finalizeSegment(nil); err != nil {
				log.Printf("recording epoch transition: segment finalization failed: %v", err)
			}
		}
		r.segment = nil
		r.epoch = item.Epoch
		r.haveEpoch = true
		r.needKeyframe = true
		r.rolloverSent = false
	}
	if r.segment == nil {
		if !item.Keyframe {
			return nil
		}
		return r.startSegment(item)
	}

	segmentDuration := time.Duration(item.PTS90K-r.segment.startPTS) * time.Second / videoTimeScale
	if item.Keyframe && segmentDuration >= r.config.SegmentDuration {
		if err := r.finalizeSegment(item); err != nil {
			return err
		}
		r.rolloverSent = false
		return r.startSegment(item)
	}
	if segmentDuration >= r.config.SegmentDuration && !r.rolloverSent {
		r.rolloverSent = true
		r.requestKeyframeAsync()
	}
	if r.spool.Load()+pendingSampleBytes(r.segment.pending)+int64(len(item.Data))+2048 > r.config.SpoolMaxBytes {
		r.abortSegment("recording spool limit reached")
		r.needKeyframe = true
		r.requestKeyframeAsync()
		return nil
	}
	before := r.segment.bytes
	err := r.segment.append(item)
	r.spool.Add(r.segment.bytes - before)
	if err != nil {
		r.abortSegment("invalid or discontinuous H.264 access unit")
		r.needKeyframe = true
		r.requestKeyframeAsync()
		return err
	}
	r.updateStatus()
	return nil
}

func (r *Recorder) startSegment(item *yolofeed.AccessUnit) error {
	index, markerBytes, err := r.allocateSegmentIndex(r.activeContext.RecordingSessionID)
	if err != nil {
		r.counters.droppedSegments.Add(1)
		r.requestKeyframeAsync()
		return fmt.Errorf("allocate segment index: %w", err)
	}
	r.spool.Add(markerBytes)
	segment, err := newSegmentWriter(r.config.SpoolDir, r.config.Bucket, r.activeContext, index, item)
	if err != nil {
		r.counters.droppedSegments.Add(1)
		r.requestKeyframeAsync()
		return fmt.Errorf("start MP4 segment: %w", err)
	}
	if r.spool.Load()+segment.bytes > r.config.SpoolMaxBytes {
		_ = segment.discard()
		r.counters.droppedSegments.Add(1)
		r.needKeyframe = true
		r.requestKeyframeAsync()
		log.Printf("recording spool limit reached; waiting for space before opening the next segment")
		return nil
	}
	r.segment = segment
	r.spool.Add(segment.bytes)
	r.segmentIndex = index
	r.needKeyframe = false
	r.rolloverSent = false
	r.updateStatus()
	log.Printf("recording segment started trip=%d session=%s segment=%d epoch=%d seq=%d", r.activeContext.TripID, r.activeContext.RecordingSessionID, index, item.Epoch, item.Seq)
	return nil
}

func (r *Recorder) finalizeSegment(next *yolofeed.AccessUnit) error {
	segment := r.segment
	if segment == nil {
		return nil
	}
	before := segment.bytes
	manifest, err := segment.finalize(next)
	r.spool.Add(segment.bytes - before)
	if err != nil {
		r.abortSegment("MP4 finalization failure")
		return err
	}
	manifestBytes, err := writeJSONAtomic(segment.manifestPath, manifest)
	if err != nil {
		r.abortSegment("manifest write failure")
		return fmt.Errorf("write recording manifest: %w", err)
	}
	r.spool.Add(manifestBytes)
	if err := segment.commitFile(); err != nil {
		r.segment = nil
		r.counters.droppedSegments.Add(1)
		r.updateStatus()
		return fmt.Errorf("commit MP4 segment to spool: %w", err)
	}
	r.segment = nil
	r.upload.Enqueue(segment.finalPath)
	r.updateStatus()
	log.Printf("recording segment finalized trip=%d session=%s segment=%d size=%d duration=%ds", manifest.TripID, manifest.RecordingSessionID, manifest.SegmentIndex, manifest.SizeBytes, manifest.DurationSec)
	return nil
}

func (r *Recorder) abortSegment(reason string) {
	segment := r.segment
	if segment == nil {
		return
	}
	if info, err := os.Stat(segment.tmpPath); err == nil {
		_ = segment.discard()
		r.spool.Add(-info.Size())
	} else {
		_ = segment.discard()
		r.spool.Add(-segment.bytes)
	}
	r.counters.droppedSegments.Add(1)
	r.segment = nil
	r.updateStatus()
	log.Printf("recording segment dropped trip=%d session=%s segment=%d reason=%s", segment.context.TripID, segment.context.RecordingSessionID, segment.index, reason)
}

func pendingSampleBytes(sample *pendingSample) int64 {
	if sample == nil {
		return 0
	}
	var total int64
	for _, nalu := range sample.nalus {
		total += int64(len(nalu)) + 4
	}
	return total
}

func (r *Recorder) allocateSegmentIndex(sessionID string) (int, int64, error) {
	prefix := "session-" + sessionID + "-segment-"
	entries, err := os.ReadDir(r.config.SpoolDir)
	if err != nil {
		return 0, 0, err
	}
	next := 0
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		tail := strings.TrimPrefix(name, prefix)
		extension := filepath.Ext(tail)
		if extension != ".index" && extension != ".mp4" && extension != ".json" {
			continue
		}
		value, parseErr := strconv.Atoi(strings.TrimSuffix(tail, extension))
		if parseErr == nil && value >= next {
			next = value + 1
		}
	}
	for {
		marker := filepath.Join(r.config.SpoolDir, fmt.Sprintf("%s%06d.index", prefix, next))
		file, openErr := os.OpenFile(marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if errors.Is(openErr, os.ErrExist) {
			next++
			continue
		}
		if openErr != nil {
			return 0, 0, openErr
		}
		if _, err := fmt.Fprintln(file, next); err != nil {
			_ = file.Close()
			_ = os.Remove(marker)
			return 0, 0, err
		}
		if err := file.Sync(); err != nil {
			_ = file.Close()
			_ = os.Remove(marker)
			return 0, 0, err
		}
		if err := file.Close(); err != nil {
			_ = os.Remove(marker)
			return 0, 0, err
		}
		info, err := os.Stat(marker)
		if err != nil {
			return 0, 0, err
		}
		return next, info.Size(), nil
	}
}

func (r *Recorder) requestKeyframeAsync() {
	r.callbackMu.RLock()
	callback := r.requestKeyframe
	r.callbackMu.RUnlock()
	if callback != nil {
		go callback()
	}
}

func (r *Recorder) updateStatus() {
	status := Status{
		Enabled:       true,
		Active:        r.activeContext.TripID > 0,
		SegmentActive: r.segment != nil,
	}
	if status.Active {
		status.TripID = strconv.FormatInt(r.activeContext.TripID, 10)
		status.RecordingSession = r.activeContext.RecordingSessionID
	}
	if r.segment != nil {
		status.SegmentFrames = r.segment.sampleCount + 1
		status.SegmentBytes = r.segment.bytes
	}
	if r.segment != nil {
		index := r.segment.index
		status.SegmentIndex = &index
	}
	r.statusMu.Lock()
	r.status = status
	r.statusMu.Unlock()
}

func validateRecordingContext(recordingContext Context) error {
	if recordingContext.TripID <= 0 || recordingContext.VehicleID <= 0 {
		return errors.New("tripId and vehicleId must be positive")
	}
	if !recordingSessionPattern.MatchString(recordingContext.RecordingSessionID) || strings.Contains(recordingContext.RecordingSessionID, "..") {
		return errors.New("recordingSessionId must be 1-80 safe alphanumeric, dot, underscore, or hyphen characters")
	}
	return nil
}

var _ ContextValidator = (*NodeClient)(nil)
var _ SegmentRegistrar = (*NodeClient)(nil)
