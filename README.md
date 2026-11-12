# t3-maple-adapter

Exports finished [T3 Code](https://github.com/pingdotgg/t3code) turns to
[Maple Agent Sessions](https://app.maple.dev/agent-sessions) as OpenTelemetry GenAI spans.
Each user turn becomes one trace: an `invoke_agent` root, a `chat` span per model response,
and an `execute_tool` span per tool call. Maple groups them into sessions by T3 thread.

It runs beside T3, not inside it: no T3 patch, no plugin, nothing written to T3's files.

<!-- SCREENSHOT PLACEHOLDER: a Maple Agent Sessions screenshot goes here once it has been
     uploaded through GitHub's image upload (not committed to git). -->
> **Screenshot:** _not added yet._

> [!WARNING]
> This reads T3 Code's **internal** SQLite database (`statev2.sqlite`), opened read-only.
> That schema is not a public API. A T3 update, especially a Nightly build, can rename tables
> or fields, and the adapter then stops exporting until it is updated. T3 itself is never
> affected. After updating T3, check with `bun src/main.ts backfill --since 1h --dry-run`.

## Requirements

- macOS or Linux with T3 Code installed (desktop or server) and its data in `~/.t3/userdata`.
- [Bun](https://bun.sh) **1.4 or newer**. `bun.lock` uses lockfile version 2, which older Bun
  releases (1.3.x, for example) can't parse. Run `bun upgrade` first. `package.json` pins
  `packageManager: bun@1.4.4`, the version this is tested on.
- A Maple OTLP traces endpoint and ingest key.

## Setup

```sh
git clone https://github.com/tino-software/t3-maple-adapter
cd t3-maple-adapter
bun install
```

The adapter uses the same OTLP settings T3 uses for its own telemetry. Put them in
`~/.t3/userdata/otel.env` (mode `600`) if they aren't there already:

```sh
T3CODE_OTLP_TRACES_URL=https://<your-maple-ingest-host>/v1/traces
T3CODE_OTLP_HEADERS=Authorization=Bearer%20<your-maple-ingest-key>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=laptop
```

Or skip `otel.env` and set `T3_MAPLE_TRACES_URL` / `T3_MAPLE_OTLP_HEADERS` instead. See
[`.env.example`](.env.example). Bun also loads a `.env` in the working directory, and
`.env` is git-ignored.

Try it without sending anything:

```sh
bun src/main.ts backfill --since 2h --dry-run
```

## Usage

```sh
bun src/main.ts watch                         # tail new turns until stopped
bun src/main.ts backfill --since 24h          # export turns finished in the last 24h (m/h/d or ISO date)
bun src/main.ts backfill --thread <threadId>  # export every turn of one thread (repeatable)
bun src/main.ts show --run <runId>            # print the mapped spans as JSON, export nothing
```

Add `--dry-run` to `backfill` to map without exporting.

`watch` starts at the current end of T3's event log the first time, so it exports nothing
from the past. It stores its cursor and the ids of exported runs in a state file, and
resumes from there after a restart. To export older turns, use `backfill`. `backfill` doesn't
check the state file, so running it twice sends the same spans twice. The trace and span ids
are deterministic, so they repeat too.

## Configuration

All settings are environment variables. Values in `otel.env` are read too, and the process
environment takes precedence.

| Variable | Default | Purpose |
|---|---|---|
| `T3_MAPLE_TRACES_URL` | `T3CODE_OTLP_TRACES_URL` from `otel.env` | OTLP/HTTP traces endpoint |
| `T3_MAPLE_OTLP_HEADERS` | `T3CODE_OTLP_HEADERS` from `otel.env` | `k=v,k2=v2`, values percent-encoded |
| `T3_MAPLE_CAPTURE_CONTENT` | `1` | `0` drops prompts, replies, reasoning and tool input/output. Only metadata is sent: timings, names, models, tokens, status |
| `T3_MAPLE_MAX_CONTENT_CHARS` | `16000` | Clip each captured string to this length |
| `T3_MAPLE_EXCLUDE_PROJECTS` | (none) | Comma-separated T3 project ids or titles that are never exported |
| `T3_MAPLE_HOST` | `os.hostname()` | `host.name` resource attribute |
| `OTEL_RESOURCE_ATTRIBUTES` | (none) | Only `deployment.environment.name` is used; defaults to `unknown` |
| `T3_MAPLE_POLL_MS` | `5000` | `watch` poll interval |
| `T3_HOME` | `~/.t3/userdata` | T3 data directory |
| `T3_MAPLE_DB` | `$T3_HOME/statev2.sqlite` | T3 database (opened read-only) |
| `T3_MAPLE_OTEL_ENV` | `$T3_HOME/otel.env` | Env file with the OTLP settings. Optional if the variables above are set |
| `T3_MAPLE_STATE` | `~/.local/state/t3-maple-adapter/state.json` | `watch` cursor and exported run ids (mode `600`, holds no secrets) |

**Privacy.** With content capture on (the default), full prompts, assistant replies,
reasoning, shell commands and their output, and tool arguments and results all go to Maple.
For anything sensitive, set `T3_MAPLE_CAPTURE_CONTENT=0`, or list the project in
`T3_MAPLE_EXCLUDE_PROJECTS`.

**Secrets.** The ingest key stays in memory. Logs print header names only, never values, and
the traces URL without its query string. Nothing secret is written to the state file.

## Run as a macOS LaunchAgent

[`launchd/example.plist`](launchd/example.plist) runs `watch` at login and restarts it if it
exits. launchd doesn't expand `~` or `$HOME`, so fill in the placeholders when you install it:

```sh
LABEL=dev.t3-maple-adapter
mkdir -p ~/Library/Logs/t3-maple-adapter
sed -e "s|__HOME__|$HOME|g" -e "s|__REPO__|$PWD|g" launchd/example.plist \
  > ~/Library/LaunchAgents/$LABEL.plist
# edit T3_MAPLE_HOST and T3_MAPLE_EXCLUDE_PROJECTS in that file, then:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$LABEL.plist

launchctl print gui/$(id -u)/$LABEL | grep -E 'state|pid'   # status
tail -f ~/Library/Logs/t3-maple-adapter/stderr.log           # logs
launchctl kickstart -k gui/$(id -u)/$LABEL                   # restart after pulling changes
launchctl bootout gui/$(id -u)/$LABEL                        # uninstall
```

Keep the Maple key in `otel.env`, not in the plist. Restarting the agent keeps the state file,
so `watch` resumes from its cursor and doesn't re-export old turns.

## How it works

**Change feed.** `orchestration_events` is T3's append-only event log. Its `sequence` column
only grows, so it serves as the resume cursor. `watch` looks for `run.updated` events whose
status is terminal (`completed`, `failed`, `interrupted` or `cancelled`).

**Turn contents.** A finished run is rebuilt from the `orchestration_v2_projection_*` tables:
`threads`, `runs` (one per user turn), `provider_turns` (token usage) and `turn_items`
(messages, reasoning, tool calls).

**Span shape.**

```
invoke_agent t3-<providerInstance>   INTERNAL  root, one trace per turn
├─ chat <model>                       CLIENT    one per reconstructed model response
└─ execute_tool <tool>                INTERNAL  shell, mcp__*, web_search, file_change, file_search, subagent
```

- Every span carries `gen_ai.operation.name`, `gen_ai.conversation.id` (the T3 thread id),
  `gen_ai.provider.name`, `gen_ai.agent.name`, `gen_ai.request.model`, and `t3.*` ids.
  Maple derives `maple_ai.session.id` from `gen_ai.conversation.id`.
- Resource: `service.name=t3-maple-adapter`, `host.name`, `deployment.environment.name`.
- The turn's token usage (input including cache, cache read and write, output, reasoning) is
  on the last `chat` span, so Maple doesn't double count when it sums per-call usage.
- Failed runs, failed or cancelled tools, and shell commands that exit nonzero set
  `error.type` and ERROR status.
- Trace and span ids are sha256 hashes of T3's run and item ids. Timestamps are T3's own
  item times.

**Why not T3's WebSocket API or logs?** The local WebSocket API only offers a subscription
per thread: no global tail, no resume cursor, and it needs a paired session token. The
provider logs are each provider's own wire format and rotate. SQLite is the only source that
is global, resumable and needs no credentials.

## Limitations

- **Model calls are reconstructed.** T3 doesn't store individual API calls. A `chat` span is
  a run of reasoning and assistant items plus the tool calls they emitted. Counts and order
  are right; durations are approximate.
- **Usage is per turn**, not per call. Providers that report no usage (for example a
  delegated Codex run with `usageStatus: unavailable`) export no token counts.
- **No cost**, system prompt, tool definitions or time to first token. T3 doesn't store them.
- **Subagents are flat.** A `subagent` tool span carries the `childThreadId`, but the child
  thread exports as its own session, not nested under the parent trace.
- **Turns export when they finish**, not while they run.
- Tested with the Claude and Codex providers.

## Development

```sh
bun install
bun test
bun run typecheck
```

`src/spans.ts` is the pure mapping from a turn to spans, and is where most of the tests are.
`src/store.ts` holds every SQL query against T3. When a T3 update breaks the adapter, the
fix goes in that file.

## License

[MIT](LICENSE)
