import type {
  AnthropicMessage,
  AnthropicMessageContentBlock,
  AnthropicToolResultBlock
} from "../types/contracts.js"
import { stripClaudeCodeTokenReminders } from "./token_reminders.js"

function appendSanitizedText(parts: string[], text: string): void {
  const sanitized = stripClaudeCodeTokenReminders(text)
  if (sanitized.trim().length > 0) {
    parts.push(sanitized)
  }
}

function toolResultToText(block: AnthropicToolResultBlock): string {
  if (typeof block.content === "string") {
    return stripClaudeCodeTokenReminders(block.content)
  }

  return block.content
    .filter((part) => part.type === "text")
    .map((part) => stripClaudeCodeTokenReminders(part.text))
    .filter((text) => text.trim().length > 0)
    .join("\n")
}

export function contentBlocksToText(blocks: AnthropicMessageContentBlock[]): string {
  const parts: string[] = []

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        appendSanitizedText(parts, block.text)
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
      case "tool_result": {
        const text = toolResultToText(block)
        if (text.trim().length > 0) {
          parts.push(text)
        }
        break
      }
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
    return stripClaudeCodeTokenReminders(system)
  }

  return contentBlocksToText(system)
}

export function messageToText(message: AnthropicMessage): string {
  if (typeof message.content === "string") {
    return stripClaudeCodeTokenReminders(message.content)
  }

  return contentBlocksToText(message.content)
}
