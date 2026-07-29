import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"

import { convertAnthropicRequestToOpenAI } from "../adapters/anthropic_to_openai.js"
import { OpenAIStreamToAnthropic, convertOpenAINonStreamToAnthropic } from "../adapters/openai_to_anthropic.js"
import type { AnthropicMessagesRequest } from "../types/contracts.js"
import { GatewayError, toAnthropicStreamErrorEvent, toGatewayError } from "../utils/errors.js"
import { createSseParserState, formatSseEvent, parseSseChunk } from "../utils/sse.js"

const anthropicMessageSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.any()).min(1),
  system: z.union([z.string(), z.array(z.any())]).optional(),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional()
})

async function streamAnthropicResponse(
  app: FastifyInstance,
  payload: AnthropicMessagesRequest,
  reply: FastifyReply
): Promise<void> {
  const openAiPayload = convertAnthropicRequestToOpenAI(
    payload,
    app.gatewayConfig.modelAliases,
    app.gatewayConfig.upstreamModel
  )
  openAiPayload.stream = true
  openAiPayload.stream_options = { include_usage: true }

  const upstreamResponse = await app.upstreamClient.streamChatCompletion(openAiPayload)
  if (!upstreamResponse.body) {
    throw new GatewayError(502, "Upstream stream did not return a body", "api_error")
  }

  const translator = new OpenAIStreamToAnthropic(payload.model)
  const reader = upstreamResponse.body.getReader()
  const decoder = new TextDecoder()
  let parserState = createSseParserState()

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      const chunkText = decoder.decode(value, { stream: true })
      const parsed = parseSseChunk(chunkText, parserState)
      parserState = parsed.state

      for (const event of parsed.events) {
        if (event.data === "[DONE]") {
          continue
        }

        let parsedChunk: Record<string, unknown>
        try {
          parsedChunk = JSON.parse(event.data) as Record<string, unknown>
        } catch {
          continue
        }

        const anthropicEvents = translator.processChunk(parsedChunk)
        for (const anthropicEvent of anthropicEvents) {
          reply.raw.write(formatSseEvent(anthropicEvent.event, anthropicEvent.data))
        }
      }
    }

    const finalEvents = translator.finalize()
    for (const event of finalEvents) {
      reply.raw.write(formatSseEvent(event.event, event.data))
    }
  } catch (error) {
    const gatewayError = toGatewayError(error)
    reply.raw.write(formatSseEvent("error", toAnthropicStreamErrorEvent(gatewayError)))
  } finally {
    reader.releaseLock()
    reply.raw.end()
  }
}

export function registerMessagesRoute(app: FastifyInstance): void {
  app.post("/v1/messages", async (request, reply) => {
    const payload = anthropicMessageSchema.parse(request.body) as AnthropicMessagesRequest

    if (payload.stream) {
      await streamAnthropicResponse(app, payload, reply)
      return reply
    }

    const openAiPayload = convertAnthropicRequestToOpenAI(
      payload,
      app.gatewayConfig.modelAliases,
      app.gatewayConfig.upstreamModel
    )
    const upstreamResponse = await app.upstreamClient.createChatCompletion(openAiPayload)
    const anthropicResponse = convertOpenAINonStreamToAnthropic(upstreamResponse, payload.model)
    return reply.send(anthropicResponse)
  })
}
