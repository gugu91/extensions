# slack-api

Typed Slack Web API client + CLI generated from Slack's OpenAPI spec with
[`@hey-api/openapi-ts`](https://github.com/hey-api/openapi-ts).

## What it includes

- `generated/` — generated type-safe Slack Web API SDK
- `cli.ts` — CLI wrapper for calling generated SDK methods
- `scripts/generate.ts` — re-downloads the Slack spec and regenerates the client

## Regenerate the client

```bash
pnpm --filter @gugu91/pi-slack-api run generate
```

The generator currently tries these sources in order:

1. Official Slack GitHub spec
   - `https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json`
2. Community fallback
   - `https://raw.githubusercontent.com/api-evangelist/slack/main/openapi/slack-web-api-openapi.yml`

## CLI usage

List all generated Slack methods:

```bash
pnpm --filter @gugu91/pi-slack-api exec node --experimental-strip-types cli.ts list
```

Call a method with repeated key/value params:

```bash
pnpm --filter @gugu91/pi-slack-api exec node --experimental-strip-types cli.ts conversations.list \
  --token "$SLACK_TOKEN" \
  --param limit=50
```

Call a method with JSON input:

```bash
pnpm --filter @gugu91/pi-slack-api exec node --experimental-strip-types cli.ts chat.postMessage \
  --token "$SLACK_TOKEN" \
  --input '{"channel":"C123","text":"hello from slack-api"}'
```

Or use the package-local bin wrapper directly:

```bash
cd slack-api
./bin/slack-api auth.test --token "$SLACK_TOKEN"
```

## Notes

- The CLI accepts Slack method names like `auth.test` and `chat.postMessage`.
- Flat `--param` and `--input` fields are automatically routed into `headers`, `query`, `path`, or `body` based on the OpenAPI parameter location for the selected method.
- `--token` is injected as `token` when the method input does not already define one, then routed to the correct request section.
- If you need an escape hatch, you can pass explicit nested sections like `{ "headers": { "token": "..." } }`.
- Generated imports are rewritten from `.js` to `.ts` so the SDK can run directly via Node's `--experimental-strip-types` mode without a separate build step.
