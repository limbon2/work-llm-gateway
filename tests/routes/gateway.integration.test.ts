import { afterEach, describe, expect, it } from "vitest"

import { createApp } from "../../src/app.js"
import { UpstreamClient } from "../../src/clients/upstream_openai.js"
import { GatewayConfig } from "../../src/config/env.js"
import { OpenAIChatCompletionRequest, OpenAIChatCompletionResponse } from "../../src/types/contracts.js"

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    upstreamBaseUrl: "http://upstream.test/v1",
    upstreamApiKey: "upstream-key",
    port: 8787,
    host: "127.0.0.1",
    requestTimeoutMs: 60_000,
    requestBodyLimitBytes: 32 * 1024 * 1024,
    gatewayApiKeys: [],
    modelAliases: {
      "claude-sonnet-4-5": "gpt-4o-mini"
    },
    logLevel: "error",
    ...overrides
  }
}

function createStubClient(): UpstreamClient {
  return {
    async createChatCompletion(_payload: OpenAIChatCompletionRequest): Promise<OpenAIChatCompletionResponse> {
      return {
        id: "chatcmpl-test",
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Hello from upstream"
            }
          }
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5
        }
      }
    },
    async streamChatCompletion(_payload: OpenAIChatCompletionRequest): Promise<Response> {
      const sse = [
        "data: {\"id\":\"chatcmpl-test\",\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}",
        "",
        "data: {\"id\":\"chatcmpl-test\",\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1}}",
        "",
        "data: [DONE]",
        ""
      ].join("\n")
      return new Response(sse, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream"
        }
      })
    },
    async listModels(): Promise<string[]> {
      return ["gpt-4o-mini", "gpt-4.1"]
    }
  }
}

