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

  it("closes each block before starting the next (reasoning then text)", () => {
    const translator = new OpenAIStreamToAnthropic("claude-sonnet-4-5")
    const events = [
      ...translator.processChunk({
        choices: [{ index: 0, delta: { reasoning_content: "thinking..." }, finish_reason: null }]
      }),
      ...translator.processChunk({
        choices: [{ index: 0, delta: { content: "Answer" }, finish_reason: null }]
      }),
      ...translator.processChunk({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      }),
      ...translator.finalize()
    ]

    const sequence = events.map((event) => `${event.event}:${(event.data as any).index ?? ""}`)
    expect(sequence).toEqual([
      "message_start:",
      "content_block_start:0",
      "content_block_delta:0",
      "content_block_stop:0",
      "content_block_start:1",
      "content_block_delta:1",
      "content_block_stop:1",
      "message_delta:",
      "message_stop:"
    ])

    const starts = events.filter((event) => event.event === "content_block_start")
    expect((starts[0].data as any).content_block.type).toBe("thinking")
    expect((starts[1].data as any).content_block.type).toBe("text")
  })

  it("closes each block before starting the next (reasoning, text, then tool calls)", () => {
    const translator = new OpenAIStreamToAnthropic("claude-sonnet-4-5")
    const events = [
      ...translator.processChunk({
        choices: [{ index: 0, delta: { reasoning_content: "plan" }, finish_reason: null }]
      }),
      ...translator.processChunk({
        choices: [{ index: 0, delta: { content: "Calling tools" }, finish_reason: null }]
      }),
      ...translator.processChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", type: "function", function: { name: "sum", arguments: "{\"a\":" } }
              ]
            },
            finish_reason: null
          }
        ]
      }),
      ...translator.processChunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] },
            finish_reason: null
          }
        ]
      }),
      ...translator.processChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, id: "call_b", type: "function", function: { name: "max", arguments: "{}" } }
              ]
            },
            finish_reason: null
          }
        ]
      }),
      ...translator.processChunk({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
      }),
      ...translator.finalize()
    ]

    const starts = events.filter((event) => event.event === "content_block_start")
    expect(starts.map((event) => (event.data as any).content_block.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
      "tool_use"
    ])
    expect((starts[2].data as any).content_block).toMatchObject({ id: "call_a", name: "sum" })
    expect((starts[3].data as any).content_block).toMatchObject({ id: "call_b", name: "max" })

    // Sequential contract: every block stops before the next one starts,
    // and no stops are deferred to the end of the stream.
    let open: number | null = null
    for (const event of events) {
      if (event.event === "content_block_start") {
        expect(open).toBeNull()
        open = (event.data as any).index
      }
      if (event.event === "content_block_stop") {
        expect((event.data as any).index).toBe(open)
        open = null
      }
      if (event.event === "message_delta") {
        expect(open).toBeNull()
      }
    }

    const stops = events.filter((event) => event.event === "content_block_stop")
    expect(stops.map((event) => (event.data as any).index)).toEqual([0, 1, 2, 3])
  })

  it("reports full usage in message_delta with Anthropic cache semantics", () => {
    const translator = new OpenAIStreamToAnthropic("claude-sonnet-4-5")
    const events = [
      ...translator.processChunk({
        choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }]
      }),
      ...translator.processChunk({
        choices: [],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 1000 }
        }
      }),
      ...translator.finalize()
    ]

    const messageStart = events.find((event) => event.event === "message_start")
    expect((messageStart?.data as any).message.usage.input_tokens).toBe(0)

    const messageDelta = events.find((event) => event.event === "message_delta")
    expect((messageDelta?.data as any).usage).toEqual({
      input_tokens: 200,
      output_tokens: 40,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0
    })
  })

  it("estimates only output tokens when the upstream never reports usage", () => {
    const translator = new OpenAIStreamToAnthropic("claude-sonnet-4-5")
    const events = [
      ...translator.processChunk({
        choices: [{ index: 0, delta: { content: "twelve chars" }, finish_reason: "stop" }]
      }),
      ...translator.finalize()
    ]

    const messageDelta = events.find((event) => event.event === "message_delta")
    expect((messageDelta?.data as any).usage).toEqual({
      input_tokens: 0,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    })
  })

  it("tolerates upstreams that set finish_reason on every chunk", () => {
    const translator = new OpenAIStreamToAnthropic("claude-sonnet-4-5")
    const events = [
      ...translator.processChunk({
        choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: "stop" }]
      }),
      ...translator.processChunk({
        choices: [{ index: 0, delta: { content: "lo " }, finish_reason: "stop" }]
      }),
      ...translator.processChunk({
        choices: [{ index: 0, delta: { content: "there" }, finish_reason: "stop" }]
      }),
      ...translator.finalize()
    ]

    // The message must stay a single text block; per-chunk finish_reason must
    // not fragment it.
    const starts = events.filter((event) => event.event === "content_block_start")
    expect(starts).toHaveLength(1)
    const text = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => (event.data as any).delta.text)
      .join("")
    expect(text).toBe("Hello there")
    expect((events.find((e) => e.event === "message_delta")?.data as any).delta.stop_reason).toBe("end_turn")
  })

  it("keeps tool call arguments intact when tool-call indices interleave", () => {
    const translator = new OpenAIStreamToAnthropic("claude-sonnet-4-5")
    const events = [
      ...translator.processChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", type: "function", function: { name: "sum", arguments: "{\"a\":1," } },
                { index: 1, id: "call_b", type: "function", function: { name: "max", arguments: "{\"xs\":" } }
              ]
            },
            finish_reason: null
          }
        ]
      }),
      ...translator.processChunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: "\"b\":2}" } }] },
            finish_reason: null
          }
        ]
      }),
      ...translator.processChunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, function: { arguments: "[1,2]}" } }] },
            finish_reason: "tool_calls"
          }
        ]
      }),
      ...translator.finalize()
    ]

    const starts = events.filter((event) => event.event === "content_block_start")
    expect(starts).toHaveLength(2)
    expect((starts[0].data as any).content_block).toMatchObject({ id: "call_a", name: "sum" })
    expect((starts[1].data as any).content_block).toMatchObject({ id: "call_b", name: "max" })

    const argsByIndex = new Map<number, string>()
    for (const event of events) {
      if (event.event !== "content_block_delta") continue
      const data = event.data as any
      argsByIndex.set(data.index, (argsByIndex.get(data.index) ?? "") + data.delta.partial_json)
    }
    expect(JSON.parse(argsByIndex.get((starts[0].data as any).index)!)).toEqual({ a: 1, b: 2 })
    expect(JSON.parse(argsByIndex.get((starts[1].data as any).index)!)).toEqual({ xs: [1, 2] })
  })

  it("does not double-count cached tokens in non-stream responses", () => {
    const response: OpenAIChatCompletionResponse = {
      id: "chatcmpl-2",
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Hi" }
        }
      ],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 1000 }
      }
    }

    const converted = convertOpenAINonStreamToAnthropic(response, "claude-sonnet-4-5")
    expect(converted.usage).toEqual({
      input_tokens: 200,
      output_tokens: 5,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0
    })
  })
})
