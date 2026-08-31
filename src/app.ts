import Fastify, { type FastifyInstance } from "fastify"

import { GatewayConfig } from "./config/env.js"
import { UpstreamClient, UpstreamOpenAIClient } from "./clients/upstream_openai.js"
import { registerHealthRoute } from "./routes/health.js"
import { registerMessagesRoute } from "./routes/messages.js"
import { registerModelsRoute } from "./routes/models.js"
import { registerTokenRoute } from "./routes/tokens.js"
import { GatewayError, sendAnthropicError, toGatewayError } from "./utils/errors.js"

declare module "fastify" {
  interface FastifyInstance {
    gatewayConfig: GatewayConfig
    upstreamClient: UpstreamClient
  }
}

interface CreateAppOptions {
  upstreamClient?: UpstreamClient
}

function readGatewayKeyFromHeaders(headers: Record<string, unknown>): string | undefined {
  const directKey = headers["x-api-key"]
  if (typeof directKey === "string" && directKey.length > 0) {
    return directKey
  }

  const authHeader = headers.authorization
  if (typeof authHeader !== "string") {
    return undefined
  }

  if (!authHeader.startsWith("Bearer ")) {
    return undefined
  }

  return authHeader.slice("Bearer ".length).trim()
}

export function createApp(config: GatewayConfig, options: CreateAppOptions = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: config.requestBodyLimitBytes,
    logger: {
      level: config.logLevel
    }
  })

  app.decorate("gatewayConfig", config)
  app.decorate(
    "upstreamClient",
    options.upstreamClient ?? new UpstreamOpenAIClient(config, app.log)
  )

  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0]
    if (path === "/healthz" || config.gatewayApiKeys.length === 0) {
      return
    }

    const providedKey = readGatewayKeyFromHeaders(request.headers as Record<string, unknown>)
    if (!providedKey || !config.gatewayApiKeys.includes(providedKey)) {
      throw new GatewayError(401, "Invalid gateway API key", "authentication_error")
    }
  })

  app.setErrorHandler((error, _request, reply) => {
    const gatewayError = toGatewayError(error)
    app.log.error({ err: error }, gatewayError.message)
    sendAnthropicError(reply, gatewayError)
  })

  registerHealthRoute(app)
  registerMessagesRoute(app)
  registerTokenRoute(app)
  registerModelsRoute(app)

  return app
}
