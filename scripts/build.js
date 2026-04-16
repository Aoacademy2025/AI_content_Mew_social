delete process.env.__NEXT_PRIVATE_STANDALONE_CONFIG;
delete process.env.__NEXT_PRIVATE_RENDER_WORKER_CONFIG;

const { spawn } = require("child_process");

const child = spawn("npx", ["next", "build"], {
  stdio: "inherit",
  env: process.env,
  shell: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
