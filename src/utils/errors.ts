import type { FastifyReply } from "fastify"

import type { AnthropicErrorResponse } from "../types/contracts.js"

type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"

const statusToErrorType: Record<number, AnthropicErrorType> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "invalid_request_error",
  413: "request_too_large",
  429: "rate_limit_error"
}

function defaultErrorType(status: number): AnthropicErrorType {
  return statusToErrorType[status] ?? (status >= 400 && status < 500 ? "invalid_request_error" : "api_error")
}

export class GatewayError extends Error {
  readonly statusCode: number
  readonly errorType: AnthropicErrorType

  constructor(statusCode: number, message: string, errorType: AnthropicErrorType = defaultErrorType(statusCode)) {
    super(message)
    this.name = "GatewayError"
    this.statusCode = statusCode
    this.errorType = errorType
  }
}

const contextOverflowPatterns: RegExp[] = [
  /context_length_exceeded/i,
  /maximum context length/i,
  /exceeds? (?:the )?(?:available |model )?context/i,
  /context (?:window|length|limit).{0,60}(?:exceed|too (?:long|large)|overflow)/i,
  /input is too long/i,
  /prompt is too long/i,
  /too many tokens/i
]

// [limit, actual] or [actual, limit] extraction attempts, most specific first.
const contextNumberPatterns: Array<{ pattern: RegExp; order: "actual-first" | "limit-first" }> = [
  // Anthropic shape: "prompt is too long: 210000 tokens > 200000 maximum"
  { pattern: /(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i, order: "actual-first" },
  // OpenAI/vLLM shape: "This model's maximum context length is 128000 tokens.
  // However, your messages resulted in 130009 tokens" / "you requested 133089 tokens"
  {
    pattern:
      /maximum context length is (\d[\d,]*) tokens?[\s\S]{0,200}?(?:resulted in|requested|submitted)\s*(?:approximately\s*)?(\d[\d,]*)/i,
    order: "limit-first"
  },
  // Generic: "context window of 32768 tokens ... requested 40000 tokens"
  {
    pattern:
      /context (?:window|length|limit) (?:is |of )?(?:only )?(\d[\d,]*)[\s\S]{0,200}?(?:got|received|requested|resulted in|input(?: was)?)\s*(?:approximately\s*)?(\d[\d,]*)/i,
    order: "limit-first"
  }
]

function parseTokenCount(raw: string): number {
  return parseInt(raw.replace(/,/g, ""), 10)
}

// Claude Code recovers from context overflow (compact conversation, then retry)
// only when the error message matches the Anthropic API's wording: it detects
// the substring "prompt is too long" and parses "<actual> tokens > <limit>".
// Upstream OpenAI-compatible providers phrase this error in many other ways,
// which clients treat as a fatal request failure instead. Rewriting the message
// re-enables the automatic recovery path.
export function normalizeContextOverflowMessage(
  status: number,
  message: string,
  errorCode?: string
): string | undefined {
  if (status !== 400 && status !== 413) {
    return undefined
  }

  const isOverflow =
    errorCode === "context_length_exceeded" ||
    contextOverflowPatterns.some((pattern) => pattern.test(message))
  if (!isOverflow) {
    return undefined
  }

  const upstreamNote = ` (upstream: ${message.length > 300 ? `${message.slice(0, 300)}…` : message})`

  for (const { pattern, order } of contextNumberPatterns) {
    const match = message.match(pattern)
    if (!match) {
      continue
    }
    const first = parseTokenCount(match[1])
    const second = parseTokenCount(match[2])
    const [actual, limit] = order === "actual-first" ? [first, second] : [second, first]
    if (Number.isFinite(actual) && Number.isFinite(limit) && actual > 0 && limit > 0) {
      return `prompt is too long: ${actual} tokens > ${limit} maximum${upstreamNote}`
    }
  }

  return `prompt is too long${upstreamNote}`
}

export function toGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) {
    return error
  }

  if (error instanceof Error) {
    const statusCode = (error as Error & { statusCode?: unknown }).statusCode
    if (
      typeof statusCode === "number" &&
      Number.isInteger(statusCode) &&
      statusCode >= 400 &&
      statusCode <= 599
    ) {
      return new GatewayError(statusCode, error.message)
    }

    return new GatewayError(500, error.message, "api_error")
  }

  return new GatewayError(500, "Unknown server error", "api_error")
}

export function toAnthropicErrorResponse(error: GatewayError): AnthropicErrorResponse {
  return {
    type: "error",
    error: {
      type: error.errorType,
      message: error.message
    }
  }
}

export function sendAnthropicError(reply: FastifyReply, error: GatewayError): FastifyReply {
  return reply.code(error.statusCode).send(toAnthropicErrorResponse(error))
}

export function toAnthropicStreamErrorEvent(error: GatewayError): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: error.errorType,
      message: error.message
    }
  }
}
