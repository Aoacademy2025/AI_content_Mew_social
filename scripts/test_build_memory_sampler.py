import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from scripts import build_memory_sampler


def stat_line(pid: int, ppid: int, starttime: int, name: str = "node worker") -> str:
    fields = ["S", str(ppid)] + ["0"] * 17 + [str(starttime)] + ["0"] * 30
    return f"{pid} ({name}) " + " ".join(fields) + "\n"


class ProcFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        (root / "meminfo").write_text(
            "MemTotal: 32000000 kB\n"
            "MemAvailable: 24000000 kB\n"
            "SwapTotal: 8000000 kB\n"
            "SwapFree: 7000000 kB\n"
        )

    def add_process(
        self,
        pid: int,
        ppid: int,
        starttime: int,
        *,
        cmdline: bytes = b"/bin/sh\0",
        environ: bytes = b"",
        smaps: bool = True,
    ) -> None:
        directory = self.root / str(pid)
        directory.mkdir()
        (directory / "stat").write_text(stat_line(pid, ppid, starttime))
        (directory / "cmdline").write_bytes(cmdline)
        (directory / "environ").write_bytes(environ)
        if smaps:
            (directory / "smaps_rollup").write_text(
                "Rss: 100 kB\n"
                "Pss: 80 kB\n"
                "Shared_Clean: 10 kB\n"
                "Shared_Dirty: 5 kB\n"
                "Private_Clean: 20 kB\n"
                "Private_Dirty: 45 kB\n"
                "Swap: 3 kB\n"
            )


