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

  return {
    id: response.id || `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    content,
    model: requestedModel || response.model,
    stop_reason: mapStopReason(firstChoice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: response.usage?.prompt_tokens_details?.cached_tokens,
      cache_creation_input_tokens: response.usage?.prompt_tokens_details?.cache_write_tokens
    }
  }
}

interface ToolState {
  blockIndex: number
  id: string
  name: string
  started: boolean
  closed: boolean
}

export class OpenAIStreamToAnthropic {
  private readonly messageId = `msg_${randomUUID().replace(/-/g, "")}`
  private readonly requestedModel: string
  private stopReason: AnthropicStopReason = "end_turn"
  private usage = {
    input_tokens: 0,
    output_tokens: 0
  }
  private started = false
  private finalized = false
  private nextBlockIndex = 0
  private textBlockIndex: number | null = null
  private textBlockClosed = false
  private thinkingBlockIndex: number | null = null
  private thinkingBlockClosed = false
  private readonly toolStates = new Map<number, ToolState>()

  constructor(requestedModel: string) {
    this.requestedModel = requestedModel
  }

  processChunk(chunk: Record<string, any>): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = []
    events.push(...this.ensureMessageStart())

    const choice = chunk.choices?.[0]
    const delta = choice?.delta ?? {}
    const finishReason = choice?.finish_reason

    if (chunk.usage) {
      this.usage.input_tokens = chunk.usage.prompt_tokens ?? this.usage.input_tokens
      this.usage.output_tokens = chunk.usage.completion_tokens ?? this.usage.output_tokens
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      events.push(...this.handleTextDelta(delta.content))
    }

    const reasoningText = this.readReasoningDelta(delta)
    if (reasoningText) {
      events.push(...this.handleThinkingDelta(reasoningText))
    }

    if (Array.isArray(delta.tool_calls)) {
      events.push(...this.handleToolCallDeltas(delta.tool_calls))
    }

    if (finishReason) {
      this.stopReason = mapStopReason(finishReason)
      if (finishReason === "tool_calls") {
        events.push(...this.closeOpenToolBlocks())
      }
    }

    return events
  }

  finalize(): AnthropicSseEvent[] {
    if (this.finalized) {
      return []
    }
    this.finalized = true

    const events: AnthropicSseEvent[] = []
    events.push(...this.ensureMessageStart())
    events.push(...this.closeRemainingBlocks())
    events.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: this.stopReason,
          stop_sequence: null
        },
        usage: {
          output_tokens: this.usage.output_tokens
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
            usage: {
              input_tokens: this.usage.input_tokens,
              output_tokens: this.usage.output_tokens
            }
          }
        }
      }
    ]
  }

  private handleTextDelta(text: string): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = []
    if (this.textBlockIndex === null) {
      this.textBlockIndex = this.nextBlockIndex++
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: this.textBlockIndex,
          content_block: {
            type: "text",
            text: ""
          }
        }
      })
    }

    if (!this.textBlockClosed) {
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.textBlockIndex,
          delta: {
            type: "text_delta",
            text
          }
        }
      })
    }

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
    if (this.thinkingBlockIndex === null) {
      this.thinkingBlockIndex = this.nextBlockIndex++
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: this.thinkingBlockIndex,
          content_block: {
            type: "thinking",
            thinking: ""
          }
        }
      })
    }

    if (!this.thinkingBlockClosed) {
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.thinkingBlockIndex,
          delta: {
            type: "thinking_delta",
            thinking
          }
        }
      })
    }
    return events
  }

  private handleToolCallDeltas(toolCalls: Array<Record<string, any>>): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = []

    for (const toolCall of toolCalls) {
      const openAiToolIndex = Number(toolCall.index ?? 0)
      let state = this.toolStates.get(openAiToolIndex)

      if (!state) {
        state = {
          blockIndex: this.nextBlockIndex++,
          id: toolCall.id || `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          name: toolCall.function?.name || "tool",
          started: false,
          closed: false
        }
        this.toolStates.set(openAiToolIndex, state)
      }

      if (toolCall.id && state.id.startsWith("toolu_")) {
        state.id = toolCall.id
      }
      if (toolCall.function?.name && state.name === "tool") {
        state.name = toolCall.function.name
      }

      if (!state.started) {
        state.started = true
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: state.blockIndex,
            content_block: {
              type: "tool_use",
              id: state.id,
              name: state.name,
              input: {}
            }
          }
        })
      }

      const argsDelta = toolCall.function?.arguments
      if (typeof argsDelta === "string" && argsDelta.length > 0) {
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: state.blockIndex,
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

  private closeOpenToolBlocks(): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = []
    for (const state of this.toolStates.values()) {
      if (state.started && !state.closed) {
        state.closed = true
        events.push({
          event: "content_block_stop",
          data: {
            type: "content_block_stop",
            index: state.blockIndex
          }
        })
      }
    }
    return events
  }

  private closeRemainingBlocks(): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = []

    if (this.textBlockIndex !== null && !this.textBlockClosed) {
      this.textBlockClosed = true
      events.push({
        event: "content_block_stop",
        data: {
          type: "content_block_stop",
          index: this.textBlockIndex
        }
      })
    }

    if (this.thinkingBlockIndex !== null && !this.thinkingBlockClosed) {
      this.thinkingBlockClosed = true
      events.push({
        event: "content_block_stop",
        data: {
          type: "content_block_stop",
          index: this.thinkingBlockIndex
        }
      })
    }

    events.push(...this.closeOpenToolBlocks())
    return events
  }
}
