import { afterEach, describe, expect, it, vi } from "vitest"

import {
  UpstreamLogger,
  UpstreamOpenAIClient
} from "../../src/clients/upstream_openai.js"
import { GatewayConfig } from "../../src/config/env.js"

interface LogEntry {
  level: "info" | "warn" | "error"
  bindings: Record<string, unknown>
  message: string
}

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    upstreamBaseUrl: "http://provider.test/v1",
    upstreamApiKey: "provider-secret",
    port: 8787,
    host: "127.0.0.1",
    requestTimeoutMs: 5000,
    requestBodyLimitBytes: 32 * 1024 * 1024,
    gatewayApiKeys: [],
    modelAliases: {},
    logLevel: "info",
    ...overrides
  }
}

function captureLogger(): { logger: UpstreamLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const logger: UpstreamLogger = {
    info: (bindings, message) => entries.push({ level: "info", bindings, message }),
    warn: (bindings, message) => entries.push({ level: "warn", bindings, message }),
    error: (bindings, message) => entries.push({ level: "error", bindings, message })
  }
  return { logger, entries }
}

afterEach(() => vi.unstubAllGlobals())

describe("UpstreamOpenAIClient request diagnostics", () => {
  it("logs the startup check without exposing credentials", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{"data":[]}', { status: 200 })
    )
    vi.stubGlobal("fetch", fetchMock)
    const { logger, entries } = captureLogger()
    const client = new UpstreamOpenAIClient(
      baseConfig({ upstreamBaseUrl: "http://user:password@provider.test/v1" }),
      logger
    )

    await expect(client.checkConnectivity()).resolves.toEqual({ statusCode: 200 })

    const [, init] = fetchMock.mock.calls[0]
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer provider-secret"
    )
    expect(entries[0]).toMatchObject({
      message: "Sending request to upstream provider",
      bindings: { operation: "startup_check", method: "GET", timeoutMs: 5000 }
    })
    expect(entries[1]).toMatchObject({
      message: "Upstream provider request completed",
      bindings: { operation: "startup_check", statusCode: 200 }
    })
    expect(JSON.stringify(entries)).not.toContain("provider-secret")
    expect(JSON.stringify(entries)).not.toContain("password")
  })

  it("surfaces and logs the network cause hidden by fetch failed", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND missing-provider.test"), {
      code: "ENOTFOUND",
      errno: -3008,
      syscall: "getaddrinfo",
      hostname: "missing-provider.test"
    })
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause })
    }))
    const { logger, entries } = captureLogger()
    const client = new UpstreamOpenAIClient(baseConfig(), logger)

    await expect(client.listModels({ gatewayRequestId: "req-42" })).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("ENOTFOUND")
    })

    expect(entries).toContainEqual(expect.objectContaining({
      level: "error",
      message: "Upstream provider request failed",
      bindings: expect.objectContaining({
        gatewayRequestId: "req-42",
        operation: "list_models",
        networkError: expect.arrayContaining([
          expect.objectContaining({
            code: "ENOTFOUND",
            syscall: "getaddrinfo",
            hostname: "missing-provider.test"
          })
        ])
      })
    }))
  })

  it("logs and reports the configured timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("This operation was aborted", "AbortError")),
          { once: true }
        )
      })
    ))
    const { logger, entries } = captureLogger()
    const client = new UpstreamOpenAIClient(baseConfig({ requestTimeoutMs: 10 }), logger)

    await expect(client.checkConnectivity()).rejects.toMatchObject({
      statusCode: 504,
      message: "Upstream request timed out after 10ms"
    })
    expect(entries).toContainEqual(expect.objectContaining({
      level: "error",
      message: "Upstream provider request timed out",
      bindings: expect.objectContaining({ operation: "startup_check", timeoutMs: 10 })
    }))
  })
})
