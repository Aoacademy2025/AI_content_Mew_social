import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type LeaseRecord = {
  pid: number;
  token: string;
  updatedAt: number;
};

export type HeavyMediaLease = {
  heartbeat(): Promise<void>;
  release(): Promise<void>;
};

export class HeavyMediaAdmissionTimeoutError extends Error {
  constructor(public readonly waitedMs: number) {
    super("ระบบกำลังประมวลผลงานวิดีโออื่นอยู่ กรุณารอสักครู่");
    this.name = "HeavyMediaAdmissionTimeoutError";
  }
}

type HeavyMediaAdmissionOptions = {
  rootDir: string;
  enabled: boolean;
  pid?: number;
  leaseStaleMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
};

const LOCK_FILE = "admission.lock";
const COMPOSITE_LEASE_FILE = "composite.lease.json";
const MUTEX_STALE_MS = 30_000;

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class HeavyMediaAdmission {
  private readonly pid: number;
  private readonly leaseStaleMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly now: () => number;

  constructor(private readonly options: HeavyMediaAdmissionOptions) {
    this.pid = options.pid ?? process.pid;
    this.leaseStaleMs = options.leaseStaleMs ?? 90_000;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.now = options.now ?? Date.now;
  }

  async tryAcquireRender(): Promise<HeavyMediaLease | null> {
    if (!this.options.enabled) return this.noopLease();
    const token = crypto.randomUUID();
    const leasePath = path.join(this.options.rootDir, `render-${this.pid}-${token}.lease.json`);
    const acquired = await this.withMutex(() => {
      this.cleanupStaleRecords();
      const names = fs.readdirSync(this.options.rootDir);
      const compositeActive = names.includes(COMPOSITE_LEASE_FILE);
      const compositeWaiting = names.some((name) => name.startsWith("composite-waiting-") && name.endsWith(".json"));
      if (compositeActive || compositeWaiting) return false;
      this.writeRecord(leasePath, token);
      return true;
    });
    return acquired ? this.lease(leasePath, token) : null;
  }

  async acquireComposite(input: { maxWaitMs: number; pollMs: number }): Promise<HeavyMediaLease> {
    if (!this.options.enabled) return this.noopLease();
    const token = crypto.randomUUID();
    const waitingPath = path.join(this.options.rootDir, `composite-waiting-${token}.json`);
    const compositePath = path.join(this.options.rootDir, COMPOSITE_LEASE_FILE);
    const startedAt = this.now();
    let acquired = false;

    try {
      while (this.now() - startedAt <= input.maxWaitMs) {
        acquired = await this.withMutex(() => {
          this.cleanupStaleRecords();
          this.writeRecord(waitingPath, token);
          const names = fs.readdirSync(this.options.rootDir);
          const renderActive = names.some((name) => name.startsWith("render-") && name.endsWith(".lease.json"));
          if (renderActive || names.includes(COMPOSITE_LEASE_FILE)) return false;
          this.writeRecord(compositePath, token);
          this.removeOwnedRecord(waitingPath, token);
          return true;
        });
        if (acquired) return this.lease(compositePath, token);
        await sleep(Math.max(1, input.pollMs));
      }
      throw new HeavyMediaAdmissionTimeoutError(this.now() - startedAt);
    } finally {
      if (!acquired) {
        await this.withMutex(() => this.removeOwnedRecord(waitingPath, token)).catch(() => {});
      }
    }
  }

  private noopLease(): HeavyMediaLease {
    return {
      heartbeat: async () => {},
      release: async () => {},
    };
  }

  private lease(filePath: string, token: string): HeavyMediaLease {
    return {
      heartbeat: async () => {
        await this.withMutex(() => {
          const record = this.readRecord(filePath);
          if (record?.token === token) this.writeRecord(filePath, token);
        });
      },
      release: async () => {
        await this.withMutex(() => this.removeOwnedRecord(filePath, token));
      },
    };
  }

  private async withMutex<T>(operation: () => T): Promise<T> {
    fs.mkdirSync(this.options.rootDir, { recursive: true });
    const lockPath = path.join(this.options.rootDir, LOCK_FILE);
    const token = crypto.randomUUID();
    const startedAt = this.now();

    while (this.now() - startedAt <= 5_000) {
      try {
        const fd = fs.openSync(lockPath, "wx");
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: this.pid, token, updatedAt: this.now() }));
        } finally {
          fs.closeSync(fd);
        }
        try {
          return operation();
        } finally {
          this.removeOwnedRecord(lockPath, token);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = this.readRecord(lockPath);
        if (!owner || !this.isProcessAlive(owner.pid) || this.now() - owner.updatedAt > MUTEX_STALE_MS) {
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
        await sleep(10);
      }
    }
    throw new Error("heavy media admission mutex timeout");
  }

  private cleanupStaleRecords(): void {
    for (const name of fs.readdirSync(this.options.rootDir)) {
      if (
        name === LOCK_FILE
        || (!name.endsWith(".lease.json") && !(name.startsWith("composite-waiting-") && name.endsWith(".json")))
      ) continue;
      const filePath = path.join(this.options.rootDir, name);
      const record = this.readRecord(filePath);
      if (!record || !this.isProcessAlive(record.pid) || this.now() - record.updatedAt > this.leaseStaleMs) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
  }

  private writeRecord(filePath: string, token: string): void {
    fs.writeFileSync(filePath, JSON.stringify({ pid: this.pid, token, updatedAt: this.now() }));
  }

  private readRecord(filePath: string): LeaseRecord | null {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<LeaseRecord>;
      return Number.isInteger(raw.pid) && typeof raw.token === "string" && Number.isFinite(raw.updatedAt)
        ? raw as LeaseRecord
        : null;
    } catch {
      return null;
    }
  }

  private removeOwnedRecord(filePath: string, token: string): void {
    const record = this.readRecord(filePath);
    if (record?.token !== token) return;
    try { fs.unlinkSync(filePath); } catch {}
  }
}
