import { randomUUID } from "node:crypto"

import { GatewayConfig } from "../config/env.js"
import { OpenAIChatCompletionRequest, OpenAIChatCompletionResponse } from "../types/contracts.js"
import { GatewayError, normalizeContextOverflowMessage } from "../utils/errors.js"
import { sanitizeUrl } from "../utils/logging.js"

export interface UpstreamRequestContext {
  gatewayRequestId?: string
}

export interface UpstreamConnectivityResult {
  statusCode: number
}

export interface UpstreamClient {
  checkConnectivity(): Promise<UpstreamConnectivityResult>
  createChatCompletion(
    payload: OpenAIChatCompletionRequest,
    context?: UpstreamRequestContext
  ): Promise<OpenAIChatCompletionResponse>
  streamChatCompletion(
    payload: OpenAIChatCompletionRequest,
    context?: UpstreamRequestContext
  ): Promise<Response>
  listModels(context?: UpstreamRequestContext): Promise<string[]>
}

export interface UpstreamLogger {
  info(bindings: Record<string, unknown>, message: string): void
  warn(bindings: Record<string, unknown>, message: string): void
  error(bindings: Record<string, unknown>, message: string): void
}

interface RequestLogContext extends UpstreamRequestContext {
  operation: "startup_check" | "chat_completion" | "stream_chat_completion" | "list_models"
  model?: string
}

interface ErrorDetails {
  name?: string
  message: string
  code?: string
  errno?: string | number
  syscall?: string
  address?: string
  hostname?: string
  port?: string | number
}

const silentLogger: UpstreamLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function readStringOrNumber(
  record: Record<string, unknown>,
  key: string
): string | number | undefined {
  const value = record[key]
  return typeof value === "string" || typeof value === "number" ? value : undefined
}

function errorDetails(error: unknown): ErrorDetails {
  if (error instanceof Error) {
    const record = error as unknown as Record<string, unknown>
    return {
      name: error.name,
      message: error.message,
      code: readString(record, "code"),
      errno: readStringOrNumber(record, "errno"),
      syscall: readString(record, "syscall"),
      address: readString(record, "address"),
      hostname: readString(record, "hostname"),
      port: readStringOrNumber(record, "port")
    }
  }

  return { message: String(error) }
}

function flattenErrorDetails(error: unknown, seen = new Set<unknown>()): ErrorDetails[] {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    if (seen.has(error)) {
      return []
    }
    seen.add(error)
  }

  const details = [errorDetails(error)]
  if (!(error instanceof Error)) {
    return details
  }

  const record = error as unknown as Record<string, unknown>
  if ("cause" in record && record.cause !== undefined) {
    details.push(...flattenErrorDetails(record.cause, seen))
  }

  const nestedErrors = record.errors
  if (Array.isArray(nestedErrors)) {
    for (const nestedError of nestedErrors) {
      details.push(...flattenErrorDetails(nestedError, seen))
    }
  }

  return details
}

function describeNetworkFailure(details: ErrorDetails[]): string {
  const actionable = details.filter((detail) => detail.code || detail.message !== "fetch failed")
  const selected = actionable.length > 0 ? actionable : details
  const descriptions = selected.map((detail) => {
    const metadata = [
      detail.code ? `code=${detail.code}` : undefined,
      detail.syscall ? `syscall=${detail.syscall}` : undefined,
      detail.hostname ? `hostname=${detail.hostname}` : undefined,
      detail.address ? `address=${detail.address}` : undefined,
      detail.port !== undefined ? `port=${detail.port}` : undefined
    ].filter((part): part is string => !!part)

    return metadata.length > 0 ? `${detail.message} (${metadata.join(", ")})` : detail.message
  })

  return [...new Set(descriptions)].slice(0, 3).join("; caused by: ")
}

