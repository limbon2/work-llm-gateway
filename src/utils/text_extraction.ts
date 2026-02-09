import type {
  AnthropicMessage,
  AnthropicMessageContentBlock,
  AnthropicToolResultBlock
} from "../types/contracts.js"

function toolResultToText(block: AnthropicToolResultBlock): string {
  if (typeof block.content === "string") {
    return block.content
  }

  return block.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

export function contentBlocksToText(blocks: AnthropicMessageContentBlock[]): string {
  const parts: string[] = []

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text)
        break
      case "thinking":
        parts.push(block.thinking)
        break
      case "redacted_thinking":
        parts.push(block.data)
        break
      case "tool_use":
        parts.push(`tool:${block.name}`)
        parts.push(JSON.stringify(block.input ?? {}))
        break
      case "tool_result":
        parts.push(toolResultToText(block))
        break
      default:
        break
    }
  }

  return parts.join("\n")
}

export function systemPromptToText(system?: string | AnthropicMessageContentBlock[]): string {
  if (!system) {
    return ""
  }

  if (typeof system === "string") {
    return system
  }

  return contentBlocksToText(system)
}

export function messageToText(message: AnthropicMessage): string {
  if (typeof message.content === "string") {
    return message.content
  }

  return contentBlocksToText(message.content)
}
