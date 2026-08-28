import { config as loadDotEnv } from "dotenv"
import { z } from "zod"

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace"] as const
const defaultRequestBodyLimitBytes = 32 * 1024 * 1024

// Load environment files in this order:
// 1) .env
// 2) .env.local (overrides .env)
loadDotEnv()
loadDotEnv({ path: ".env.local", override: true })

const envSchema = z.object({
  UPSTREAM_BASE_URL: z.string().url(),
  UPSTREAM_API_KEY: z.string().default(""),
  UPSTREAM_MODEL: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("0.0.0.0"),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(defaultRequestBodyLimitBytes),
  GATEWAY_API_KEYS: z.string().optional(),
  MODEL_ALIAS_JSON: z.string().optional(),
  LOG_LEVEL: z.enum(logLevels).default("info")
})

export interface GatewayConfig {
  upstreamBaseUrl: string
  upstreamApiKey: string
  upstreamModel?: string
  port: number
  host: string
  requestTimeoutMs: number
  requestBodyLimitBytes: number
  gatewayApiKeys: string[]
  modelAliases: Record<string, string>
  logLevel: (typeof logLevels)[number]
}

function parseApiKeys(raw?: string): string[] {
  if (!raw) {
    return []
  }

  return raw
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)
}

function parseModelAliases(raw?: string): Record<string, string> {
  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("MODEL_ALIAS_JSON must be a JSON object")
    }

    const aliases: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        throw new Error(`MODEL_ALIAS_JSON value for "${key}" must be a string`)
      }
      aliases[key] = value
    }
    return aliases
  } catch (error) {
    throw new Error(
      `Invalid MODEL_ALIAS_JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function loadConfig(input: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.parse(input)

  return {
    upstreamBaseUrl: parsed.UPSTREAM_BASE_URL,
    upstreamApiKey: parsed.UPSTREAM_API_KEY,
    upstreamModel: parsed.UPSTREAM_MODEL,
    port: parsed.PORT,
    host: parsed.HOST,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    requestBodyLimitBytes: parsed.REQUEST_BODY_LIMIT_BYTES,
    gatewayApiKeys: parseApiKeys(parsed.GATEWAY_API_KEYS),
    modelAliases: parseModelAliases(parsed.MODEL_ALIAS_JSON),
    logLevel: parsed.LOG_LEVEL
  }
}
