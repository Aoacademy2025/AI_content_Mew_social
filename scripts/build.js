delete process.env.__NEXT_PRIVATE_STANDALONE_CONFIG;
delete process.env.__NEXT_PRIVATE_RENDER_WORKER_CONFIG;

const { spawn } = require("child_process");

// Limit Node heap to prevent WasmHash OOM on low-RAM VPS during webpack bundling.
// 4096 MB ceiling — webpack's wasm hash runs in the main process and OOMs without this.
const memFlag = "--max-old-space-size=12288";
const env = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, memFlag].filter(Boolean).join(" "),
  // Next.js 15 spawns a worker process — pass memory flag to it too
  NEXT_PRIVATE_WORKER_OPTIONS: memFlag,
  NEXT_CPU_PROF: "0",
};

const child = spawn("npx", ["next", "build"], {
  stdio: "inherit",
  env,
  shell: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
