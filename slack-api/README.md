# slack-api

Slack Web API CLI wrapper powered by [`@slack/web-api`](https://www.npmjs.com/package/@slack/web-api).

## CLI usage

List all available Slack methods:

```bash
slack-api list
```

Call a method:

```bash
slack-api auth.test --token xoxb-...
slack-api conversations.list --token xoxb-... --param limit=50
slack-api chat.postMessage --token xoxb-... --input '{"channel":"C123","text":"hello"}'
```

## Options

| Flag                  | Description                                |
| --------------------- | ------------------------------------------ |
| `--token <token>`     | Slack API token (or set `SLACK_TOKEN` env) |
| `--input <json>`      | JSON object passed as method arguments     |
| `--input-file <path>` | Read JSON input from a file                |
| `--param KEY=VALUE`   | Set individual parameters (repeatable)     |

## Notes

- Method names use Slack's dot notation (`chat.postMessage`, `conversations.list`, etc.)
- `--param` values are auto-parsed: `true`/`false` → boolean, digits → number, `{}`/`[]` → JSON
- `--token` is passed to the `WebClient` constructor; method arguments come from `--input` / `--param`
