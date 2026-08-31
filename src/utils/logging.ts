export function redact(value: string | undefined): string | undefined {
  if (!value) {
    return value
  }

  if (value.length <= 8) {
    return "***"
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.hash = ""
    if (url.search) {
      url.search = "?redacted"
    }
    return url.toString()
  } catch {
    return value
  }
}
