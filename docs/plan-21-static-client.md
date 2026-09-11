# Plan — Fully static client (#21)

Branch: `feat/tv/21-static-client`
Issue: https://github.com/alex-moon/tova/issues/21

## Motivation

Issue #21 asks for the client to be served by "something more production than `vite preview`"
(nginx is explicitly suggested as fine), with all views compiled down to static files with
cache busting, served along the file structure. A comment on the issue adds: as part of this
work, fix broken styles on the deployed environment — the admin button renders as plain text
and the admin view has no styles at all.

### Current state (verified in repo)

- The live stack (`docker-compose.live.yml`) runs the frontend via `src/client/Dockerfile`,
  which does `npm run build` and then `vite preview --host 0.0.0.0 --port 4173 --strictPort`,
  exposed on host port 15173. `preview.allowedHosts: ['tova.ajmoon.com']` exists solely to
  make the production host acceptable to vite preview.
- Build output goes to `src/client/dist` (gitignored). Vite already content-hashes assets
  (`assets/index-<hash>.js|css`), so hash-based cache busting exists implicitly; nothing is
  done with cache headers.
- The client is a single-entry SPA: `src/client/index.html` is the only HTML file. There is
  no react-router; `App.tsx` checks `window.location.pathname.startsWith('/admin')` and
  renders `AdminView`. `/admin` currently works only via the preview/express SPA fallback.
- Client API calls are same-origin (`/api/...`), with auth via httpOnly cookie (see
  `src/client/src/services/admin.ts`). Whatever serves the static files must also proxy
  `/api/` to the backend to preserve cookies.
- The backend already has a static fallback (`src/server/index.ts` serves
  `src/client/dist` + catch-all to `index.html`), but the live stack does not route HTML
  through the backend.
- Deploy host nginx (outside this repo, `/opt/ajmoon/nginx/ajmoon.conf`) proxies 15173.
- Admin styles bug confirmed in source: `AdminView.tsx` contains zero `className`
  attributes, and the "Admin" link in `App.tsx` is a bare `<a>`.

### Decisions so far

- `docs/plan-15-admin-view.md` deferred nginx/static serving (its step 8) and minimal
  AdminView styling (its step 9) — this re-scoped territory is now ticket #21.
- plan-15 records the owner confirming an admin route *inside* the SPA (approach (b)) for
  the #15 work, which suggests a single-entry SPA with nginx `try_files ... /index.html`
  satisfies "all views" — see Open questions.

## Decisions made

- **Nginx replaces vite preview** in `src/client/Dockerfile` (multi-stage: build with node,
  serve with nginx). Vite preview and its `allowedHosts` workaround are removed.
- **Nginx also proxies `/api/`** to the backend service, preserving same-origin cookies.
  Docker-compose networking allows `proxy_pass http://backend:5000;` (service name resolved
  by Docker DNS).
- **Cache policy**: hashed assets (`/assets/*`) get `immutable` long max-age; HTML gets
  `no-cache` so deploys pick up new asset hashes immediately.

## Done checklist

Small tasks, each safely deliverable in a single commit:

- [ ] 1. Write `src/client/nginx.conf` (or `default.conf`): root at `/usr/share/nginx/html`,
      `try_files $uri /index.html`, `location /assets/` with immutable cache header,
      HTML `no-cache`, `location /api/ { proxy_pass http://backend:5000; }`.
- [ ] 2. Rewrite `src/client/Dockerfile` as multi-stage: node build stage (`npm ci`,
      `npm run build`), nginx stage copying `dist` and the nginx conf.
- [ ] 3. Update `docker-compose.live.yml`: frontend service uses the new image, and the
      `/api` proxying decision determines port exposure (see Open question 1) — remove
      `vite preview` references.
- [ ] 4. Remove now-unneeded preview config from `vite.config.ts` (`preview.allowedHosts`)
      unless still wanted for local testing.
- [ ] 5. Style `AdminView.tsx` minimally (classNames consistent with existing chat-ui
      styling) and fix the admin button link in `App.tsx` so it renders as a real styled
      button/link (addresses the issue comment).
- [ ] 6. Verify end-to-end: build locally, serve via nginx (docker compose), check that
      `/`, `/admin` (HTML fallbacks), hashed assets, `/api` proxy, and cache headers
      behave correctly. Run `npm run ci`.

## Open questions

1. **Port topology:** should nginx on the frontend container be the single front door
   (published on 15173 as today, doing static + `/api` proxy), or should the old
   backend-port/proxy topology change? Today's mapping (4173→15173 published) can be kept
   by proxying `/api` from the nginx container to `backend:5000`; assume that, but flag it
   in the PR since the deploy host nginx config (outside the repo) also targets 15173.
2. **File-structure serving:** the issue says static views "served along the file structure".
   Multi-entry build (`/admin.html` at its own path) would literally match that, but
   plan-15 records the owner choosing an in-SPA `/admin` route. Planning assumes
   single-entry SPA + `try_files` fallback; if the owner wants true per-path HTML files,
   the work expands (Vite multi-entry `rollupOptions.input`) — needs confirmation, hence
   not planned.
3. **Deploy host nginx config** lives outside this repo; if the internal mapping changes,
   that file needs a manual update at deploy time. Assumed unchanged (15173 kept).
