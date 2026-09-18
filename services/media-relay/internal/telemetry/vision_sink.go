package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

const (
	DefaultVisionQueue   = 64
	visionRequestTimeout = 2 * time.Second
)

type visionGPSSample struct {
	TimestampNS         string   `json:"timestamp_ns"`
	UTCEpochMS          *string  `json:"utc_epoch_ms"`
	Latitude            float64  `json:"latitude"`
	Longitude           float64  `json:"longitude"`
	AltitudeM           *float64 `json:"altitude_m"`
	SpeedMPS            *float64 `json:"speed_mps"`
	BearingDeg          *float64 `json:"bearing_deg"`
	HorizontalAccuracyM *float64 `json:"horizontal_accuracy_m"`
}

type visionIMUSample struct {
	TimestampNS string  `json:"timestamp_ns"`
	PitchDeg    float64 `json:"pitch_deg"`
	RollDeg     float64 `json:"roll_deg"`
	YawDeg      float64 `json:"yaw_deg"`
	Accuracy    *int    `json:"accuracy"`
}

// visionBatch is the canonical batch forwarded to Vision. Its identity is the
// trusted stream identity, never the Android payload fields.
type visionBatch struct {
	Mode               Mode              `json:"mode"`
	TripID             string            `json:"tripId"`
	VehicleID          string            `json:"vehicleId"`
	RecordingSessionID string            `json:"recordingSessionId"`
	SourceClockNS      string            `json:"sourceClockNs"`
	ReceivedAt         string            `json:"receivedAt"`
	GPS                []visionGPSSample `json:"gps"`
	IMU                []visionIMUSample `json:"imu"`
}

type visionItem struct {
	body   []byte
	hasGPS bool
}

// Poster sends a JSON body to a fixed URL.
type Poster interface {
	Post(ctx context.Context, body []byte) error
}

type HTTPPoster struct {
	URL    string
	Client *http.Client
}

func (p HTTPPoster) Post(ctx context.Context, body []byte) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := p.Client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("vision returned HTTP %d", response.StatusCode)
	}
	return nil
}

// VisionSink forwards full GPS/IMU batches for live-video synchronization. It
// is latency-oriented: under overload, stale IMU-only batches are discarded
// first, and nothing is retried - an old orientation sample delivered late is
// worse than a gap.
type VisionSink struct {
	poster  Poster
	queue   *boundedQueue[visionItem]
	metrics *Metrics
	logs    *rateLimitedLogger
}

func NewVisionSink(poster Poster, capacity int, metrics *Metrics) *VisionSink {
	return &VisionSink{
		poster:  poster,
		queue:   newBoundedQueue(capacity, evictVision),
		metrics: metrics,
		logs:    newRateLimitedLogger(5 * time.Second),
	}
}

func evictVision(queued []visionItem, _ visionItem) int {
	for index, item := range queued {
		if !item.hasGPS {
			return index
		}
	}
	return 0
}

func (s *VisionSink) Enqueue(accepted Accepted) {
	body, err := json.Marshal(buildVisionBatch(accepted))
	if err != nil {
		s.logs.Printf("vision-encode", "telemetry: encode Vision batch: %v", err)
		return
	}
	if s.queue.Push(visionItem{body: body, hasGPS: len(accepted.GPS) > 0}) {
		s.metrics.VisionDropped.Add(1)
	}
}

func (s *VisionSink) QueueDepth() int { return s.queue.Len() }

func (s *VisionSink) Run(ctx context.Context) {
	for {
		item, ok := s.queue.Pop(ctx)
		if !ok {
			return
		}
		requestContext, cancel := context.WithTimeout(ctx, visionRequestTimeout)
		err := s.poster.Post(requestContext, item.body)
		cancel()
		if err != nil {
			s.metrics.VisionFailures.Add(1)
			s.logs.Printf("vision-fail", "telemetry: forward to Vision failed: %v", err)
			continue
		}
		s.metrics.VisionForwarded.Add(1)
	}
}

func buildVisionBatch(accepted Accepted) visionBatch {
	gps := make([]visionGPSSample, 0, len(accepted.GPS))
	for _, sample := range accepted.GPS {
		var utc *string
		if sample.UTCEpochMS != nil {
			value := strconv.FormatInt(*sample.UTCEpochMS, 10)
			utc = &value
		}
		gps = append(gps, visionGPSSample{
			TimestampNS:         strconv.FormatInt(sample.TimestampNS, 10),
			UTCEpochMS:          utc,
			Latitude:            sample.Latitude,
			Longitude:           sample.Longitude,
			AltitudeM:           sample.AltitudeM,
			SpeedMPS:            sample.SpeedMPS,
			BearingDeg:          sample.BearingDeg,
			HorizontalAccuracyM: sample.HorizontalAccuracyM,
		})
	}
	imu := make([]visionIMUSample, 0, len(accepted.IMU))
	for _, sample := range accepted.IMU {
		imu = append(imu, visionIMUSample{
			TimestampNS: strconv.FormatInt(sample.TimestampNS, 10),
			PitchDeg:    sample.PitchDeg,
			RollDeg:     sample.RollDeg,
			YawDeg:      sample.YawDeg,
			Accuracy:    sample.Accuracy,
		})
	}
	return visionBatch{
		Mode:               accepted.Mode,
		TripID:             accepted.Identity.tripString(),
		VehicleID:          accepted.Identity.vehicleString(),
		RecordingSessionID: accepted.Identity.RecordingSessionID,
		SourceClockNS:      strconv.FormatInt(accepted.SourceNS, 10),
		ReceivedAt:         formatUTC(accepted.ReceivedAt),
		GPS:                gps,
		IMU:                imu,
	}
}
