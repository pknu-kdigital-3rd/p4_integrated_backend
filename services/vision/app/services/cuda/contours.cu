#include "contour_trace.h"

// Parent indices are local to each padded mask; links always decrease. This
// avoids cycles even when adjacent foreground edges are united concurrently.
__device__ int read_parent(int32_t* address) {
#if __CUDA_ARCH__ >= 700
    // An atomic relaxed load avoids a read-modify-write at the shared root of
    // a large background component. AtomicAdd(0) would serialize those reads.
    int value;
    asm volatile("ld.relaxed.gpu.b32 %0, [%1];" : "=r"(value) : "l"(address) : "memory");
    return value;
#else
    return atomicAdd(address, 0); // Older GPUs: native validation only.
#endif
}
__device__ int find_root(int32_t* parent, int index) {
    int next = read_parent(parent + index);
    while (next != index) {
        // Path halving keeps large background regions from developing long
        // raster-order chains while other edges are still being united.
        int grandparent = read_parent(parent + next);
        atomicMin(parent + index, grandparent);
        index = next;
        next = read_parent(parent + index);
    }
    return index;
}
__device__ void unite(int32_t* parent, int left, int right) {
    for (;;) {
        left = find_root(parent, left);
        right = find_root(parent, right);
        if (left == right) return;
        int high = left > right ? left : right;
        int low = left < right ? left : right;
        if (atomicCAS(parent + high, high, low) == high) return;
    }
}

extern "C" __global__ void initialize_parents(int32_t* parents, int32_t* counts,
                                            int32_t* errors, int32_t* metadata,
                                            int cells, int count, int components) {
    int index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < cells * count) parents[index] = index % cells;
    if (index < count) { counts[index] = 0; errors[index] = 0; }
    if (index < count * components * 3) metadata[index] = 0;
}
extern "C" __global__ void connect_pixels(const uint8_t* masks, int32_t* parents, int h, int w, int count) {
    int global = blockIdx.x * blockDim.x + threadIdx.x;
    int stride = w + 2, cells = (h + 2) * stride;
    if (global >= cells * count) return;
    int instance = global / cells, index = global % cells;
    int x = index % stride, y = index / stride;
    const uint8_t* mask = masks + instance * h * w;
    int32_t* parent = parents + instance * cells;
    bool value = padded_foreground(mask, h, w, index);
    if (x > 0 && padded_foreground(mask, h, w, index - 1) == value)
        unite(parent, index, index - 1);
    if (y > 0 && padded_foreground(mask, h, w, index - stride) == value)
        unite(parent, index, index - stride);
    if (value && y > 0) {
        if (x > 0 && padded_foreground(mask, h, w, index - stride - 1))
            unite(parent, index, index - stride - 1);
        if (x + 1 < stride && padded_foreground(mask, h, w, index - stride + 1))
            unite(parent, index, index - stride + 1);
    }
}
extern "C" __global__ void compress_parents(int32_t* parents, int cells, int count) {
    int global = blockIdx.x * blockDim.x + threadIdx.x;
    if (global >= cells * count) return;
    int32_t* parent = parents + global / cells * cells;
    atomicExch(parent + global % cells, find_root(parent, global % cells));
}
extern "C" __global__ void trace_external_contours(const uint8_t* masks, int32_t* parents,
                                      int32_t* counts, int32_t* metadata,
                                      int32_t* points, int32_t* errors,
                                      int h, int w, int count, int components, int max_points) {
    int global = blockIdx.x * blockDim.x + threadIdx.x;
    int stride = w + 2, cells = (h + 2) * stride;
    if (global >= cells * count) return;
    int instance = global / cells, root = global % cells;
    const uint8_t* mask = masks + instance * h * w;
    int32_t* parent = parents + instance * cells;
    if (parent[root] != root || !padded_foreground(mask, h, w, root)) return;
    // The smallest raster pixel starts an exterior contour iff its left
    // background belongs to the padded exterior (root zero). This excludes
    // holes and foreground islands enclosed inside those holes.
    if (parent[root - 1] != 0) return;
    int slot = atomicAdd(counts + instance, 1);
    if (slot >= components) { atomicMax(errors + instance, 1); return; }
    int offset = instance * components + slot;
    write_contour(mask, h, w, root, metadata + offset * 3,
                  points + offset * max_points * 2, max_points);
    if (metadata[offset * 3 + 2] < 0) atomicMax(errors + instance, 2);
}
