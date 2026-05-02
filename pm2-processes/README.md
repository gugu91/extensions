# pi-pm2-processes

Generic Pi extension for managing project-local PM2 processes declared in a PM2 ecosystem config.

## Configuration discovery

The extension manages only apps declared by the active PM2 config. Discovery order:

1. `PI_PM2_CONFIG=/absolute/or/relative/ecosystem.config.cjs`
2. `pm2-processes.configPath` in `.pi/settings.json` or `~/.pi/agent/settings.json`
3. `.pi/pm2/ecosystem.config.cjs`
4. `ecosystem.config.js`, `ecosystem.config.cjs`, `ecosystem.config.json` in the current workspace

Optional metadata can live at `.pi/pm2/metadata.json`, `PI_PM2_METADATA`, or `pm2-processes.metadataPath`:

```json
{
  "apps": {
    "backend": { "url": "http://localhost:8000/health" },
    "frontend": { "url": "http://localhost:3000" }
  }
}
```

## Slash command

```text
/pm2                  # default status/config summary
/pm2 status [app|all]
/pm2 start [app|all]
/pm2 restart [app|all]
/pm2 stop [app|all]
/pm2 logs <app> [--lines N]
/pm2 urls
/pm2 config
```

## Agent tool

`pm2_process` accepts:

```ts
{
  action: "status" | "start" | "restart" | "stop" | "logs" | "urls" | "config";
  target?: string; // declared app name, or "all" where supported
  lines?: number;
}
```

Safety properties:

- no arbitrary shell command input
- exact app-name allowlist from the PM2 ecosystem config
- `all` is expanded to exact declared app names for mutations
- no `pm2 stop all`, `delete`, or `kill`
- log output is bounded by configured line/byte limits
- config output lists app names and paths, not environment values
- PM2 owns the long-running processes independently of Pi
