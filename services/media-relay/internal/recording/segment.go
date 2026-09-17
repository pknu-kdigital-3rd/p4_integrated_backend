package recording

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"

	"github.com/bluenviron/mediacommon/pkg/formats/fmp4"

	"poc-server-webrtc/relay-go/internal/yolofeed"
)

const (
	videoTrackID     = 1
	videoTimeScale   = 90000
	defaultFrameTick = 3000
	maxFrameGapTick  = 10 * videoTimeScale
)

type pendingSample struct {
	nalus      [][]byte
	pts        int64
	seq        uint64
	receivedAt time.Time
}

type segmentWriter struct {
	file         *os.File
	tmpPath      string
	finalPath    string
	manifestPath string
	context      Context
	bucket       string
	index        int
	epoch        uint64
	startSeq     uint64
	startPTS     int64
	startedAt    time.Time
	pending      *pendingSample
	lastDuration int64
	decodeTime   uint64
	partSequence uint32
	sampleCount  int
	bytes        int64
}

func newSegmentWriter(directory, bucket string, recordingContext Context, index int, item *yolofeed.AccessUnit) (*segmentWriter, error) {
	nalus, err := parseAnnexBNALUs(item.Data)
	if err != nil {
		return nil, err
	}
	sps, pps, hasIDR := h264Parameters(nalus)
	if !item.Keyframe || !hasIDR || len(sps) == 0 || len(pps) == 0 {
		return nil, errors.New("recording segment must start with an IDR and SPS/PPS")
	}
	baseName := fmt.Sprintf("session-%s-segment-%06d", recordingContext.RecordingSessionID, index)
	tmpPath := filepath.Join(directory, baseName+".mp4.tmp")
	file, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create spool segment: %w", err)
	}
	writer := &segmentWriter{
		file:         file,
		tmpPath:      tmpPath,
		finalPath:    filepath.Join(directory, baseName+".mp4"),
		manifestPath: filepath.Join(directory, baseName+".json"),
		context:      recordingContext,
		bucket:       bucket,
		index:        index,
		epoch:        item.Epoch,
		startSeq:     item.Seq,
		startPTS:     item.PTS90K,
		startedAt:    time.Now().UTC(),
	}
	init := &fmp4.Init{Tracks: []*fmp4.InitTrack{{
		ID:        videoTrackID,
		TimeScale: videoTimeScale,
		Codec:     &fmp4.CodecH264{SPS: sps, PPS: pps},
	}}}
	if err := init.Marshal(file); err != nil {
		_ = writer.discard()
		return nil, fmt.Errorf("write fMP4 initialization block: %w", err)
	}
	if err := writer.refreshSize(); err != nil {
		_ = writer.discard()
		return nil, fmt.Errorf("stat fMP4 initialization block: %w", err)
	}
	writer.pending = &pendingSample{nalus: nalus, pts: item.PTS90K, seq: item.Seq, receivedAt: time.Now().UTC()}
	return writer, nil
}

func (s *segmentWriter) append(item *yolofeed.AccessUnit) error {
	if item == nil || item.Epoch != s.epoch {
		return errors.New("access unit does not belong to this relay epoch")
	}
	if item.Seq != s.pending.seq+1 {
		return fmt.Errorf("H.264 access unit sequence gap: previous=%d next=%d", s.pending.seq, item.Seq)
	}
	nalus, err := parseAnnexBNALUs(item.Data)
	if err != nil {
		return err
	}
	if item.PTS90K <= s.pending.pts {
		return fmt.Errorf("non-monotonic H.264 presentation timestamp: current=%d next=%d", s.pending.pts, item.PTS90K)
	}
	duration := item.PTS90K - s.pending.pts
	if duration > maxFrameGapTick {
		return fmt.Errorf("H.264 presentation timestamp gap is too large: %d ticks", duration)
	}
	if err := s.writeSample(s.pending, duration); err != nil {
		return err
	}
	s.lastDuration = duration
	s.pending = &pendingSample{nalus: nalus, pts: item.PTS90K, seq: item.Seq, receivedAt: time.Now().UTC()}
	return nil
}

