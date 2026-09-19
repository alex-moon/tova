# Fixing the asset-upload CORS failure on the `tova` Space

The live bug (issue #49): attaching a file in chat fails with "The upload to storage failed" and the browser logs `CORS Missing Allow Origin`.

## Diagnosis (verified, 2026-09-16)

- The frontend uploads directly to Spaces with a presigned PUT: `src/client/src/services/assets.ts` (`presign` → XHR `PUT` with an explicit `Content-Type` header → `confirm`).
- Bucket host: `https://tova.lon1.digitaloceanspaces.com` (bucket `tova`, region `lon1`).
- The Spaces CORS rule already allows origin `https://tova.ajmoon.com` and method `PUT`:
  - `OPTIONS` with `Origin: https://tova.ajmoon.com` + `Access-Control-Request-Method: PUT` → `200` with `access-control-allow-origin: https://tova.ajmoon.com`.
- Adding `Access-Control-Request-Headers: content-type` (what the browser sends because the XHR sets `Content-Type`) → `403 AccessDenied` with **no** `access-control-allow-origin` header.
- Root cause: the rule has no **Allowed Headers** entry, so preflights that request header permission fail.

## Fix

Add **`Content-Type`** to the rule's Allowed Headers ( Allowed Origins and Allowed Methods stay as they are).

### Option A — DO control panel

1. DigitalOcean → Spaces → the `tova` Space (region `lon1`).
2. **Settings** → **CORS Config** → Edit.
3. In the CORS XML inside the existing `<CORSRule>` block, add:

   ```xml
   <CORSAllowedHeader>Content-Type</CORSAllowedHeader>
   ```

   (or `<CORSAllowedHeader>*</CORSAllowedHeader>` if you prefer to allow all).

4. Save.

### Option B — CLI with a bucket-admin key

The repo's `DO_SPACES_KEY` is Space-scoped and cannot change the bucket CORS config (verified: `GetBucketCors`/`PutBucketCors` → 403). Use an account/bucket-admin key.

```sh
# See the current config (should show a rule missing AllowedHeader)
aws --endpoint-url https://lon1.digitaloceanspaces.com s3api get-bucket-cors \
  --bucket tova

# Apply the fix
aws --endpoint-url https://lon1.digitaloceanspaces.com s3api put-bucket-cors \
  --bucket tova \
  --cors-configuration '{
    "CORSRules": [
      {
        "AllowedOrigins": ["https://tova.ajmoon.com"],
        "AllowedMethods": ["PUT"],
        "AllowedHeaders": ["Content-Type"]
      }
    ]
  }'
```

Preserve any additional existing rules/origins when re-applying — merge the `AllowedHeaders` entry into the existing rule rather than replacing the whole config.

## Verify after applying

1. `OPTIONS https://tova.lon1.digitaloceanspaces.com/` with `Origin: https://tova.ajmoon.com`, `Access-Control-Request-Method: PUT`, `Access-Control-Request-Headers: content-type` → expect `200` + `access-control-allow-origin: https://tova.ajmoon.com`.
2. In the UI: attach a file; Network tab shows the PUT `200`, then `POST /api/assets/:id/confirm` returns `status: "ready"` (confirm is synchronous — no worker involved).
3. AssetLibrary attach buttons enable and attachment to a chat message works.

## Notes

- The "worker not running" hypothesis in the ticket is not applicable: assets transition `pending → ready` in the `confirm` route (`src/server/routes/assets.ts`); it was never reached because CORS blocked the PUT.
- The rule lists only `PUT`. Attach downloads navigate to presigned GET URLs (no browser fetch), so no CORS is involved today; add `GET, HEAD` only if client-side fetches of Space objects are ever added.
- The presigned PUT URL expires after 60s (`src/server/services/storageService.ts`); slow uploads may still fail post-CORS-fix — potential small follow-up to bump the TTL.
