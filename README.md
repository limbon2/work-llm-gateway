# LLM Gateway

Anthropic-compatible gateway for Claude Code that forwards requests to an OpenAI-compatible upstream provider.

## What this project does

1. Exposes Anthropic-style endpoints:
   - `POST /v1/messages`
   - `POST /v1/messages/count_tokens`
   - `GET /v1/models`
   - `GET /healthz`
2. Accepts Claude Code requests in Anthropic format.
3. Translates requests to OpenAI-compatible upstream calls (`/chat/completions`).
4. Translates responses and streaming events back to Anthropic-compatible format.

## Requirements

1. Node.js 20+ (Node 22 recommended)
2. npm 10+
3. An upstream provider URL and API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create local env file:

```bash
cp .env.example .env
```

3. Edit `.env`:

```dotenv
UPSTREAM_BASE_URL=https://api.openai.com/v1
UPSTREAM_API_KEY=sk-your-provider-key
UPSTREAM_MODEL=
PORT=8787
HOST=0.0.0.0
REQUEST_TIMEOUT_MS=60000
REQUEST_BODY_LIMIT_BYTES=33554432
GATEWAY_API_KEYS=
MODEL_ALIAS_JSON={}
LOG_LEVEL=info
```

The gateway auto-loads:
1. `.env`
2. `.env.local` (overrides `.env`)

## Environment variables

1. `UPSTREAM_BASE_URL`:
   - Required
   - Base URL of your OpenAI-compatible provider
2. `UPSTREAM_API_KEY`:
   - Usually required by upstream provider
3. `UPSTREAM_MODEL`:
   - Optional
   - Forces one upstream model for all requests
4. `MODEL_ALIAS_JSON`:
   - Optional JSON object
   - Maps incoming Anthropic model names to upstream model names
   - Example: `{"claude-sonnet-4-5":"gpt-4o-mini"}`
5. `GATEWAY_API_KEYS`:
   - Optional comma-separated list
   - If set, incoming requests must include one key via `Authorization: Bearer ...` or `x-api-key`
6. `REQUEST_BODY_LIMIT_BYTES`:
   - Maximum accepted request body size in bytes
   - Defaults to 32 MiB (`33554432`)
7. `PORT`, `HOST`, `REQUEST_TIMEOUT_MS`, `LOG_LEVEL`:
   - Runtime settings

Model resolution precedence:
1. `UPSTREAM_MODEL`
2. `MODEL_ALIAS_JSON` mapping
3. Incoming Anthropic `model`

## Run locally

Development:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm run start
```

At launch, the gateway makes an authenticated `GET /models` request to the configured
`UPSTREAM_BASE_URL` before opening its listening socket. Startup fails if the provider cannot
be reached, TLS setup fails, the request times out, or the provider rejects the check.

Checks:

```bash
npm run test
npm run lint
```

## Quick health checks

```bash
curl -s http://127.0.0.1:8787/healthz
```

```bash
curl -s http://127.0.0.1:8787/v1/models
```

Non-streaming message:

```bash
curl -s http://127.0.0.1:8787/v1/messages \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "messages": [{"role":"user","content":"Hello"}]
  }'
```

Streaming message:

```bash
curl -N http://127.0.0.1:8787/v1/messages \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "stream": true,
    "messages": [{"role":"user","content":"Stream hello"}]
  }'
```

## Connect from Claude Code

Claude Code gateway configuration is documented in Anthropic docs:
- https://code.claude.com/docs/en/llm-gateway
- https://code.claude.com/docs/en/model-config

Configure Claude Code to point at this gateway.

macOS/Linux:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=local-gateway-key
export ANTHROPIC_MODEL=claude-sonnet-4-5
claude
```

Windows PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
$env:ANTHROPIC_AUTH_TOKEN="local-gateway-key"
$env:ANTHROPIC_MODEL="claude-sonnet-4-5"
claude
```

Notes:
1. If `GATEWAY_API_KEYS` is configured, `ANTHROPIC_AUTH_TOKEN` must match one configured key.
2. If `GATEWAY_API_KEYS` is empty, token validation is disabled by this gateway.
3. `ANTHROPIC_MODEL` controls the model Claude Code requests; the gateway can still remap or
   force the upstream model via `MODEL_ALIAS_JSON` or `UPSTREAM_MODEL`.
4. Claude Code may inject `<total_tokens>... tokens left</total_tokens>` bookkeeping into
   prompts. The gateway removes these standalone counters before forwarding requests upstream.
   To stop Claude Code from generating them too, set
   `CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off` in the Claude Code environment.

## Troubleshooting

1. `401 Invalid gateway API key`:
   - Set `ANTHROPIC_AUTH_TOKEN` to one of `GATEWAY_API_KEYS`
   - Or clear `GATEWAY_API_KEYS` for local dev
2. Upstream timeout:
   - Increase `REQUEST_TIMEOUT_MS`
   - Verify `UPSTREAM_BASE_URL` reachability
   - Inspect the `Upstream provider request failed` log entry. Its `networkError` field
     includes nested Node.js causes such as `ENOTFOUND`, `ECONNREFUSED`, the failed syscall,
     host/address, and port.
3. Model not found upstream:
   - Use `UPSTREAM_MODEL` or `MODEL_ALIAS_JSON` to map to a valid upstream model
4. Empty `/v1/models`:
   - Upstream may not expose `/models`, or auth/key is invalid
5. `Request body is too large`:
   - Increase `REQUEST_BODY_LIMIT_BYTES` if requests legitimately exceed the 32 MiB default
   - Requests above the configured limit return HTTP 413 instead of HTTP 500

Every provider call emits structured start and completion/failure logs. They include
correlation IDs, operation, sanitized provider URL, HTTP method/status, timeout, and elapsed
time. Request bodies, API keys, authorization headers, and URL credentials/query values are
not logged.
