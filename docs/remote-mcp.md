# temp-code over MCP — the page to hand a bot

Paste this to Grok, ChatGPT or any MCP client that should start, steer and watch
temp-code threads.

## Connect

- Endpoint: `https://tempcode.landonhale.com/mcp` (MCP streamable HTTP, JSON-RPC
  over POST; the server answers in the response, no server stream).
- Auth: header `x-api-key: tc_…` (or `Authorization: Bearer tc_…`). The key is a
  bot key (audience `mcp`) made in temp-code under Settings → Remote access →
  New key → Bot (MCP). Keys can be revoked there at any time.
- Limits: 120 calls a minute per key, 256 KiB per request body. A refused call
  comes back as a tool result starting with `error:` so you can read why.
- Claude Code: `claude mcp add --transport http temp-code https://tempcode.landonhale.com/mcp --header "x-api-key: tc_…"`.

## Words

- **Repo**: a git checkout temp-code knows (`list_projects` names them).
  **Project**: a line of work inside a repo, on a branch or worktree.
  **Session**: one thread of an agent (Claude or Codex) working in a project.
- **Status** of a session is one of `working` (the agent is busy), `waiting`
  (it stopped for a human: a question, a plan approval or a permission
  request), `failed` (the turn died or an account needs sign-in), `done` (idle,
  ready for the next message). `state` carries temp-code's own finer word.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Repos and the projects inside each, with branch and path. |
| `list_sessions` | Sessions, working first: id, title, repo, project, branch, model, status, pending prompt kind, queued messages, last activity. Filter by `repo`, `project`, `status`, `archived`; page with `cursor`. |
| `start_session` | `repo` + `prompt`, optional `model` (`claude`, `codex`, or a model id), `reasoning`, `branch` (its own worktree, made when new), `project`, `type` (`implementation` default, `chat`, `planning`, `research`), `title`, `permission` (`safe`, `edits` default). Returns the new session row, already working. |
| `send_message` | `session` + `text`; `when`: `after_turn` (default: queued behind the current turn, sent at once if idle), `now` (steer the running turn), `interrupt` (stop the turn, then send). |
| `get_session` | The row plus pending prompts, the queue, task progress, what it is doing, what it last said, the error when it failed. |
| `get_transcript` | A page of lines: `#seq user: …`, `#seq assistant: …`, `#seq tool Bash: …`, `#seq result: …`, `#seq PERMISSION id: …`, `#seq QUESTION id: …`, `#seq — turn complete —`. Newest first by default (`limit` blocks, about a turn). |
| `list_pending` | Prompts waiting on a human across sessions (or one `session`): kind, request id, the question or the tool, and whether this key may answer. |
| `respond` | `session` + `requestId`; a question takes `answers` (one array of chosen labels per question) or `answer`; a plan prompt takes `allow`. |
| `stop_session` | Stops the running turn and every subagent; the session stays. |
| `archive_session` | Archives (stops first); `archived: false` restores. |
| `get_diff` | Changed files in the session's working tree with line counts and the branch; with `path`, that file's unified diff. |

Large tool outputs are summarised in the transcript (first line, line count,
size). Page older with `before: firstSeq`, newer with `after: lastSeq`; a page
reports `moreBefore` / `moreAfter`, and `reset: true` means the gap was too
large and you got a fresh tail. Pages are capped at `chars` (16 000 default).

## What the key cannot do

A bot key is capped at read + operate. It can start, message, stop and archive
sessions and answer questions and plan prompts. It cannot approve a
**permission request** (a tool the agent wants to run under a `safe` or `edits`
policy): `respond` says so, names the thread and the tool, and the right move is
to tell the user to answer it in temp-code. It also cannot start a session with
`permission: auto`, read files or run git itself, or manage keys.

## Webhook

If the key was made with a webhook URL, temp-code posts one JSON body per
transition of a session (roots only; a subagent's prompt is reported on its
root):

```json
{ "event": "finished", "hostId": "box", "threadId": "VHgjJIsQkQEz", "title": "Ship it", "body": "Finished its turn", "url": "https://tempcode.landonhale.com/ui#thread=VHgjJIsQkQEz", "ts": 1792386000000 }
```

Events: `needs_you` (a permission or question appeared; the body names it),
`finished` (the turn ended with nothing pending), `failed` (an error ended the
turn, or an account needs sign-in), `stuck` (no activity for N minutes while
working, 10 by default). One notice per transition; the same state is never
reported twice. Headers: `x-hub-signature-256: sha256=<hex>` is HMAC-SHA256 of
the exact request bytes with the key's signing secret (shown once when the key
was made); `x-hub-delivery` is a UUID shared by the one retry. Verify the
signature in constant time and deduplicate on the delivery id. The same payload
arrives through the hub at hub.landonhale.com when a subscription exists there.
