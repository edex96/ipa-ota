// pm2 process definition. Deploy: pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'ipa-ota',
      script: 'server.js',
      cwd: '$OTA_DIR',
      instances: 1, // single instance: uploads live on local disk, no shared store
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        PUBLIC_URL: 'https://ota.example.com',
        MAX_MB: 2048,
      },
      out_file: '/var/log/ipa-ota/out.log',
      error_file: '/var/log/ipa-ota/err.log',
      merge_logs: true,
      time: true,
    },
  ],
}
