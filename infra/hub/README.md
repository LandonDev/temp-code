# temp-code hub

A host directory and webhook relay. It stores host metadata, credential hashes,
subscriptions, and delivery failure counts in two Durable Object classes, with
KV as a cold mirror (see "Storage and the KV quota"). It never stores thread
records, transcripts, or notification payloads. Notification title/body are transient;
callers should send a short status, not thread content. Timestamps use Unix
milliseconds.

## Run and check

```sh
cd infra/hub
npm ci
npm run typecheck
npm test
npx wrangler dev
```

For local dev, put `ADMIN_KEY` and `WEBHOOK_KEY` in an untracked `.dev.vars`.
The Workers Vitest pool runs against real local KV and Durable Objects. Tests
clear KV/object storage before each test. The Worker suite uses its own Vitest
version and does not change the app's test tools. The requested pool package has
been renamed upstream to `@cloudflare/vitest-plugin`; this package keeps the
requested name, with pinned tools and overrides checked by the suite.

The root `bun run hub:test` runs the isolated suite. Install this package first;
it does not share the app's dependencies. The root test glob excludes infra.

## Deploy

Deployed on 2026-10-19 as `temp-code-hub` at https://hub.landonhale.com (custom
domain only; `workers_dev = false`). KV namespace `05925489b5f946d7a654816415273207`.
`ADMIN_KEY`, `WEBHOOK_KEY` and the box's host token live in the Mac login
Keychain as `tempcode-hub-ADMIN_KEY`, `tempcode-hub-WEBHOOK_KEY` and
`tempcode-hub-host-box` (`security find-generic-password -a landon -s <name> -w`).
Host `box` is registered and its scaffold timer (`box-heartbeat.timer`) posts
every minute from `/etc/box-heartbeat.env`; the app's own heartbeat replaces it
once the host runs. The account needed a workers.dev subdomain before the first
deploy even with `workers_dev = false`; it was created through the API
(`PUT /accounts/<id>/workers/subdomain`).

Later deploys are `npx wrangler deploy` from `infra/hub` with wrangler logged
in as the account owner; the secrets stay on the Worker and migrations apply
on deploy (`v2`, the `Directory` class, went out on 2026-10-20). A fresh
account needs the namespace and secrets first:

```sh
cd infra/hub
npm ci
npx wrangler login
npx wrangler kv namespace create HUB_KV
```

Copy the returned namespace ID into `wrangler.toml`, then run:

```sh
npx wrangler secret put ADMIN_KEY
npx wrangler secret put WEBHOOK_KEY
npm run typecheck
npm test
npx wrangler deploy --dry-run
npx wrangler deploy
```

Use separate random 32-byte values for the two secrets (for example generate
with `openssl rand -hex 32`, and paste at each secret prompt). Keep `WEBHOOK_KEY`
stable: changing it makes existing encrypted subscription keys unreadable;
recreate the subscriptions to rotate it. `ADMIN_KEY` can rotate directly.

Suggested custom domain: `hub.landonhale.com`. The zone is already on
Cloudflare. After the workers.dev deployment succeeds, add this to
`wrangler.toml` and deploy again, or add the custom domain in the dashboard:

```toml
[[routes]]
pattern = "hub.landonhale.com"
custom_domain = true
```

## Storage and the KV quota

Two SQLite-backed Durable Object classes hold the state. Migration `v1` created
`HostState`, `v2` added `Directory`.

