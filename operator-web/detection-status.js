// Detection summary shown under the live preview video. Categories group the
// model's COCO class names; every category is listed, even at zero, so the
// line keeps a stable shape while objects come and go.
export const DETECTION_CATEGORIES = [
  {label: '자동차', classes: ['car', 'bus', 'truck']},
  {label: '사람', classes: ['person']},
  {label: '오토바이', classes: ['motorcycle']},
];

/** Frames older than this no longer describe what is on screen. */
export const DETECTION_STALE_MS = 3000;

/** Counts one frame's detections per category from a {className: count} map. */
export function countDetections(classCounts) {
  const counts = {};
  for (const {label, classes} of DETECTION_CATEGORIES) {
    counts[label] = classes.reduce((sum, name) => {
      const value = Number(classCounts?.[name] ?? 0);
      return sum + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0);
  }
  return counts;
}

/** The status line text, e.g. "YOLO 객체 탐지 중 · 자동차 3 | 사람 1 | 오토바이 0". */
export function describeDetections(classCounts, receivedAt, now) {
  if (classCounts == null || !Number.isFinite(receivedAt)) return 'YOLO 객체 탐지 대기 중';
  if (now - receivedAt > DETECTION_STALE_MS) return 'YOLO 객체 탐지 · 영상 수신 대기 중';
  const counts = countDetections(classCounts);
  return `YOLO 객체 탐지 중 · ${DETECTION_CATEGORIES.map(({label}) => `${label} ${counts[label]}`).join(' | ')}`;
}
