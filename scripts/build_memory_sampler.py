#!/usr/bin/env python3
"""Bounded Linux build-process memory sampler."""

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Set, Tuple


MAX_PROC_FILE_BYTES = 1024 * 1024
MAX_LOG_READ_BYTES = 1024 * 1024
MEMORY_FIELDS = {
    "Rss": "rss_kib",
    "Pss": "pss_kib",
    "Private_Clean": "private_clean_kib",
    "Private_Dirty": "private_dirty_kib",
    "Shared_Clean": "shared_clean_kib",
    "Shared_Dirty": "shared_dirty_kib",
    "Swap": "swap_kib",
}
STAGES = {
    "unknown",
    "webpack",
    "typescript",
    "page-data",
    "static-generation",
    "optimization",
    "tracing",
    "complete",
}
FINAL_RECORD_RESERVE = 3072
STAGE_MARKERS = (
    ("webpack", (b"creating an optimized production build", b"compiled successfully")),
    ("typescript", (b"running typescript", b"checking validity of types")),
    ("page-data", (b"collecting page data",)),
    ("static-generation", (b"generating static pages",)),
    ("optimization", (b"finalizing page optimization",)),
    ("tracing", (b"collecting build traces",)),
    ("complete", (b"build completed", b"deployment complete")),
)
DEFAULT_MAX_SECONDS = 1800.0
HARD_MAX_SECONDS = 7200.0
DEFAULT_MAX_BYTES = 64 * 1024 * 1024
HARD_MAX_BYTES = 256 * 1024 * 1024


class RootProcessExited(RuntimeError):
    pass


class RootPidReused(RuntimeError):
    pass


class InvalidArguments(RuntimeError):
    pass


class PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        raise InvalidArguments()


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    starttime_ticks: int


@dataclass(frozen=True)
class ProcessStat:
    pid: int
    ppid: int
    starttime_ticks: int


class BoundedJsonl:
    def __init__(self, path: Path, max_bytes: int) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(str(path), flags, 0o600)
        os.fchmod(descriptor, 0o600)
        self._file = os.fdopen(descriptor, "wb")
        self.max_bytes = max_bytes
        self.bytes_written = 0

    def __enter__(self) -> "BoundedJsonl":
        return self

    def __exit__(self, *_args: object) -> None:
        self._file.close()

    def write(self, record: Dict[str, object], reserve: int = 0) -> bool:
        encoded = (json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n").encode(
            "utf-8"
        )
        if self.bytes_written + len(encoded) + reserve > self.max_bytes:
            return False
        self._file.write(encoded)
        self._file.flush()
        self.bytes_written += len(encoded)
        return True


class StageTracker:
    def __init__(self, path: Optional[Path]) -> None:
        self.path = path
        self.stage = "unknown"
        self.offset = 0
        self.inode: Optional[int] = None
        self.carry = b""

    def current(self) -> str:
        if self.path is None:
            return self.stage
        try:
            file_stat = self.path.stat()
            if self.inode != file_stat.st_ino or file_stat.st_size < self.offset:
                self.inode = file_stat.st_ino
                self.offset = 0
                self.carry = b""
            with self.path.open("rb") as source:
                source.seek(self.offset)
                chunk = source.read(MAX_LOG_READ_BYTES)
                self.offset = source.tell()
        except (FileNotFoundError, PermissionError, OSError):
            return self.stage
        searchable = (self.carry + chunk).lower()
        self.carry = searchable[-256:]
        current_index = next(
            (index for index, item in enumerate(STAGE_MARKERS) if item[0] == self.stage), -1
        )
        matches = []
        for index, (stage, markers) in enumerate(STAGE_MARKERS):
            for marker in markers:
                position = searchable.find(marker)
                if position >= 0:
                    matches.append((position, index, stage))
        for _position, index, stage in sorted(matches):
            if index >= current_index:
                self.stage = stage
                current_index = index
        return self.stage


def _read_limited(path: Path) -> bytes:
    with path.open("rb") as source:
        return source.read(MAX_PROC_FILE_BYTES)


def _parse_stat(raw: str) -> ProcessStat:
    closing = raw.rfind(")")
    if closing < 0:
        raise ValueError("invalid proc stat")
    pid = int(raw[: raw.index(" ")])
    fields = raw[closing + 2 :].split()
    if len(fields) < 20:
        raise ValueError("short proc stat")
    return ProcessStat(pid=pid, ppid=int(fields[1]), starttime_ticks=int(fields[19]))


