export type AnthropicRole = "user" | "assistant"

export type AnthropicStopReason = "end_turn" | "max_tokens" | "tool_use" | "stop_sequence"

export interface AnthropicTextBlock {
  type: "text"
  text: string
}

export interface AnthropicImageBlock {
  type: "image"
  source?: {
    type: "base64" | "url"
    media_type?: string
    data?: string
    url?: string
  }
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: unknown
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<{ type: "text"; text: string }>
  is_error?: boolean
}

export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking"
  data: string
}

export interface AnthropicDocumentBlock {
  type: "document"
}

export type AnthropicMessageContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicDocumentBlock

export interface AnthropicMessage {
  role: AnthropicRole
  content: string | AnthropicMessageContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export type AnthropicToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" }

export interface AnthropicMessagesRequest {
  model: string
  messages: AnthropicMessage[]
  max_tokens?: number
  system?: string | AnthropicMessageContentBlock[]
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  stream?: boolean
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  metadata?: {
    user_id?: string
  }
}

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>
  model: string
  stop_reason: AnthropicStopReason
  stop_sequence: string | null
  usage: AnthropicUsage
}

export interface AnthropicErrorResponse {
  type: "error"
  error: {
    type: string
    message: string
  }
}

export interface OpenAITextPart {
  type: "text"
  text: string
}

export interface OpenAIImagePart {
  type: "image_url"
  image_url: {
    url: string
  }
}

export type OpenAIMessageContent = string | Array<OpenAITextPart | OpenAIImagePart>

export interface OpenAIToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content?: OpenAIMessageContent | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

export interface OpenAIToolDefinition {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "function"
      function: {
        name: string
      }
    }

export interface OpenAIChatCompletionRequest {
  model: string
  messages: OpenAIChatMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  tools?: OpenAIToolDefinition[]
  tool_choice?: OpenAIToolChoice
  parallel_tool_calls?: boolean
  stream?: boolean
  stream_options?: {
    include_usage?: boolean
  }
}

export interface OpenAIChatCompletionResponse {
  id: string
  model: string
  choices: Array<{
    index: number
    finish_reason: string | null
    message: {
      role: "assistant"
      content?: string | null
      tool_calls?: OpenAIToolCall[]
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
      cache_write_tokens?: number
    }
  }
}

export interface AnthropicSseEvent {
  event: string
  data: Record<string, unknown>
}

export interface ModelListResponse {
  data: Array<{
    id: string
    type: "model"
    display_name: string
    created_at: number
  }>
  first_id: string | null
  last_id: string | null
  has_more: boolean
}
