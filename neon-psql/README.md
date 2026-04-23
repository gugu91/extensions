# neon-psql

Config-driven Neon tunnel + read-only `psql` inspection for pi.

By default, `neon-psql` is now **safe-first**:

- the `psql` tool and `/psql` command stay available for read-only DB inspection
- shell env injection is **off** unless you explicitly enable it
- the Python `sitecustomize.py` asyncpg shim is **off** unless you explicitly enable it

That keeps the default operator story narrow: read-only `psql` inspection is separate from the higher-power mode that copies tunnel credentials into shell/Python subprocesses.

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
    "injectIntoBash": false,
    "injectPythonShim": false,
    "logPath": ".pi/neon-psql-tunnel.log",
    "psqlBin": "/custom/path/to/psql",
    "sourceEnv": {
      "host": "DB_HOST",
      "port": "DB_PORT",
      "user": "DB_USER",
      "password": "DB_PASSWORD",
      "database": "DB_NAME"
    },
    "psqlEnv": {
      "NEON_TUNNEL_DATABASE_URL": "postgres_url"
    }
  }
}
```

Project-local (`.pi/settings.json`) works too and takes priority over the global settings.

#### Safe default vs higher-power injection mode

**Safe default**

- keep `injectIntoBash: false`
- keep `injectPythonShim: false`
- use the `psql` tool and `/psql` command for read-only inspection only

**Higher-power injection mode**

- set `injectIntoBash: true` to copy tunnel env into agent `bash` and user shell commands
- optionally set `injectPythonShim: true` to prepend the asyncpg shim to `PYTHONPATH`
- when either injection option is enabled, the extension emits an operator-visible warning and `/psql-tunnel status` shows the elevated mode

Example higher-power mode:

```json
{
  "neon-psql": {
    "enabled": true,
    "injectIntoBash": true,
    "injectPythonShim": true,
    "injectEnv": {
      "DATABASE_URL": "postgres_url",
      "DB_HOST": "tunnel_host",
      "DB_PORT": "tunnel_port",
      "DB_USER": "source_user",
      "DB_PASSWORD": "source_password",
      "DB_NAME": "source_database"
    }
  }
}
```

`injectPythonShim` is only useful when shell injection is enabled, because the shim is applied through the injected process environment.

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

## Config semantics

- `injectIntoBash` — default `false`; enables higher-power shell env injection
- `injectPythonShim` — default `false`; enables the asyncpg shim inside injected Python subprocesses
- `psqlEnv` — narrow env used by the read-only `psql` tool/command path
- `injectEnv` — broader env used only for shell/Python injection mode

The default `psqlEnv` is intentionally narrow:

```json
{
  "NEON_TUNNEL_DATABASE_URL": "postgres_url"
}
```

The default `injectEnv` is broader because it is meant for explicit shell/Python opt-in workflows.

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
