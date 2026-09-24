#!/usr/bin/env python3
"""Fixture checks for the privacy-safe SQLite /proc/locks observer."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time


ROOT = Path(__file__).resolve().parents[1]
OBSERVER = ROOT / "scripts" / "observe-sqlite-locks.py"


def proc_stat(pid: int, start_ticks: int) -> str:
    return f"{pid} (fixture) S " + " ".join(["0"] * 18 + [str(start_ticks)]) + "\n"


def lock_identity(path: Path) -> tuple[str, int]:
    stat = path.stat()
    return f"{os.major(stat.st_dev):x}:{os.minor(stat.st_dev):x}", stat.st_ino


def run_observer(
    db: Path,
    proc_root: Path,
    *extra: str,
    duration: str = "0.05",
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(OBSERVER),
            "--db",
            str(db),
            "--duration-seconds",
            duration,
            "--interval-ms",
            "10",
            "--proc-root",
            str(proc_root),
            *extra,
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=5,
        check=False,
        env={"PATH": os.environ.get("PATH", "")},
    )


def run_raw(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(OBSERVER), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=5,
        check=False,
        env={"PATH": os.environ.get("PATH", "")},
    )


def assert_private_cli_failure(
    result: subprocess.CompletedProcess[str],
    sentinel: str,
    expected_error: str,
) -> None:
    assert result.returncode == 2
    assert result.stdout == ""
    assert result.stderr == f"sqlite-lock-observer: {expected_error}\n"
    assert sentinel not in result.stdout
    assert sentinel not in result.stderr


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="hero-lock-observer-") as temp:
        base = Path(temp)
        db = base / "private-fixture-name.db"
        connection = sqlite3.connect(db)
        assert connection.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
        connection.execute("CREATE TABLE fixture(value INTEGER)")
        connection.commit()
        shm = Path(f"{db}-shm")
        assert shm.exists()

        proc_root = base / "proc"
        proc_root.mkdir()
        for pid, ticks in ((4321, 9001), (4322, 9002), (4323, 9003), (4324, 9004), (4325, 9005)):
            process_dir = proc_root / str(pid)
            process_dir.mkdir()
            (process_dir / "stat").write_text(proc_stat(pid, ticks), encoding="ascii")

        shm_device, shm_inode = lock_identity(shm)
        db_device, db_inode = lock_identity(db)
        lock_text = "\n".join(
            [
                f"1: POSIX ADVISORY WRITE 4321 {shm_device}:{shm_inode} 120 120",
                f"2: POSIX ADVISORY WRITE 4322 {shm_device}:{shm_inode} 121 121",
                f"3: POSIX ADVISORY READ 4323 {shm_device}:{shm_inode} 124 124",
                f"4: POSIX ADVISORY READ 4324 {db_device}:{db_inode} 1073741826 1073742335",
                f"5: POSIX ADVISORY READ 4325 {shm_device}:{shm_inode} 128 128",
            ]
        ) + "\n"
        (proc_root / "locks").write_text(lock_text, encoding="ascii")

        observed = run_observer(
            db,
            proc_root,
            "--pid-class",
            "4321=fixture-writer",
            "--pid-class",
            "4322=fixture-checkpointer",
            "--pid-class",
            "4323=fixture-reader",
        )
        assert observed.returncode == 0, observed.stderr
        records = [json.loads(line) for line in observed.stdout.splitlines()]
        events = [record for record in records if record["event"] == "lock"]
        assert {
            (event["pid"], event["target"], event["role"], event["mode"])
            for event in events
        } == {
            (4321, "wal-index", "write", "write"),
            (4322, "wal-index", "checkpoint", "write"),
            (4323, "wal-index", "read-slot-1", "read"),
            (4324, "database", "main-lock", "read"),
            (4325, "wal-index", "deadman-switch", "read"),
        }
        assert {(event["pid"], event["processClass"], event["pidStartTicks"]) for event in events} == {
            (4321, "fixture-writer", 9001),
            (4322, "fixture-checkpointer", 9002),
            (4323, "fixture-reader", 9003),
            (4324, "unknown", 9004),
            (4325, "unknown", 9005),
        }
        for event in events:
            assert event["firstObservedAtUtc"].endswith("Z")
            assert event["lastObservedAtUtc"].endswith("Z")
            assert 0 <= event["firstObservedElapsedMs"] <= event["lastObservedElapsedMs"]
            assert event["samples"] >= 1
        assert records[-1]["event"] == "summary"
        assert records[-1]["unsupported"] == 0
        assert records[-1]["startedAtUtc"].endswith("Z")
        assert records[-1]["endedAtUtc"].endswith("Z")
        assert records[-1]["observedElapsedMs"] >= 50
        assert "private-fixture-name" not in observed.stdout
        assert str(base) not in observed.stdout

        invalid_duration = "PRIVATE_DURATION_SENTINEL"
        assert_private_cli_failure(
            run_raw("--db", str(db), "--duration-seconds", invalid_duration),
            invalid_duration,
            "invalid command line",
        )
        invalid_interval = "PRIVATE_INTERVAL_SENTINEL"
        assert_private_cli_failure(
            run_raw(
                "--db", str(db),
                "--duration-seconds", "1",
                "--interval-ms", invalid_interval,
            ),
            invalid_interval,
            "invalid command line",
        )
        unknown_argument = "--PRIVATE_UNKNOWN_SENTINEL"
        assert_private_cli_failure(
            run_raw(
                "--db", str(db),
                "--duration-seconds", "1",
                unknown_argument,
            ),
            unknown_argument,
            "invalid command line",
        )
        missing_required = "PRIVATE_MISSING_SENTINEL"
        assert_private_cli_failure(
            run_raw("--pid-class", missing_required),
            missing_required,
            "invalid command line",
        )
        invalid_class = "4321=PRIVATE_CLASS_SENTINEL"
        assert_private_cli_failure(
            run_raw(
                "--db", str(db),
                "--duration-seconds", "1",
                "--proc-root", str(proc_root),
                "--pid-class", invalid_class,
            ),
            invalid_class,
            "invalid PID class mapping",
        )

        def interrupt_locks() -> None:
            time.sleep(0.10)
            (proc_root / "locks").write_text("", encoding="ascii")
            time.sleep(0.08)
            (proc_root / "locks").write_text(lock_text, encoding="ascii")

        interruption = threading.Thread(target=interrupt_locks)
        interruption.start()
        changed = run_observer(db, proc_root, duration="0.30")
        interruption.join()
        assert changed.returncode == 0, changed.stderr
        changed_records = [json.loads(line) for line in changed.stdout.splitlines()]
        writer_intervals = [
            record for record in changed_records
            if record.get("event") == "lock" and record.get("pid") == 4321 and record.get("role") == "write"
        ]
        assert len(writer_intervals) == 2, "a disappearance and reappearance must be two observed intervals"

        out_of_bounds = run_observer(db, proc_root, duration="301")
        assert out_of_bounds.returncode == 2
        assert out_of_bounds.stdout == ""
        assert out_of_bounds.stderr.strip() == "sqlite-lock-observer: observation bounds are invalid"

        (proc_root / "locks").write_text(
            f"1: FLOCK ADVISORY WRITE 4321 {shm_device}:{shm_inode} 0 EOF\n",
            encoding="ascii",
        )
        unsupported = run_observer(db, proc_root)
        assert unsupported.returncode == 2
        assert unsupported.stdout == ""
        assert unsupported.stderr.strip() == "sqlite-lock-observer: unsupported targeted lock record"

        connection.close()

        rollback_db = base / "rollback.db"
        rollback = sqlite3.connect(rollback_db)
        rollback.execute("CREATE TABLE fixture(value INTEGER)")
        rollback.commit()
        Path(f"{rollback_db}-shm").touch()
        non_wal = run_observer(rollback_db, proc_root)
        assert non_wal.returncode == 2
        assert non_wal.stdout == ""
        assert non_wal.stderr.strip() == "sqlite-lock-observer: database is not WAL mode"
        rollback.close()

    print("verify-sqlite-lock-observer: ALL PASS")


if __name__ == "__main__":
    main()
