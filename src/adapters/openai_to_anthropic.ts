import { randomUUID } from "node:crypto"

import {
  AnthropicResponse,
  AnthropicSseEvent,
  AnthropicStopReason,
  OpenAIChatCompletionResponse,
  OpenAIToolCall
} from "../types/contracts.js"

function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return { raw }
  }
}

interface NormalizedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

// OpenAI's prompt_tokens INCLUDES cached tokens; Anthropic's input_tokens
// EXCLUDES cache reads/writes and reports them in separate fields. Clients sum
// all four fields to get the total, so cached tokens must be subtracted here
// or they get counted twice.
function normalizeOpenAIUsage(usage: Record<string, any> | null | undefined): NormalizedUsage {
  const promptTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0
  const completionTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0
  const details = usage?.prompt_tokens_details
  const cacheRead = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0
  const cacheWrite = typeof details?.cache_write_tokens === "number" ? details.cache_write_tokens : 0

  return {
    inputTokens: Math.max(0, promptTokens - cacheRead - cacheWrite),
    outputTokens: completionTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite
  }
}

export function mapStopReason(stopReason: string | null | undefined): AnthropicStopReason {
  switch (stopReason) {
    case "length":
      return "max_tokens"
    case "tool_calls":
      return "tool_use"
    case "stop":
      return "end_turn"
    default:
      return "end_turn"
  }
}

function convertToolCalls(toolCalls: OpenAIToolCall[] | undefined) {
  if (!toolCalls || toolCalls.length === 0) {
    return []
  }

  return toolCalls.map((toolCall) => ({
    type: "tool_use" as const,
    id: toolCall.id,
    name: toolCall.function.name,
    input: parseToolInput(toolCall.function.arguments)
  }))
}

