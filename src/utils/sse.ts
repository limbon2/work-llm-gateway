export interface ParsedSseEvent {
  event: string
  data: string
}

export interface SseParserState {
  buffer: string
  currentEvent: string | null
  currentData: string[]
}

export function createSseParserState(): SseParserState {
  return {
    buffer: "",
    currentEvent: null,
    currentData: []
  }
}

export function parseSseChunk(chunk: string, state: SseParserState): {
  events: ParsedSseEvent[]
  state: SseParserState
} {
  const events: ParsedSseEvent[] = []
  const lines = `${state.buffer}${chunk}`.split(/\r?\n/)

  let currentEvent = state.currentEvent
  const currentData = [...state.currentData]
  let remaining = ""

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    const isLastLine = index === lines.length - 1
    const hasTrailingNewLine = chunk.endsWith("\n") || chunk.endsWith("\r")
    if (isLastLine && !hasTrailingNewLine && line !== "") {
      remaining = line
      break
    }

    if (line === "") {
      if (currentData.length > 0) {
        events.push({
          event: currentEvent ?? "message",
          data: currentData.join("\n")
        })
      }
      currentEvent = null
      currentData.length = 0
      continue
    }

    if (line.startsWith("event:")) {
      currentEvent = line.slice("event:".length).trim()
      continue
    }

    if (line.startsWith("data:")) {
      currentData.push(line.slice("data:".length).trim())
      continue
    }
  }

  return {
    events,
    state: {
      buffer: remaining,
      currentEvent,
      currentData
    }
  }
}

export function formatSseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
