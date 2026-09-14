"""Validate QR decode logs against a recorded frame/IMU timeline.

This intentionally does not run YOLO.  It answers the first integration
question cheaply: can the Android QR timestamps be joined to the supplied
recording with enough coverage for metric distance estimation?

Example (run from the server directory)::

    python validate_monocular.py \
      --dataset-dir G:/project4_data/20260827_pknutrip_segments \
      --qr-log qr_decode_test_log.csv
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

from app.services.monocular import MonocularTimeline, QRResolver


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-dir", type=Path, required=True)
    parser.add_argument("--qr-log", type=Path, required=True)
    parser.add_argument("--calibration-file", type=Path)
    parser.add_argument("--qr-max-age-ms", type=float, default=200.0)
    parser.add_argument("--source-max-delta-ms", type=float, default=50.0)
    parser.add_argument("--imu-max-delta-ms", type=float, default=50.0)
    args = parser.parse_args()

    timeline = MonocularTimeline.load(args.dataset_dir, args.calibration_file)
    resolver = QRResolver(args.qr_max_age_ms)
    total = valid = stale = missing = joined = imu_missing = 0
    rewinds = 0
    last_epoch = 0
    with args.qr_log.open(newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            total += 1
            success = row.get("decode_success", "").strip().lower() == "true"
            source = row.get("decoded_value")
            source_ns = int(source) if success and source else None
            capture = row.get("capture_ts_elapsed_ns")
            capture_ns = int(capture) if capture else None
            seq = int(row.get("capture_index", total - 1))
            resolution = resolver.resolve(
                source_ns,
                capture_ns,
                decode_success=success and source_ns is not None,
                seq=seq,
            )
            if resolution.epoch != last_epoch:
                rewinds += 1
                last_epoch = resolution.epoch
            if resolution.status == "ok":
                valid += 1
            elif resolution.status == "qr_stale":
                stale += 1
            else:
                missing += 1
            if resolution.source_timestamp_ns is not None:
                match, status = timeline.lookup(
                    resolution.source_timestamp_ns,
                    max_frame_delta_ms=args.source_max_delta_ms,
                    max_imu_delta_ms=args.imu_max_delta_ms,
                )
                if match is not None:
                    joined += 1
                    if status == "imu_unavailable":
                        imu_missing += 1

    print(f"dataset={args.dataset_dir}")
    print(f"qr attempts={total}")
    print(f"direct valid={valid} ({valid / total:.1%})" if total else "direct valid=0")
    print(f"carried stale={stale}  missing={missing}  rewinds={rewinds}")
    print(f"dataset joins={joined} ({joined / total:.1%})" if total else "dataset joins=0")
    print(f"joins without IMU={imu_missing}")
    print(f"metric calibration={'available' if timeline.calibration else 'missing'}")


if __name__ == "__main__":
    main()
