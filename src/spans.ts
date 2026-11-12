// Pure mapping: one finished T3 run (a user turn) -> OTel GenAI spans.
//
//   invoke_agent <agent>      INTERNAL, root, one per run (trace per turn)
//   ├─ chat <model>           CLIENT, one per model response (see segment())
//   └─ execute_tool <tool>    INTERNAL, one per tool-like turn item
//
// T3 does not persist per-API-call records, so model calls are reconstructed
// from item order: a model response is a run of reasoning/assistant items plus
// the tool calls it emitted; it ends where its first tool starts, and the next
// response starts when that batch of tools has finished.
import { createHash } from "node:crypto"
import type { Json, Turn } from "./store"

export const SpanKind = { INTERNAL: 0, CLIENT: 2 } as const
export const StatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const

export type AttrValue = string | number | boolean | ReadonlyArray<string>

export interface SpanRecord {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly name: string
  readonly kind: number
  readonly startMs: number
  readonly endMs: number
  readonly attributes: Record<string, AttrValue>
  readonly status: { code: number; message?: string }
}

export interface MapOptions {
  readonly captureContent: boolean
  readonly maxContentChars: number
}

const MODEL_OUTPUT_TYPES = new Set(["assistant_message", "reasoning"])
const TOOL_TYPES = new Set([
  "command_execution",
  "dynamic_tool",
  "web_search",
  "file_change",
  "file_search",
  "subagent",
])

const hex = (input: string, chars: number) =>
  createHash("sha256").update(input).digest("hex").slice(0, chars)

const ms = (iso: string | null | undefined): number | undefined => {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}

const clip = (value: unknown, max: number): unknown => {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
  if (Array.isArray(value)) return value.map((v) => clip(v, max))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, max)]))
  return value
}

export function providerName(driver: string | undefined, model: string | undefined): string {
  const m = (model ?? "").toLowerCase()
  if (m.includes("/")) return m.split("/")[0]!
  if (m.startsWith("claude")) return "anthropic"
  if (/^(gpt|o\d|codex)/.test(m)) return "openai"
  if (m.startsWith("gemini")) return "gcp.gemini"
  if (m.startsWith("grok")) return "x_ai"
  switch (driver) {
    case "claudeAgent":
      return "anthropic"
    case "codex":
    case "fx":
      return "openai"
    default:
      return driver ?? "unknown"
  }
}

export function toolName(item: Json): string {
  switch (item.type) {
    case "dynamic_tool":
      return String(item.toolName ?? "tool")
    case "command_execution":
      return "shell"
    default:
      return String(item.type)
  }
}

function toolArgs(item: Json): unknown {
  switch (item.type) {
    case "command_execution":
      return { command: item.input }
    case "dynamic_tool":
      return item.input
    case "web_search":
      return { patterns: item.patterns }
    case "file_change":
      return { file: item.fileName }
    case "file_search":
      return { pattern: item.pattern }
    case "subagent":
      return {
        prompt: item.prompt,
        driver: item.driver,
        providerInstanceId: item.providerInstanceId,
        childThreadId: item.childThreadId,
      }
    default:
      return item.input
  }
}

function toolResult(item: Json): unknown {
  switch (item.type) {
    case "command_execution":
      return { output: item.output, exitCode: item.exitCode }
    case "web_search":
    case "file_search":
      return item.results
    case "file_change":
      return item.diffStr
    case "subagent":
      return item.result
    default:
      return item.output
  }
}

function toolError(item: Json): string | undefined {
  if (item.status === "failed") return "tool_failed"
  if (item.status === "cancelled" || item.status === "interrupted") return `tool_${item.status}`
  if (item.type === "command_execution" && typeof item.exitCode === "number" && item.exitCode !== 0)
    return "nonzero_exit"
  return undefined
}

interface Segment {
  readonly startMs: number
  readonly outputs: Json[]
  readonly tools: Json[]
}

