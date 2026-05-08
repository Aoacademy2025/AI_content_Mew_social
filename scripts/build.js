delete process.env.__NEXT_PRIVATE_STANDALONE_CONFIG;
delete process.env.__NEXT_PRIVATE_RENDER_WORKER_CONFIG;

const { spawn } = require("child_process");

const env = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=4096"].filter(Boolean).join(" "),
};

const child = spawn("npx", ["next", "build"], {
  stdio: "inherit",
  env,
  shell: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
