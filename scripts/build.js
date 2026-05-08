delete process.env.__NEXT_PRIVATE_STANDALONE_CONFIG;
delete process.env.__NEXT_PRIVATE_RENDER_WORKER_CONFIG;

const { spawn } = require("child_process");

// Limit Node heap to prevent OOM on low-memory VPS during build.
const heapMB = process.env.BUILD_HEAP_MB || "12288";
const workerHeapMB = process.env.BUILD_WORKER_HEAP_MB || heapMB;
const memFlag = `--max-old-space-size=${heapMB}`;
const workerMemFlag = `--max-old-space-size=${workerHeapMB}`;
const env = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, memFlag].filter(Boolean).join(" "),
  // Next.js spawns worker processes during build — keep them smaller than parent.
  NEXT_PRIVATE_WORKER_OPTIONS: workerMemFlag,
  NEXT_CPU_PROF: "0",
};
if (process.env.BUILD_NO_LINT === "1") {
  env.NEXT_DISABLE_ESLINT = "1";
}

const buildArgs = ["next", "build"];
if (process.env.BUILD_NO_LINT === "1") {
  buildArgs.push("--no-lint");
}

const child = spawn("npx", buildArgs, {
  stdio: "inherit",
  env,
  shell: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
