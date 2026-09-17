package recording

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"poc-server-webrtc/relay-go/internal/yolofeed"
)

// This smoke test exercises the actual remux output when FFmpeg is installed.
// CI and developer hosts without FFmpeg still run the package unit tests.
func TestFFprobeReadsRecorderOutput(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is not installed")
	}
	directory := t.TempDir()
	fixturePath := filepath.Join(directory, "fixture.h264")
	command := exec.Command(ffmpeg,
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size=96x64:rate=30",
		"-frames:v", "6", "-pix_fmt", "yuv420p", "-c:v", "libx264",
		"-preset", "ultrafast", "-tune", "zerolatency",
		"-x264-params", "aud=1:keyint=3:min-keyint=3:scenecut=0:repeat-headers=1",
		"-f", "h264", fixturePath,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Skipf("ffmpeg cannot generate the H.264 fixture: %v (%s)", err, strings.TrimSpace(string(output)))
	}
	fixture, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	accessUnits, err := splitFixtureAccessUnits(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if len(accessUnits) != 6 || !accessUnits[0].Keyframe || !accessUnits[3].Keyframe {
		t.Fatalf("unexpected fixture access units: count=%d keyframes=[%t,%t]", len(accessUnits), accessUnits[0].Keyframe, accessUnits[3].Keyframe)
	}

	context := Context{TripID: 312, VehicleID: 27, RecordingSessionID: "ffprobe-smoke"}
	var segmentPaths []string
	var writer *segmentWriter
	for _, item := range accessUnits {
		if writer != nil && item.Keyframe && time.Duration(item.PTS90K-writer.startPTS)*time.Second/videoTimeScale >= 90*time.Millisecond {
			manifest, finalizeErr := writer.finalize(item)
			if finalizeErr != nil {
				t.Fatal(finalizeErr)
			}
			if commitErr := writer.commitFile(); commitErr != nil {
				t.Fatal(commitErr)
			}
			if manifest.SegmentIndex != len(segmentPaths) {
				t.Fatalf("unexpected segment index %d", manifest.SegmentIndex)
			}
			segmentPaths = append(segmentPaths, writer.finalPath)
			writer = nil
		}
		if writer == nil {
			if !item.Keyframe {
				continue
			}
			writer, err = newSegmentWriter(directory, "p4-trip-recordings", context, len(segmentPaths), item)
			if err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := writer.append(item); err != nil {
			t.Fatal(err)
		}
	}
	if writer != nil {
		if _, err := writer.finalize(nil); err != nil {
			t.Fatal(err)
		}
		if err := writer.commitFile(); err != nil {
			t.Fatal(err)
		}
		segmentPaths = append(segmentPaths, writer.finalPath)
	}
	if len(segmentPaths) != 2 {
		t.Fatalf("expected two independently playable segments, got %d", len(segmentPaths))
	}

	for _, path := range segmentPaths {
		probe := exec.Command(ffprobe,
			"-v", "error", "-select_streams", "v:0", "-count_frames",
			"-show_entries", "stream=codec_name,time_base,nb_read_frames",
			"-show_entries", "format=duration", "-of", "default=noprint_wrappers=1", path,
		)
		output, err := probe.CombinedOutput()
		if err != nil {
			t.Fatalf("ffprobe rejected %s: %v (%s)", filepath.Base(path), err, strings.TrimSpace(string(output)))
		}
		probeText := string(output)
		if !strings.Contains(probeText, "codec_name=h264") || !strings.Contains(probeText, "time_base=1/90000") || !strings.Contains(probeText, "nb_read_frames=3") {
			t.Fatalf("unexpected segment probe output for %s: %s", filepath.Base(path), probeText)
		}
		var duration float64
		for _, line := range strings.Split(probeText, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "duration=") {
				duration, err = strconv.ParseFloat(strings.TrimPrefix(line, "duration="), 64)
				if err != nil {
					t.Fatal(err)
				}
			}
		}
		if duration < 0.09 || duration > 0.11 {
			t.Fatalf("segment duration should be about 0.1 seconds, got %.6f", duration)
		}
		decode := exec.Command(ffmpeg, "-v", "error", "-i", path, "-frames:v", "1", "-f", "null", "-")
		if output, err := decode.CombinedOutput(); err != nil {
			t.Fatalf("first IDR frame is not independently decodable in %s: %v (%s)", filepath.Base(path), err, strings.TrimSpace(string(output)))
		}
	}
}

func splitFixtureAccessUnits(fixture []byte) ([]*yolofeed.AccessUnit, error) {
	nalus, err := parseAnnexBNALUs(fixture)
	if err != nil {
		return nil, err
	}
	var groups [][][]byte
	var current [][]byte
	hasVCL := func(values [][]byte) bool {
		for _, nalu := range values {
			if len(nalu) > 0 && nalu[0]&0x1f >= 1 && nalu[0]&0x1f <= 5 {
				return true
			}
		}
		return false
	}
	for _, nalu := range nalus {
		if nalu[0]&0x1f == 9 && hasVCL(current) {
			groups = append(groups, current)
			current = nil
		}
		current = append(current, nalu)
	}
	if hasVCL(current) {
		groups = append(groups, current)
	}
	accessUnits := make([]*yolofeed.AccessUnit, 0, len(groups))
	for index, group := range groups {
		var data []byte
		for _, nalu := range group {
			data = append(data, 0, 0, 0, 1)
			data = append(data, nalu...)
		}
		_, _, keyframe := h264Parameters(group)
		accessUnits = append(accessUnits, &yolofeed.AccessUnit{
			Epoch: 1, Seq: uint64(index), PTS90K: int64(index) * 3000,
			TimestampUS: int64(index) * 1_000_000 / 30,
			Keyframe:    keyframe, Data: data,
		})
	}
	if len(accessUnits) == 0 {
		return nil, fmt.Errorf("fixture contains no H.264 access units")
	}
	return accessUnits, nil
}
