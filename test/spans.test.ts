import { expect, test } from "bun:test"
import { SpanKind, turnToSpans } from "../src/spans"
import type { Turn } from "../src/store"

const at = (s: number) => new Date(Date.UTC(2026, 10, 12, 1, 0, s)).toISOString()
const item = (ordinal: number, type: string, start: number, end: number, extra: object = {}) => ({
  id: `item-${ordinal}`,
  ordinal,
  type,
  status: "completed",
  startedAt: at(start),
  completedAt: at(end),
  nativeItemRef: { driver: "claudeAgent", nativeId: `native-${ordinal}` },
  providerTurnId: "pt-1",
  ...extra,
})

const turn: Turn = {
  thread: { id: "thread-1", title: "Test", projectId: "p" },
  run: {
    id: "run-1",
    threadId: "thread-1",
    ordinal: 1,
    status: "completed",
    providerInstanceId: "claudeAgent",
    modelSelection: { model: "claude-opus-5-5" },
    startedAt: at(0),
    completedAt: at(20),
  },
  providerTurns: [
    {
      nativeTurnRef: { driver: "claudeAgent" },
      turnTokenUsage: { usageStatus: "complete", inputTokens: 100, cachedInputTokens: 80, outputTokens: 7 },
    },
  ],
  items: [
    item(1, "user_message", 0, 0, { text: "list files" }),
    item(2, "reasoning", 1, 2, { text: "thinking" }),
    item(3, "command_execution", 3, 5, { input: "ls", output: "a\nb", exitCode: 0 }),
    item(4, "dynamic_tool", 3, 4, { toolName: "mcp__x__y", input: { q: 1 }, output: { ok: true } }),
    item(5, "assistant_message", 6, 7, { text: "two files" }),
    item(6, "command_execution", 8, 9, { input: "false", output: "", exitCode: 1 }),
    item(7, "assistant_message", 10, 11, { text: "done" }),
  ],
}

test("maps a turn to invoke_agent + chat + execute_tool spans", () => {
  const spans = turnToSpans(turn, { captureContent: true, maxContentChars: 1000 })
  const ops = spans.map((s) => s.attributes["gen_ai.operation.name"])
  expect(ops).toEqual(["invoke_agent", "chat", "execute_tool", "execute_tool", "chat", "execute_tool", "chat"])

  const [root, ...children] = spans
  expect(root!.kind).toBe(SpanKind.INTERNAL)
  expect(root!.parentSpanId).toBeUndefined()
  expect(children.every((s) => s.parentSpanId === root!.spanId && s.traceId === root!.traceId)).toBe(true)
  expect(spans.every((s) => s.attributes["gen_ai.conversation.id"] === "thread-1")).toBe(true)
  expect(spans.filter((s) => s.kind === SpanKind.CLIENT)).toHaveLength(3)

  const chats = spans.filter((s) => s.attributes["gen_ai.operation.name"] === "chat")
  // First call ends where its tools start; second starts when they finish.
  expect(chats[0]!.endMs - chats[0]!.startMs).toBe(3000)
  expect(new Date(chats[1]!.startMs).toISOString()).toBe(at(5))
  // Turn-total usage only on the last model call.
  expect(chats.map((c) => c.attributes["gen_ai.usage.input_tokens"])).toEqual([undefined, undefined, 100])
  expect(JSON.parse(chats[0]!.attributes["gen_ai.input.messages"] as string)[0].parts[0].content).toBe("list files")

  const failed = spans.find((s) => s.attributes["gen_ai.tool.call.id"] === "native-6")!
  expect(failed.attributes["error.type"]).toBe("nonzero_exit")
  const mcp = spans.find((s) => s.attributes["gen_ai.tool.name"] === "mcp__x__y")!
  expect(JSON.parse(mcp.attributes["gen_ai.tool.call.arguments"] as string)).toEqual({ q: 1 })
})

test("content capture off drops transcript attributes", () => {
  const spans = turnToSpans(turn, { captureContent: false, maxContentChars: 1000 })
  const keys = spans.flatMap((s) => Object.keys(s.attributes))
  expect(keys.some((k) => k.startsWith("gen_ai.input") || k.startsWith("gen_ai.output") || k.startsWith("gen_ai.tool.call.a") || k.startsWith("gen_ai.tool.call.r"))).toBe(false)
})
