package recording

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type MinioStore struct {
	client *minio.Client
}

func NewMinioStore(endpoint, accessKey, secretKey string, secure bool) (*MinioStore, error) {
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: secure,
		Region: "us-east-1",
	})
	if err != nil {
		return nil, fmt.Errorf("create MinIO client: %w", err)
	}
	return &MinioStore{client: client}, nil
}

func (s *MinioStore) Upload(ctx context.Context, bucket, key, filePath, contentType string) (ObjectInfo, error) {
	info, err := s.client.FPutObject(ctx, bucket, key, filePath, minio.PutObjectOptions{ContentType: contentType})
	if err != nil {
		return ObjectInfo{}, err
	}
	return ObjectInfo{ETag: info.ETag, SizeBytes: info.Size}, nil
}

type NodeClient struct {
	baseURL *url.URL
	token   string
	client  *http.Client
}

func NewNodeClient(baseURL, token string) (*NodeClient, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed == nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, fmt.Errorf("invalid Node internal base URL %q", baseURL)
	}
	return &NodeClient{
		baseURL: parsed,
		token:   token,
		client:  &http.Client{Timeout: 5 * time.Second},
	}, nil
}

func (c *NodeClient) ValidateRecordingContext(ctx context.Context, recordingContext Context) (Context, error) {
	if err := validateRecordingContext(recordingContext); err != nil {
		return Context{}, err
	}
	var validated Context
	if err := c.postJSON(ctx, "/internal/recordings/validate", recordingContext, &validated); err != nil {
		return Context{}, err
	}
	if validated != recordingContext {
		return Context{}, fmt.Errorf("Node returned a different recording identity")
	}
	return validated, nil
}

func (c *NodeClient) RegisterSegment(ctx context.Context, segment Manifest) error {
	return c.postJSON(ctx, "/internal/recordings/segments", segment, nil)
}

// PostJSON posts to any Node internal API path with service authentication.
func (c *NodeClient) PostJSON(ctx context.Context, path string, value any) error {
	return c.postJSON(ctx, path, value, nil)
}

// HTTPStatusError is returned for a non-2xx Node response so callers can tell
// a rejected request from a transient outage.
type HTTPStatusError struct {
	Status  int
	Message string
}

func (e *HTTPStatusError) Error() string {
	return fmt.Sprintf("Node internal API returned HTTP %d: %s", e.Status, e.Message)
}

func (e *HTTPStatusError) StatusCode() int { return e.Status }

func (c *NodeClient) postJSON(ctx context.Context, path string, value any, result any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + path
	endpoint.RawQuery = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Internal-Service-Token", c.token)
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return &HTTPStatusError{Status: response.StatusCode, Message: strings.TrimSpace(string(message))}
	}
	if result != nil {
		if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(result); err != nil {
			return fmt.Errorf("decode Node internal API response: %w", err)
		}
	}
	return nil
}
