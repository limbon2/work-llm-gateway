import { afterEach, describe, expect, it } from "vitest"
import { createApp } from "../../src/app.js"
import type { GatewayConfig } from "../../src/config/env.js"
import type { UpstreamClient } from "../../src/clients/upstream_openai.js"

const config: GatewayConfig = {
  upstreamBaseUrl: "http://upstream.test/v1",
  upstreamApiKey: "",
  port: 8787,
  host: "127.0.0.1",
  requestTimeoutMs: 50,
  requestBodyLimitBytes: 1024 * 1024,
  gatewayApiKeys: [],
  modelAliases: {},
  logLevel: "silent" as GatewayConfig["logLevel"],
}

const apps: ReturnType<typeof createApp>[] = []

function client(body: string | ReadableStream<Uint8Array>): UpstreamClient {
  return {
    async checkConnectivity() {
      return { statusCode: 200 }
    },
    async createChatCompletion() {
      throw new Error("Unexpected non-streaming call")
    },
    async streamChatCompletion() {
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      })
    },
    async listModels() {
      return ["test-model"]
    },
  }
}

async function request(body: string | ReadableStream<Uint8Array>) {
  const app = createApp(config, { upstreamClient: client(body) })
  apps.push(app)
  return app.inject({
    method: "POST",
    url: "/v1/messages",
    payload: {
      model: "test-model",
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    },
  })
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe("interrupted upstream streams", () => {
  it("rejects EOF without a terminal event", async () => {
    const response = await request(
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    )
    expect(response.body).toContain("event: error")
    expect(response.body).not.toContain("event: message_stop")
  })

  it("cancels a stalled body and reports a timeout", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"start"}}]}\n\n'),
        )
      },
      cancel() {
        cancelled = true
      },
    })
    const response = await request(body)
    expect(cancelled).toBe(true)
    expect(response.body).toContain("idle timeout")
    expect(response.body).not.toContain("event: message_stop")
  })

  it("accepts terminal records without a trailing blank line and records real zero usage", async () => {
    const response = await request(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":0}}\n\ndata: [DONE]',
    )
    expect(response.body).toContain("event: message_stop")
    expect(response.body).not.toContain("event: error")
    expect(response.body).toContain('"usage_source":"reported"')
    expect(response.body).toContain('"output_tokens":0')
  })

  it("preserves provider quota codes from stream error events", async () => {
    const response = await request(
      'data: {"error":{"code":"daily_limit_exceeded","message":"Daily budget exhausted"}}\n\n',
    )
    expect(response.body).toContain('"code":"daily_limit_exceeded"')
    expect(response.body).not.toContain("event: message_stop")
  })
})