def _read_stat(proc_root: Path, pid: int) -> ProcessStat:
    return _parse_stat(_read_limited(proc_root / str(pid) / "stat").decode("ascii"))


def _snapshot_stats(proc_root: Path) -> Dict[int, ProcessStat]:
    stats = {}
    for directory in proc_root.iterdir():
        if not directory.name.isdigit():
            continue
        try:
            stat = _read_stat(proc_root, int(directory.name))
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError, OSError):
            continue
        stats[stat.pid] = stat
    return stats


def _descendants(stats: Dict[int, ProcessStat], root_pid: int) -> Set[int]:
    selected = {root_pid}
    changed = True
    while changed:
        changed = False
        for stat in stats.values():
            if stat.pid not in selected and stat.ppid in selected:
                selected.add(stat.pid)
                changed = True
    return selected


def _cmdline(proc_root: Path, pid: int) -> List[str]:
    try:
        return [
            value.decode("utf-8", "replace")
            for value in _read_limited(proc_root / str(pid) / "cmdline").split(b"\0")
            if value
        ]
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        return []


def _role(arguments: List[str], is_root: bool) -> str:
    if is_root:
        return "deploy-shell"
    joined = " ".join(arguments).lower()
    executable = Path(arguments[0]).name.lower() if arguments else ""
    if "processchild.js" in joined:
        return "webpack-compiler"
    if (
        executable in {"npm", "npm-cli.js", "pnpm", "yarn"} and "build" in joined
    ) or "scripts/build.js" in joined:
        return "npm-build-wrapper"
    if "next" in joined and "build" in joined:
        return "next-build"
    if "/next/" in joined and "worker" in joined:
        return "next-worker"
    return "unclassified"


def _compiler_details(proc_root: Path, pid: int) -> Tuple[Optional[str], Optional[int]]:
    try:
        entries = _read_limited(proc_root / str(pid) / "environ").split(b"\0")
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        return None, None
    node_options = b""
    profile = b""
    for entry in entries:
        if entry.startswith(b"NODE_OPTIONS="):
            node_options = entry[len(b"NODE_OPTIONS=") :]
        elif entry.startswith(b"__NEXT_PRIVATE_CPU_PROFILE="):
            profile = entry[len(b"__NEXT_PRIVATE_CPU_PROFILE=") :]
    target_match = re.search(
        rb"build-webpack-(server|edge-server|client)(?:[-.]|$)", profile
    )
    heap_matches = re.findall(rb"--max-old-space-size(?:=|\s+)(\d+)", node_options)
    target = target_match.group(1).decode("ascii") if target_match else None
    heap = int(heap_matches[-1]) if heap_matches else None
    return target, heap


def _memory(proc_root: Path, pid: int) -> Optional[Dict[str, Optional[int]]]:
    try:
        raw = _read_limited(proc_root / str(pid) / "smaps_rollup").decode("ascii")
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError, UnicodeDecodeError):
        return None
    parsed: Dict[str, int] = {}
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].rstrip(":") in MEMORY_FIELDS:
            try:
                parsed[parts[0].rstrip(":")] = int(parts[1])
            except ValueError:
                pass
    return {output: parsed.get(source) for source, output in MEMORY_FIELDS.items()}


def _host_memory(proc_root: Path) -> Dict[str, Optional[int]]:
    wanted = {
        "MemAvailable": "mem_available_kib",
        "SwapFree": "swap_free_kib",
        "SwapTotal": "swap_total_kib",
    }
    result: Dict[str, Optional[int]] = {value: None for value in wanted.values()}
    try:
        raw = _read_limited(proc_root / "meminfo").decode("ascii")
    except (FileNotFoundError, PermissionError, OSError, UnicodeDecodeError):
        return result
    for line in raw.splitlines():
        parts = line.split()
        key = parts[0].rstrip(":") if parts else ""
        if key in wanted and len(parts) >= 2:
            try:
                result[wanted[key]] = int(parts[1])
            except ValueError:
                pass
    return result


