import { loadConfig } from "./config/env.js"
import { createApp } from "./app.js"

async function bootstrap(): Promise<void> {
  const config = loadConfig()
  const app = createApp(config)

  try {
    await app.listen({
      port: config.port,
      host: config.host
    })
    app.log.info(
      {
        port: config.port,
        host: config.host,
        upstreamBaseUrl: config.upstreamBaseUrl
      },
      "LLM gateway started"
    )
  } catch (error) {
    app.log.error({ err: error }, "Failed to start server")
    process.exit(1)
  }
}

void bootstrap()
