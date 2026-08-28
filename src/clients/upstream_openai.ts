import { GatewayConfig } from "../config/env.js"
import { OpenAIChatCompletionRequest, OpenAIChatCompletionResponse } from "../types/contracts.js"
import { GatewayError, normalizeContextOverflowMessage } from "../utils/errors.js"

export interface UpstreamClient {
  createChatCompletion(payload: OpenAIChatCompletionRequest): Promise<OpenAIChatCompletionResponse>
  streamChatCompletion(payload: OpenAIChatCompletionRequest): Promise<Response>
  listModels(): Promise<string[]>
}

export class UpstreamOpenAIClient implements UpstreamClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(config: GatewayConfig) {
    this.baseUrl = config.upstreamBaseUrl.replace(/\/+$/, "")
    this.apiKey = config.upstreamApiKey
    this.timeoutMs = config.requestTimeoutMs
  }

  async createChatCompletion(payload: OpenAIChatCompletionRequest): Promise<OpenAIChatCompletionResponse> {
    const response = await this.request("/chat/completions", {
      method: "POST",
      headers: this.defaultHeaders({
        "Content-Type": "application/json",
        Accept: "application/json"
      }),
      body: JSON.stringify(payload)
    })

    return (await response.json()) as OpenAIChatCompletionResponse
  }

  async streamChatCompletion(payload: OpenAIChatCompletionRequest): Promise<Response> {
    return this.request("/chat/completions", {
      method: "POST",
      headers: this.defaultHeaders({
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      }),
      body: JSON.stringify(payload)
    })
  }

  async listModels(): Promise<string[]> {
    const response = await this.request("/models", {
      method: "GET",
      headers: this.defaultHeaders({
        Accept: "application/json"
      })
    })

    const payload = (await response.json()) as { data?: Array<{ id?: string }> }
    const ids = payload.data?.map((item) => item.id).filter((id): id is string => !!id) ?? []
    return [...new Set(ids)]
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    if (init.signal) {
      init.signal.addEventListener("abort", () => controller.abort(), { once: true })
    }

    try {
      const response = await fetch(this.url(path), {
        ...init,
        signal: controller.signal
      })

      if (!response.ok) {
        throw await this.toUpstreamError(response)
      }

      return response
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new GatewayError(504, "Upstream request timed out", "api_error")
      }

      throw new GatewayError(502, `Upstream request failed: ${String(error)}`, "api_error")
    } finally {
      clearTimeout(timeout)
    }
  }

  private async toUpstreamError(response: Response): Promise<GatewayError> {
    const fallbackMessage = `Upstream error: ${response.status} ${response.statusText}`
    let message = fallbackMessage
    let errorCode: string | undefined

    try {
      const bodyText = await response.text()
      if (!bodyText) {
        return new GatewayError(response.status, message)
      }

      const parsed = JSON.parse(bodyText) as Record<string, unknown>
      const errorBody = parsed.error as { message?: string; code?: string } | undefined
      const extractedMessage = errorBody?.message ?? (parsed.message as string | undefined) ?? bodyText
      if (typeof extractedMessage === "string") {
        message = extractedMessage
      }
      if (typeof errorBody?.code === "string") {
        errorCode = errorBody.code
      }
    } catch {
      // Ignore parse failures and keep fallback message.
    }

    const contextOverflowMessage = normalizeContextOverflowMessage(response.status, message, errorCode)
    if (contextOverflowMessage) {
      return new GatewayError(400, contextOverflowMessage, "invalid_request_error")
    }

    if (response.status === 429) {
      return new GatewayError(429, message, "rate_limit_error")
    }
    if (response.status === 401) {
      return new GatewayError(401, message, "authentication_error")
    }
    if (response.status === 413) {
      return new GatewayError(413, message, "request_too_large")
    }
    if (response.status >= 400 && response.status < 500) {
      return new GatewayError(response.status, message, "invalid_request_error")
    }
    return new GatewayError(502, message, "api_error")
  }

  private defaultHeaders(headers: Record<string, string>): Record<string, string> {
    const baseHeaders: Record<string, string> = {
      ...headers
    }

    if (this.apiKey) {
      baseHeaders.Authorization = `Bearer ${this.apiKey}`
    }

    return baseHeaders
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`
  }
}
