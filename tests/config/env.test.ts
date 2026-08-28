import { describe, expect, it } from "vitest"

import { loadConfig } from "../../src/config/env.js"

describe("loadConfig request body limit", () => {
  it("defaults to 32 MiB", () => {
    const config = loadConfig({
      UPSTREAM_BASE_URL: "http://upstream.test/v1"
    })

    expect(config.requestBodyLimitBytes).toBe(32 * 1024 * 1024)
  })

  it("accepts an override in bytes", () => {
    const config = loadConfig({
      UPSTREAM_BASE_URL: "http://upstream.test/v1",
      REQUEST_BODY_LIMIT_BYTES: "2097152"
    })

    expect(config.requestBodyLimitBytes).toBe(2 * 1024 * 1024)
  })
})
