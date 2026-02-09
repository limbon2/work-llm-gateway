import {
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicMessageContentBlock,
  AnthropicToolChoice,
  AnthropicToolResultBlock,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAIImagePart,
  OpenAITextPart,
  OpenAIToolChoice,
  OpenAIToolDefinition
} from "../types/contracts.js"
import { GatewayError } from "../utils/errors.js"

function normalizeModel(
  model: string,
  aliases: Record<string, string>,
  forcedModel?: string
): string {
  return forcedModel || aliases[model] || model
}

function systemToOpenAIMessage(system?: string | AnthropicMessageContentBlock[]): OpenAIChatMessage[] {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  }

  const textBlocks = system
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)

  if (textBlocks.length === 0) {
    return []
  }

  return [{ role: "system", content: textBlocks.join("\n") }]
}

function toolResultContentToText(block: AnthropicToolResultBlock): string {
  if (typeof block.content === "string") {
    return block.content
  }

  return block.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function imageBlockToPart(block: Extract<AnthropicMessageContentBlock, { type: "image" }>): OpenAIImagePart {
  const source = block.source
  if (!source) {
    throw new GatewayError(400, "Image block is missing source", "invalid_request_error")
  }

  if (source.type === "url" && source.url) {
    return { type: "image_url", image_url: { url: source.url } }
  }

  if (source.type === "base64" && source.media_type && source.data) {
    return {
      type: "image_url",
      image_url: { url: `data:${source.media_type};base64,${source.data}` }
    }
  }

  throw new GatewayError(400, "Unsupported image source format", "invalid_request_error")
}

function flushUserParts(parts: Array<OpenAITextPart | OpenAIImagePart>, target: OpenAIChatMessage[]): void {
  if (parts.length === 0) {
    return
  }

  if (parts.length === 1 && parts[0].type === "text") {
    target.push({ role: "user", content: parts[0].text })
  } else {
    target.push({ role: "user", content: [...parts] })
  }
  parts.length = 0
}

function convertUserContentBlocks(blocks: AnthropicMessageContentBlock[]): OpenAIChatMessage[] {
  const result: OpenAIChatMessage[] = []
  const pendingParts: Array<OpenAITextPart | OpenAIImagePart> = []

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        pendingParts.push({ type: "text", text: block.text })
        break
      case "image":
        pendingParts.push(imageBlockToPart(block))
        break
      case "tool_result":
        flushUserParts(pendingParts, result)
        result.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultContentToText(block)
        })
        break
      case "thinking":
      case "redacted_thinking":
      case "document":
        // Drop unsupported internal blocks.
        break
      case "tool_use":
        throw new GatewayError(
          400,
          "tool_use blocks are not valid in user messages",
          "invalid_request_error"
        )
      default:
        break
    }
  }

  flushUserParts(pendingParts, result)
  return result
}

function convertAssistantContentBlocks(blocks: AnthropicMessageContentBlock[]): OpenAIChatMessage[] {
  const textParts: string[] = []
  const toolCalls: NonNullable<OpenAIChatMessage["tool_calls"]> = []

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        textParts.push(block.text)
        break
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {})
          }
        })
        break
      case "thinking":
      case "redacted_thinking":
      case "document":
      case "image":
      case "tool_result":
        break
      default:
        break
    }
  }

  if (textParts.length === 0 && toolCalls.length === 0) {
    return []
  }

  return [
    {
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("\n") : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    }
  ]
}

function convertMessage(message: AnthropicMessage): OpenAIChatMessage[] {
  if (typeof message.content === "string") {
    return [{ role: message.role, content: message.content }]
  }

  if (message.role === "user") {
    return convertUserContentBlocks(message.content)
  }

  return convertAssistantContentBlocks(message.content)
}

function convertTools(tools?: AnthropicMessagesRequest["tools"]): OpenAIToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    }
  }))
}

function convertToolChoice(toolChoice?: AnthropicToolChoice): OpenAIToolChoice | undefined {
  if (!toolChoice) {
    return undefined
  }

  switch (toolChoice.type) {
    case "auto":
      return "auto"
    case "none":
      return "none"
    case "any":
      return "required"
    case "tool":
      return {
        type: "function",
        function: {
          name: toolChoice.name
        }
      }
    default:
      return undefined
  }
}

function convertParallelToolCalls(toolChoice?: AnthropicToolChoice): boolean | undefined {
  if (!toolChoice || !("disable_parallel_tool_use" in toolChoice)) {
    return undefined
  }
  return !toolChoice.disable_parallel_tool_use
}

export function convertAnthropicRequestToOpenAI(
  request: AnthropicMessagesRequest,
  modelAliases: Record<string, string>,
  forcedUpstreamModel?: string
): OpenAIChatCompletionRequest {
  const messages: OpenAIChatMessage[] = [...systemToOpenAIMessage(request.system)]

  for (const anthropicMessage of request.messages) {
    messages.push(...convertMessage(anthropicMessage))
  }

  return {
    model: normalizeModel(request.model, modelAliases, forcedUpstreamModel),
    messages,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    stop: request.stop_sequences,
    tools: convertTools(request.tools),
    tool_choice: convertToolChoice(request.tool_choice),
    parallel_tool_calls: convertParallelToolCalls(request.tool_choice),
    stream: request.stream ?? false,
    ...(request.stream ? { stream_options: { include_usage: true } } : {})
  }
}
