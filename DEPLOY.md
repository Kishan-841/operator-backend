# Deploying Operator CRM

Backend → Docker on your VM · Frontend → Vercel.

## Backend (VM)

```bash
# on the VM, inside backend/
cp .env.docker.example .env.docker   # fill in: POSTGRES_PASSWORD, JWT_SECRET, FRONTEND_URL, SEED_PASSWORD
docker compose up -d --build
```

What happens on boot: the API container runs `prisma db push` (the project's
schema-sync convention), optionally seeds one user per role when
`SEED_USERS=1` (set it for the first boot only), then starts the server on
port **5003**. Postgres data lives in the `pgdata` volume; uploaded documents
in the `uploads` volume (until R2 is configured).

- Logs: `docker compose logs -f api`
- Update: `git pull && docker compose up -d --build`
- Health: `curl http://localhost:5003/api/health`
- LibreOffice (agreement → PDF) is baked into the image — nothing to install
  on the VM itself.

Put the API behind HTTPS (Caddy/nginx/Cloudflare Tunnel) — the Vercel frontend
is served over HTTPS and browsers will block a plain-http API. Example Caddyfile:

```
api.yourdomain.com {
    reverse_proxy localhost:5003
}
```

## Frontend (Vercel)

1. Import the repo in Vercel, set the project **Root Directory** to `frontend/`.
2. Environment variable: `NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api`
   (must match how `frontend/lib/api.js` builds its base URL — same value the
   local `.env` uses, pointed at the VM).
3. Deploy. Then make sure the backend's `FRONTEND_URL` in `.env.docker` is the
   exact Vercel origin (e.g. `https://operator-crm.vercel.app`) — CORS and
   socket.io only accept that origin — and `docker compose up -d` again.

## Checklist

- [ ] `POSTGRES_PASSWORD` + `JWT_SECRET` are long and random
- [ ] `FRONTEND_URL` = exact Vercel origin (no trailing slash)
- [ ] First boot done with `SEED_USERS=1`, then set back to `0`
- [ ] HTTPS in front of :5003
- [ ] DB backups: `docker compose exec db pg_dump -U operator operator_crm > backup.sql` (cron it)
