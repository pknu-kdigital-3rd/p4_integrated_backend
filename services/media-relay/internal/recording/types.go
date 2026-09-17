package recording

import (
	"context"
	"time"
)

const contentTypeMP4 = "video/mp4"

// Config contains only the recording settings consumed by this package.
type Config struct {
	SegmentDuration time.Duration
	QueueFrames     int
	UploadQueue     int
	SpoolDir        string
	SpoolMaxBytes   int64
	Bucket          string
}

// Context is supplied by signaling only after Node has confirmed that the
// trip and vehicle relationship is valid and the trip is in progress.
type Context struct {
	TripID             int64  `json:"tripId,string"`
	VehicleID          int64  `json:"vehicleId,string"`
	RecordingSessionID string `json:"recordingSessionId"`
}

// Manifest is the durable local journal and the idempotent Node registration
// payload. Large integer values are encoded as strings for JavaScript clients.
type Manifest struct {
	TripID             int64     `json:"tripId,string"`
	VehicleID          int64     `json:"vehicleId,string"`
	RecordingSessionID string    `json:"recordingSessionId"`
	SegmentIndex       int       `json:"segmentIndex"`
	StorageBucket      string    `json:"storageBucket"`
	ObjectKey          string    `json:"objectKey"`
	ContentType        string    `json:"contentType"`
	ETag               string    `json:"etag,omitempty"`
	SizeBytes          int64     `json:"sizeBytes,string"`
	RelayEpoch         uint64    `json:"relayEpoch,string"`
	StartSeq           uint64    `json:"startSeq,string"`
	EndSeq             uint64    `json:"endSeq,string"`
	StartPTS90K        int64     `json:"startPts90k,string"`
	EndPTS90K          int64     `json:"endPts90k,string"`
	DurationPTS90K     int64     `json:"durationPts90k,string"`
	StartedAt          time.Time `json:"startedAt"`
	EndedAt            time.Time `json:"endedAt"`
	DurationSec        int       `json:"durationSec"`
	Uploaded           bool      `json:"uploaded,omitempty"`
}

type ObjectInfo struct {
	ETag      string
	SizeBytes int64
}

type ObjectStore interface {
	Upload(ctx context.Context, bucket, key, filePath, contentType string) (ObjectInfo, error)
}

type SegmentRegistrar interface {
	RegisterSegment(ctx context.Context, segment Manifest) error
}

type ContextValidator interface {
	ValidateRecordingContext(ctx context.Context, recordingContext Context) (Context, error)
}

// Status is safe to expose through the relay's internal health endpoint.
type Status struct {
	Enabled          bool   `json:"enabled"`
	Active           bool   `json:"active"`
	SegmentActive    bool   `json:"segmentActive"`
	TripID           string `json:"tripId,omitempty"`
	RecordingSession string `json:"recordingSessionId,omitempty"`
	SegmentIndex     *int   `json:"segmentIndex,omitempty"`
	InputQueue       int    `json:"inputQueue"`
	UploadQueue      int    `json:"uploadQueue"`
	SpoolBytes       int64  `json:"spoolBytes"`
	SegmentFrames    int    `json:"segmentFrames"`
	SegmentBytes     int64  `json:"segmentBytes"`
	UploadedTotal    uint64 `json:"segmentsUploaded"`
	UploadFailures   uint64 `json:"uploadFailures"`
	DroppedSegments  uint64 `json:"droppedSegments"`
	DroppedFrames    uint64 `json:"droppedFrames"`
	LastUploadMS     int64  `json:"lastUploadMs"`
}
