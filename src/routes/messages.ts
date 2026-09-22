import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"

import { convertAnthropicRequestToOpenAI } from "../adapters/anthropic_to_openai.js"
import {
  OpenAIStreamToAnthropic,
  convertOpenAINonStreamToAnthropic,
} from "../adapters/openai_to_anthropic.js"
import type { AnthropicMessagesRequest } from "../types/contracts.js"
import {
  GatewayError,
  toAnthropicStreamErrorEvent,
  toGatewayError,
} from "../utils/errors.js"
import {
  createSseParserState,
  formatSseEvent,
  parseSseChunk,
} from "../utils/sse.js"

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
  metadata: z.record(z.any()).optional(),
})

async function streamAnthropicResponse(
  app: FastifyInstance,
  payload: AnthropicMessagesRequest,
  reply: FastifyReply,
  gatewayRequestId: string,
  attemptId?: string,
): Promise<void> {
  const openAiPayload = convertAnthropicRequestToOpenAI(
    payload,
    app.gatewayConfig.modelAliases,
    app.gatewayConfig.upstreamModel,
  )
  openAiPayload.stream = true
  openAiPayload.stream_options = { include_usage: true }

  const upstreamResponse = await app.upstreamClient.streamChatCompletion(
    openAiPayload,
    {
      gatewayRequestId,
    },
  )

  if (!upstreamResponse.body) {
    throw new GatewayError(
      502,
      "Upstream stream did not return a body",
      "api_error",
    )
  }

  const translator = new OpenAIStreamToAnthropic(payload.model)
  const reader = upstreamResponse.body.getReader()
  const decoder = new TextDecoder()
  let parserState = createSseParserState()
  let terminal = false
  let usage: Record<string, unknown> | undefined
  const startedAt = Date.now()
  const idleMs =
    Number(process.env.STREAM_IDLE_TIMEOUT_MS) ||
    app.gatewayConfig.requestTimeoutMs
  const totalMs =
    Number(process.env.STREAM_TOTAL_TIMEOUT_MS) || Math.max(idleMs, 1800000)
  let totalTimer: ReturnType<typeof setTimeout> | undefined
  let interrupted: Error | undefined
  const interrupt = (error: Error) => {
    interrupted = error
    void reader.cancel(error).catch(() => {})
  }
  const disconnected = () => {
    if (!reply.raw.writableEnded) {
      interrupt(new GatewayError(499, "Client disconnected"))
    }
  }
  reply.raw.on("close", disconnected)
  totalTimer = setTimeout(
    () => interrupt(new GatewayError(504, "Upstream body deadline exceeded")),
    totalMs,
  )

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-IFE-Resolved-Model": openAiPayload.model,
  })

  try {
    while (true) {
      const idleTimer = setTimeout(
        () => interrupt(new GatewayError(504, "Upstream stream idle timeout")),
        idleMs,
      )
      let result: { done: boolean; value?: Uint8Array }

      try {
        result = await reader.read()
      } finally {
        clearTimeout(idleTimer)
      }

      if (interrupted) {
        throw interrupted
      }

      const { done, value } = result
      // Flush a complete final SSE record even if the provider omitted its blank line.
      const chunkText = done
        ? decoder.decode() + "\n\n"
        : decoder.decode(value, { stream: true })
      const parsed = parseSseChunk(chunkText, parserState)
      parserState = parsed.state

      for (const event of parsed.events) {
        if (event.data === "[DONE]") {
          terminal = true
          continue
        }

        let parsedChunk: Record<string, unknown>

        try {
          parsedChunk = JSON.parse(event.data) as Record<string, unknown>
        } catch {
          throw new GatewayError(502, "Malformed upstream stream event")
        }

        if (parsedChunk.error) {
          const body = parsedChunk.error as {
            message?: string
            code?: string
            type?: string
            retry_at?: number
            reset_at?: number
          }
          const error = new GatewayError(
            502,
            body.message || "Upstream stream error",
          )
          error.upstreamCode = body.code || body.type
          error.retryAt = body.retry_at
          error.resetAt = body.reset_at
          throw error
        }

        const choices = parsedChunk.choices as
          | Array<{ finish_reason?: string }>
          | undefined
        const finish = choices?.[0]?.finish_reason

        if (finish === "error") {
          throw new GatewayError(502, "Upstream returned error finish reason")
        }

        if (
          finish &&
          [
            "stop",
            "length",
            "tool_calls",
            "function_call",
            "content_filter",
          ].includes(finish)
        ) {
          terminal = true
        }

        if (parsedChunk.usage && typeof parsedChunk.usage === "object") {
          usage = parsedChunk.usage as Record<string, unknown>
        }

        const anthropicEvents = translator.processChunk(parsedChunk)

        for (const anthropicEvent of anthropicEvents) {
          reply.raw.write(
            formatSseEvent(anthropicEvent.event, anthropicEvent.data),
          )
        }
      }

      if (done) {
        break
      }
    }

    if (
      !terminal ||
      parserState.buffer.trim() ||
      parserState.currentData.length
    ) {
      throw new GatewayError(
        502,
        "Upstream stream ended before a complete terminal event",
      )
    }

    const finalEvents = translator.finalize()

    for (const event of finalEvents) {
      if (event.event === "message_delta") {
        event.data.usage_source =
          usage && typeof usage.completion_tokens === "number"
            ? "reported"
            : "estimated"
        event.data.usage_presence = {
          input: typeof usage?.prompt_tokens === "number",
          output: true,
        }
      }

      reply.raw.write(formatSseEvent(event.event, event.data))
    }

    app.log.info(
      {
        gatewayRequestId,
        attemptId,
        model: openAiPayload.model,
        durationMs: Date.now() - startedAt,
        usageSource: usage ? "reported" : "estimated",
        usage,
      },
      "Upstream stream completed",
    )
  } catch (error) {
    const gatewayError = toGatewayError(error)
    reply.raw.write(
      formatSseEvent("error", toAnthropicStreamErrorEvent(gatewayError)),
    )
  } finally {
    clearTimeout(totalTimer)
    reply.raw.off("close", disconnected)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    reply.raw.end()
  }
}

export function registerMessagesRoute(app: FastifyInstance): void {
  app.post("/v1/messages", async (request, reply) => {
    const attemptHeader = request.headers["x-ife-eval-attempt"]
    const attemptId =
      typeof attemptHeader === "string" ? attemptHeader : undefined
    const payload = anthropicMessageSchema.parse(
      request.body,
    ) as AnthropicMessagesRequest

    if (payload.stream) {
      await streamAnthropicResponse(app, payload, reply, request.id, attemptId)

      return reply
    }

    const openAiPayload = convertAnthropicRequestToOpenAI(
      payload,
      app.gatewayConfig.modelAliases,
      app.gatewayConfig.upstreamModel,
    )
    const upstreamResponse = await app.upstreamClient.createChatCompletion(
      openAiPayload,
      {
        gatewayRequestId: request.id,
      },
    )
    const anthropicResponse = convertOpenAINonStreamToAnthropic(
      upstreamResponse,
      payload.model,
    )
    app.log.info(
      { gatewayRequestId: request.id, attemptId, model: openAiPayload.model },
      "Upstream request completed",
    )

    return reply
      .header("x-ife-resolved-model", openAiPayload.model)
      .send(anthropicResponse)
  })
}