describe("gateway routes", () => {
  let appsToClose: Array<ReturnType<typeof createApp>> = []

  afterEach(async () => {
    await Promise.all(appsToClose.map((app) => app.close()))
    appsToClose = []
  })

  it("handles non-streaming /v1/messages", async () => {
    const app = createApp(baseConfig(), { upstreamClient: createStubClient() })
    appsToClose.push(app)

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-sonnet-4-5",
        max_tokens: 256,
        messages: [{ role: "user", content: "Say hi" }]
      }
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.type).toBe("message")
    expect(body.model).toBe("claude-sonnet-4-5")
    expect(body.content[0]).toEqual({ type: "text", text: "Hello from upstream" })
  })

  it("removes Claude Code token reminders before calling upstream", async () => {
    let capturedPayload: OpenAIChatCompletionRequest | undefined
    const stubClient = createStubClient()
    const upstreamClient: UpstreamClient = {
      ...stubClient,
      async createChatCompletion(payload) {
        capturedPayload = payload
        return stubClient.createChatCompletion(payload)
      }
    }
    const app = createApp(baseConfig(), { upstreamClient })
    appsToClose.push(app)

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-sonnet-4-5",
        system: [
          { type: "text", text: "Be helpful." },
          { type: "text", text: "<total_tokens>15000000 tokens left</total_tokens>" }
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "<system-reminder>",
                  "<total_tokens>14999990 tokens left</total_tokens>",
                  "</system-reminder>"
                ].join("\n")
              },
              { type: "text", text: "Say hi" }
            ]
          }
        ]
      }
    })

    expect(response.statusCode).toBe(200)
    expect(capturedPayload?.messages).toEqual([
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Say hi" }
    ])
  })

  it("accepts message bodies larger than Fastify's default one MiB limit", async () => {
    const app = createApp(baseConfig(), { upstreamClient: createStubClient() })
    appsToClose.push(app)

    const largeMessage = "x".repeat(1_048_576)
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-sonnet-4-5",
        max_tokens: 256,
        messages: [{ role: "user", content: largeMessage }]
      }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().content[0]).toEqual({ type: "text", text: "Hello from upstream" })
  })

  it("returns 413 when a message exceeds the configured body limit", async () => {
    const app = createApp(baseConfig({ requestBodyLimitBytes: 1024 }), {
      upstreamClient: createStubClient()
    })
    appsToClose.push(app)

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "x".repeat(1024) }]
      }
    })

    expect(response.statusCode).toBe(413)
    expect(response.json()).toEqual({
      type: "error",
      error: {
        type: "request_too_large",
        message: "Request body is too large"
      }
    })
  })

  it("handles streaming /v1/messages", async () => {
    const app = createApp(baseConfig(), { upstreamClient: createStubClient() })
    appsToClose.push(app)

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-sonnet-4-5",
        stream: true,
        messages: [{ role: "user", content: "Say hi" }]
      }
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers["content-type"]).toContain("text/event-stream")
    expect(response.payload).toContain("event: message_start")
    expect(response.payload).toContain("event: content_block_delta")
    expect(response.payload).toContain("event: message_stop")
  })

  it("serves /v1/models and /v1/messages/count_tokens", async () => {
    const app = createApp(baseConfig(), { upstreamClient: createStubClient() })
    appsToClose.push(app)

    const modelsResponse = await app.inject({
      method: "GET",
      url: "/v1/models"
    })
    expect(modelsResponse.statusCode).toBe(200)
    const modelsBody = modelsResponse.json()
    expect(modelsBody.data.some((model: { id: string }) => model.id === "claude-sonnet-4-5")).toBe(true)
    expect(modelsBody.data.some((model: { id: string }) => model.id === "gpt-4o-mini")).toBe(true)

    const tokenResponse = await app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens?beta=true",
      payload: {
        model: "claude-sonnet-4-5",
        system: "You are helpful",
        messages: [{ role: "user", content: "Count these tokens." }]
      }
    })
    expect(tokenResponse.statusCode).toBe(200)
    expect(tokenResponse.json().input_tokens).toBeGreaterThan(0)

    const tokenResponseWithReminder = await app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens?beta=true",
      payload: {
        model: "claude-sonnet-4-5",
        system: [
          { type: "text", text: "You are helpful" },
          { type: "text", text: "<total_tokens>15000000 tokens left</total_tokens>" }
        ],
        messages: [{ role: "user", content: "Count these tokens." }]
      }
    })
    expect(tokenResponseWithReminder.statusCode).toBe(200)
    expect(tokenResponseWithReminder.json().input_tokens).toBe(tokenResponse.json().input_tokens)
  })

  it("enforces optional gateway API keys", async () => {
    const app = createApp(baseConfig({ gatewayApiKeys: ["secret-key"] }), {
      upstreamClient: createStubClient()
    })
    appsToClose.push(app)

    const denied = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hello" }]
      }
    })
    expect(denied.statusCode).toBe(401)

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "secret-key"
      },
      payload: {
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hello" }]
      }
    })
    expect(allowed.statusCode).toBe(200)
  })

  it("forces configured upstream model", async () => {
    let capturedPayload: OpenAIChatCompletionRequest | undefined
    const upstreamClient: UpstreamClient = {
      async createChatCompletion(payload: OpenAIChatCompletionRequest): Promise<OpenAIChatCompletionResponse> {
        capturedPayload = payload
        return {
          id: "chatcmpl-test",
          model: payload.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "ok"
              }
            }
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1
          }
        }
      },
      async streamChatCompletion(_payload: OpenAIChatCompletionRequest): Promise<Response> {
        return new Response("", { status: 200 })
      },
      async listModels(): Promise<string[]> {
        return []
      }
    }

    const app = createApp(
      baseConfig({
        upstreamModel: "gpt-4.1"
      }),
      { upstreamClient }
    )
    appsToClose.push(app)

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hello" }]
      }
    })

    expect(response.statusCode).toBe(200)
    expect(capturedPayload?.model).toBe("gpt-4.1")
  })
})
