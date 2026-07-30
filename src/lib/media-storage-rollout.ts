import {
  LocalMediaStorageAdapter,
  type MaterializedMedia,
  type MediaByteRange,
  type MediaCommitReceipt,
  type MediaDescriptor,
  type MediaIdentity,
  type MediaRead,
  type MediaRemoveResult,
  type MediaStorage,
} from "@/lib/media-storage";
import {
  mediaStorageRuntimeConfig,
  type MediaStorageRuntimeConfig,
} from "@/lib/media-storage-config";
import { MediaCatalog } from "@/lib/media-catalog";
import {
  AliasResolvingMediaStorage,
  LocalFreshnessMediaAliasResolver,
} from "@/lib/media-storage-alias";
import { createR2MediaStorageFromEnv } from "@/lib/media-storage-r2";

export type MediaStorageRolloutEvent = {
  operation: "commit" | "stat" | "open" | "materialize" | "remove" | "configure";
  backend: "local" | "r2";
  outcome: "blocked" | "fallback" | "failed" | "unavailable";
  area?: MediaIdentity["area"];
  errorName?: string;
};

export type MediaStorageRolloutOptions = {
  config: MediaStorageRuntimeConfig;
  local: MediaStorage;
  remoteRead?: MediaStorage;
  remoteWrite?: MediaStorage;
  observe?: (event: MediaStorageRolloutEvent) => void;
};

export function logRuntimeMediaStorageEvent(event: MediaStorageRolloutEvent): void {
  if (event.outcome === "fallback") {
    console.info("[media-storage-rollout]", event);
    return;
  }
  console.warn("[media-storage-rollout]", event);
}

export class MediaRemoteUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("remote media storage is unavailable", options);
    this.name = "MediaRemoteUnavailableError";
  }
}

