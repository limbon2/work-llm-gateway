import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { estimateTokensFromText } from "../utils/token_estimate.js"
import { messageToText, systemPromptToText } from "../utils/text_extraction.js"

const tokenCountSchema = z.object({
  model: z.string().optional(),
  system: z.union([z.string(), z.array(z.any())]).optional(),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.union([z.string(), z.array(z.any())])
    })
  )
})

export function registerTokenRoute(app: FastifyInstance): void {
  app.post("/v1/messages/count_tokens", async (request, reply) => {
    const payload = tokenCountSchema.parse(request.body)

    const textParts = [
      systemPromptToText(payload.system as any),
      ...payload.messages.map((message) => {
        const text = messageToText(message as any)
        return text.trim().length > 0 ? `${message.role}: ${text}` : ""
      })
    ].filter(Boolean)

    const combined = textParts.join("\n")
    const inputTokens = estimateTokensFromText(combined)
    return reply.send({ input_tokens: inputTokens })
  })
}
