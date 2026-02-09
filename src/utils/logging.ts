export function redact(value: string | undefined): string | undefined {
  if (!value) {
    return value
  }

  if (value.length <= 8) {
    return "***"
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`
}
