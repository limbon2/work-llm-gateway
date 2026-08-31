import { loadConfig } from "./config/env.js"
import { createApp } from "./app.js"
import { sanitizeUrl } from "./utils/logging.js"

async function bootstrap(): Promise<void> {
  const config = loadConfig()
  const app = createApp(config)
  const upstreamBaseUrl = sanitizeUrl(config.upstreamBaseUrl)

  try {
    app.log.info(
      { upstreamBaseUrl },
      "Checking upstream provider connectivity"
    )
    const connectivity = await app.upstreamClient.checkConnectivity()
    app.log.info(
      {
        upstreamBaseUrl,
        statusCode: connectivity.statusCode
      },
      "Upstream provider connectivity check passed"
    )

    await app.listen({
      port: config.port,
      host: config.host
    })
    app.log.info(
      {
        port: config.port,
        host: config.host,
        upstreamBaseUrl
      },
      "LLM gateway started"
    )
  } catch (error) {
    app.log.error({ err: error }, "Failed to start server")
    process.exit(1)
  }
}

void bootstrap()
