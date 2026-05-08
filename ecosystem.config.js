module.exports = {
  apps: [
  {
      name: "ai-content",
      cwd: "/var/www/ai-content",
      script: "node_modules/.bin/next",
      args: "start",
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        NEXT_DISABLE_ESLINT: "1",
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 3000,
      },
    },
    {
      name: "cleanup-videos",
      cwd: "/var/www/ai-content",
      script: "scripts/cleanup-videos.js",
      cron_restart: "0 3 * * *", // runs every day at 3:00 AM
      autorestart: false,
      watch: false,
    },
  ],
};
