package telemetry

import (
	"context"
	"sync"
)

// boundedQueue never blocks the producer. When full, evict chooses which
// queued item to discard (or -1 to discard the incoming item instead).
type boundedQueue[T any] struct {
	mu       sync.Mutex
	items    []T
	capacity int
	notify   chan struct{}
	evict    func(queued []T, incoming T) int
}

func newBoundedQueue[T any](capacity int, evict func([]T, T) int) *boundedQueue[T] {
	if capacity < 1 {
		capacity = 1
	}
	return &boundedQueue[T]{capacity: capacity, notify: make(chan struct{}, 1), evict: evict}
}

// Push returns true when an item (queued or incoming) had to be dropped.
func (q *boundedQueue[T]) Push(item T) (dropped bool) {
	q.mu.Lock()
	if len(q.items) >= q.capacity {
		dropped = true
		index := q.evict(q.items, item)
		if index < 0 {
			q.mu.Unlock()
			return true
		}
		q.items = append(q.items[:index], q.items[index+1:]...)
	}
	q.items = append(q.items, item)
	q.mu.Unlock()
	select {
	case q.notify <- struct{}{}:
	default:
	}
	return dropped
}

// Pop blocks until an item is available or ctx ends.
func (q *boundedQueue[T]) Pop(ctx context.Context) (T, bool) {
	for {
		q.mu.Lock()
		if len(q.items) > 0 {
			item := q.items[0]
			var zero T
			q.items[0] = zero
			q.items = q.items[1:]
			q.mu.Unlock()
			return item, true
		}
		q.mu.Unlock()
		select {
		case <-ctx.Done():
			var zero T
			return zero, false
		case <-q.notify:
		}
	}
}

func (q *boundedQueue[T]) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

func evictOldest[T any](_ []T, _ T) int { return 0 }