/** Split the run's items into model responses. */
export function segment(items: ReadonlyArray<Json>, runStartMs: number): Segment[] {
  const ordered = [...items]
    .filter((i) => MODEL_OUTPUT_TYPES.has(i.type) || TOOL_TYPES.has(i.type))
    .sort((a, b) => (ms(a.startedAt) ?? 0) - (ms(b.startedAt) ?? 0) || a.ordinal - b.ordinal)
  const segments: Segment[] = []
  let current: Segment = { startMs: runStartMs, outputs: [], tools: [] }
  for (const item of ordered) {
    if (MODEL_OUTPUT_TYPES.has(item.type) && current.tools.length > 0) {
      segments.push(current)
      const toolsDone = Math.max(...current.tools.map((t) => ms(t.completedAt) ?? ms(t.startedAt) ?? 0))
      current = { startMs: Math.max(current.startMs, toolsDone), outputs: [], tools: [] }
    }
    ;(TOOL_TYPES.has(item.type) ? current.tools : current.outputs).push(item)
  }
  if (current.outputs.length + current.tools.length > 0) segments.push(current)
  return segments
}

function turnUsage(providerTurns: ReadonlyArray<Json>): Record<string, number> | undefined {
  const usages = providerTurns
    .map((t) => t.turnTokenUsage)
    .filter((u) => u && u.usageStatus === "complete")
  if (usages.length === 0) return undefined
  const sum = (key: string) => usages.reduce((n, u) => n + (Number(u[key]) || 0), 0)
  const out: Record<string, number> = {
    "gen_ai.usage.input_tokens": sum("inputTokens"),
    "gen_ai.usage.output_tokens": sum("outputTokens"),
    "gen_ai.usage.cache_read.input_tokens": sum("cachedInputTokens"),
    "gen_ai.usage.cache_creation.input_tokens": sum("cacheCreationTokens"),
    "gen_ai.usage.reasoning.output_tokens": sum("reasoningTokens"),
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v > 0))
}

const textMessage = (role: string, text: string) => ({ role, parts: [{ type: "text", content: text }] })