def collect_sample(proc_root: Path, root: ProcessIdentity, stage: str) -> Dict[str, object]:
    if stage not in STAGES:
        raise ValueError("stage is not allowlisted")
    stats = _snapshot_stats(proc_root)
    current_root = stats.get(root.pid)
    if current_root is None:
        raise RootProcessExited()
    if current_root.starttime_ticks != root.starttime_ticks:
        raise RootPidReused()

    processes = []
    for pid in sorted(_descendants(stats, root.pid)):
        stat = stats[pid]
        arguments = _cmdline(proc_root, pid)
        role = _role(arguments, pid == root.pid)
        compiler_target = None
        heap_mib = None
        if role == "webpack-compiler":
            compiler_target, heap_mib = _compiler_details(proc_root, pid)
        memory = _memory(proc_root, pid)
        status = "ok" if memory is not None else "exited_during_sample"
        try:
            confirmed = _read_stat(proc_root, pid)
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError, OSError):
            confirmed = None
        if confirmed is None:
            if pid == root.pid:
                raise RootProcessExited()
            status = "exited_during_sample"
            memory = None
        elif confirmed.starttime_ticks != stat.starttime_ticks:
            if pid == root.pid:
                raise RootPidReused()
            status = "pid_reused_during_sample"
            memory = None
        processes.append(
            {
                "pid": pid,
                "ppid": stat.ppid,
                "starttime_ticks": stat.starttime_ticks,
                "role": role,
                "status": status,
                "compiler_target": compiler_target,
                "effective_max_old_space_size_mib": heap_mib,
                "memory_kib": memory,
            }
        )

    totals = {
        name: 0
        for name in ("rss_kib", "pss_kib", "private_kib", "shared_kib", "swap_kib")
    }
    incomplete = 0
    for process in processes:
        memory = process["memory_kib"]
        if memory is None:
            incomplete += 1
            continue
        totals["rss_kib"] += memory["rss_kib"] or 0
        totals["pss_kib"] += memory["pss_kib"] or 0
        totals["private_kib"] += (memory["private_clean_kib"] or 0) + (
            memory["private_dirty_kib"] or 0
        )
        totals["shared_kib"] += (memory["shared_clean_kib"] or 0) + (
            memory["shared_dirty_kib"] or 0
        )
        totals["swap_kib"] += memory["swap_kib"] or 0
    if incomplete:
        for name in tuple(totals):
            totals[name] = None
    totals["incomplete_processes"] = incomplete

    return {
        "type": "sample",
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "stage": stage,
        "root": {"pid": root.pid, "starttime_ticks": root.starttime_ticks},
        "host": _host_memory(proc_root),
        "tree": totals,
        "processes": processes,
    }