export function convertOpenAINonStreamToAnthropic(
  response: OpenAIChatCompletionResponse,
  requestedModel: string
): AnthropicResponse {
  const firstChoice = response.choices[0]
  const assistantMessage = firstChoice?.message
  const content = []

  if (assistantMessage?.content) {
    content.push({
      type: "text" as const,
      text: assistantMessage.content
    })
  }

  content.push(...convertToolCalls(assistantMessage?.tool_calls))

  const usage = normalizeOpenAIUsage(response.usage)

  return {
    id: response.id || `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    content,
    model: requestedModel || response.model,
    stop_reason: mapStopReason(firstChoice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadInputTokens,
      cache_creation_input_tokens: usage.cacheCreationInputTokens
    }
  }
}

interface ToolIdentity {
  id: string
  name: string
}

// Anthropic streams content blocks strictly sequentially: block N emits
// content_block_stop before block N+1 emits content_block_start. Clients
// (including Claude Code) rely on that ordering when they reconstruct the
// message, so only one block may ever be open at a time.
type OpenBlock =
  | { kind: "text"; index: number }
  | { kind: "thinking"; index: number }
  | { kind: "tool"; index: number; openAiToolIndex: number }

export class OpenAIStreamToAnthropic {
  private readonly messageId = `msg_${randomUUID().replace(/-/g, "")}`
  private readonly requestedModel: string
  private readonly estimatedInputTokens?: number
  private stopReason: AnthropicStopReason = "end_turn"
  private usage: NormalizedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  }
  private promptUsageReported = false
  private completionUsageReported = false
  private emittedChars = 0
  private started = false
  private finalized = false
  private nextBlockIndex = 0
  private openBlock: OpenBlock | null = null
  private readonly toolIdentities = new Map<number, ToolIdentity>()

  constructor(requestedModel: string, estimatedInputTokens?: number) {
    this.requestedModel = requestedModel
    this.estimatedInputTokens = estimatedInputTokens
  }

  processChunk(chunk: Record<string, any>): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = []
    events.push(...this.ensureMessageStart())

    const choice = chunk.choices?.[0]
    const delta = choice?.delta ?? {}
    const finishReason = choice?.finish_reason

    if (chunk.usage) {
      const normalized = normalizeOpenAIUsage(chunk.usage)
      if (typeof chunk.usage.prompt_tokens === "number" && chunk.usage.prompt_tokens > 0) {
        this.promptUsageReported = true
        this.usage.inputTokens = normalized.inputTokens
        this.usage.cacheReadInputTokens = normalized.cacheReadInputTokens
        this.usage.cacheCreationInputTokens = normalized.cacheCreationInputTokens
      }
      if (typeof chunk.usage.completion_tokens === "number" && chunk.usage.completion_tokens > 0) {
        this.completionUsageReported = true
        this.usage.outputTokens = normalized.outputTokens
      }
    }

    // Reasoning precedes the answer, so thinking blocks must open before text.
    const reasoningText = this.readReasoningDelta(delta)
    if (reasoningText) {
      events.push(...this.handleThinkingDelta(reasoningText))
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      events.push(...this.handleTextDelta(delta.content))
    }

    if (Array.isArray(delta.tool_calls)) {
      events.push(...this.handleToolCallDeltas(delta.tool_calls))
    }

    if (finishReason) {
      this.stopReason = mapStopReason(finishReason)
      events.push(...this.closeOpenBlock())
    }

    return events
  }

  finalize(): AnthropicSseEvent[] {
    if (this.finalized) {
      return []
    }
    this.finalized = true

    // Estimated fallbacks keep token accounting meaningful for upstreams that
    // never report usage; real reported values always win.
    const inputTokens = this.promptUsageReported
      ? this.usage.inputTokens
      : (this.estimatedInputTokens ?? 0)
    const outputTokens = this.completionUsageReported
      ? this.usage.outputTokens
      : this.emittedChars > 0
        ? Math.max(1, Math.ceil(this.emittedChars / 4))
        : 0

    const events: AnthropicSseEvent[] = []
    events.push(...this.ensureMessageStart())
    events.push(...this.closeOpenBlock())
    events.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: this.stopReason,
          stop_sequence: null
        },
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: this.usage.cacheReadInputTokens,
          cache_creation_input_tokens: this.usage.cacheCreationInputTokens
        }
      }
    })
    events.push({
      event: "message_stop",
      data: {
        type: "message_stop"
      }
    })
    return events
  }

  private ensureMessageStart(): AnthropicSseEvent[] {
    if (this.started) {
      return []
    }

    this.started = true
    return [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: this.messageId,
            type: "message",
            role: "assistant",
            model: this.requestedModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            // Zeros, not estimates: real usage arrives only in the upstream's
            // final chunk and is reported via message_delta. Clients merge that
            // into the message, and several (including Claude Code) prefer the
            // merged final values only when the message_start snapshot reads 0.
            usage: {
              input_tokens: 0,
              output_tokens: 0
            }
          }
        }
      }
    ]
  }

  private closeOpenBlock(): AnthropicSseEvent[] {
    if (!this.openBlock) {
      return []
    }

    const index = this.openBlock.index
    this.openBlock = null
    return [
      {
        event: "content_block_stop",
        data: {
          type: "content_block_stop",
          index
        }
      }
    ]
  }

  private handleTextDelta(text: string): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = []
    this.emittedChars += text.length

    if (this.openBlock?.kind !== "text") {
      events.push(...this.closeOpenBlock())
      this.openBlock = { kind: "text", index: this.nextBlockIndex++ }
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: this.openBlock.index,
          content_block: {
            type: "text",
            text: ""
          }
        }
      })
    }

    events.push({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: this.openBlock.index,
        delta: {
          type: "text_delta",
          text
        }
      }
    })

    return events
  }

  private readReasoningDelta(delta: Record<string, unknown>): string | undefined {
    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
      return delta.reasoning
    }

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      return delta.reasoning_content
    }

    return undefined
  }

  private handleThinkingDelta(thinking: string): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = []
    this.emittedChars += thinking.length

    if (this.openBlock?.kind !== "thinking") {
      events.push(...this.closeOpenBlock())
      this.openBlock = { kind: "thinking", index: this.nextBlockIndex++ }
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: this.openBlock.index,
          content_block: {
            type: "thinking",
            thinking: ""
          }
        }
      })
    }

    events.push({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: this.openBlock.index,
        delta: {
          type: "thinking_delta",
          thinking
        }
      }
    })

    return events
  }

  private handleToolCallDeltas(toolCalls: Array<Record<string, any>>): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = []

    for (const toolCall of toolCalls) {
      const openAiToolIndex = Number(toolCall.index ?? 0)
      let identity = this.toolIdentities.get(openAiToolIndex)

      if (!identity) {
        identity = {
          id: toolCall.id || `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          name: toolCall.function?.name || "tool"
        }
        this.toolIdentities.set(openAiToolIndex, identity)
      } else {
        if (toolCall.id && identity.id.startsWith("toolu_")) {
          identity.id = toolCall.id
        }
        if (toolCall.function?.name && identity.name === "tool") {
          identity.name = toolCall.function.name
        }
      }

      if (this.openBlock?.kind !== "tool" || this.openBlock.openAiToolIndex !== openAiToolIndex) {
        events.push(...this.closeOpenBlock())
        this.openBlock = { kind: "tool", index: this.nextBlockIndex++, openAiToolIndex }
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: this.openBlock.index,
            content_block: {
              type: "tool_use",
              id: identity.id,
              name: identity.name,
              input: {}
            }
          }
        })
      }

      const argsDelta = toolCall.function?.arguments
      if (typeof argsDelta === "string" && argsDelta.length > 0) {
        this.emittedChars += argsDelta.length
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: this.openBlock.index,
            delta: {
              type: "input_json_delta",
              partial_json: argsDelta
            }
          }
        })
      }
    }

    return events
  }
}
