#pragma once
#include <stdint.h>

#ifdef __CUDACC__
#define P4_HD __host__ __device__
#else
#define P4_HD
#endif

// Moore-neighborhood boundary following. Foreground uses 8-connectivity;
// exterior background uses 4-connectivity. No OpenCV code is embedded here.
P4_HD inline int direction_x(int d) {
    return d == 0 || d == 1 || d == 7 ? 1 : (d == 3 || d == 4 || d == 5 ? -1 : 0);
}
P4_HD inline int direction_y(int d) {
    return d == 5 || d == 6 || d == 7 ? 1 : (d == 1 || d == 2 || d == 3 ? -1 : 0);
}
P4_HD inline bool foreground(const uint8_t* mask, int h, int w, int x, int y) {
    return x >= 0 && x < w && y >= 0 && y < h && mask[y * w + x] != 0;
}
P4_HD inline bool padded_foreground(const uint8_t* mask, int h, int w, int index) {
    return foreground(mask, h, w, index % (w + 2) - 1, index / (w + 2) - 1);
}

// A first pass counts direction changes (CHAIN_APPROX_SIMPLE). A second pass
// emits evenly spaced vertices if the configured point bound is exceeded.
// The directed starting edge, rather than the starting pixel alone, closes
// a contour correctly for thin lines and diagonally touching regions.
P4_HD inline int walk_contour(const uint8_t* mask, int h, int w, int start,
                              int32_t* output, int capacity, int total) {
    const int sx = start % (w + 2) - 1;
    const int sy = start / (w + 2) - 1;
    int x = sx, y = sy, back = 4, incoming = -1;
    int first_x = -1, first_y = -1, corners = 0, emitted = 0;
    const int limit = total < capacity ? total : capacity;
    // Every directed foreground-neighbor edge can be visited at most once.
    for (int steps = 0; steps <= 8 * h * w; ++steps) {
        int direction = -1;
        for (int offset = 1; offset <= 8; ++offset) {
            const int d = (back + offset) & 7;
            if (foreground(mask, h, w, x + direction_x(d), y + direction_y(d))) {
                direction = d;
                break;
            }
        }
        if (direction < 0) {
            if (output != nullptr && capacity > 0) {
                output[0] = x; output[1] = y;
            }
            return 1;
        }
        const int nx = x + direction_x(direction), ny = y + direction_y(direction);
        if (steps != 0 && x == sx && y == sy && nx == first_x && ny == first_y)
            return corners;
        if (steps == 0) { first_x = nx; first_y = ny; }
        if (steps == 0 || incoming != direction) {
            if (output != nullptr && emitted < limit &&
                corners == (int64_t(emitted) * total) / limit) {
                output[2 * emitted] = x;
                output[2 * emitted + 1] = y;
                ++emitted;
            }
            ++corners;
        }
        x = nx; y = ny;
        back = (direction + 6 - (direction & 1)) & 7;
        incoming = direction;
    }
    return -1; // Explicit failure rather than a partial/malformed polygon.
}

P4_HD inline void write_contour(const uint8_t* mask, int h, int w, int root,
                               int32_t* metadata, int32_t* points, int max_points) {
    const int total = walk_contour(mask, h, w, root, nullptr, 0, 0);
    metadata[0] = root;
    metadata[1] = total < max_points ? total : max_points;
    metadata[2] = total;
    if (total > 0 && walk_contour(mask, h, w, root, points, max_points, total) != total)
        metadata[2] = -1;
}