class BuildMemorySamplerTest(unittest.TestCase):
    def test_sample_emits_only_allowlisted_derived_process_data(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            proc = Path(temporary)
            fixture = ProcFixture(proc)
            fixture.add_process(100, 1, 1000)
            fixture.add_process(
                101,
                100,
                1001,
                cmdline=(
                    b"/usr/bin/node\0"
                    b"/app/node_modules/next/dist/compiled/jest-worker/processChild.js\0"
                    b"--token=CMDLINE_CANARY\0"
                ),
                environ=(
                    b"NODE_OPTIONS=--require ENV_CANARY --max-old-space-size=4096\0"
                    b"__NEXT_PRIVATE_CPU_PROFILE=/private/build-webpack-server-PATH_CANARY.cpuprofile\0"
                    b"API_KEY=SECRET_CANARY\0"
                ),
            )

            sample = build_memory_sampler.collect_sample(
                proc, build_memory_sampler.ProcessIdentity(100, 1000), "webpack"
            )
            serialized = json.dumps(sample, sort_keys=True)

            self.assertNotIn("CANARY", serialized)
            child = next(process for process in sample["processes"] if process["pid"] == 101)
            self.assertEqual(child["role"], "webpack-compiler")
            self.assertEqual(child["compiler_target"], "server")
            self.assertEqual(child["effective_max_old_space_size_mib"], 4096)
            self.assertEqual(sample["host"]["mem_available_kib"], 24000000)
            self.assertEqual(sample["tree"]["pss_kib"], 160)
            self.assertEqual(sample["tree"]["private_kib"], 130)

    def test_root_pid_reuse_during_proc_reads_stops_the_sample(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            proc = Path(temporary)
            fixture = ProcFixture(proc)
            fixture.add_process(100, 1, 1000)
            command_path = proc / "100" / "cmdline"
            command_path.unlink()
            os.mkfifo(command_path)

            def replace_while_reading() -> None:
                with command_path.open("wb") as command:
                    (proc / "100" / "stat").write_text(stat_line(100, 1, 9000))
                    command.write(b"/bin/sh\0")

            replacement = threading.Thread(target=replace_while_reading)
            replacement.start()
            try:
                with self.assertRaises(build_memory_sampler.RootPidReused):
                    build_memory_sampler.collect_sample(
                        proc, build_memory_sampler.ProcessIdentity(100, 1000), "unknown"
                    )
            finally:
                replacement.join(timeout=2)
            self.assertFalse(replacement.is_alive())

    def test_child_pid_reuse_during_proc_reads_is_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            proc = Path(temporary)
            fixture = ProcFixture(proc)
            fixture.add_process(100, 1, 1000)
            fixture.add_process(101, 100, 1001)
            command_path = proc / "101" / "cmdline"
            command_path.unlink()
            os.mkfifo(command_path)

            def replace_while_reading() -> None:
                with command_path.open("wb") as command:
                    (proc / "101" / "stat").write_text(stat_line(101, 100, 9001))
                    command.write(b"/usr/bin/node\0worker.js\0")

            replacement = threading.Thread(target=replace_while_reading)
            replacement.start()
            try:
                sample = build_memory_sampler.collect_sample(
                    proc, build_memory_sampler.ProcessIdentity(100, 1000), "unknown"
                )
            finally:
                replacement.join(timeout=2)

            child = next(process for process in sample["processes"] if process["pid"] == 101)
            self.assertEqual(child["status"], "pid_reused_during_sample")
            self.assertIsNone(child["memory_kib"])
            self.assertIsNone(sample["tree"]["pss_kib"])

    def test_root_pid_reuse_stops_and_an_exited_child_is_not_recorded_as_zero(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proc = root / "proc"
            proc.mkdir()
            fixture = ProcFixture(proc)
            fixture.add_process(100, 1, 1000)
            fixture.add_process(101, 100, 1001, smaps=False)
            output = root / "samples.jsonl"

            def reuse_root_pid(_seconds: float) -> None:
                (proc / "100" / "stat").write_text(stat_line(100, 1, 9000))

            build_memory_sampler.run_sampler(
                proc,
                100,
                output,
                interval_seconds=1,
                max_seconds=10,
                max_bytes=32768,
                sleep=reuse_root_pid,
            )
            records = [json.loads(line) for line in output.read_text().splitlines()]

            sample = next(record for record in records if record["type"] == "sample")
            child = next(process for process in sample["processes"] if process["pid"] == 101)
            self.assertEqual(child["status"], "exited_during_sample")
            self.assertIsNone(child["memory_kib"])
            self.assertIsNone(sample["tree"]["pss_kib"])
            self.assertEqual(records[-1]["stop_reason"], "root_pid_reused")

    def test_duration_lifecycle_writes_private_auditable_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proc = root / "proc"
            proc.mkdir()
            fixture = ProcFixture(proc)
            fixture.add_process(100, 1, 1000)
            output = root / "samples.jsonl"
            elapsed = [0.0]

            def clock() -> float:
                return elapsed[0]

            def advance(seconds: float) -> None:
                elapsed[0] += seconds

            build_memory_sampler.run_sampler(
                proc,
                100,
                output,
                interval_seconds=1,
                max_seconds=2,
                max_bytes=32768,
                sleep=advance,
                monotonic=clock,
            )
            records = [json.loads(line) for line in output.read_text().splitlines()]
            summary = records[-1]

            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertEqual(summary["stop_reason"], "max_duration")
            self.assertEqual(summary["peaks"]["tree_pss_kib"]["value_kib"], 80)
            self.assertEqual(summary["host"]["minimum_mem_available_kib"]["value_kib"], 24000000)
            self.assertEqual(summary["top_processes_by_pss"][0]["starttime_ticks"], 1000)

    def test_output_limit_preserves_space_for_final_record(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proc = root / "proc"
            proc.mkdir()
            fixture = ProcFixture(proc)
            fixture.add_process(100, 1, 1000)
            for pid in range(101, 121):
                fixture.add_process(pid, 100, 1000 + pid)
            output = root / "samples.jsonl"

            build_memory_sampler.run_sampler(
                proc,
                100,
                output,
                interval_seconds=1,
                max_seconds=10,
                max_bytes=4096,
            )
            records = [json.loads(line) for line in output.read_text().splitlines()]

            self.assertLessEqual(output.stat().st_size, 4096)
            self.assertEqual(records[-1]["stop_reason"], "output_limit")

    def test_log_parser_emits_only_a_known_stage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proc = root / "proc"
            proc.mkdir()
            fixture = ProcFixture(proc)
            fixture.add_process(100, 1, 1000)
            log = root / "build.log"
            log.write_text("customer text LOG_CANARY\nRunning TypeScript\n")
            output = root / "samples.jsonl"

            def exit_root(_seconds: float) -> None:
                (proc / "100" / "stat").unlink()

            build_memory_sampler.run_sampler(
                proc,
                100,
                output,
                log_path=log,
                interval_seconds=1,
                max_seconds=10,
                max_bytes=32768,
                sleep=exit_root,
            )
            serialized = output.read_text()
            records = [json.loads(line) for line in serialized.splitlines()]

            self.assertNotIn("LOG_CANARY", serialized)
            self.assertEqual(next(record for record in records if record["type"] == "sample")["stage"], "typescript")

    def test_cli_smoke_samples_a_synthetic_linux_proc_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proc = root / "proc"
            proc.mkdir()
            fixture = ProcFixture(proc)
            fixture.add_process(100, 1, 1000)
            output = root / "samples.jsonl"

            completed = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("build_memory_sampler.py")),
                    "--proc-root",
                    str(proc),
                    "--root-pid",
                    "100",
                    "--output",
                    str(output),
                    "--interval-seconds",
                    "0.05",
                    "--max-seconds",
                    "0.1",
                    "--max-bytes",
                    "32768",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            records = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual(records[0]["type"], "metadata")
            self.assertEqual(records[-1]["type"], "summary")
            self.assertTrue(any(record["type"] == "sample" for record in records))

    def test_cli_argument_errors_are_static_and_private(self) -> None:
        script = str(Path(__file__).with_name("build_memory_sampler.py"))
        cases = (
            ["--root-pid", "CLI_SECRET_CANARY", "--output", "/tmp/not-created.jsonl"],
            ["--unknown-CLI_SECRET_CANARY"],
            [],
        )

        for arguments in cases:
            with self.subTest(arguments=arguments):
                completed = subprocess.run(
                    [sys.executable, script, *arguments],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(completed.returncode, 2)
                self.assertEqual(completed.stderr, "sampler error: invalid arguments\n")
                self.assertNotIn("CANARY", completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main()