def run_sampler(
    proc_root: Path,
    root_pid: int,
    output_path: Path,
    *,
    log_path: Optional[Path] = None,
    interval_seconds: float,
    max_seconds: float,
    max_bytes: int,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> None:
    if interval_seconds <= 0 or max_seconds <= 0 or max_bytes < 4096:
        raise ValueError("invalid sampler bounds")
    initial = _read_stat(proc_root, root_pid)
    root = ProcessIdentity(root_pid, initial.starttime_ticks)
    started = monotonic()
    samples = 0
    stop_reason = "max_duration"
    peak_names = ("rss_kib", "pss_kib", "private_kib", "swap_kib")
    peaks: Dict[str, Dict[str, object]] = {}
    process_peaks: Dict[Tuple[int, int], Dict[str, object]] = {}
    baseline_available: Optional[int] = None
    minimum_available: Optional[Dict[str, object]] = None
    stages = StageTracker(log_path)

    with BoundedJsonl(output_path, max_bytes) as output:
        output.write(
            {
                "type": "metadata",
                "schema_version": 1,
                "root": {"pid": root.pid, "starttime_ticks": root.starttime_ticks},
                "interval_seconds": interval_seconds,
                "max_seconds": max_seconds,
                "max_bytes": max_bytes,
            },
            FINAL_RECORD_RESERVE,
        )
        while True:
            try:
                sample = collect_sample(proc_root, root, stages.current())
            except RootProcessExited:
                stop_reason = "root_exited"
                break
            except RootPidReused:
                stop_reason = "root_pid_reused"
                break
            if not output.write(sample, FINAL_RECORD_RESERVE):
                stop_reason = "output_limit"
                break
            samples += 1
            timestamp = sample["timestamp"]
            stage = sample["stage"]
            tree = sample["tree"]
            for name in peak_names:
                value = tree[name]
                key = "tree_" + name
                if value is None:
                    continue
                if key not in peaks or value > peaks[key]["value_kib"]:
                    peaks[key] = {"value_kib": value, "timestamp": timestamp, "stage": stage}
            available = sample["host"]["mem_available_kib"]
            if available is not None:
                if baseline_available is None:
                    baseline_available = available
                if minimum_available is None or available < minimum_available["value_kib"]:
                    minimum_available = {
                        "value_kib": available,
                        "timestamp": timestamp,
                        "stage": stage,
                    }
            for process in sample["processes"]:
                memory = process["memory_kib"]
                if memory is None or memory["pss_kib"] is None:
                    continue
                key = (process["pid"], process["starttime_ticks"])
                previous = process_peaks.get(key)
                if previous is None or memory["pss_kib"] > previous["peak_pss_kib"]:
                    process_peaks[key] = {
                        "pid": process["pid"],
                        "starttime_ticks": process["starttime_ticks"],
                        "role": process["role"],
                        "peak_pss_kib": memory["pss_kib"],
                        "timestamp": timestamp,
                        "stage": stage,
                    }
            elapsed = monotonic() - started
            if elapsed >= max_seconds:
                break
            sleep(min(interval_seconds, max_seconds - elapsed))
        host_summary: Dict[str, object] = {
            "baseline_mem_available_kib": baseline_available,
            "minimum_mem_available_kib": minimum_available,
            "mem_available_drop_kib": None,
        }
        if baseline_available is not None and minimum_available is not None:
            host_summary["mem_available_drop_kib"] = (
                baseline_available - minimum_available["value_kib"]
            )
        output.write(
            {
                "type": "summary",
                "stop_reason": stop_reason,
                "samples": samples,
                "elapsed_seconds": round(monotonic() - started, 3),
                "peaks": peaks,
                "host": host_summary,
                "top_processes_by_pss": sorted(
                    process_peaks.values(), key=lambda item: item["peak_pss_kib"], reverse=True
                )[:10],
            }
        )


def _arguments(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = PrivateArgumentParser(
        description="Sample an opt-in Linux build process tree into private JSONL."
    )
    parser.add_argument("--root-pid", required=True, type=int, help="deploy shell PID")
    parser.add_argument("--output", required=True, type=Path, help="new JSONL output path")
    parser.add_argument("--log-path", type=Path, help="optional build log used only for fixed stage markers")
    parser.add_argument("--proc-root", type=Path, default=Path("/proc"), help=argparse.SUPPRESS)
    parser.add_argument("--interval-seconds", type=float, default=1.0)
    parser.add_argument("--max-seconds", type=float, default=DEFAULT_MAX_SECONDS)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    arguments = parser.parse_args(argv)
    if arguments.root_pid <= 0:
        parser.error("--root-pid must be positive")
    if not 0.05 <= arguments.interval_seconds <= 60:
        parser.error("--interval-seconds must be between 0.05 and 60")
    if not 0.05 <= arguments.max_seconds <= HARD_MAX_SECONDS:
        parser.error("--max-seconds exceeds the allowed bound")
    if not 4096 <= arguments.max_bytes <= HARD_MAX_BYTES:
        parser.error("--max-bytes exceeds the allowed bound")
    return arguments


def main(argv: Optional[List[str]] = None) -> int:
    try:
        arguments = _arguments(argv)
    except InvalidArguments:
        print("sampler error: invalid arguments", file=sys.stderr)
        return 2
    if arguments.proc_root == Path("/proc") and not sys.platform.startswith("linux"):
        print("sampler error: /proc sampling requires Linux", file=sys.stderr)
        return 2
    try:
        run_sampler(
            arguments.proc_root,
            arguments.root_pid,
            arguments.output,
            log_path=arguments.log_path,
            interval_seconds=arguments.interval_seconds,
            max_seconds=arguments.max_seconds,
            max_bytes=arguments.max_bytes,
        )
    except FileExistsError:
        print("sampler error: output already exists", file=sys.stderr)
        return 2
    except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError, OSError):
        print("sampler error: unable to start or persist sampling", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
