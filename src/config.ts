import { existsSync, readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"

export interface Config {
  readonly dbPath: string
  readonly statePath: string
  readonly tracesUrl: string
  /** Parsed from T3CODE_OTLP_HEADERS. Never log this. */
  readonly headers: Readonly<Record<string, string>>
  readonly resource: Readonly<Record<string, string>>
  readonly captureContent: boolean
  readonly maxContentChars: number
  readonly pollMs: number
  /** Project ids or titles never exported (e.g. work projects). */
  readonly excludeProjects: ReadonlySet<string>
}

const T3_HOME = process.env.T3_HOME ?? join(homedir(), ".t3", "userdata")

/** KEY=VALUE lines; values are not unquoted or expanded beyond surrounding quotes. */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    out[match[1]!] = match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2")
  }
  return out
}

/** OTEL-style `k=v,k2=v2`, values percent-decoded. */
function parsePairs(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of (raw ?? "").split(",")) {
    const i = pair.indexOf("=")
    if (i <= 0) continue
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
  }
  return out
}

const flag = (raw: string | undefined, fallback: boolean) =>
  raw === undefined ? fallback : !/^(0|false|off|no)$/i.test(raw)

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  return n
}

export function loadConfig(): Config {
  const otelEnvPath = process.env.T3_MAPLE_OTEL_ENV ?? join(T3_HOME, "otel.env")
  const env = { ...parseEnvFile(otelEnvPath), ...process.env }
  const tracesUrl = env.T3_MAPLE_TRACES_URL ?? env.T3CODE_OTLP_TRACES_URL
  if (!tracesUrl)
    throw new Error(`No traces URL: set T3CODE_OTLP_TRACES_URL in ${otelEnvPath} or T3_MAPLE_TRACES_URL`)
  const headers = parsePairs(env.T3_MAPLE_OTLP_HEADERS ?? env.T3CODE_OTLP_HEADERS)
  const inherited = parsePairs(env.OTEL_RESOURCE_ATTRIBUTES)
  return {
    dbPath: env.T3_MAPLE_DB ?? join(T3_HOME, "statev2.sqlite"),
    statePath:
      env.T3_MAPLE_STATE ?? join(homedir(), ".local", "state", "t3-maple-adapter", "state.json"),
    tracesUrl,
    headers,
    resource: {
      "service.name": "t3-maple-adapter",
      "service.version": "0.1.0",
      "deployment.environment.name": inherited["deployment.environment.name"] ?? "unknown",
      "host.name": env.T3_MAPLE_HOST || hostname() || "unknown",
    },
    captureContent: flag(env.T3_MAPLE_CAPTURE_CONTENT, true),
    maxContentChars: positiveInt("T3_MAPLE_MAX_CONTENT_CHARS", env.T3_MAPLE_MAX_CONTENT_CHARS, 16_000),
    pollMs: positiveInt("T3_MAPLE_POLL_MS", env.T3_MAPLE_POLL_MS, 5_000),
    excludeProjects: new Set(
      (env.T3_MAPLE_EXCLUDE_PROJECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ),
  }
}

const redactUrl = (raw: string) => {
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname}`
  } catch {
    return "(invalid url)"
  }
}

/** Safe-to-print summary: header names only, never values. */
export function describeConfig(config: Config): string {
  const headers = Object.keys(config.headers).join(", ")
  return [
    `db=${config.dbPath}`,
    `traces=${redactUrl(config.tracesUrl)}`,
    `headers=[${headers || "none"}]`,
    `env=${config.resource["deployment.environment.name"]}`,
    `host=${config.resource["host.name"]}`,
    `content=${config.captureContent ? "on" : "off"}`,
    `excluded_projects=${config.excludeProjects.size}`,
  ].join(" ")
}
