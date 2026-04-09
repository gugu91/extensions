import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


LOCAL_TUNNEL_HOSTS = {"127.0.0.1", "localhost"}


def _is_local_tunnel_host(host):
    return isinstance(host, str) and host.strip().lower() in LOCAL_TUNNEL_HOSTS


def _dsn_uses_local_tunnel(dsn, tunnel_port):
    if not isinstance(dsn, str) or not tunnel_port:
        return False

    try:
        parts = urlsplit(dsn)
    except ValueError:
        return False

    return _is_local_tunnel_host(parts.hostname) and parts.port is not None and str(parts.port) == tunnel_port


def _uses_local_tunnel(args, kwargs):
    tunnel_port = os.getenv("NEON_TUNNEL_PORT", "")
    if not tunnel_port:
        return False

    host = kwargs.get("host")
    port = kwargs.get("port")
    dsn = kwargs.get("dsn") if isinstance(kwargs.get("dsn"), str) else (args[0] if args and isinstance(args[0], str) else None)

    if _is_local_tunnel_host(host) and port is not None and str(port) == tunnel_port:
        return True

    return _dsn_uses_local_tunnel(dsn, tunnel_port)


def _extract_options_from_dsn(dsn):
    if not isinstance(dsn, str):
        return None
    parts = urlsplit(dsn)
    if not parts.query:
        return None
    params = parse_qsl(parts.query, keep_blank_values=True)
    value = None
    filtered = []
    for key, item in params:
        if key == "options" and value is None:
            value = item
        else:
            filtered.append((key, item))
    if value is None:
        return None
    query = urlencode(filtered)
    cleaned = urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))
    return value, cleaned


def _patch_asyncpg():
    if os.getenv("NEON_TUNNEL_ACTIVE") != "1":
        return

    try:
        import asyncpg
    except Exception:
        return

    endpoint = os.getenv("NEON_TUNNEL_ENDPOINT", "").strip()
    sslmode = os.getenv("NEON_TUNNEL_SSL_MODE", "").strip()

    original_connect = asyncpg.connect
    original_create_pool = asyncpg.create_pool

    async def patched_connect(*args, **kwargs):
        server_settings = dict(kwargs.get("server_settings") or {})
        options = kwargs.pop("options", None)

        dsn_result = _extract_options_from_dsn(kwargs.get("dsn") if "dsn" in kwargs else (args[0] if args else None))
        if dsn_result is not None:
            dsn_options, cleaned_dsn = dsn_result
            if "dsn" in kwargs:
                kwargs["dsn"] = cleaned_dsn
            elif args:
                args = (cleaned_dsn, *args[1:])
            if options is None:
                options = dsn_options

        if options and "options" not in server_settings:
            server_settings["options"] = options
        elif endpoint and "options" not in server_settings and _uses_local_tunnel(args, kwargs):
            server_settings["options"] = f"endpoint={endpoint}"

        if server_settings:
            kwargs["server_settings"] = server_settings

        if "sslmode" in kwargs and "ssl" not in kwargs:
            kwargs["ssl"] = kwargs.pop("sslmode")
        elif sslmode and "ssl" not in kwargs and _uses_local_tunnel(args, kwargs):
            kwargs["ssl"] = sslmode

        return await original_connect(*args, **kwargs)

    async def patched_create_pool(*args, **kwargs):
        server_settings = dict(kwargs.get("server_settings") or {})
        options = kwargs.pop("options", None)
        if options and "options" not in server_settings:
            server_settings["options"] = options
        elif endpoint and "options" not in server_settings and _uses_local_tunnel(args, kwargs):
            server_settings["options"] = f"endpoint={endpoint}"
        if server_settings:
            kwargs["server_settings"] = server_settings

        if "sslmode" in kwargs and "ssl" not in kwargs:
            kwargs["ssl"] = kwargs.pop("sslmode")
        elif sslmode and "ssl" not in kwargs and _uses_local_tunnel(args, kwargs):
            kwargs["ssl"] = sslmode

        return await original_create_pool(*args, **kwargs)

    asyncpg.connect = patched_connect
    asyncpg.create_pool = patched_create_pool


_patch_asyncpg()
