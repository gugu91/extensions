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

Config lookup order:

1. `PI_NEON_PSQL_CONFIG`
2. `.pi/neon-psql.json`
3. `config.json` next to the extension
4. `~/.pi/agent/extensions/neon-psql/config.json`

If no config file is found, the extension does nothing.

For a shared project config, copy `config.example.json` into the consuming repo as:

```bash
mkdir -p .pi
cp ~/.pi/agent/extensions/neon-psql/config.example.json .pi/neon-psql.json
```

For a personal machine-local config, copy it next to the extension as:

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

See `config.example.json`.
