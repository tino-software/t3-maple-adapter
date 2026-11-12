#!/usr/bin/env bun
// t3-maple-adapter: export finished T3 turns to Maple Agent Sessions.
//
//   bun src/main.ts backfill --thread <threadId> [--thread …] [--dry-run]
//   bun src/main.ts backfill --since 2h [--dry-run]
//   bun src/main.ts watch                 # tail new turns, ad hoc (Ctrl-C to stop)
//   bun src/main.ts show --run <runId>    # print mapped spans as JSON, no export
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parseArgs } from "node:util"
import { Effect, Schedule } from "effect"
import { describeConfig, loadConfig, type Config } from "./config"
import { exportSpans } from "./otlp"
import { turnToSpans, type SpanRecord } from "./spans"
import { Store } from "./store"

interface State {
  cursor: number
  exported: string[]
  /** Runs whose export failed or whose items weren't projected yet: run id -> attempts. */
  pending?: Record<string, number>
}

const MAX_REMEMBERED_RUNS = 5_000
const MAX_ATTEMPTS = 20

function readState(path: string): State | undefined {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, "utf8"))
}

function writeState(path: string, state: State) {
  mkdirSync(dirname(path), { recursive: true })
  const trimmed = { ...state, exported: state.exported.slice(-MAX_REMEMBERED_RUNS) }
  writeFileSync(path, JSON.stringify(trimmed, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
}

const summarize = (runId: string, spans: ReadonlyArray<SpanRecord>) => {
  const root = spans[0]!
  const count = (op: string) => spans.filter((s) => s.attributes["gen_ai.operation.name"] === op).length
  return [
    `conv=${root.attributes["gen_ai.conversation.id"]}`,
    `run=${root.attributes["t3.run.ordinal"]}`,
    `start=${new Date(root.startMs).toISOString()}`,
    `agent=${root.attributes["gen_ai.agent.name"]}`,
    `model=${root.attributes["gen_ai.request.model"] ?? "?"}`,
    `chat=${count("chat")} tools=${count("execute_tool")}`,
    `trace=${root.traceId}`,
  ].join(" ")
}

type Outcome = "done" | "retry"

/** "done": exported, excluded, or dry-run. "retry": not projected yet, or the export failed. */
const exportRuns = (store: Store, config: Config, runIds: ReadonlyArray<string>, dryRun: boolean) =>
  Effect.forEach(
    runIds,
    (runId) =>
      Effect.gen(function* () {
        const turn = store.loadTurn(runId)
        if (!turn || turn.items.length === 0) {
          yield* Effect.logInfo(`run ${runId} has no items yet`)
          return [runId, "retry"] as const
        }
        const projectId: string = turn.thread.projectId ?? ""
        if (config.excludeProjects.has(projectId) || config.excludeProjects.has(store.projectTitle(projectId) ?? "")) {
          yield* Effect.logInfo(`skipped excluded project for run ${runId}`)
          return [runId, "done"] as const
        }
        const spans = turnToSpans(turn, config)
        const result = dryRun ? undefined : yield* exportSpans(spans, config)
        yield* Effect.logInfo(
          `${result ? `exported(${result.status}, ${result.accepted} spans)` : "dry-run"} ${summarize(runId, spans)}`,
        )
        return [runId, "done"] as const
      }).pipe(
        Effect.catch((e) =>
          Effect.logWarning(`run ${runId} failed: ${e.message}`).pipe(Effect.as([runId, "retry"] as const)),
        ),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((results) => new Map<string, Outcome>(results)))

const parseSince = (raw: string): string => {
  const m = /^(\d+)([mhd])$/.exec(raw)
  if (!m) return new Date(raw).toISOString()
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"]
  return new Date(Date.now() - Number(m[1]) * unit).toISOString()
}

const watch = (store: Store, config: Config) =>
  Effect.gen(function* () {
    let state = readState(config.statePath) ?? { cursor: store.maxSequence(), exported: [] }
    writeState(config.statePath, state)
    yield* Effect.logInfo(`watching from sequence ${state.cursor} (${state.exported.length} runs already exported)`)
    const tick = Effect.gen(function* () {
      const { runIds, cursor } = store.finishedRunsSince(state.cursor)
      const pending = { ...state.pending }
      const exported = new Set(state.exported)
      const candidates = [...new Set([...Object.keys(pending), ...runIds])].filter((id) => !exported.has(id))
      const outcomes = yield* exportRuns(store, config, candidates, false)
      const done: string[] = []
      for (const [runId, outcome] of outcomes) {
        if (outcome === "done") {
          done.push(runId)
          delete pending[runId]
          continue
        }
        const attempts = (pending[runId] ?? 0) + 1
        if (attempts < MAX_ATTEMPTS) pending[runId] = attempts
        else {
          delete pending[runId]
          yield* Effect.logWarning(`giving up on run ${runId} after ${attempts} attempts`)
        }
      }
      state = { cursor, exported: [...state.exported, ...done], pending }
      writeState(config.statePath, state)
    })
    yield* tick.pipe(
      Effect.catch((e) => Effect.logWarning(`tick failed: ${String(e)}`)),
      Effect.repeat(Schedule.spaced(`${config.pollMs} millis`)),
    )
  })

const main = Effect.gen(function* () {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      thread: { type: "string", multiple: true },
      run: { type: "string" },
      since: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  })
  const config = loadConfig()
  const store = new Store(config.dbPath)
  yield* Effect.logInfo(describeConfig(config))
  switch (positionals[0]) {
    case "backfill": {
      const runIds = [
        ...(values.thread ?? []).flatMap((t) => store.runIdsForThread(t)),
        ...(values.since ? store.runIdsCompletedSince(parseSince(values.since)) : []),
      ]
      if (runIds.length === 0) return yield* Effect.logWarning("no runs matched")
      const outcomes = yield* exportRuns(store, config, runIds, values["dry-run"]!)
      const done = [...outcomes.values()].filter((o) => o === "done").length
      yield* Effect.logInfo(`${done}/${runIds.length} runs ${values["dry-run"] ? "mapped" : "exported"}`)
      return
    }
    case "show": {
      const turn = values.run ? store.loadTurn(values.run) : undefined
      if (!turn) return yield* Effect.logWarning("run not found")
      console.log(JSON.stringify(turnToSpans(turn, config), null, 2))
      return
    }
    case "watch":
      return yield* watch(store, config)
    default:
      console.error("usage: main.ts backfill --thread <id> | --since 2h [--dry-run] | watch | show --run <id>")
      process.exitCode = 2
  }
})

Effect.runPromise(main).catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
