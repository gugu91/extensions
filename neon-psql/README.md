# neon-psql

Config-driven tunnel + `psql` + tunnel-aware bash for pi.

## Install / configure

### 1) Link this as a pi extension

From your repo root:

```bash
ln -s "$(pwd)/neon-psql" ~/.pi/agent/extensions/neon-psql
```

If you already have a link:

```bash
rm -f ~/.pi/agent/extensions/neon-psql
ln -s "$(pwd)/neon-psql" ~/.pi/agent/extensions/neon-psql
```

### 2) Add config

You can now configure `neon-psql` directly from pi's top-level settings.

#### Recommended: top-level settings.json

Global (`~/.pi/agent/settings.json`):

```json
{
  "neon-psql": {
    "enabled": true,
    "injectIntoBash": true,
    "injectPythonShim": true,
    "logPath": ".pi/neon-psql-tunnel.log",
    "psqlBin": "/custom/path/to/psql",
    "sourceEnv": {
      "host": "DB_HOST",
      "port": "DB_PORT",
      "user": "DB_USER",
      "password": "DB_PASSWORD",
      "database": "DB_NAME"
    }
  }
}
```

Project-local (`.pi/settings.json`) works too and takes priority over the global settings.

#### Legacy config files still supported

Config lookup order:

1. `PI_NEON_PSQL_CONFIG`
2. `.pi/settings.json` → `"neon-psql"`
3. `~/.pi/agent/settings.json` → `"neon-psql"`
4. `.pi/neon-psql.json`
5. `config.json` next to the extension
6. `~/.pi/agent/extensions/neon-psql/config.json`

If no config is found, the extension does nothing.

For a shared project config file, copy `config.example.json` into the consuming repo as:

```bash
mkdir -p .pi
cp ~/.pi/agent/extensions/neon-psql/config.example.json .pi/neon-psql.json
```

For a personal machine-local legacy config file, copy it next to the extension as:

```bash
cp ~/.pi/agent/extensions/neon-psql/config.example.json ~/.pi/agent/extensions/neon-psql/config.json
```

## What it provides

- `psql` tool for read-only DB inspection
- `/psql <query>`
- `/psql-tunnel [status|start|stop|log|env]`
- optional bash env injection for agent `bash` and user `!` / `!!` commands
- optional Python `sitecustomize.py` shim for `asyncpg` / SQLAlchemy asyncpg
- automatic reuse of the sandbox SOCKS proxy when the `sandbox` extension is installed

## Common config tokens

- `postgres_url`
- `sqlalchemy_url`
- `sqlalchemy_async_url`
- `asyncpg_dsn`
- `tunnel_host`
- `tunnel_port`
- `endpoint`
- `pgoptions`
- `sslmode`
- `source_host`
- `source_port`
- `source_user`
- `source_password`
- `source_database`

Unknown values are treated as literals. `source:ENV_NAME` copies from an arbitrary source env var.

## psql binary lookup

By default the extension resolves `psql` in this order:

1. `psql` on `PATH`
2. `/opt/homebrew/opt/libpq/bin/psql`
3. `/usr/local/opt/libpq/bin/psql`
4. `/usr/bin/psql`

If your installation lives elsewhere, set `neon-psql.psqlBin` in settings.

See `config.example.json`.

## License

MIT. See [`LICENSE`](./LICENSE).
