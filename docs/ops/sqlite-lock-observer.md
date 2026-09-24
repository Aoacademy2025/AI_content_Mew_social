# SQLite WAL lock observer

`scripts/observe-sqlite-locks.py` is a standalone, bounded, read-only Linux
diagnostic. It reads the SQLite database header, file identities,
`/proc/locks`, and numeric process start times. It never opens a database
connection, reads SQL or rows, reads process command lines, or emits paths,
inodes, environment values, or application payloads.

Do not run a natural production observation until this tool and the synthetic
Linux evidence have independent review. A reviewer-approved operator must
serialize any later observation with other host work. Keep the output private:

```bash
umask 077
python3 scripts/observe-sqlite-locks.py \
  --db "$PRIVATE_DATABASE_PATH" \
  --duration-seconds 30 \
  --interval-ms 100 \
  --pid-class "$APP_PID=ai-content" \
  > "$PRIVATE_EVIDENCE_FILE"
```

Use only current numeric PIDs and the fixed PM2 classes accepted by the CLI.
The observer binds each supplied mapping to the PID's numeric process start
time and aborts if the identity changes. It samples for at most 300 seconds,
buffers at most 1,000 continuous lock intervals, and emits nothing if a
targeted record, WAL mode, file identity, or process identity is unsupported.
Zero lock records followed by a summary is a valid observation with no holder
finding during the sampled instants.

## Interpretation

Linux `/proc/locks` supplies a lock type, mode, holder PID, device and inode,
and inclusive byte range. SQLite's Unix VFS maps its WAL locks onto the
`-shm` file as follows:

| Observer role | Shared-memory byte | Narrow meaning |
| --- | ---: | --- |
| `write` | 120 | The PID held `WAL_WRITE_LOCK`; appending and recovery can hold it. |
| `checkpoint` | 121 | The PID held `WAL_CKPT_LOCK`; checkpoint and recovery can hold it. |
| `recovery` | 122 | The PID held `WAL_RECOVER_LOCK`. |
| `read-slot-0` … `read-slot-4` | 123–127 | The PID held that WAL read-mark slot. A write-mode slot can also be checkpoint/recovery/reset activity. |
| `deadman-switch` | 128 | The Unix VFS kept the shared-memory segment live; this is not a transaction lock. |
| `main-lock` | database lock page | A legacy main-file lock; in WAL mode it does not by itself identify a writer. |

These byte definitions come from SQLite's [WAL-index format](https://www.sqlite.org/walformat.html#wal_locks)
and Unix VFS [`UNIX_SHM_BASE` / `UNIX_SHM_DMS`](https://sqlite.org/src/artifact/410185df49).
The `/proc/locks` field meanings and PID-namespace limitation are documented in
[`proc_locks(5)`](https://www.man7.org/linux/man-pages/man5/proc_locks.5.html).

Each lock record contains UTC and monotonic-relative first/last observed times,
sample count, numeric PID/start time, fixed process class, target/role/mode, and
byte range. It identifies an OS holder observed during that interval. It does
not identify a request, transaction caller, customer, SQL statement, or
business operation. Generated Prisma caller provenance belongs to the waiting
or completing call and must not be assigned to the holder without separate,
independently correlated in-flight evidence.

## Disposable verification

The parser/privacy/fail-closed fixture runs on any development host. The second
command must run on Linux and uses only a temporary disposable WAL database:

```bash
python3 scripts/verify-sqlite-lock-observer.py
python3 scripts/verify-sqlite-lock-observer-linux.py
```

The Linux regression holds an actual read-only transaction and an actual
`BEGIN IMMEDIATE` writer, then runs an actual truncate checkpoint behind the
reader. It requires the writer PID on byte 120, a reader slot with no writer
label for the read-only PID, and the checkpoint PID on byte 121. All children
and temporary files are bounded and cleaned up even when an assertion fails.
