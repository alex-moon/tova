# Plan — Fully static client (#21)

Branch: `feat/tv/21-static-client`
Issue: https://github.com/alex-moon/tova/issues/21

## Motivation

Issue #21 asks for the client to be served by "something more production than `vite preview`"
(nginx is explicitly suggested as fine), with all views compiled down to static files with
cache busting, served along the file structure.

From the issue comments (moved into the plan, no longer open):

- The owner adds a second deliverable: fix broken styles on the deployed environment —
  the admin button renders as plain text and the admin view has no styles at all.
  **Root cause verified in repo**: the "Admin" link in `src/client/src/App.tsx:242` is a bare
  `<a href="/admin">Admin</a>` (unstyled), and `AdminView.tsx` contains zero `className`
  attributes — it renders raw content with none of the app's Tailwind classes. This is not a
  deployment-only issue; the missing styles are visible in source and will show wherever the
  built app runs. Fix belongs in step 5 below, not in nginx configuration.

### Current state (verified in repo)

- The live stack (`docker-compose.live.yml`) runs the frontend via `src/client/Dockerfile`,
  which does `npm install && npm run build` and then
  `vite preview --host 0.0.0.0 --port 4173 --strictPort`, published on host port 15173.
  `preview.allowedHosts: ['tova.ajmoon.com']` in `src/client/vite.config.ts:32` exists solely
  to make that production host acceptable to vite preview; it can be deleted once preview
  is gone.
- Build output goes to `src/client/dist` (gitignored). Vite already content-hashes assets
  (`assets/index-<hash>.js|css`), so hash-based cache busting exists implicitly; nothing
  sets cache headers today. `build` in `src/client/vite.config.ts` has no output-path
  override and needs none.
- The client is a single-entry SPA: `src/client/index.html` is the only HTML file. There is
  no react-router; `App.tsx` (`isAdminRoute`, App.tsx:22) checks
  `window.location.pathname.startsWith('/admin')` and renders `AdminView`. `/admin` works
  via the preview SPA fallback today and via nginx `try_files` after this change.
- `/admin` is additionally gated in the UI by `user.role === 'admin'` (App.tsx:235); the
  route only *renders* admin content for admins, so the fallback serving `/index.html` for
  any path leaks nothing (calls are still authorized backend-side).
- Client API calls are same-origin (`/api/...`), auth via httpOnly cookie
  (`src/client/src/services/admin.ts`). Whatever serves static files must also proxy
  `/api/` to the backend to preserve cookies. The chat endpoint `/api/chat/stream` is a
  streaming (SSE-style) response — the nginx proxy config must disable response buffering
  for it or streamed tokens will arrive in chunks only when buffers flush.
- Backend service is reachable inside the compose network at `backend:5000`
  (docker-compose.live.yml service name + `PORT=5000`); nginx can `proxy_pass
  http://backend:5000;` without any port re-mapping.
- The backend also has a static fallback (`src/server/index.ts` serves `src/client/dist`
  + catch-all to `index.html`), but the live stack does not route HTML through the backend.
  That fallback is untouched by this work (still useful for the backend-only dev flow).
- Deploy host nginx (outside this repo, `/opt/ajmoon/nginx/ajmoon.conf`) proxies to 15173.
  Keeping 15173 published means no change is needed there.
- Admin styles bug confirmed in source as above; there are existing shadcn/ui primitives
  and Tailwind tokens (e.g. `border-border`, `bg-sidebar` in Sidebar.tsx) to reuse.
- Docker + docker compose are available in the local environment (verified: server 29.8.0,
  compose v5.5.1), so end-to-end verification of the nginx image is doable without deploy.

### Decisions so far

- `docs/plan-15-admin-view.md` deferred nginx/static serving (its step 8) and minimal
  AdminView styling (its step 9) — this re-scoped territory is now ticket #21.
- plan-15 records the owner confirming an admin route *inside* the SPA (approach (b)) for
  the #15 work.

## Decisions made

- **Nginx replaces vite preview** in `src/client/Dockerfile` (multi-stage: build with node,
  serve with nginx). Vite preview and its `allowedHosts` workaround are removed. npm
  switches from `npm install` to `npm ci` in the build stage so the image uses the
  committed `package-lock.json` (clean, reproducible; `package-lock.json` is present).
- **Nginx is the single front door on the frontend container.** Compose keeps publishing
  `15173:4173`; nginx listens on 4173 inside the container (container port unchanged, so
  the external deploy-host map is untouched) and serves static files + proxies `/api/` to
  `http://backend:5000`. Cookies stay same-origin, cached, and httpOnly.
- **Cache policy**: hashed assets (`/assets/*`) get `Cache-Control: public, max-age=31536000,
  immutable`; `/index.html` gets `no-cache` so deploys picked up immediately; everything
  else gets a short (`max-age=3600`) cache or `no-cache` — small surface either way.
- **Streaming**: `location /api/` sets `proxy_buffering off` (plus standard
  `proxy_set_header Host/X-Real-IP`) so `/api/chat/stream` keeps its token-by-token behavior.