func (s *segmentWriter) finalize(next *yolofeed.AccessUnit) (Manifest, error) {
	if s.pending == nil {
		return Manifest{}, errors.New("cannot finalize an empty segment")
	}
	duration := s.lastDuration
	if next != nil && next.Epoch == s.epoch && next.PTS90K > s.pending.pts {
		duration = next.PTS90K - s.pending.pts
	}
	if duration <= 0 || duration > maxFrameGapTick {
		duration = defaultFrameTick
	}
	if err := s.writeSample(s.pending, duration); err != nil {
		return Manifest{}, err
	}
	if err := s.file.Sync(); err != nil {
		return Manifest{}, fmt.Errorf("sync fMP4 segment: %w", err)
	}
	if err := s.file.Close(); err != nil {
		s.file = nil
		return Manifest{}, fmt.Errorf("close fMP4 segment: %w", err)
	}
	s.file = nil
	info, err := os.Stat(s.tmpPath)
	if err != nil {
		return Manifest{}, fmt.Errorf("stat finalized segment: %w", err)
	}
	s.bytes = info.Size()
	endedAt := s.pending.receivedAt
	if endedAt.Before(s.startedAt) {
		endedAt = s.startedAt
	}
	durationTicks := s.pending.pts - s.startPTS + duration
	return Manifest{
		TripID:             s.context.TripID,
		VehicleID:          s.context.VehicleID,
		RecordingSessionID: s.context.RecordingSessionID,
		SegmentIndex:       s.index,
		StorageBucket:      s.bucket,
		ObjectKey:          fmt.Sprintf("trips/%d/sessions/%s/segment-%06d.mp4", s.context.TripID, s.context.RecordingSessionID, s.index),
		ContentType:        contentTypeMP4,
		SizeBytes:          info.Size(),
		RelayEpoch:         s.epoch,
		StartSeq:           s.startSeq,
		EndSeq:             s.pending.seq,
		StartPTS90K:        s.startPTS,
		EndPTS90K:          s.pending.pts,
		StartedAt:          s.startedAt,
		EndedAt:            endedAt,
		DurationSec:        int(math.Round(float64(durationTicks) / videoTimeScale)),
	}, nil
}

func (s *segmentWriter) writeSample(sample *pendingSample, duration int64) error {
	if duration <= 0 || uint64(duration) > uint64(^uint32(0)) {
		return fmt.Errorf("sample duration is outside the MP4 range: %d", duration)
	}
	encoded, err := fmp4.NewPartSampleH264(0, sample.nalus)
	if err != nil {
		return fmt.Errorf("encode H.264 MP4 sample: %w", err)
	}
	encoded.Duration = uint32(duration)
	s.partSequence++
	part := &fmp4.Part{
		SequenceNumber: s.partSequence,
		Tracks: []*fmp4.PartTrack{{
			ID:       videoTrackID,
			BaseTime: s.decodeTime,
			Samples:  []*fmp4.PartSample{encoded},
		}},
	}
	before, err := s.file.Seek(0, 1)
	if err != nil {
		return fmt.Errorf("read fMP4 spool offset: %w", err)
	}
	if err := part.Marshal(s.file); err != nil {
		_ = s.refreshSize()
		return fmt.Errorf("write fMP4 media fragment: %w", err)
	}
	after, err := s.file.Seek(0, 1)
	if err != nil {
		return fmt.Errorf("read fMP4 spool size: %w", err)
	}
	s.bytes += after - before
	s.decodeTime += uint64(duration)
	s.sampleCount++
	return nil
}

func (s *segmentWriter) refreshSize() error {
	info, err := s.file.Stat()
	if err != nil {
		return err
	}
	s.bytes = info.Size()
	return nil
}

func (s *segmentWriter) discard() error {
	if s.file != nil {
		_ = s.file.Close()
		s.file = nil
	}
	err := os.Remove(s.tmpPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s *segmentWriter) commitFile() error {
	return os.Rename(s.tmpPath, s.finalPath)
}
