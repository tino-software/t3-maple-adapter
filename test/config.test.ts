import { afterEach, expect, test } from "bun:test"
import { hostname } from "node:os"
import { describeConfig, loadConfig } from "../src/config"

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

const base = () => {
  process.env = {
    ...saved,
    T3_MAPLE_OTEL_ENV: "/nonexistent/otel.env",
    T3_MAPLE_TRACES_URL: "https://ingest.example.com/v1/traces?token=abc",
    T3_MAPLE_OTLP_HEADERS: "Authorization=Bearer%20secret-key-value",
  }
  delete process.env.T3_MAPLE_HOST
  delete process.env.OTEL_RESOURCE_ATTRIBUTES
  delete process.env.T3_MAPLE_POLL_MS
}

test("works without otel.env and uses generic resource defaults", () => {
  base()
  const config = loadConfig()
  expect(config.headers.Authorization).toBe("Bearer secret-key-value")
  expect(config.resource["host.name"]).toBe(hostname() || "unknown")
  expect(config.resource["deployment.environment.name"]).toBe("unknown")
})

test("describeConfig prints header names, never values or URL queries", () => {
  base()
  const text = describeConfig(loadConfig())
  expect(text).toContain("headers=[Authorization]")
  expect(text).not.toContain("Bearer")
  expect(text).not.toContain("secret")
  expect(text).not.toContain("token=abc")
})

test("rejects non-numeric poll interval", () => {
  base()
  process.env.T3_MAPLE_POLL_MS = "5s"
  expect(() => loadConfig()).toThrow("T3_MAPLE_POLL_MS")
})
