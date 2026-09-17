package recording

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type uploadedMarker struct {
	ETag      string `json:"etag"`
	SizeBytes int64  `json:"sizeBytes"`
}

type committedMarker struct {
	CommittedAt time.Time `json:"committedAt"`
}

type uploader struct {
	directory string
	store     ObjectStore
	registrar SegmentRegistrar
	queue     chan string
	ctx       context.Context
	cancel    context.CancelFunc
	done      chan struct{}

	spool    *atomic.Int64
	counters *uploadCounters
	pending  map[string]struct{}
	mu       sync.Mutex
}

func newUploader(directory string, capacity int, store ObjectStore, registrar SegmentRegistrar, spool *atomic.Int64, counters *uploadCounters) (*uploader, error) {
	if capacity < 1 || store == nil || registrar == nil || spool == nil || counters == nil {
		return nil, errors.New("invalid uploader configuration")
	}
	ctx, cancel := context.WithCancel(context.Background())
	u := &uploader{
		directory: directory,
		store:     store,
		registrar: registrar,
		queue:     make(chan string, capacity),
		ctx:       ctx,
		cancel:    cancel,
		done:      make(chan struct{}),
		spool:     spool,
		counters:  counters,
		pending:   make(map[string]struct{}),
	}
	u.scan()
	go u.run()
	return u, nil
}

func (u *uploader) Enqueue(filePath string) {
	u.enqueue(filePath)
}

func (u *uploader) QueueDepth() int {
	return len(u.queue)
}

func (u *uploader) Close() error {
	u.cancel()
	<-u.done
	return nil
}

func (u *uploader) enqueue(filePath string) {
	filePath = filepath.Clean(filePath)
	u.mu.Lock()
	if _, exists := u.pending[filePath]; exists {
		u.mu.Unlock()
		return
	}
	u.pending[filePath] = struct{}{}
	select {
	case u.queue <- filePath:
		u.mu.Unlock()
	default:
		delete(u.pending, filePath)
		u.mu.Unlock()
	}
}

func (u *uploader) scan() {
	entries, err := os.ReadDir(u.directory)
	if err != nil {
		log.Printf("recording spool scan failed: %v", err)
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasSuffix(name, ".committed.json") {
			committedPath := filepath.Join(u.directory, name)
			u.enqueue(strings.TrimSuffix(committedPath, ".committed.json") + ".mp4")
			continue
		}
		if !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".uploaded.json") {
			continue
		}
		manifestPath := filepath.Join(u.directory, name)
		if _, err := readManifest(manifestPath); err != nil {
			log.Printf("recording spool scan skipped %s: %v", name, err)
			continue
		}
		filePath := strings.TrimSuffix(manifestPath, ".json") + ".mp4"
		if _, err := os.Stat(filePath); err != nil {
			log.Printf("recording spool scan retained manifest without MP4: %s (%v)", name, err)
			continue
		}
		u.enqueue(filePath)
	}
}

func (u *uploader) run() {
	defer close(u.done)
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-u.ctx.Done():
			return
		case filePath := <-u.queue:
			u.process(filePath)
			u.mu.Lock()
			delete(u.pending, filePath)
			u.mu.Unlock()
		case <-ticker.C:
			u.scan()
		}
	}
}

func (u *uploader) process(filePath string) {
	attempt := 0
	for {
		if u.ctx.Err() != nil {
			return
		}
		if err := u.processOnce(filePath); err == nil {
			return
		} else {
			u.counters.uploadFailures.Add(1)
			log.Printf("recording upload/registration will retry for %s: %v", filepath.Base(filePath), err)
		}
		wait := time.Second << min(attempt, 5)
		attempt++
		timer := time.NewTimer(wait)
		select {
		case <-u.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (u *uploader) processOnce(filePath string) error {
	basePath := strings.TrimSuffix(filePath, ".mp4")
	manifestPath := basePath + ".json"
	uploadedPath := basePath + ".uploaded.json"
	committedPath := basePath + ".committed.json"
	if _, err := os.Stat(committedPath); err == nil {
		return u.removeCommitted(filePath, manifestPath, uploadedPath, committedPath)
	}
	manifest, err := readManifest(manifestPath)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filePath); err != nil {
		return fmt.Errorf("stat local segment: %w", err)
	}

	marker, err := readUploadedMarker(uploadedPath)
	if errors.Is(err, os.ErrNotExist) {
		uploadStarted := time.Now()
		info, uploadErr := u.store.Upload(u.ctx, manifest.StorageBucket, manifest.ObjectKey, filePath, manifest.ContentType)
		u.counters.lastUploadMS.Store(time.Since(uploadStarted).Milliseconds())
		if uploadErr != nil {
			return fmt.Errorf("upload object to MinIO: %w", uploadErr)
		}
		marker = uploadedMarker{ETag: info.ETag, SizeBytes: info.SizeBytes}
		if marker.SizeBytes == 0 {
			if localInfo, statErr := os.Stat(filePath); statErr == nil {
				marker.SizeBytes = localInfo.Size()
			}
		}
		if _, err := writeJSONAtomic(uploadedPath, marker); err != nil {
			return fmt.Errorf("persist MinIO upload journal: %w", err)
		}
		u.spool.Add(markerFileSize(uploadedPath))
	} else if err != nil {
		return fmt.Errorf("read MinIO upload journal: %w", err)
	}
	manifest.ETag = marker.ETag
	manifest.SizeBytes = marker.SizeBytes

	if err := u.registrar.RegisterSegment(u.ctx, manifest); err != nil {
		return fmt.Errorf("register segment metadata in Node: %w", err)
	}
	if _, err := writeJSONAtomic(committedPath, committedMarker{CommittedAt: time.Now().UTC()}); err != nil {
		return fmt.Errorf("persist Node acknowledgement: %w", err)
	}
	u.spool.Add(markerFileSize(committedPath))
	u.counters.uploadedTotal.Add(1)
	return u.removeCommitted(filePath, manifestPath, uploadedPath, committedPath)
}

func (u *uploader) removeCommitted(paths ...string) error {
	if len(paths) == 0 {
		return nil
	}
	var errorsToReturn []error
	var removedBytes int64
	// Keep the acknowledgement marker until all other spool files have been
	// removed. Recovery can then finish cleanup without uploading the object or
	// registering its metadata a second time.
	for _, path := range paths[:len(paths)-1] {
		info, statErr := os.Stat(path)
		if errors.Is(statErr, os.ErrNotExist) {
			continue
		}
		if statErr != nil {
			errorsToReturn = append(errorsToReturn, statErr)
			continue
		}
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			errorsToReturn = append(errorsToReturn, removeErr)
			continue
		}
		removedBytes += info.Size()
	}
	if len(errorsToReturn) == 0 {
		acknowledgement := paths[len(paths)-1]
		info, statErr := os.Stat(acknowledgement)
		if statErr == nil {
			if removeErr := os.Remove(acknowledgement); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				errorsToReturn = append(errorsToReturn, removeErr)
			} else {
				removedBytes += info.Size()
			}
		} else if !errors.Is(statErr, os.ErrNotExist) {
			errorsToReturn = append(errorsToReturn, statErr)
		}
	}
	u.spool.Add(-removedBytes)
	return errors.Join(errorsToReturn...)
}

func readUploadedMarker(path string) (uploadedMarker, error) {
	var marker uploadedMarker
	content, err := os.ReadFile(path)
	if err != nil {
		return marker, err
	}
	if err := json.Unmarshal(content, &marker); err != nil {
		return marker, err
	}
	return marker, nil
}

func markerFileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}
