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
