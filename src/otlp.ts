// OTLP http/protobuf export. Builds the ReadableSpan-shaped records the
// official serializer reads, so span/trace ids and timestamps stay ours
// (deterministic ids, historical start/end times) instead of an SDK tracer's.
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer"
import { Data, Effect, Schedule } from "effect"
import type { Config } from "./config"
import type { AttrValue, SpanRecord } from "./spans"

export class ExportError extends Data.TaggedError("ExportError")<{
  readonly status: number | undefined
  readonly message: string
}> {}

const hrTime = (ms: number): [number, number] => [Math.floor(ms / 1000), (ms % 1000) * 1e6]

function toReadable(span: SpanRecord, resource: object, scope: object) {
  const durationMs = Math.max(0, span.endMs - span.startMs)
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => ({ traceId: span.traceId, spanId: span.spanId, traceFlags: 1 }),
    parentSpanContext: span.parentSpanId
      ? { traceId: span.traceId, spanId: span.parentSpanId, traceFlags: 1 }
      : undefined,
    startTime: hrTime(span.startMs),
    endTime: hrTime(span.endMs),
    duration: hrTime(durationMs),
    ended: true,
    status: span.status,
    attributes: span.attributes as Record<string, AttrValue>,
    links: [],
    events: [],
    resource,
    instrumentationScope: scope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  }
}

export function encode(spans: ReadonlyArray<SpanRecord>, config: Config): Uint8Array {
  const resource = { attributes: config.resource, schemaUrl: undefined }
  const scope = { name: "t3-maple-adapter", version: "0.1.0" }
  const body = ProtobufTraceSerializer.serializeRequest(
    spans.map((s) => toReadable(s, resource, scope)) as never,
  )
  if (!body) throw new Error("serializer returned no body")
  return body
}

/** POST one batch; retries 5xx/429/network errors with backoff. Never logs headers. */
export const exportSpans = (spans: ReadonlyArray<SpanRecord>, config: Config) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(config.tracesUrl, {
        method: "POST",
        headers: { ...config.headers, "content-type": "application/x-protobuf" },
        body: encode(spans, config),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        const text = (await response.text()).slice(0, 300)
        throw new ExportError({ status: response.status, message: text })
      }
      const reply = ProtobufTraceSerializer.deserializeResponse(new Uint8Array(await response.arrayBuffer()))
      const rejected = Number(reply.partialSuccess?.rejectedSpans ?? 0)
      if (rejected > 0)
        throw new ExportError({ status: 400, message: `rejected ${rejected} spans: ${reply.partialSuccess?.errorMessage}` })
      return { status: response.status, accepted: spans.length }
    },
    catch: (e) => (e instanceof ExportError ? e : new ExportError({ status: undefined, message: String(e) })),
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential("500 millis"),
      times: 4,
      while: (e) => e.status === undefined || e.status === 429 || e.status >= 500,
    }),
  )
