import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { UpstreamOpenAIClient } from "../../src/clients/upstream_openai.js"
import { GatewayError, normalizeContextOverflowMessage } from "../../src/utils/errors.js"

// Claude Code's actual detection logic (extracted from the CLI bundle): the
// substring check gates recovery, the regex feeds the compaction size hints.
function claudeCodeDetectsPtl(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes("prompt is too long") || lower.includes("input is too long for requested model")
}

function claudeCodeParsesPtl(message: string): { actual?: number; limit?: number } {
  const match = message.match(/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i)
  return {
    actual: match ? parseInt(match[1], 10) : undefined,
    limit: match ? parseInt(match[2], 10) : undefined
  }
}

describe("normalizeContextOverflowMessage", () => {
  it("converts the OpenAI context_length_exceeded error with numbers", () => {
    const message =
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130009 tokens. Please reduce the length of the messages."
    const normalized = normalizeContextOverflowMessage(400, message, "context_length_exceeded")

    expect(normalized).toBeDefined()
    expect(claudeCodeDetectsPtl(normalized!)).toBe(true)
    expect(claudeCodeParsesPtl(normalized!)).toEqual({ actual: 130009, limit: 128000 })
  })

  it("converts the vLLM requested-tokens variant", () => {
    const message =
      "This model's maximum context length is 32768 tokens. However, you requested 36210 tokens (33210 in the messages, 3000 in the completion). Please reduce the length of the messages or completion."
    const normalized = normalizeContextOverflowMessage(400, message)

    expect(normalized).toBeDefined()
    expect(claudeCodeParsesPtl(normalized!)).toEqual({ actual: 36210, limit: 32768 })
  })

  it("converts number-free overflow errors to the bare recoverable form", () => {
    const message = "the request exceeds the available context size. try increasing the context size or enable context shift"
    const normalized = normalizeContextOverflowMessage(400, message)

    expect(normalized).toBeDefined()
    expect(claudeCodeDetectsPtl(normalized!)).toBe(true)
    // No fabricated numbers: Claude Code's parser must come back empty rather
    // than being fed a misleading compaction target.
    expect(claudeCodeParsesPtl(normalized!)).toEqual({ actual: undefined, limit: undefined })
  })

  it("preserves already-Anthropic-shaped messages", () => {
    const normalized = normalizeContextOverflowMessage(400, "prompt is too long: 210000 tokens > 200000 maximum")

    expect(normalized).toBeDefined()
    expect(claudeCodeParsesPtl(normalized!)).toEqual({ actual: 210000, limit: 200000 })
  })

  it("ignores rate-limit token errors (429)", () => {
    expect(
      normalizeContextOverflowMessage(429, "Rate limit reached: too many tokens per minute. Try again later.")
    ).toBeUndefined()
  })

  it("ignores unrelated 400 errors", () => {
    expect(normalizeContextOverflowMessage(400, "Invalid tool schema: parameters must be an object")).toBeUndefined()
  })
})

describe("UpstreamOpenAIClient context overflow mapping", () => {
  let server: Server
  let port: number

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: {
            message:
              "This model's maximum context length is 262144 tokens. However, your messages resulted in 270100 tokens. Please reduce the length of the messages.",
            type: "invalid_request_error",
            code: "context_length_exceeded"
          }
        })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    port = typeof address === "object" && address ? address.port : 0
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it("returns a Claude-Code-recoverable prompt-too-long error", async () => {
    const client = new UpstreamOpenAIClient({
      upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
      upstreamApiKey: "",
      port: 0,
      host: "",
      requestTimeoutMs: 5000,
      gatewayApiKeys: [],
      modelAliases: {},
      logLevel: "error"
    })

    let caught: unknown
    try {
      await client.createChatCompletion({ model: "m", messages: [{ role: "user", content: "hi" }] })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(GatewayError)
    const gatewayError = caught as GatewayError
    expect(gatewayError.statusCode).toBe(400)
    expect(gatewayError.errorType).toBe("invalid_request_error")
    expect(claudeCodeDetectsPtl(gatewayError.message)).toBe(true)
    expect(claudeCodeParsesPtl(gatewayError.message)).toEqual({ actual: 270100, limit: 262144 })
  })
})
