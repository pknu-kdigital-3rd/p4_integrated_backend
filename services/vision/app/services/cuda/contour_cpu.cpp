// CPU validation harness for the shared native contour walker. Production
// GPU mode never calls this function; it exists to test geometry without CUDA.
#include <vector>
#include "contour_trace.h"

#ifdef _WIN32
#define P4_EXPORT __declspec(dllexport)
#else
#define P4_EXPORT
#endif

static int root_of(std::vector<int>& parents, int index) {
    while (parents[index] != index) index = parents[index];
    return index;
}
static void join(std::vector<int>& parents, int a, int b) {
    a = root_of(parents, a); b = root_of(parents, b);
    if (a > b) parents[a] = b;
    else if (b > a) parents[b] = a;
}

extern "C" P4_EXPORT void p4_trace_cpu(const uint8_t* masks, int32_t* counts,
                                      int32_t* metadata, int32_t* points, int32_t* errors,
                                      int count, int h, int w, int components, int max_points) {
    int stride = w + 2, cells = (h + 2) * stride;
    for (int n = 0; n < count; ++n) {
        const uint8_t* mask = masks + n * h * w;
        std::vector<int> parents(cells);
        for (int i = 0; i < cells; ++i) parents[i] = i;
        for (int i = 0; i < cells; ++i) {
            int x = i % stride, y = i / stride;
            bool value = padded_foreground(mask, h, w, i);
            if (x > 0 && padded_foreground(mask, h, w, i - 1) == value) join(parents, i, i - 1);
            if (y > 0 && padded_foreground(mask, h, w, i - stride) == value) join(parents, i, i - stride);
            if (value && y > 0) {
                if (x > 0 && padded_foreground(mask, h, w, i - stride - 1)) join(parents, i, i - stride - 1);
                if (x + 1 < stride && padded_foreground(mask, h, w, i - stride + 1)) join(parents, i, i - stride + 1);
            }
        }
        for (int i = 0; i < cells; ++i) parents[i] = root_of(parents, i);
        counts[n] = 0; errors[n] = 0;
        for (int i = 0; i < cells; ++i) {
            if (parents[i] != i || !padded_foreground(mask, h, w, i) || parents[i - 1] != 0) continue;
            int slot = counts[n]++;
            if (slot >= components) { errors[n] = 1; continue; }
            int offset = n * components + slot;
            write_contour(mask, h, w, i, metadata + offset * 3,
                          points + offset * max_points * 2, max_points);
            if (metadata[offset * 3 + 2] < 0) errors[n] = 2;
        }
    }
}