- **Serving model**: single-entry SPA + `try_files $uri $uri/ /index.html`. Rationale: all
  views *are* compiled to static files (one HTML + hashed assets), and plan-15 already
  records the owner choosing the in-SPA `/admin` route. The residual interpretation risk
  on "served along the file structure" is tracked as an open question and blocks nothing:
  `try_files` makes `/admin` work at its file-structure path either way; if the owner later
  wants literal `/admin/index.html` output, that is an additive Vite `rollupOptions.input`
  change, not a rework of this plan.
- **Admin styles fix** is in scope here (issue comment), reusing existing shadcn/ui
  primitives (`Button` from `@/components/ui/button`) and Tailwind token classes consistent
  with Sidebar/ChatWindow styling. This is a code fix, not a config fix.

## Implementation steps

- [ ] 1. Write `src/client/nginx.conf`:
    - `server { listen 4173; root /usr/share/nginx/html; index index.html; }`
    - `location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }`
      (assets are served from root by default; immutable header added on this location)
    - `location = /index.html` (and the fallback): `add_header Cache-Control "no-cache";`
    - `location /api/ { proxy_pass http://backend:5000; proxy_http_version 1.1;
      proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr;
      proxy_buffering off; }`
    - `location / { try_files $uri $uri/ /index.html; }` for `/admin` etc.
- [ ] 2. Rewrite `src/client/Dockerfile` as multi-stage:
    - stage 1 `FROM node:22-alpine`: `WORKDIR /app`, `COPY package*.json ./`, `RUN npm ci`,
      `COPY . .`, `RUN npm run build`
    - stage 2 `FROM nginx:alpine`: `COPY nginx.conf /etc/nginx/conf.d/default.conf`,
      `COPY --from=0 /app/dist /usr/share/nginx/html`, `EXPOSE 4173`
    - remove `vite preview` CMD and node_modules-carrying final image.
    - Note: `.dockerignore` — if `src/client` has none, check whether `node_modules`/
      `dist` exist in the context and how large it is; add one if the build context drags
      `node_modules` in (build correctness is unaffected since `npm ci` reinstalls, but the
      context upload would be needlessly huge).
- [ ] 3. Update `docker-compose.live.yml` frontend service: no port change needed
      (`15173:4173` stays), `depends_on: backend` already right. Only if the nginx conf
      needs backend reachability hints, nothing changes elsewhere. Remove any implicit
      `vite preview` expectations in comments/README if present.
- [ ] 4. Remove `preview.allowedHosts` from `src/client/vite.config.ts` and update its
      comment (the live stack no longer serves via preview). Keep `server.proxy` — it is
      for local dev, unrelated.
- [ ] 5. Style the admin surfaces (issue-comment deliverable):
    - `App.tsx:242`: replace bare `<a href="/admin">Admin</a>` with a styled element
      (e.g. `Button` variant/`asChild`-style link or Tailwind classes consistent with the
      app); same for the "Back to chat" link at App.tsx:237.
    - `AdminView.tsx`: wrap content in a top-level layout consistent with the chat view
      (`flex h-dvh`, heading, panels), class its error/loading states, keep the existing
      test-observable text and roles intact (AdminView.test.tsx must keep passing).
- [ ] 6. Verify end-to-end:
    - `npm --prefix src/client run build` succeeds locally (vite build, no preview needed).
    - `docker compose -f docker-compose.live.yml build frontend` succeeds.
    - Run the live stack and check with curl: `200` on `/`, `/admin` (SPA fallback),
      immutable header on `/assets/index-*.js`, `no-cache` on `index.html`,
      `/api/...` proxied (401/redirect rather than 404), and a streaming request to
      `/api/chat/stream` arrives incrementally (buffering off).
    - `npm run ci`.

## Done checklist

Mirrors the implementation steps; each is a single deliverable commit:

- [ ] 1. nginx.conf written with cache headers + /api proxy (buffering off).
- [ ] 2. Dockerfile multi-stage node-build → nginx-serve; npm ci.
- [ ] 3. docker-compose.live.yml consistent with the nginx image (ports unchanged).
- [ ] 4. vite preview config removed from vite.config.ts.
- [ ] 5. AdminView styled + admin/back links styled, tests updated if needed.
- [ ] 6. E2E verification via docker compose curl checks + `npm run ci`.

## Open questions

1. **"Served along the file structure" — literal multi-entry HTML?** The issue phrase could
   mean literal per-path HTML files (`/admin/index.html`) via Vite multi-entry
   (`rollupOptions.input`). plan-15 recorded the owner choosing an in-SPA `/admin` route,
   and this plan assumes that (single HTML + hashed assets + `try_files`). If the owner
   wants literal per-path HTML files, step 1's `try_files` and the build config expand —
   this is the only open question with build-shape impact.
2. **Deploy host nginx**: lives outside this repo (`/opt/ajmoon/nginx/ajmoon.conf`) and
   targets 15173; plan keeps 15173 so no change is required there. Risk is only if the
   owner wants a different internal topology — flagged in the PR for visibility, not
   blocking.
3. **Verification depth for streaming**: confirming incremental delivery of
   `/api/chat/stream` through nginx needs either a scripted SSE client against the local
   stack or acceptance of manual observation. A script (curl + timestamps) is planned;
   if local/streaming specifics get messy, fall back to confirming `proxy_buffering off`
   is in effect and defer live-stream proof to deploy review.