export function turnToSpans(turn: Turn, opts: MapOptions): SpanRecord[] {
  const { thread, run, items, providerTurns } = turn
  const json = (value: unknown) => JSON.stringify(clip(value, opts.maxContentChars)) ?? "null"
  const driver: string | undefined =
    providerTurns[0]?.nativeTurnRef?.driver ?? items.find((i) => i.nativeItemRef)?.nativeItemRef?.driver
  const providerInstanceId: string = run.providerInstanceId ?? driver ?? "unknown"
  const usageModels: string[] = providerTurns.flatMap((t) => t.turnTokenUsage?.models ?? [])
  const requestedModel: string | undefined = run.modelSelection?.model
  const model = requestedModel && requestedModel !== "default" ? requestedModel : (usageModels[0] ?? requestedModel)
  const provider = providerName(driver ?? providerInstanceId, model)
  const agentName = `t3-${providerInstanceId}`

  const traceId = hex(`t3-maple:trace:${run.id}`, 32)
  const rootId = hex(`t3-maple:span:${run.id}`, 16)
  const itemEnds = items.map((i) => ms(i.completedAt) ?? ms(i.updatedAt) ?? 0)
  const startMs = ms(run.startedAt) ?? ms(run.requestedAt) ?? Math.min(...items.map((i) => ms(i.startedAt) ?? Infinity))
  const endMs = Math.max(startMs, ms(run.completedAt) ?? Math.max(startMs, ...itemEnds))

  const common: Record<string, AttrValue> = {
    "gen_ai.conversation.id": thread.id ?? run.threadId,
    "gen_ai.provider.name": provider,
    "gen_ai.agent.name": agentName,
    "t3.thread.id": run.threadId,
    "t3.run.id": run.id,
    "t3.run.ordinal": Number(run.ordinal ?? 0),
    "t3.provider_instance": providerInstanceId,
    ...(model ? { "gen_ai.request.model": model } : {}),
    ...(thread.projectId ? { "t3.project.id": thread.projectId } : {}),
  }

  const userText = items
    .filter((i) => i.type === "user_message" && typeof i.text === "string")
    .map((i) => i.text as string)
  const assistantTexts = items.filter((i) => i.type === "assistant_message" && i.text)
  const finalText: string | undefined = assistantTexts.at(-1)?.text

  const runFailed = run.status === "failed"
  const root: SpanRecord = {
    traceId,
    spanId: rootId,
    parentSpanId: undefined,
    name: `invoke_agent ${agentName}`,
    kind: SpanKind.INTERNAL,
    startMs,
    endMs,
    attributes: {
      ...common,
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": providerInstanceId,
      "gen_ai.response.status": String(run.status),
      ...(thread.title ? { "t3.thread.title": thread.title } : {}),
      ...(runFailed ? { "error.type": "run_failed" } : {}),
      ...(opts.captureContent && userText.length
        ? { "gen_ai.input.messages": json(userText.map((t) => textMessage("user", t))) }
        : {}),
      ...(opts.captureContent && finalText
        ? { "gen_ai.output.messages": json([{ ...textMessage("assistant", finalText), finish_reason: "stop" }]) }
        : {}),
    },
    status: runFailed ? { code: StatusCode.ERROR, message: "run failed" } : { code: StatusCode.UNSET },
  }

  const spans: SpanRecord[] = [root]
  const segments = segment(items, startMs)
  const usage = turnUsage(providerTurns)

  segments.forEach((seg, index) => {
    const outputEnd = Math.max(seg.startMs, ...seg.outputs.map((o) => ms(o.completedAt) ?? ms(o.startedAt) ?? 0))
    const firstTool = seg.tools.length ? Math.min(...seg.tools.map((t) => ms(t.startedAt) ?? outputEnd)) : undefined
    const segEnd = Math.max(seg.startMs, firstTool ?? outputEnd)
    const previous = segments[index - 1]
    const input =
      index === 0
        ? userText.map((t) => textMessage("user", t))
        : (previous?.tools ?? []).map((t) => ({
            role: "tool",
            parts: [{ type: "tool_call_response", id: t.nativeItemRef?.nativeId ?? t.id, response: toolResult(t) }],
          }))
    const parts = [
      ...seg.outputs.map((o) =>
        o.type === "reasoning" ? { type: "reasoning", content: o.text ?? "" } : { type: "text", content: o.text ?? "" },
      ),
      ...seg.tools.map((t) => ({
        type: "tool_call",
        id: t.nativeItemRef?.nativeId ?? t.id,
        name: toolName(t),
        arguments: toolArgs(t),
      })),
    ]
    const finish = seg.tools.length ? "tool_call" : "stop"
    const isLast = index === segments.length - 1
    spans.push({
      traceId,
      spanId: hex(`t3-maple:chat:${run.id}:${index}`, 16),
      parentSpanId: rootId,
      name: `chat ${model ?? providerInstanceId}`,
      kind: SpanKind.CLIENT,
      startMs: seg.startMs,
      endMs: segEnd,
      attributes: {
        ...common,
        "gen_ai.operation.name": "chat",
        "gen_ai.response.finish_reasons": [finish],
        ...(usageModels[0] ? { "gen_ai.response.model": usageModels[0] } : {}),
        ...(isLast && usage ? { ...usage, "t3.usage.scope": "turn_total" } : {}),
        ...(opts.captureContent
          ? {
              "gen_ai.input.messages": json(input),
              "gen_ai.output.messages": json([{ role: "assistant", parts, finish_reason: finish }]),
            }
          : {}),
      },
      status: { code: StatusCode.UNSET },
    })

    for (const tool of seg.tools) {
      const callId: string = tool.nativeItemRef?.nativeId ?? tool.id
      const error = toolError(tool)
      const tStart = ms(tool.startedAt) ?? segEnd
      spans.push({
        traceId,
        spanId: hex(`t3-maple:tool:${tool.id}`, 16),
        parentSpanId: rootId,
        name: `execute_tool ${toolName(tool)}`,
        kind: SpanKind.INTERNAL,
        startMs: tStart,
        endMs: Math.max(tStart, ms(tool.completedAt) ?? ms(tool.updatedAt) ?? tStart),
        attributes: {
          ...common,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName(tool),
          "gen_ai.tool.call.id": callId,
          "gen_ai.tool.type": tool.type === "dynamic_tool" ? "extension" : "function",
          "t3.item.type": String(tool.type),
          ...(error ? { "error.type": error } : {}),
          ...(opts.captureContent
            ? {
                "gen_ai.tool.call.arguments": json(toolArgs(tool)),
                "gen_ai.tool.call.result": json(toolResult(tool)),
              }
            : {}),
        },
        status: error ? { code: StatusCode.ERROR, message: error } : { code: StatusCode.UNSET },
      })
    }
  })

  return spans
}
