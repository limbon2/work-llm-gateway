import { describe, expect, it } from "vitest"

import {
  OpenAIStreamToAnthropic,
  convertOpenAINonStreamToAnthropic
} from "../../src/adapters/openai_to_anthropic.js"
import { OpenAIChatCompletionResponse } from "../../src/types/contracts.js"

describe("convertOpenAINonStreamToAnthropic", () => {
  it("maps text, tool calls, usage, and stop reason", () => {
    const response: OpenAIChatCompletionResponse = {
      id: "chatcmpl-1",
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Running tool",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "sum",
                  arguments: "{\"a\":1,\"b\":2}"
                }
              }
            ]
          }
        }
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7
      }
    }

    const converted = convertOpenAINonStreamToAnthropic(response, "claude-sonnet-4-5")
    expect(converted.stop_reason).toBe("tool_use")
    expect(converted.usage.input_tokens).toBe(11)
    expect(converted.usage.output_tokens).toBe(7)
    expect(converted.content).toEqual([
      { type: "text", text: "Running tool" },
      { type: "tool_use", id: "call_1", name: "sum", input: { a: 1, b: 2 } }
    ])
  })
})

describe("OpenAIStreamToAnthropic", () => {
  it("emits Anthropic SSE-compatible event sequence", () => {
    const translator = new OpenAIStreamToAnthropic("claude-sonnet-4-5")
    const events = [
      ...translator.processChunk({
        id: "chatcmpl-a",
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }]
      }),
      ...translator.processChunk({
        id: "chatcmpl-a",
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2 }
      }),
      ...translator.finalize()
    ]

    expect(events.map((event) => event.event)).toContain("message_start")
    expect(events.map((event) => event.event)).toContain("content_block_start")
    expect(events.map((event) => event.event)).toContain("content_block_delta")
    expect(events.map((event) => event.event)).toContain("content_block_stop")
    expect(events.map((event) => event.event)).toContain("message_delta")
    expect(events.map((event) => event.event)).toContain("message_stop")

    const textDeltas = events.filter((event) => event.event === "content_block_delta")
    expect(textDeltas.some((event) => event.data.delta && (event.data.delta as any).text === "Hel")).toBe(true)
    expect(textDeltas.some((event) => event.data.delta && (event.data.delta as any).text === "lo")).toBe(true)
  })
})
