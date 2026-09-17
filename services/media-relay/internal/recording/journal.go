package recording

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
)

type sessionState struct {
	NextSegmentIndex int `json:"nextSegmentIndex"`
}

func writeJSONAtomic(path string, value any) (int64, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return 0, err
	}
	payload = append(payload, '\n')
	temporaryPath := path + ".tmp"
	file, err := os.OpenFile(temporaryPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	if _, err = file.Write(payload); err != nil {
		_ = file.Close()
		return 0, err
	}
	if err = file.Sync(); err != nil {
		_ = file.Close()
		return 0, err
	}
	if err = file.Close(); err != nil {
		return 0, err
	}
	if err = os.Rename(temporaryPath, path); err != nil {
		return 0, err
	}
	return int64(len(payload)), nil
}

func recoverSpool(directory string) (int64, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return 0, err
	}
	for _, entry := range entries {
		name := entry.Name()
		path := filepath.Join(directory, name)
		if strings.HasSuffix(name, ".committed.json") {
			base := strings.TrimSuffix(path, ".committed.json")
			artifacts := []string{base + ".mp4", base + ".json", base + ".uploaded.json"}
			cleanupFailed := false
			for _, committedArtifact := range artifacts {
				if removeErr := os.Remove(committedArtifact); removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
					log.Printf("recording recovery: retain acknowledged artifact %s: %v", committedArtifact, removeErr)
					cleanupFailed = true
				}
			}
			// Keep the commit acknowledgement until every larger artifact is gone.
			// If cleanup is interrupted, the uploader can resume from this marker
			// without uploading or registering the segment again.
			if !cleanupFailed {
				if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
					log.Printf("recording recovery: retain commit acknowledgement %s: %v", path, removeErr)
				}
			}
			continue
		}
		if strings.HasSuffix(name, ".mp4.tmp") {
			base := strings.TrimSuffix(path, ".mp4.tmp")
			manifestPath := base + ".json"
			finalPath := base + ".mp4"
			if _, manifestErr := os.Stat(manifestPath); manifestErr == nil {
				if _, finalErr := os.Stat(finalPath); errors.Is(finalErr, fs.ErrNotExist) {
					if renameErr := os.Rename(path, finalPath); renameErr != nil {
						log.Printf("recording recovery: retain finalized temp %s: %v", path, renameErr)
					}
				} else if finalErr == nil {
					log.Printf("recording recovery: remove duplicate temp after finalized MP4 exists: %s", path)
					if removeErr := os.Remove(path); removeErr != nil {
						log.Printf("recording recovery: unable to remove duplicate temp %s: %v", path, removeErr)
					}
				} else {
					log.Printf("recording recovery: unable to inspect finalized file for %s: %v", path, finalErr)
				}
				continue
			}
			log.Printf("recording recovery: discard incomplete segment %s", path)
			if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
				log.Printf("recording recovery: unable to discard %s: %v", path, removeErr)
			}
		}
		if strings.HasSuffix(name, ".json.tmp") || strings.HasSuffix(name, ".state.tmp") {
			log.Printf("recording recovery: discard incomplete journal %s", path)
			if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
				log.Printf("recording recovery: unable to discard journal %s: %v", path, removeErr)
			}
		}
	}

	entries, err = os.ReadDir(directory)
	if err != nil {
		return 0, err
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".mp4") {
			continue
		}
		manifestPath := strings.TrimSuffix(filepath.Join(directory, entry.Name()), ".mp4") + ".json"
		if _, statErr := os.Stat(manifestPath); errors.Is(statErr, fs.ErrNotExist) {
			log.Printf("recording recovery: finalized MP4 has no manifest; retaining it: %s", entry.Name())
		}
	}
	return directorySize(directory)
}

func directorySize(directory string) (int64, error) {
	var total int64
	err := filepath.WalkDir(directory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return fmt.Errorf("read spool file info for %s: %w", path, err)
		}
		total += info.Size()
		return nil
	})
	return total, err
}

func readManifest(path string) (Manifest, error) {
	var manifest Manifest
	content, err := os.ReadFile(path)
	if err != nil {
		return manifest, err
	}
	if err := json.Unmarshal(content, &manifest); err != nil {
		return manifest, fmt.Errorf("decode recording manifest %s: %w", path, err)
	}
	if err := validateRecordingContext(Context{
		TripID: manifest.TripID, VehicleID: manifest.VehicleID,
		RecordingSessionID: manifest.RecordingSessionID,
	}); err != nil {
		return manifest, fmt.Errorf("invalid recording manifest %s: %w", path, err)
	}
	if manifest.SegmentIndex < 0 || manifest.StorageBucket == "" || manifest.ObjectKey == "" || manifest.ContentType != contentTypeMP4 {
		return manifest, fmt.Errorf("invalid recording manifest metadata: %s", path)
	}
	return manifest, nil
}
