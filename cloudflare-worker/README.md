# Cloudflare signaling migration

This directory contains an isolated Cloudflare Workers + Durable Objects implementation of the current signaling service.

## Safety

- This migration is on the `cloudflare-durable-objects-migration` branch.
- It does not change the existing Node.js server, the frontend endpoint, or Supabase.
- Do not merge this branch into `main` until staging tests pass.
- Do not put the Supabase service-role key here. The Worker uses the public anon/publishable key together with each user's own access token.

## Cloudflare setup

Deploy this directory as the Worker root (not the repository root):

- Worker entrypoint: `src/index.js`
- Wrangler config: `wrangler.jsonc`
- Durable Object binding: `MATCHMAKER`
- Durable Object class: `Matchmaker`

Add this Worker secret in Settings > Variables and Secrets:

- `SUPABASE_ANON_KEY`: the existing Supabase anon/public key for project `btkcubibosbtpxcronnd`

The project URL is already configured as a non-secret variable in `wrangler.jsonc`.

## Endpoints

- `GET /health` — deployment/build health response
- `GET /api/live` — authenticated list of currently matched users
- `GET /api/live/frame/:userId` — latest cached JPEG frame, if present
- `GET /?access_token=...` with WebSocket Upgrade — authenticated signaling connection

The WebSocket message protocol retains the existing event names: `connected`, `find`, `leave`, `next`, `matched`, `partner_left`, `sdp`, `ice`, `age_restricted`, `banned`, `auth_error`, `frame`, `report`, `report_ack`, and `reported`.

## Important staging requirement

The frontend still points to the existing Belmo hostname. Do not change it until the Cloudflare Worker has been deployed and the following have been tested with separate adult test accounts:

1. `/health` returns build `cloudflare-migration-v1`.
2. A valid Supabase access token can establish a WebSocket connection.
3. An adult account passes the authenticated `get_dob` and `is_user_banned` checks.
4. An under-18 account is rejected with `age_restricted`.
5. Two different adult accounts match and exchange WebRTC offer/answer/ICE messages.
6. `/api/live` returns authenticated live-user rows.
7. Leave, next, disconnect, and report flows work.

The free Durable Objects quota is finite. Monitor Cloudflare usage before production cutover.
