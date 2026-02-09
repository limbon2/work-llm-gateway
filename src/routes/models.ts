import type { FastifyInstance } from "fastify"

import type { ModelListResponse } from "../types/contracts.js"

function mapModels(ids: string[]): ModelListResponse {
  const data = ids.map((id) => ({
    id,
    type: "model" as const,
    display_name: id,
    created_at: 0
  }))

  return {
    data,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    has_more: false
  }
}

export function registerModelsRoute(app: FastifyInstance): void {
  app.get("/v1/models", async (_request, reply) => {
    const upstreamModels = await app.upstreamClient.listModels()
    const aliasModels = Object.keys(app.gatewayConfig.modelAliases)

    const allIds = [...new Set([...aliasModels, ...upstreamModels])]
    return reply.send(mapModels(allIds))
  })
}
