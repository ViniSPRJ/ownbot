# Production static UI

Build the app before replacing the Vite development process:

```sh
bun run --cwd app build
bun test scripts/tests/serve-ui.test.ts
```

The existing systemd UI service should keep its current user, working directory,
EnvironmentFile, Tailscale forwarding, and restart settings. Replace only the
Vite ExecStart with the actual installed Bun path and this script, for example:

```ini
ExecStart=/absolute/path/to/bun /home/viniciuspinho/openbot/scripts/serve-ui.ts
```

Defaults: `APP_HOST=127.0.0.1`, `APP_PORT=3010`, backend at
`http://127.0.0.1:${SERVER_PORT:-3001}`, build at `app/dist` relative to this script.
Override backend with `OPENBOT_UI_API_URL` (HTTP origin), or build directory with
`OPENBOT_UI_DIST`. Keep loopback binding when the existing tailnet HTTPS proxy
provides external access. The existing Vite host allowlist is preserved (localhost,
loopback and `.tail3c3777.ts.net`); override it with comma-separated
`OPENBOT_UI_ALLOWED_HOSTS` only when changing the deployment hostname.
No new public listener or TLS configuration is needed.

`/api` retains its original prefix and streams request/response bodies, SSE,
cookies and WebSocket upgrades to the backend. There is no Vite HMR dependency.
SPA deep links, including `/channel/{id}` and `/routine-runs/{id}`, serve the
built index; missing asset files return 404. Hashed assets are immutable; HTML
must revalidate. Build files should remain read-only to the serving process.

After restarting the existing UI service:

```sh
bun scripts/serve-ui.ts --check
```

This read-only command checks static UI liveness and API `/health`; it does not
claim inference, routine execution, Telegram delivery, or readiness of external
workers. The UI's `/__ui/health` endpoint reports static serving only. Review the
API readiness endpoint separately for queue/outbox/worker health.

Preserve the prior build and unit override before deployment. Rollback means
restore the previous artifact/ExecStart and restart only this UI service. Deploy
builds atomically or during the restart window so an index never references
partially copied assets. Do not delete the previous build until validation.
