module.exports = {
  apps: [
  {
      name: "ai-content",
      cwd: "/var/www/ai-content",
      script: "node_modules/.bin/next",
      args: "start",
      max_memory_restart: "12G",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        NEXT_DISABLE_ESLINT: "1",
        // Render tuning — increase concurrency and cache for faster renders
        RENDER_CONCURRENCY: "4",
        RENDER_OFFTHREAD_CACHE_MB: "512",
        RENDER_JPEG_QUALITY: "70",
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
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        CRON_SECRET: process.env.CRON_SECRET || "",
      },
    },
  ],
};
