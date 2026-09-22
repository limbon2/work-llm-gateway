# LLM Gateway

## Benchmark integration

`GET /v1/eval-capabilities` is authenticated like the model endpoints. It exposes forced-model/alias routing and support for structured errors and stream completion checks. For multi-model comparisons, leave `UPSTREAM_MODEL` unset and use actual upstream IDs.

The gateway accepts `x-ife-eval-attempt` for log correlation and returns `x-ife-resolved-model` on successful message requests. Provider quota codes and reliable retry/reset metadata are preserved in errors. Stream usage carries reported/estimated provenance; missing upstream usage is not a provider budget estimate.

`STREAM_IDLE_TIMEOUT_MS` controls idle body reads (default: `REQUEST_TIMEOUT_MS`). `STREAM_TOTAL_TIMEOUT_MS` controls the full stream body deadline (default: at least 30 minutes). The sample environment sets five-minute idle and 30-minute total limits. Interrupted requests cancel the reader. Malformed events and EOF without a terminal event produce a stream error instead of successful completion.

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

The gateway removes Claude Code's standalone `<total_tokens>... tokens left</total_tokens>`
reminders before forwarding prompts. These are client bookkeeping, not user or model content.
They can also be disabled at the client with `CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off`.

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
