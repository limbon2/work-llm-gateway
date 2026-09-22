import type { FastifyInstance } from "fastify"

export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/healthz", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }))
  // Authenticated capability check used by the benchmark. No credentials or upstream URL.
  app.get("/v1/eval-capabilities", async () => ({
    version: 1,
    forcedModel: app.gatewayConfig.upstreamModel || null,
    aliases: app.gatewayConfig.modelAliases,
    streamCompletionChecks: true,
    structuredErrors: true,
  }))
}
