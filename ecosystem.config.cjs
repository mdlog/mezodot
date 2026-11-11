// pm2 process file for running Mezodot on this machine: the keeper agent (127.0.0.1:8787) and the web app's
// production build (127.0.0.1:3000, scripts/serve-web.ts), restarted when they crash and resurrected at boot by the
// pm2 systemd unit:
//
//   env -i HOME="$HOME" PATH="$PATH" pm2 start ecosystem.config.cjs && env -i HOME="$HOME" PATH="$PATH" pm2 save
//
// Start it from a clean environment (env -i): pm2 copies the starting shell's environment into every app and into
// ~/.pm2/dump.pm2, tokens included. The agent reads its own secrets from services/agent/.env (node --env-file).
const path = require('node:path');

// The Node that runs `pm2 start` (the repository needs Node 22); `pm2 save` records this absolute path, so the apps
// come back on the same Node at boot whatever Node the pm2 daemon itself runs on.
const node = process.execPath;

module.exports = {
  apps: [
    {
      name: 'mezodot-agent',
      cwd: path.join(__dirname, 'services/agent'),
      // Node itself rather than the pnpm/tsx wrappers, so SIGINT/SIGTERM reach the agent's graceful shutdown.
      script: node,
      args: ['--import', 'tsx', '--env-file-if-exists=.env', 'src/index.ts'],
      interpreter: 'none',
      // On stop the agent waits up to 100 s for transactions in flight (services/agent/README.md); pm2 would
      // otherwise SIGKILL it after 1.6 s.
      kill_timeout: 120_000,
      // Backs off while an RPC or the network is down at boot instead of restarting in a tight loop.
      exp_backoff_restart_delay: 2_000,
    },
    {
      // apps/web/dist served the way it should be hosted: GET/HEAD only, security headers, no dotfiles, and only the
      // tunnel's hostname (any other Host gets 421). Never the Vite dev server: it serves files from the whole
      // workspace. After a change: pnpm --filter @mezodot/web build && pm2 restart mezodot-web
      name: 'mezodot-web',
      cwd: __dirname,
      script: node,
      args: ['scripts/serve-web.ts'],
      interpreter: 'none',
      env: { WEB_HOST: '127.0.0.1', WEB_PORT: '3000', WEB_ALLOWED_HOSTS: 'mezodot.mdloglabs.org' },
      exp_backoff_restart_delay: 2_000,
      time: true,
    },
  ],
};
