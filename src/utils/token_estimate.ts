import type { AnthropicMessagesRequest } from "../types/contracts.js"
import { messageToText, systemPromptToText } from "./text_extraction.js"

export function estimateTokensFromText(text: string): number {
  const normalized = text.trim()
  if (!normalized) {
    return 0
  }

  // Approximation when exact tokenizer is unavailable.
  const charEstimate = Math.ceil(normalized.length / 4)
  const punctuationWeight = (normalized.match(/[.,!?;:()[\]{}]/g) ?? []).length
  return Math.max(1, charEstimate + Math.floor(punctuationWeight / 8))
}

export function estimateRequestInputTokens(request: AnthropicMessagesRequest): number {
  const textParts = [
    systemPromptToText(request.system),
    ...request.messages.map((message) => `${message.role}: ${messageToText(message)}`),
    ...(request.tools ?? []).map(
      (tool) => `${tool.name} ${tool.description ?? ""} ${JSON.stringify(tool.input_schema)}`
    )
  ].filter(Boolean)

  return estimateTokensFromText(textParts.join("\n"))
}
