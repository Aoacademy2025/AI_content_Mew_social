#!/usr/bin/env python3
"""Bounded, read-only Linux observer for SQLite WAL byte-range locks.

Output contains only numeric lock evidence and fixed process-class/role labels.
A WAL lock identifies an OS process, not the process's business operation.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time


WAL_LOCK_OFFSET = 120
WAL_INDEX_LOCK_LAST = 127
UNIX_SHM_DMS = 128
PENDING_BYTE = 1_073_741_824
SHARED_LOCK_LAST = 1_073_742_335
MAX_EVENTS = 1_000
PROCESS_CLASSES = {
    "ai-content",
    "cleanup-videos",
    "db-backup",
    "disk-watch",
    "founding-sweep",
    "fixture-checkpointer",
    "fixture-reader",
    "fixture-writer",
    "media-cleanup",
    "mcp-video-worker",
    "mine-loanwords",
    "north-star-snapshot",
    "reconcile-ai-images",
    "reconcile-processing",
    "renewal-reminders",
    "render-worker",
    "runpod-image-cost-sync",
    "story-film-system-worker",
    "trial-expiry",
    "trial-reminders",
}
LOCK_LINE = re.compile(
    r"^\s*\d+:\s+(?:(->)\s+)?(\S+)\s+(\S+)\s+(\S+)\s+(-?\d+)\s+"
    r"([0-9a-fA-F]+):([0-9a-fA-F]+):(\d+)\s+(\d+|EOF)\s+(\d+|EOF)\s*$"
)
LOCK_IDENTITY = re.compile(r"(?<!\S)([0-9a-fA-F]+):([0-9a-fA-F]+):(\d+)(?=\s)")


class ObserverError(Exception):
    pass


class FixedErrorArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        raise ObserverError("invalid command line")


@dataclass(frozen=True)
class FileIdentity:
    major: int
    minor: int
    inode: int


@dataclass(frozen=True)
class ProcessClass:
    name: str
    start_ticks: int


def file_identity(path: Path) -> FileIdentity:
    try:
        stat = path.stat()
    except OSError as error:
        raise ObserverError("database lock target unavailable") from error
    return FileIdentity(os.major(stat.st_dev), os.minor(stat.st_dev), stat.st_ino)


def require_wal_database(path: Path) -> None:
    try:
        with path.open("rb") as database:
            header = database.read(20)
    except OSError as error:
        raise ObserverError("database lock target unavailable") from error
    if len(header) < 20 or header[:16] != b"SQLite format 3\x00":
        raise ObserverError("invalid SQLite database header")
    if header[18:20] != b"\x02\x02":
        raise ObserverError("database is not WAL mode")


def read_start_ticks(proc_root: Path, pid: int) -> int:
    try:
        stat_line = (proc_root / str(pid) / "stat").read_text(encoding="ascii")
    except (OSError, UnicodeError) as error:
        raise ObserverError("process identity unavailable") from error
    closing_parenthesis = stat_line.rfind(")")
    fields = stat_line[closing_parenthesis + 1:].split() if closing_parenthesis >= 0 else []
    if len(fields) < 20:
        raise ObserverError("unsupported process stat format")
    try:
        start_ticks = int(fields[19])
    except ValueError as error:
        raise ObserverError("unsupported process stat format") from error
    if start_ticks < 0:
        raise ObserverError("unsupported process stat format")
    return start_ticks


def parse_pid_classes(values: list[str], proc_root: Path) -> dict[int, ProcessClass]:
    result: dict[int, ProcessClass] = {}
    for value in values:
        pid_text, separator, process_class = value.partition("=")
        if not separator or not pid_text.isdecimal() or process_class not in PROCESS_CLASSES:
            raise ObserverError("invalid PID class mapping")
        pid = int(pid_text)
        if pid <= 0 or pid in result:
            raise ObserverError("invalid PID class mapping")
        result[pid] = ProcessClass(process_class, read_start_ticks(proc_root, pid))
    return result


def targeted_identity(line: str, targets: dict[FileIdentity, str]) -> FileIdentity | None:
    match = LOCK_IDENTITY.search(line)
    if not match:
        return None
    identity = FileIdentity(int(match[1], 16), int(match[2], 16), int(match[3]))
    return identity if identity in targets else None


def process_fields(
    proc_root: Path,
    pid: int,
    classes: dict[int, ProcessClass],
) -> tuple[str, int]:
    start_ticks = read_start_ticks(proc_root, pid)
    mapped = classes.get(pid)
    if mapped is None:
        return "unknown", start_ticks
    if mapped.start_ticks != start_ticks:
        raise ObserverError("mapped PID identity changed")
    return mapped.name, start_ticks


def lock_events(
    line: str,
    targets: dict[FileIdentity, str],
    proc_root: Path,
    classes: dict[int, ProcessClass],
) -> list[dict[str, object]]:
    identity = targeted_identity(line, targets)
    if identity is None:
        return []

    match = LOCK_LINE.fullmatch(line)
    if match is None:
        raise ObserverError("unsupported targeted lock record")
    blocked, lock_type, advisory, mode, pid_text, major, minor, inode, start_text, end_text = match.groups()
    parsed_identity = FileIdentity(int(major, 16), int(minor, 16), int(inode))
    if parsed_identity != identity:
        raise ObserverError("unsupported targeted lock record")
    if (
        blocked is not None
        or lock_type != "POSIX"
        or advisory != "ADVISORY"
        or mode not in {"READ", "WRITE"}
        or int(pid_text) <= 0
        or start_text == "EOF"
        or end_text == "EOF"
    ):
        raise ObserverError("unsupported targeted lock record")

    pid = int(pid_text)
    start = int(start_text)
    end = int(end_text)
    if end < start:
        raise ObserverError("unsupported targeted lock record")
    process_class, start_ticks = process_fields(proc_root, pid, classes)
    common = {
        "event": "lock",
        "mode": mode.lower(),
        "pid": pid,
        "pidStartTicks": start_ticks,
        "processClass": process_class,
    }

    target = targets[identity]
    if target == "database":
        if start < PENDING_BYTE or end > SHARED_LOCK_LAST:
            raise ObserverError("unsupported SQLite database lock range")
        return [{
            **common,
            "target": "database",
            "role": "main-lock",
            "byteStart": start,
            "byteEnd": end,
        }]

    if start < WAL_LOCK_OFFSET or end > UNIX_SHM_DMS:
        raise ObserverError("unsupported SQLite WAL lock range")
    events: list[dict[str, object]] = []
    for byte in range(start, end + 1):
        if byte == 120:
            role = "write"
            if mode != "WRITE":
                raise ObserverError("unsupported SQLite WAL lock mode")
        elif byte == 121:
            role = "checkpoint"
            if mode != "WRITE":
                raise ObserverError("unsupported SQLite WAL lock mode")
        elif byte == 122:
            role = "recovery"
            if mode != "WRITE":
                raise ObserverError("unsupported SQLite WAL lock mode")
        elif byte <= WAL_INDEX_LOCK_LAST:
            role = f"read-slot-{byte - 123}"
        else:
            # SQLite's Unix VFS holds this deadman-switch byte while the
            # shared-memory file is live. It is not a transaction lock.
            role = "deadman-switch"
        events.append({
            **common,
            "target": "wal-index",
            "role": role,
            "byteStart": byte,
            "byteEnd": byte,
        })
    return events


def snapshot(
    proc_root: Path,
    targets: dict[FileIdentity, str],
    classes: dict[int, ProcessClass],
) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    try:
        with (proc_root / "locks").open(encoding="ascii") as locks:
            for line in locks:
                parsed = lock_events(line.rstrip("\n"), targets, proc_root, classes)
                if len(events) + len(parsed) > MAX_EVENTS:
                    raise ObserverError("observation event limit exceeded")
                events.extend(parsed)
    except (OSError, UnicodeError) as error:
        raise ObserverError("proc locks unavailable") from error
    return events


def observe(args: argparse.Namespace) -> list[dict[str, object]]:
    database = Path(args.db)
    shm = Path(f"{database}-shm")
    proc_root = Path(args.proc_root)
    if proc_root == Path("/proc") and not sys.platform.startswith("linux"):
        raise ObserverError("Linux /proc is required")
    require_wal_database(database)
    database_identity = file_identity(database)
    shm_identity = file_identity(shm)
    targets = {database_identity: "database", shm_identity: "wal-index"}
    if len(targets) != 2:
        raise ObserverError("database lock targets are not distinct")
    classes = parse_pid_classes(args.pid_class, proc_root)

    duration = args.duration_seconds
    interval = args.interval_ms / 1_000
    if not 0.01 <= duration <= 300 or not 10 <= args.interval_ms <= 10_000:
        raise ObserverError("observation bounds are invalid")

    started_monotonic = time.monotonic()
    started_utc = datetime.now(timezone.utc)
    deadline = started_monotonic + duration
    active: dict[tuple[object, ...], dict[str, object]] = {}
    records: list[dict[str, object]] = []
    samples = 0
    while True:
        if file_identity(database) != database_identity or file_identity(shm) != shm_identity:
            raise ObserverError("database lock target identity changed")
        samples += 1
        observed_monotonic = time.monotonic()
        observed_utc = datetime.now(timezone.utc)
        elapsed_ms = round((observed_monotonic - started_monotonic) * 1_000)
        utc_text = observed_utc.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        sampled_events = snapshot(proc_root, targets, classes)
        if file_identity(database) != database_identity or file_identity(shm) != shm_identity:
            raise ObserverError("database lock target identity changed")
        current: dict[tuple[object, ...], dict[str, object]] = {}
        for event in sampled_events:
            key = (
                event["pid"],
                event["pidStartTicks"],
                event["target"],
                event["role"],
                event["mode"],
                event["byteStart"],
                event["byteEnd"],
            )
            current[key] = event
        for key in active.keys() - current.keys():
            records.append(active.pop(key))
            if len(records) > MAX_EVENTS:
                raise ObserverError("observation event limit exceeded")
        for key, event in current.items():
            interval_record = active.get(key)
            if interval_record is None:
                if len(records) + len(active) >= MAX_EVENTS:
                    raise ObserverError("observation event limit exceeded")
                active[key] = {
                    **event,
                    "firstObservedAtUtc": utc_text,
                    "firstObservedElapsedMs": elapsed_ms,
                    "lastObservedAtUtc": utc_text,
                    "lastObservedElapsedMs": elapsed_ms,
                    "samples": 1,
                }
            else:
                interval_record["lastObservedAtUtc"] = utc_text
                interval_record["lastObservedElapsedMs"] = elapsed_ms
                interval_record["samples"] = int(interval_record["samples"]) + 1
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(interval, remaining))

    records.extend(active.values())
    if len(records) > MAX_EVENTS:
        raise ObserverError("observation event limit exceeded")
    ended_monotonic = time.monotonic()
    ended_utc = datetime.now(timezone.utc)
    records.append({
        "event": "summary",
        "events": len(records),
        "samples": samples,
        "startedAtUtc": started_utc.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "endedAtUtc": ended_utc.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "observedElapsedMs": round((ended_monotonic - started_monotonic) * 1_000),
        "unsupported": 0,
    })
    return records


def parser() -> argparse.ArgumentParser:
    result = FixedErrorArgumentParser(description="Observe SQLite WAL locks without reading SQL or process command lines.")
    result.add_argument("--db", required=True)
    result.add_argument("--duration-seconds", required=True, type=float)
    result.add_argument("--interval-ms", type=int, default=100)
    result.add_argument("--pid-class", action="append", default=[], metavar="PID=CLASS")
    result.add_argument("--proc-root", default="/proc", help=argparse.SUPPRESS)
    return result


def main() -> int:
    try:
        args = parser().parse_args()
        records = observe(args)
    except ObserverError as error:
        print(f"sqlite-lock-observer: {error}", file=sys.stderr)
        return 2
    except (OSError, ValueError):
        print("sqlite-lock-observer: observer input unavailable", file=sys.stderr)
        return 2
    except Exception:
        # Never leak a raw traceback, input path, or proc record from a
        # diagnostic failure. Unsupported observations are evidence-free.
        print("sqlite-lock-observer: observer failed closed", file=sys.stderr)
        return 2
    for record in records:
        print(json.dumps(record, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
