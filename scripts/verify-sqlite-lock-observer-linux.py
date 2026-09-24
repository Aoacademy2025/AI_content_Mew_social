#!/usr/bin/env python3
"""Linux regression using disposable SQLite WAL reader/writer/checkpointer processes."""

from __future__ import annotations

import json
import multiprocessing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
OBSERVER = ROOT / "scripts" / "observe-sqlite-locks.py"


def hold_reader(db: str, ready: multiprocessing.connection.Connection, release: multiprocessing.synchronize.Event) -> None:
    connection = sqlite3.connect(f"file:{db}?mode=ro", uri=True, isolation_level=None)
    connection.execute("BEGIN")
    connection.execute("SELECT sum(value) FROM fixture").fetchone()
    ready.send(True)
    release.wait(10)
    connection.execute("ROLLBACK")
    connection.close()


def hold_writer(db: str, ready: multiprocessing.connection.Connection, release: multiprocessing.synchronize.Event) -> None:
    connection = sqlite3.connect(db, isolation_level=None)
    connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.execute("BEGIN IMMEDIATE")
    connection.execute("INSERT INTO fixture(value) VALUES (2)")
    ready.send(True)
    release.wait(10)
    connection.execute("COMMIT")
    connection.close()


def run_checkpoint(db: str, ready: multiprocessing.connection.Connection) -> None:
    connection = sqlite3.connect(db, isolation_level=None)
    connection.execute("PRAGMA busy_timeout=5000")
    ready.send(True)
    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    connection.close()


def observe(db: Path, classes: dict[int, str], seconds: str = "1.0") -> list[dict[str, object]]:
    args = [
        sys.executable,
        str(OBSERVER),
        "--db",
        str(db),
        "--duration-seconds",
        seconds,
        "--interval-ms",
        "10",
    ]
    for pid, process_class in classes.items():
        args.extend(["--pid-class", f"{pid}={process_class}"])
    result = subprocess.run(
        args,
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=5,
        check=False,
        env={"PATH": os.environ.get("PATH", "")},
    )
    assert result.returncode == 0, result.stderr
    return [json.loads(line) for line in result.stdout.splitlines()]


def has_lock(records: list[dict[str, object]], pid: int, role: str, mode: str) -> bool:
    return any(
        record.get("event") == "lock"
        and record.get("pid") == pid
        and record.get("role") == role
        and record.get("mode") == mode
        for record in records
    )


def has_read_slot(records: list[dict[str, object]], pid: int) -> bool:
    return any(
        record.get("event") == "lock"
        and record.get("pid") == pid
        and str(record.get("role", "")).startswith("read-slot-")
        and record.get("mode") == "read"
        for record in records
    )


def main() -> None:
    if not sys.platform.startswith("linux"):
        print("verify-sqlite-lock-observer-linux: SKIP (requires Linux /proc/locks)")
        return

    context = multiprocessing.get_context("fork")
    reader_release = context.Event()
    writer_release = context.Event()
    processes: list[multiprocessing.Process] = []
    try:
        with tempfile.TemporaryDirectory(prefix="hero-lock-linux-") as temp:
            db = Path(temp) / "fixture.db"
            keeper = sqlite3.connect(db, isolation_level=None)
            assert keeper.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
            keeper.execute("PRAGMA wal_autocheckpoint=0")
            keeper.execute("CREATE TABLE fixture(value INTEGER)")
            keeper.execute("INSERT INTO fixture(value) VALUES (1)")

            reader_ready_parent, reader_ready_child = context.Pipe(duplex=False)
            reader = context.Process(target=hold_reader, args=(str(db), reader_ready_child, reader_release))
            reader.start()
            processes.append(reader)
            assert reader_ready_parent.poll(3) and reader_ready_parent.recv()

            writer_ready_parent, writer_ready_child = context.Pipe(duplex=False)
            writer = context.Process(target=hold_writer, args=(str(db), writer_ready_child, writer_release))
            writer.start()
            processes.append(writer)
            assert writer_ready_parent.poll(3) and writer_ready_parent.recv()

            active = observe(db, {reader.pid: "fixture-reader", writer.pid: "fixture-writer"})
            assert has_lock(active, writer.pid, "write", "write"), "known writer did not own WAL_WRITE_LOCK"
            assert has_read_slot(active, reader.pid), "read-only holder lacked WAL reader lock"
            assert not has_lock(active, reader.pid, "write", "write"), "read-only holder was mislabeled as writer"

            writer_release.set()
            writer.join(3)
            assert writer.exitcode == 0

            checkpoint_ready_parent, checkpoint_ready_child = context.Pipe(duplex=False)
            checkpointer = context.Process(target=run_checkpoint, args=(str(db), checkpoint_ready_child))
            checkpointer.start()
            processes.append(checkpointer)
            assert checkpoint_ready_parent.poll(3) and checkpoint_ready_parent.recv()

            checkpoint = observe(db, {reader.pid: "fixture-reader", checkpointer.pid: "fixture-checkpointer"})
            assert has_lock(checkpoint, checkpointer.pid, "checkpoint", "write"), "known checkpoint lacked WAL_CKPT_LOCK"

            reader_release.set()
            reader.join(3)
            checkpointer.join(6)
            assert reader.exitcode == 0
            assert checkpointer.exitcode == 0
            keeper.close()
    finally:
        reader_release.set()
        writer_release.set()
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join()
    print("verify-sqlite-lock-observer-linux: ALL PASS")


if __name__ == "__main__":
    main()
