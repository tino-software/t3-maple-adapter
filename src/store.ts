// Read-only view of T3's local orchestration store (statev2.sqlite).
//
// Two tables matter:
// - `orchestration_events`: append-only log with a monotonic `sequence`. Used
//   only as a change feed: which runs reached a terminal status since a cursor.
// - `orchestration_v2_projection_*`: the latest state of threads, runs,
//   provider turns and turn items. A finished turn is rebuilt from these.
import { Database } from "bun:sqlite"

export type Json = Record<string, any>

export interface Turn {
  readonly thread: Json
  readonly run: Json
  readonly providerTurns: ReadonlyArray<Json>
  readonly items: ReadonlyArray<Json>
}

export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"])

export class Store {
  private readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { readonly: true })
    this.db.exec("PRAGMA busy_timeout = 5000")
  }

  close() {
    this.db.close()
  }

  maxSequence(): number {
    const row = this.db.query("SELECT max(sequence) AS s FROM orchestration_events").get() as {
      s: number | null
    }
    return row.s ?? 0
  }

  /**
   * Runs that reached a terminal status after `after`. Reads up to a fixed end sequence, so an
   * event committed between the two queries is left for the next call instead of skipped.
   */
  finishedRunsSince(after: number, limit = 5_000): { runIds: string[]; cursor: number } {
    const end = Math.max(after, this.maxSequence())
    const rows = this.db
      .query(
        `SELECT sequence, json_extract(payload_json, '$.id') AS runId,
                json_extract(payload_json, '$.status') AS status
           FROM orchestration_events
          WHERE sequence > ? AND sequence <= ? AND event_type = 'run.updated'
          ORDER BY sequence LIMIT ?`,
      )
      .all(after, end, limit) as Array<{ sequence: number; runId: string; status: string }>
    const runIds = [...new Set(rows.filter((r) => TERMINAL_RUN_STATUSES.has(r.status)).map((r) => r.runId))]
    const cursor = rows.length === limit ? rows.at(-1)!.sequence : end
    return { runIds, cursor }
  }

  runIdsForThread(threadId: string): string[] {
    return (
      this.db
        .query("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal")
        .all(threadId) as Array<{ run_id: string }>
    ).map((r) => r.run_id)
  }

  runIdsCompletedSince(iso: string): string[] {
    return (
      this.db
        .query(
          `SELECT run_id FROM orchestration_v2_projection_runs
            WHERE completed_at >= ? AND status IN ('completed', 'failed', 'interrupted', 'cancelled')
            ORDER BY completed_at`,
        )
        .all(iso) as Array<{ run_id: string }>
    ).map((r) => r.run_id)
  }

  projectTitle(projectId: string): string | undefined {
    const row = this.db.query("SELECT title FROM projection_projects WHERE project_id = ?").get(projectId) as
      | { title: string }
      | null
    return row?.title
  }

  loadTurn(runId: string): Turn | undefined {
    const run = this.json("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id = ?", runId)
    if (!run) return undefined
    const thread = this.json(
      "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?",
      run.threadId,
    )
    const items = this.jsonAll(
      "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE run_id = ? ORDER BY ordinal",
      runId,
    )
    const turnIds = [...new Set(items.map((i) => i.providerTurnId).filter(Boolean))]
    const providerTurns = turnIds.flatMap((id) =>
      this.jsonAll(
        "SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id = ?",
        id,
      ),
    )
    return { thread: thread ?? { id: run.threadId, title: "" }, run, providerTurns, items }
  }

  private json(sql: string, arg: string): Json | undefined {
    const row = this.db.query(sql).get(arg) as { payload_json: string } | null
    return row ? JSON.parse(row.payload_json) : undefined
  }

  private jsonAll(sql: string, arg: string): Json[] {
    return (this.db.query(sql).all(arg) as Array<{ payload_json: string }>).map((r) =>
      JSON.parse(r.payload_json),
    )
  }
}
