# Muse Code fixtures (the spike of 2026-11-04, Muse Code 1.4.14-R7309.1, SDK 1.4.14)

Every line is `{ t, dir, … }`: `dir` is `command` (ours, before the ack),
`result` (the answer, with `method`), `error` (an MspError: code, kind,
message, data), `notification`, `server-request` or `stderr`. Recorded on
the Mac by `.temp-code/plan-R5k0vrmrvU4D/scripts/spike/turns.mjs` against a
scratch login (`TBH_CREDENTIAL_BACKEND=file`); no credential appears in any
file. The driver tests run against `harness/museFakeServe.mjs`, which speaks
these shapes; the catalog test reads `model-list.json` directly.

| file | what it holds |
|---|---|
| `handshake.jsonl` | `initialize` (experimental on), `permissionProfile/list` (the four profiles), `model/list` (the signed-in catalog), `usage/read` on a fresh host (`{}`), the `hook/list` and `skill/list` refusals without a sessionId |
| `model-list.json` | the `model/list` result alone: four rows, `isDefault` on muse-wonder-1.0, every `isActive` false, `variants` the ladder, `reasoningEffortVariants` the described tiers |
| `usage-read-fresh.json` | `usage/read` before any turn: `{}` |
| `turn-tool.jsonl` | `session/start` (`:ask-me`, `onRequest`), one turn with a `bash` tool call: `userMessage`, `reminderChild`, `agentMessage` with `text` deltas, `toolCall` with `output` deltas and the JSON receipt in `visibleOutput`, `session/tokenUsage`, `session/contextUsage`, `turn/foregroundCompleted`, `turn/completed`, then `usage/changed`; `usage/read` after it |
| `turn-ask.jsonl` | a `request_user_input` question: `userInput/requested` + the `userInput/request` server request, our `userInput/answer`, `userInput/settled` |
| `turn-approve.jsonl` | a network approval (`subject.kind: network`, host/port/protocol/origin; choices `allow_once`, `allow_session`, `allow_local_network`, `abort`, no `denied`) answered `abort`; `approval/resolved` |
| `turn-steer.jsonl` | `turn/steer` on a live turn (ack `{ status: accepted, turnId }`), the steered `userMessage` item carrying our `commandId` |
| `turn-cancel.jsonl` | `turn/cancel` mid-stream; `turn/completed { terminal: cancelled }` |
| `turn-resume.jsonl` | `session/resume` of the tool turn's session (its `path`, `modelId`), a bogus id's `-32020 sessionNotFound`, one turn on the resumed session |
| `turn-mcp.jsonl` | `session/start` with `config.mcpServers.spike_echo` (a stdio server, `env` interpolated, `MUSE_SESSION_ID` passed): the model calls `mcp__spike_echo__spike_ping`, which asks for approval under `:ask-me` (the run was stopped there) |
| `turn-usage.jsonl` | `usage/read` on a fresh host after earlier turns on the same config dir: `{}` (the observation is per process) |
| `base-url-stub.jsonl` | what `muse serve -c endpoint_transport.base_url="http://127.0.0.1:47311"` sent a logging stub: `GET /muse-code/models`, `POST /responses` (the Responses API, `Authorization: Bearer <api_key>` masked, `x-tbh-*` and `x-client-id` headers) |