- `HostState`, one object per host: the token hash, the last heartbeat, the
  down flag, and the host's name, version and environment id. It owns liveness
  and serializes heartbeat and cron transitions under `blockConcurrencyWhile`,
  which [KV cannot do](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
  A heartbeat writes this object and nothing else.
- `Directory`, one object: the set of host ids, the subscriptions (secrets
  sealed) and their failure counters. The cron asks it for the host ids once a
  minute and checks each host's object; the host list and the fan-out read it;
  registration, deletion and subscription changes update it under
  `blockConcurrencyWhile`.

KV (`HUB_KV`) is a cold mirror of the directory: `host:<id>` holds the id,
`sub:<id>` the subscription, written when an entry is added or removed and
never read in steady state. A failed mirror write is logged and does not fail
the request. The mirror exists to rebuild the directory: the first read after
a fresh `Directory` object seeds it from those keys (two lists and one read per
subscription, once; the `seeded` marker ends it). A seed that cannot list,
because the day's quota is spent, is logged and retried on the next read, and
a host also joins the directory at its next heartbeat (`host.listed`), so the
live host `box` needed no re-registration when the directory shipped.

The account is on Workers Free: KV allows 1,000 list and 1,000 write
operations a day. Before the directory, the cron listed KV every minute and
every heartbeat rewrote the host record, which spent both quotas by the
afternoon (Oct 19: 1,006 lists, 1,004 reads, 849 writes; Oct 20 by 18:00 UTC:
1,075 lists, 1,074 reads, 910 writes) and then failed the cron and the
heartbeats for the rest of the UTC day. Expected now, per day: 0 lists, 0
reads, and one write per host registered or deleted and per subscription
created or deleted. Heartbeats at 30 s from several hosts cost KV nothing.

Cron runs every minute. A host becomes down after more than 180 seconds since
its last heartbeat (or registration if it has never sent one). Concurrent cron
checks emit one `host_down` transition; the first recovery heartbeat emits one
`host_up`. Transition state is saved before fan-out. This avoids duplicate
transitions on repeated cron runs; a crash between that save and fan-out can
lose an alert. Webhook transport is best effort, not exactly-once delivery.

## API

All responses are JSON, errors are `{ "error": "..." }`, and caches are disabled.
Missing credentials return 401 before parsing or storage access. Invalid host
credentials return 401; invalid admin keys use constant-time hash comparison.
Bodies are capped at 16 KiB. No CORS access is granted by default.

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| GET | `/healthz` | public | `{ ok: true }` |
| POST | `/v1/hosts` | `x-api-key: ADMIN_KEY` | `{ hostId, hostToken }` (201) |
| GET | `/v1/hosts` | admin | host array with lastSeen, alive, name, version, environmentId |
| DELETE | `/v1/hosts/:hostId` | admin | `{ ok: true }` |
| POST | `/v1/hosts/:hostId/heartbeat` | host Bearer token | `{ ok: true, serverTime }` |
| POST | `/v1/notify` | host Bearer token scoped to body hostId | `{ delivered, failed }` |
| POST | `/v1/subscriptions` | admin | subscription (201) |
| GET | `/v1/subscriptions` | admin | subscriptions with lastError and failureCount |
| DELETE | `/v1/subscriptions/:id` | admin | `{ ok: true }` |

Register with `{ "hostId": "box" }` (or `{}` for a generated ID). The raw
32-byte host token appears once; only its SHA-256 hash is stored, in the host
object (the KV mirror holds the id alone). Admin key material lives in a Worker
secret, never KV. Its hash is compared in constant time. Host tokens cannot call admin endpoints or act
for another host. Delete and register again to rotate a host token.

Heartbeat body:

```json
{ "environmentId": "box", "name": "Linux box", "version": "1.0.222", "startedAt": 1792386000000, "load": { "running": 2 } }
```

`load` is optional: at most 16 scalar fields and 1 KiB. Unknown fields are
stripped. Notification body:

```json
{ "event": "finished", "hostId": "box", "threadId": "thread-id", "title": "Build finished", "body": "Ready to review", "url": "https://example.com/thread", "ts": 1792386000000 }
```

Events: `needs_you`, `finished`, `failed`, `stuck`, `host_down`, `host_up`.
`threadId` and `url` are optional. Subscribe with:

```json
{ "name": "ChatGPT webhook", "kind": "webhook", "url": "https://receiver.example/hub", "secret": "shared-signing-secret", "events": ["finished", "stuck", "host_down", "host_up"], "hosts": ["box"] }
```

Omit `hosts` to match all hosts; `[]` matches none. `events` must be nonempty.
Only HTTPS endpoints without embedded credentials are accepted. Redirects fail.
Webhook keys are encrypted with AES-GCM using `WEBHOOK_KEY`, as agreed for this
thread; HMAC cannot use a one-way hash in place of the supplied signing key.
If `secret` is omitted, the API generates one and returns it once at creation.
Lists never return signing secrets or ciphertext. The `apns` union member is a
TODO; registration currently rejects it.

Each matching subscription runs in parallel. Deliveries have a 5-second timeout
per attempt, one initial attempt plus **three retries**, with 100/200/400 ms
backoff. `delivered`/`failed` count subscriptions, not attempts. Terminal failure
increments the subscription's cumulative failure count and stores a short error
code without URL/credential text. Successful sends preserve failure history.

Receivers must verify `x-hub-signature-256: sha256=<hex>` as HMAC-SHA256 over the
**exact raw JSON request bytes**, with their subscription secret. Use
constant-time comparison. `x-hub-delivery` is a UUID shared by all retries of
that delivery. Deduplicate it before acting. The body is the validated notify
payload, with no wrapper. No outbound payload is persisted.

## Host setup and thread E

The app is off by default. In the box app's systemd service, add:

```ini
[Service]
EnvironmentFile=/etc/temp-code/hub.env
```

Create that file with mode `0600`, readable by the service, containing:

```sh
TEMP_CODE_HUB_URL=https://hub.landonhale.com
TEMP_CODE_HUB_HOST_ID=box
TEMP_CODE_HUB_TOKEN=<token-returned-on-registration>
```

Then `sudo systemctl daemon-reload` and restart the app's service using its
actual unit name. Set all three variables; partial config stays off and logs
one setup message. Do not put a token in command-line arguments or logs.

The app sends an immediate heartbeat, then every 30 seconds with ±10% jitter.
It stops timers and aborts in-flight requests on shutdown. Heartbeat and notify
failures log only when each channel changes state. No error log includes URLs,
headers, tokens, or remote response bodies. HTTPS is required outside loopback.

The app's heartbeat supersedes A's `/usr/local/bin/box-heartbeat` scaffold once
the app runs. Leave that scaffold's timer disabled (or disable it if enabled);
it must not send a second heartbeat that masks an app outage.

`src/main/server/hub.ts` exports `startHub(options)` returning `{ notify, stop }`.
`startServer()` exposes the configured client as `RunningServer.hub`, or `null`
when off. Thread E should call:

```ts
await server.hub?.notify({
  event: 'needs_you', // or finished, failed, stuck
  threadId,
  title: 'Thread needs you',
  body: 'Ready for review',
  url // optional HTTPS deep link
})
```

The client supplies `hostId` and `ts`. It returns delivery counts, or `null` on
transport failure, partial config, or after stop. Avoid awaiting notification
network I/O in the thread execution path. E owns the event-to-notice mapping.
The startup wire uses the host ID as the stable environment ID until D1 provides
its server identity; pass that identity to `hubFromEnv` when it is available.
