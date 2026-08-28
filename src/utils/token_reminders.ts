const totalTokensReminder =
  String.raw`<total_tokens>\s*(?:Infinite|\d[\d,]*)\s+tokens?\s+left\s*<\/total_tokens>`
const tokenUsageReminder =
  String.raw`Token usage:\s*-?\d[\d,]*\s*\/\s*-?\d[\d,]*\s*;` +
  String.raw`\s*-?\d[\d,]*\s+remaining`

function standaloneReminderPattern(reminder: string): RegExp {
  return new RegExp(String.raw`(^|\r?\n)[ \t]*${reminder}[ \t]*(?=\r?\n|$)`, "gim")
}

const wrappedReminderPattern = standaloneReminderPattern(
  String.raw`<system-reminder>\s*(?:${totalTokensReminder}|${tokenUsageReminder})` +
    String.raw`\s*<\/system-reminder>`
)
const legacyWrappedReminderPattern = standaloneReminderPattern(
  String.raw`<system_warning>\s*${tokenUsageReminder}\s*<\/system_warning>`
)
const totalTokensReminderPattern = standaloneReminderPattern(totalTokensReminder)

// Claude Code can inject model-facing token bookkeeping into the system prompt
// and after tool results. These counters are harness metadata, not conversation
// content, and OpenAI-compatible models may mistake them for instructions or a
// real context-window limit.
export function stripClaudeCodeTokenReminders(text: string): string {
  return text
    .replace(wrappedReminderPattern, "$1")
    .replace(legacyWrappedReminderPattern, "$1")
    .replace(totalTokensReminderPattern, "$1")
}