export class UpstreamOpenAIClient implements UpstreamClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly logger: UpstreamLogger

  constructor(config: GatewayConfig, logger: UpstreamLogger = silentLogger) {
    this.baseUrl = config.upstreamBaseUrl.replace(/\/+$/, "")
    this.apiKey = config.upstreamApiKey
    this.timeoutMs = config.requestTimeoutMs
    this.logger = logger
  }

  async checkConnectivity(): Promise<UpstreamConnectivityResult> {
    const response = await this.request(
      "/models",
      {
        method: "GET",
        headers: this.defaultHeaders({
          Accept: "application/json"
        })
      },
      { operation: "startup_check" }
    )

    await response.body?.cancel()
    return { statusCode: response.status }
  }

  async createChatCompletion(
    payload: OpenAIChatCompletionRequest,
    context: UpstreamRequestContext = {}
  ): Promise<OpenAIChatCompletionResponse> {
    const response = await this.request(
      "/chat/completions",
      {
        method: "POST",
        headers: this.defaultHeaders({
          "Content-Type": "application/json",
          Accept: "application/json"
        }),
        body: JSON.stringify(payload)
      },
      { ...context, operation: "chat_completion", model: payload.model }
    )

    return (await response.json()) as OpenAIChatCompletionResponse
  }

  async streamChatCompletion(
    payload: OpenAIChatCompletionRequest,
    context: UpstreamRequestContext = {}
  ): Promise<Response> {
    return this.request(
      "/chat/completions",
      {
        method: "POST",
        headers: this.defaultHeaders({
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        }),
        body: JSON.stringify(payload)
      },
      { ...context, operation: "stream_chat_completion", model: payload.model }
    )
  }

  async listModels(context: UpstreamRequestContext = {}): Promise<string[]> {
    const response = await this.request(
      "/models",
      {
        method: "GET",
        headers: this.defaultHeaders({
          Accept: "application/json"
        })
      },
      { ...context, operation: "list_models" }
    )

    const payload = (await response.json()) as { data?: Array<{ id?: string }> }
    const ids = payload.data?.map((item) => item.id).filter((id): id is string => !!id) ?? []
    return [...new Set(ids)]
  }

  private async request(
    path: string,
    init: RequestInit,
    context: RequestLogContext
  ): Promise<Response> {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    const abortFromCaller = (): void => controller.abort()

    if (init.signal?.aborted) {
      controller.abort()
    } else {
      init.signal?.addEventListener("abort", abortFromCaller, { once: true })
    }

    const upstreamRequestId = randomUUID()
    const method = init.method ?? "GET"
    const url = this.url(path)
    const logUrl = sanitizeUrl(url)
    const startedAt = performance.now()
    const logContext = {
      upstreamRequestId,
      gatewayRequestId: context.gatewayRequestId,
      operation: context.operation,
      method,
      url: logUrl,
      model: context.model,
      timeoutMs: this.timeoutMs
    }

    this.logger.info(logContext, "Sending request to upstream provider")

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal
      })
      const durationMs = Math.round(performance.now() - startedAt)

      if (!response.ok) {
        const upstreamError = await this.toUpstreamError(response)
        this.logger.warn(
          {
            ...logContext,
            durationMs,
            statusCode: response.status,
            statusText: response.statusText,
            upstreamErrorType: upstreamError.errorType
          },
          "Upstream provider returned an error response"
        )
        throw upstreamError
      }

      this.logger.info(
        {
          ...logContext,
          durationMs,
          statusCode: response.status,
          statusText: response.statusText
        },
        "Upstream provider request completed"
      )
      return response
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error
      }

      const durationMs = Math.round(performance.now() - startedAt)
      const details = flattenErrorDetails(error)

      if (timedOut) {
        this.logger.error(
          {
            ...logContext,
            durationMs,
            networkError: details
          },
          "Upstream provider request timed out"
        )
        throw new GatewayError(
          504,
          `Upstream request timed out after ${this.timeoutMs}ms`,
          "api_error"
        )
      }

      const failureDescription = describeNetworkFailure(details)
      this.logger.error(
        {
          ...logContext,
          durationMs,
          networkError: details
        },
        "Upstream provider request failed"
      )
      throw new GatewayError(
        502,
        `Upstream request failed: ${failureDescription}`,
        "api_error"
      )
    } finally {
      clearTimeout(timeout)
      init.signal?.removeEventListener("abort", abortFromCaller)
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
