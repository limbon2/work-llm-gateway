# LLM Gateway

This gateway exposes Anthropic-compatible endpoints for Claude Code and forwards
to an OpenAI-compatible upstream provider.

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

## Environment

See `.env.example`.

Required:

- `UPSTREAM_BASE_URL`

Recommended:

- `UPSTREAM_API_KEY`
- `UPSTREAM_MODEL` to force one upstream model for all requests.
- `MODEL_ALIAS_JSON` to map Anthropic model IDs to upstream IDs.
- `REQUEST_BODY_LIMIT_BYTES` to override the 32 MiB maximum incoming request size.

The gateway automatically loads:

1. `.env`
2. `.env.local` (overrides `.env`)

Typical setup:

1. Copy `.env.example` to `.env`
2. Fill your provider values in `.env`

Example:

```bash
MODEL_ALIAS_JSON='{"claude-sonnet-4-5":"gpt-4o-mini"}'
```

```bash
UPSTREAM_MODEL='gpt-4.1'
```

Model resolution precedence:

1. `UPSTREAM_MODEL` (if set, always used)
2. `MODEL_ALIAS_JSON` mapping
3. Incoming Anthropic `model` value

## Run

```bash
npm install
npm run dev
```

## Claude Code target

Configure Claude Code to use this gateway URL as its Anthropic-compatible
endpoint.

## Quick check

```bash
curl -s http://127.0.0.1:8787/healthz
```

```bash
curl -s http://127.0.0.1:8787/v1/models
```

```bash
curl -s http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model":"claude-sonnet-4-5",
    "max_tokens":256,
    "messages":[{"role":"user","content":"Hello"}]
  }'
```
