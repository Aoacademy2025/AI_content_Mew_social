import { deleteBrandAssetIfUnreferenced, BrandAssetError } from "../src/lib/brand-assets.server";
import { prisma } from "../src/lib/prisma";

type WorkerMessage =
  | { event: "ready" }
  | { event: "invoking" }
  | { event: "result"; kind: "returned"; value: boolean }
  | { event: "result"; kind: "brand-error"; code: string; status: number }
  | { event: "result"; kind: "unexpected-error"; message: string };

function send(message: WorkerMessage): void {
  if (process.send) process.send(message);
}

async function main(): Promise<void> {
  const [userId, assetId] = process.argv.slice(2);
  if (!userId || !assetId) throw new Error("worker_arguments_required");
  send({ event: "ready" });
  send({ event: "invoking" });
  try {
    const value = await deleteBrandAssetIfUnreferenced(userId, assetId);
    send({ event: "result", kind: "returned", value });
  } catch (error) {
    if (error instanceof BrandAssetError) {
      send({ event: "result", kind: "brand-error", code: error.code, status: error.status });
      return;
    }
    send({
      event: "result",
      kind: "unexpected-error",
      message: error instanceof Error ? error.message : "unknown_error",
    });
  }
}

main()
  .catch((error) => {
    send({
      event: "result",
      kind: "unexpected-error",
      message: error instanceof Error ? error.message : "unknown_error",
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
