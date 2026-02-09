import type { FastifyReply } from "fastify"

import type { AnthropicErrorResponse } from "../types/contracts.js"

type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "api_error"

const statusToErrorType: Record<number, AnthropicErrorType> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "invalid_request_error",
  429: "rate_limit_error"
}

function defaultErrorType(status: number): AnthropicErrorType {
  return statusToErrorType[status] ?? "api_error"
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

export function toGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) {
    return error
  }

  if (error instanceof Error) {
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
