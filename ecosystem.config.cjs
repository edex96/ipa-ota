// pm2 process definition. Deploy: pm2 start ecosystem.config.cjs && pm2 save
//
// Host-specific values come from the environment so nothing about a particular
// box lives in the repo. Set them once in the shell that starts pm2, or keep
// them in an untracked .env sourced before `pm2 start`:
//   OTA_DIR=/srv/ipa-ota OTA_PUBLIC_URL=https://ota.example.com pm2 start ecosystem.config.cjs
const DIR = process.env.OTA_DIR || process.cwd()
const LOG_DIR = process.env.OTA_LOG_DIR || `${DIR}/logs`

module.exports = {
  apps: [
    {
      name: 'ipa-ota',
      script: 'server.js',
      cwd: DIR,
      instances: 1, // single instance: uploads live on local disk, no shared store
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.OTA_PORT || 3010,
        HOST: '127.0.0.1', // nginx is the only thing that should reach it
        // must be the public https origin; iOS rejects http manifests
        PUBLIC_URL: process.env.OTA_PUBLIC_URL || '',
        MAX_MB: process.env.OTA_MAX_MB || 2048,
      },
      out_file: `${LOG_DIR}/out.log`,
      error_file: `${LOG_DIR}/err.log`,
      merge_logs: true,
      time: true,
    },
  ],
}
