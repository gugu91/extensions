import os
import selectors
import socket
import struct
import threading
import urllib.parse

LISTEN_HOST = os.environ.get("TUNNEL_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("TUNNEL_PORT", "15432"))
TARGET_HOST = os.environ["DB_HOST"]
TARGET_PORT = int(os.environ.get("DB_PORT", "5432"))

proxy_env = (
    os.environ.get("ALL_PROXY")
    or os.environ.get("all_proxy")
    or os.environ.get("SOCKS_PROXY")
    or os.environ.get("socks_proxy")
)
if not proxy_env:
    raise RuntimeError("Missing ALL_PROXY / SOCKS_PROXY for tunnel bootstrap")

proxy_url = urllib.parse.urlparse(proxy_env)
PROXY_HOST = proxy_url.hostname or "127.0.0.1"
PROXY_PORT = proxy_url.port or 1080


def recv_exact(sock: socket.socket, n: int) -> bytes:
    data = bytearray()
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise RuntimeError("unexpected EOF")
        data.extend(chunk)
    return bytes(data)


def socks5_connect() -> socket.socket:
    sock = socket.create_connection((PROXY_HOST, PROXY_PORT), timeout=10)
    sock.sendall(b"\x05\x01\x00")
    resp = recv_exact(sock, 2)
    if resp != b"\x05\x00":
        raise RuntimeError("SOCKS auth failed: " + repr(resp))

    host = TARGET_HOST.encode()
    req = b"\x05\x01\x00\x03" + bytes([len(host)]) + host + struct.pack(">H", TARGET_PORT)
    sock.sendall(req)

    hdr = recv_exact(sock, 4)
    if hdr[0] != 5 or hdr[1] != 0:
        raise RuntimeError("SOCKS connect failed: " + repr(hdr))

    atyp = hdr[3]
    if atyp == 1:
        _ = recv_exact(sock, 4)
    elif atyp == 3:
        l = recv_exact(sock, 1)[0]
        _ = recv_exact(sock, l)
    elif atyp == 4:
        _ = recv_exact(sock, 16)
    _ = recv_exact(sock, 2)

    sock.settimeout(None)
    return sock


def relay(client: socket.socket, remote: socket.socket) -> None:
    sel = selectors.DefaultSelector()
    sel.register(client, selectors.EVENT_READ)
    sel.register(remote, selectors.EVENT_READ)
    try:
        while True:
            for key, _ in sel.select():
                src = key.fileobj
                dst = remote if src is client else client
                data = src.recv(65536)
                if not data:
                    return
                dst.sendall(data)
    finally:
        for s in (client, remote):
            try:
                s.close()
            except Exception:
                pass


def handle(client: socket.socket, addr) -> None:
    try:
        remote = socks5_connect()
        print(f"accepted {addr}", flush=True)
        relay(client, remote)
    except Exception as e:
        print(f"handle error {addr}: {e}", flush=True)
        try:
            client.close()
        except Exception:
            pass


def main() -> None:
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((LISTEN_HOST, LISTEN_PORT))
    server.listen()
    print(
        f"LISTENING {LISTEN_HOST}:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT} via {PROXY_HOST}:{PROXY_PORT}",
        flush=True,
    )
    while True:
        client, addr = server.accept()
        threading.Thread(target=handle, args=(client, addr), daemon=True).start()


if __name__ == "__main__":
    main()
