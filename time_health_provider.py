#!/usr/bin/env python3
"""在 NAS 主机运行：把 chrony 的同步健康状态写成 Gateway 可读的 JSON。"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import argparse
from datetime import datetime, timezone
from pathlib import Path


MAX_SYNC_AGE_MS = 6 * 60 * 60 * 1000
MAX_ACCURACY_MS = 1000.0


def parse_chrony_tracking(output: str, now: datetime) -> tuple[bool, int, float]:
    fields: dict[str, str] = {}
    for line in output.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip()

    try:
        stratum = int(fields["Stratum"])
        leap_ok = fields["Leap status"].lower() == "normal"
        reference = datetime.strptime(
            fields["Ref time (UTC)"], "%a %b %d %H:%M:%S %Y"
        ).replace(tzinfo=timezone.utc)
        sync_age_ms = int((now - reference).total_seconds() * 1000)
        system_match = re.match(r"([-+0-9.eE]+) seconds", fields["System time"])
        rms_match = re.match(r"([-+0-9.eE]+) seconds", fields["RMS offset"])
        if not system_match or not rms_match:
            raise ValueError("chrony offset fields are unavailable")
        accuracy_ms = max(abs(float(system_match.group(1))), abs(float(rms_match.group(1)))) * 1000
        healthy = (leap_ok and 1 <= stratum <= 15 and
                   0 <= sync_age_ms <= MAX_SYNC_AGE_MS and
                   accuracy_ms <= MAX_ACCURACY_MS)
        return healthy, max(sync_age_ms, 0), accuracy_ms
    except (KeyError, ValueError, OverflowError):
        return False, MAX_SYNC_AGE_MS + 1, MAX_ACCURACY_MS + 1



def _duration_ms(value: str) -> float:
    match = re.search(r"([-+]?[0-9]+(?:\.[0-9]+)?)\s*(ns|us|µs|ms|s)\b", value)
    if not match:
        raise ValueError("time-sync duration is unavailable")
    amount = float(match.group(1))
    unit = match.group(2)
    scale = {"ns": 1e-6, "us": 1e-3, "µs": 1e-3, "ms": 1.0, "s": 1000.0}[unit]
    return amount * scale


def parse_systemd_timesync_status(
    output: str,
    now: datetime,
    last_sync: datetime,
    *,
    service_active: bool = True,
    synchronized: bool = True,
) -> tuple[bool, int, float]:
    fields: dict[str, str] = {}
    for line in output.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip().lower()] = value.strip()

    try:
        stratum = int(fields["stratum"])
        leap_ok = fields["leap"].lower() == "normal"
        server = fields["server"].strip().lower()
        sync_age_ms = int((now - last_sync).total_seconds() * 1000)
        root_distance_ms = _duration_ms(fields["root distance"])
        offset_ms = abs(_duration_ms(fields["offset"]))
        jitter_ms = _duration_ms(fields["jitter"])
        # Root distance 给出远端参考时钟的误差界；再加本机偏移和抖动作保守估计。
        accuracy_ms = root_distance_ms + offset_ms + jitter_ms
        healthy = (
            service_active
            and synchronized
            and server not in {"", "n/a", "none"}
            and leap_ok
            and 1 <= stratum <= 15
            and 0 <= sync_age_ms <= MAX_SYNC_AGE_MS
            and 0 <= root_distance_ms
            and 0 <= jitter_ms
            and accuracy_ms <= MAX_ACCURACY_MS
        )
        return healthy, max(sync_age_ms, 0), accuracy_ms
    except (KeyError, ValueError, OverflowError):
        return False, MAX_SYNC_AGE_MS + 1, MAX_ACCURACY_MS + 1


def systemd_timesync_sample() -> tuple[bool, int, float]:
    timedatectl = shutil.which("timedatectl")
    systemctl = shutil.which("systemctl")
    if not timedatectl or not systemctl:
        return False, MAX_SYNC_AGE_MS + 1, MAX_ACCURACY_MS + 1
    try:
        active = subprocess.run(
            [systemctl, "is-active", "systemd-timesyncd"],
            check=False, capture_output=True, text=True, timeout=3,
        ).stdout.strip() == "active"
        sync = subprocess.run(
            [timedatectl, "show", "--property=NTPSynchronized", "--value"],
            check=True, capture_output=True, text=True, timeout=3,
        ).stdout.strip().lower() == "yes"
        status = subprocess.run(
            [timedatectl, "timesync-status"],
            check=True, capture_output=True, text=True, timeout=3,
            env={**os.environ, "LC_ALL": "C"},
        ).stdout
        marker = Path(os.environ.get(
            "SYSTEMD_TIMESYNC_MARKER", "/run/systemd/timesync/synchronized"
        ))
        last_sync = datetime.fromtimestamp(marker.stat().st_mtime, timezone.utc)
        return parse_systemd_timesync_status(
            status, datetime.now(timezone.utc), last_sync,
            service_active=active, synchronized=sync,
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        return False, MAX_SYNC_AGE_MS + 1, MAX_ACCURACY_MS + 1

def next_sequence(path: Path) -> int:
    try:
        previous = json.loads(path.read_text(encoding="utf-8"))
        sequence = previous.get("sequence", 0)
        return sequence + 1 if isinstance(sequence, int) and sequence >= 0 else 1
    except (OSError, ValueError, AttributeError):
        return 1


def build_sample(path: Path) -> dict[str, object]:
    now = datetime.now(timezone.utc)
    synchronized = False
    sync_age_ms = MAX_SYNC_AGE_MS + 1
    accuracy_ms = MAX_ACCURACY_MS + 1
    chronyc = shutil.which("chronyc")
    if chronyc:
        try:
            result = subprocess.run(
                [chronyc, "tracking"], check=True, capture_output=True,
                text=True, timeout=3,
            )
            synchronized, sync_age_ms, accuracy_ms = parse_chrony_tracking(result.stdout, now)
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        synchronized, sync_age_ms, accuracy_ms = systemd_timesync_sample()
    return {
        "schemaVersion": 1,
        "sequence": next_sequence(path),
        "updatedAtUnixMs": int(time.time() * 1000),
        "utcMs": int(time.time() * 1000),
        "synchronized": synchronized,
        "syncAgeMs": sync_age_ms,
        "accuracyMs": accuracy_ms,
    }


def write_sample(path: Path) -> dict[str, object]:
    path.parent.mkdir(parents=True, exist_ok=True)
    sample = build_sample(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".time-health-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(sample, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return sample


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", default="data/time-health/time-health.json")
    parser.add_argument("--watch", action="store_true", help="持续运行并定期刷新健康文件")
    parser.add_argument("--interval-seconds", type=int, default=10)
    args = parser.parse_args()
    if args.interval_seconds < 1:
        parser.error("--interval-seconds must be positive")
    output = Path(args.output)
    while True:
        result = write_sample(output)
        print(json.dumps({"sequence": result["sequence"],
                          "synchronized": result["synchronized"]}), flush=True)
        if not args.watch:
            return
        time.sleep(args.interval_seconds)


if __name__ == "__main__":
    main()
