import { describe, expect, it } from "vitest"

import { stripClaudeCodeTokenReminders } from "../../src/utils/token_reminders.js"

describe("stripClaudeCodeTokenReminders", () => {
  it.each([
    "<total_tokens>14992750 tokens left</total_tokens>",
    "<total_tokens>Infinite tokens left</total_tokens>",
    "<system-reminder>\n<total_tokens>5,000,000 tokens left</total_tokens>\n</system-reminder>",
    "<system-reminder>\nToken usage: 140882/200000; 59118 remaining\n</system-reminder>",
    "<system_warning>Token usage: 140882/200000; 59118 remaining</system_warning>"
  ])("removes the generated counter %s", (reminder) => {
    const sanitized = stripClaudeCodeTokenReminders(`before\n${reminder}\nafter`)

    expect(sanitized).not.toContain("tokens left")
    expect(sanitized).not.toContain("Token usage:")
    expect(sanitized).toContain("before")
    expect(sanitized).toContain("after")
  })

  it("removes multiple counters without touching normal text", () => {
    const text = [
      "There are 12 tokens left in the example; keep this sentence.",
      "<total_tokens>100 tokens left</total_tokens>",
      "middle",
      "<total_tokens>80 tokens left</total_tokens>"
    ].join("\n")

    const sanitized = stripClaudeCodeTokenReminders(text)

    expect(sanitized).toContain("There are 12 tokens left in the example; keep this sentence.")
    expect(sanitized).toContain("middle")
    expect(sanitized).not.toContain("<total_tokens>")
  })

  it("preserves unrelated system reminders", () => {
    const text = "<system-reminder>Keep the tests green.</system-reminder>"

    expect(stripClaudeCodeTokenReminders(text)).toBe(text)
  })

  it("preserves a token tag quoted inline by the user", () => {
    const text = "Explain `<total_tokens>100 tokens left</total_tokens>` to me."

    expect(stripClaudeCodeTokenReminders(text)).toBe(text)
  })
})
