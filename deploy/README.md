# Claw-Empire Deployment Guide

This directory contains production deployment examples for a single-host Linux setup.

Included files:

- `deploy/.env.production.template`: runtime environment template
- `deploy/claw-empire@.service`: example user-level systemd service
- `deploy/nginx/claw-empire.conf`: example nginx reverse proxy

## Assumptions

- Node.js 22 or newer
- pnpm 9 or newer
- Linux with `systemd`
- Optional: nginx for TLS termination and reverse proxying

## 1. Build the app

```bash
git clone https://github.com/GreenSheep01201/claw-empire.git
cd claw-empire
pnpm install
pnpm run build
```

## 2. Create the runtime env file

```bash
cp deploy/.env.production.template deploy/.env.production
```

Set at minimum:

- `OAUTH_ENCRYPTION_SECRET`
- `INBOX_WEBHOOK_SECRET`
- `API_AUTH_TOKEN` for non-loopback access
- `OAUTH_BASE_URL` if the public URL differs from `http://127.0.0.1:8790`

If you run behind nginx on the same host, keep:

- `HOST=127.0.0.1`
- `PORT=8790`

If you expose the Node server directly on a LAN or VPN, set `HOST=0.0.0.0` and review `ALLOWED_ORIGINS` or `ALLOWED_ORIGIN_SUFFIXES`.

## 3. Install the user service

```bash
mkdir -p ~/.config/systemd/user
cp deploy/claw-empire@.service ~/.config/systemd/user/claw-empire.service
systemctl --user daemon-reload
systemctl --user enable --now claw-empire
```

If you want the service to survive logout:

```bash
sudo loginctl enable-linger "$USER"
```

Useful commands:

```bash
systemctl --user status claw-empire
journalctl --user -u claw-empire -f
```

## 4. Optional nginx reverse proxy

```bash
sudo cp deploy/nginx/claw-empire.conf /etc/nginx/sites-available/claw-empire
sudo ln -s /etc/nginx/sites-available/claw-empire /etc/nginx/sites-enabled/claw-empire
sudo nginx -t
sudo systemctl reload nginx
```

Update `server_name` before enabling the site. If you use Let's Encrypt, install the certificate after the site is reachable.

## 5. Smoke checks

Local health check:

```bash
curl http://127.0.0.1:8790/api/health
```

Authenticated remote check:

```bash
curl -H "Authorization: Bearer YOUR_API_AUTH_TOKEN" https://claw.example.com/api/health
```

## 6. Updating

```bash
git pull
pnpm install
pnpm run build
systemctl --user restart claw-empire
```

## Notes

### Video production on the host

Set `CLI_WORKER_RUNTIME_MODE=host` and install the repository dependencies with `pnpm install`. Host readiness checks the local worker, Remotion, a Chrome/Edge/Chromium executable and Shotcraft. Optional paths are `CLAW_REMOTION_BROWSER` and `CLAW_SHOTCRAFT_ROOT`. If the repository skill is absent, the runtime downloads the pinned, checksum-verified archive into the user cache.

For a video agent, select `codex`, `claude` or `gemini` in `cli_provider` and sign into that CLI under the server's operating-system account. Host mode prefers that CLI over `api_provider_id`. Each model request uses a temporary directory, a read-only/no-tools CLI invocation and the CEO protection instruction. The child environment excludes the four server authentication/encryption secrets while retaining the user's login directories. Shotcraft tools expose the original skill as read-only and write into the attempt project.

An active host worker is identified by the process created in the current server session. After a server restart, an unknown host process remains subject to reconciliation and retains its slot. Host mode runs with the account's OS permissions, so prompt restrictions and environment filtering do not provide filesystem isolation from that account's files. Browser CEO session, CSRF, RBAC and versioned approvals still apply at the API boundary.

Container mode continues to use the pinned worker image and Docker confinement.

- `deploy/.env.production` is a local runtime file and should stay untracked.
- The service example writes logs to `./logs`.
- The template is intentionally conservative. Add provider-specific keys only if you use those integrations.
