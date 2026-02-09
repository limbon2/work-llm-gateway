import { describe, expect, it } from "vitest"

import { convertAnthropicRequestToOpenAI } from "../../src/adapters/anthropic_to_openai.js"
import { AnthropicMessagesRequest } from "../../src/types/contracts.js"

describe("convertAnthropicRequestToOpenAI", () => {
  it("maps basic text request, model alias, and stream flags", () => {
    const request: AnthropicMessagesRequest = {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      system: "You are concise.",
      messages: [{ role: "user", content: "Hello there" }]
    }

    const converted = convertAnthropicRequestToOpenAI(request, {
      "claude-sonnet-4-5": "gpt-4o-mini"
    })

    expect(converted.model).toBe("gpt-4o-mini")
    expect(converted.max_tokens).toBe(1024)
    expect(converted.stream).toBe(true)
    expect(converted.stream_options?.include_usage).toBe(true)
    expect(converted.messages).toEqual([
      { role: "system", content: "You are concise." },
      { role: "user", content: "Hello there" }
    ])
  })

  it("maps tools, tool choice, assistant tool_use, and user tool_result", () => {
    const request: AnthropicMessagesRequest = {
      model: "any-model",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "sum",
              input: { a: 1, b: 2 }
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: "3"
            }
          ]
        }
      ],
      tools: [
        {
          name: "sum",
          description: "Add two numbers",
          input_schema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" }
            },
            required: ["a", "b"]
          }
        }
      ],
      tool_choice: { type: "any", disable_parallel_tool_use: true }
    }

    const converted = convertAnthropicRequestToOpenAI(request, {})

    expect(converted.tool_choice).toBe("required")
    expect(converted.parallel_tool_calls).toBe(false)
    expect(converted.tools).toHaveLength(1)
    expect(converted.messages[0]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "sum" }
        }
      ]
    })
    expect(converted.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "3"
    })
  })

  it("uses forced upstream model when configured", () => {
    const request: AnthropicMessagesRequest = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hello" }]
    }

    const converted = convertAnthropicRequestToOpenAI(
      request,
      { "claude-sonnet-4-5": "gpt-4o-mini" },
      "gpt-4.1"
    )

    expect(converted.model).toBe("gpt-4.1")
  })
})