export class MediaDeleteBlockedError extends Error {
  constructor() {
    super("media deletion is blocked during storage rollout");
    this.name = "MediaDeleteBlockedError";
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * One rollout seam for producers and readers.
 *
 * It preserves local storage as the required copy in local/shadow modes and
 * changes read precedence independently. That lets migration move one axis at
 * a time without changing stable /api/renders and /api/stocks URLs.
 */
export class RolloutMediaStorage implements MediaStorage {
  private readonly config: MediaStorageRuntimeConfig;
  private readonly local: MediaStorage;
  private readonly remoteRead?: MediaStorage;
  private readonly remoteWrite?: MediaStorage;
  private readonly observe?: (event: MediaStorageRolloutEvent) => void;

  constructor(options: MediaStorageRolloutOptions) {
    this.config = options.config;
    this.local = options.local;
    this.remoteRead = options.remoteRead;
    this.remoteWrite = options.remoteWrite;
    this.observe = options.observe;
  }

  private emit(event: MediaStorageRolloutEvent): void {
    this.observe?.(event);
  }

  private requiredRemote(operation: MediaStorageRolloutEvent["operation"]): MediaStorage {
    if (this.remoteWrite) return this.remoteWrite;
    this.emit({ operation, backend: "r2", outcome: "unavailable" });
    throw new MediaRemoteUnavailableError();
  }

  private readers(operation: "stat" | "open" | "materialize"): Array<{
    backend: "local" | "r2";
    storage: MediaStorage | undefined;
  }> {
    switch (this.config.readMode) {
      case "local":
        return [{ backend: "local", storage: this.local }];
      case "local-r2":
        return [
          { backend: "local", storage: this.local },
          { backend: "r2", storage: this.remoteRead },
        ];
      case "r2-local":
        return [
          { backend: "r2", storage: this.remoteRead },
          { backend: "local", storage: this.local },
        ];
      case "r2":
        return [{ backend: "r2", storage: this.remoteRead }];
      default:
        this.emit({ operation, backend: "r2", outcome: "unavailable" });
        throw new MediaRemoteUnavailableError();
    }
  }

  private async firstAvailable<T>(
    operation: "stat" | "open" | "materialize",
    identity: MediaIdentity,
    read: (storage: MediaStorage) => Promise<T | null>,
  ): Promise<T | null> {
    const readers = this.readers(operation);
    let lastError: unknown;
    let lastErrorBackend: "local" | "r2" | undefined;
    for (let index = 0; index < readers.length; index += 1) {
      const reader = readers[index]!;
      if (!reader.storage) {
        this.emit({
          operation,
          backend: reader.backend,
          outcome: "unavailable",
          area: identity.area,
        });
        lastError = new MediaRemoteUnavailableError();
        lastErrorBackend = reader.backend;
        continue;
      }
      try {
        const result = await read(reader.storage);
        if (result) {
          if (index > 0) {
            this.emit({
              operation,
              backend: reader.backend,
              outcome: "fallback",
              area: identity.area,
            });
          }
          return result;
        }
      } catch (error) {
        lastError = error;
        lastErrorBackend = reader.backend;
        this.emit({
          operation,
          backend: reader.backend,
          outcome: "failed",
          area: identity.area,
          errorName: errorName(error),
        });
      }
    }
    if (lastError) {
      if (lastErrorBackend === "r2" && !(lastError instanceof MediaRemoteUnavailableError)) {
        throw new MediaRemoteUnavailableError({ cause: lastError });
      }
      throw lastError;
    }
    return null;
  }

  async commit(input: {
    identity: MediaIdentity;
    sourcePath: string;
    expectedSha256?: string;
  }): Promise<MediaCommitReceipt> {
    const localReceipt = await this.local.commit(input);
    if (this.config.writeMode === "local") return localReceipt;

    const localFile = await this.local.materialize(input.identity);
    if (!localFile) throw new MediaRemoteUnavailableError();
    try {
      const remote = this.config.writeMode === "r2-required"
        ? this.requiredRemote("commit")
        : this.remoteWrite;
      if (!remote) {
        this.emit({
          operation: "commit",
          backend: "r2",
          outcome: "unavailable",
          area: input.identity.area,
        });
        return localReceipt;
      }
      try {
        await remote.commit({
          identity: input.identity,
          sourcePath: localFile.absolutePath,
          expectedSha256: localReceipt.sha256,
        });
      } catch (error) {
        this.emit({
          operation: "commit",
          backend: "r2",
          outcome: "failed",
          area: input.identity.area,
          errorName: errorName(error),
        });
        if (this.config.writeMode === "r2-required") throw error;
      }
      return localReceipt;
    } finally {
      await localFile.release();
    }
  }

  stat(identity: MediaIdentity): Promise<MediaDescriptor | null> {
    return this.firstAvailable("stat", identity, (storage) => storage.stat(identity));
  }

  open(identity: MediaIdentity, range?: MediaByteRange): Promise<MediaRead | null> {
    return this.firstAvailable("open", identity, (storage) => storage.open(identity, range));
  }

  materialize(identity: MediaIdentity): Promise<MaterializedMedia | null> {
    return this.firstAvailable(
      "materialize",
      identity,
      (storage) => storage.materialize(identity),
    );
  }

  async remove(input: {
    identity: MediaIdentity;
    expectedSha256: string;
  }): Promise<MediaRemoveResult> {
    if (this.config.writeMode !== "local" || this.config.readMode !== "local") {
      this.emit({
        operation: "remove",
        backend: "r2",
        outcome: "blocked",
        area: input.identity.area,
      });
      throw new MediaDeleteBlockedError();
    }
    return this.local.remove(input);
  }
}

type RolloutEnvironment = Record<string, string | undefined>;

let runtimeStorage: MediaStorage | undefined;

export function createRuntimeMediaStorage(
  env: RolloutEnvironment = process.env,
  options: {
    local?: MediaStorage;
    observe?: (event: MediaStorageRolloutEvent) => void;
  } = {},
): MediaStorage {
  const config = mediaStorageRuntimeConfig(env);
  const local = options.local ?? new LocalMediaStorageAdapter();
  const needsRemote =
    config.writeMode !== "local" ||
    config.readMode !== "local";
  let remoteRead: MediaStorage | undefined;
  let remoteWrite: MediaStorage | undefined;

  if (needsRemote) {
    if (config.writeMode !== "local") {
      try {
        remoteWrite = createR2MediaStorageFromEnv(env, "write");
      } catch (error) {
        options.observe?.({
          operation: "configure",
          backend: "r2",
          outcome: "failed",
          errorName: errorName(error),
        });
      }
    }
    if (config.readMode !== "local") {
      try {
        remoteRead = new AliasResolvingMediaStorage(
          createR2MediaStorageFromEnv(env, "read"),
          new LocalFreshnessMediaAliasResolver(new MediaCatalog(), local),
        );
      } catch (error) {
        options.observe?.({
          operation: "configure",
          backend: "r2",
          outcome: "failed",
          errorName: errorName(error),
        });
      }
    }
  }

  return new RolloutMediaStorage({
    config,
    local,
    remoteRead,
    remoteWrite,
    observe: options.observe,
  });
}

export function runtimeMediaStorage(): MediaStorage {
  runtimeStorage ??= createRuntimeMediaStorage(process.env, {
    observe: logRuntimeMediaStorageEvent,
  });
  return runtimeStorage;
}

export function resetRuntimeMediaStorageForTests(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("cannot reset media storage in production");
  }
  runtimeStorage = undefined;
}
