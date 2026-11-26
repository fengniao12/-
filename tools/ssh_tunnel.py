#!/usr/bin/env python3
"""Local TCP forwarder: 127.0.0.1:8000 -> VoxCPM2 API on the remote server.

Usage:
    python tools/ssh_tunnel.py

Keep it running in a terminal / background job. Then any app on this machine
can call http://127.0.0.1:8000 as if the service were local.
"""
from __future__ import annotations

import os
import select
import socketserver
import sys
import threading

import paramiko

SSH_HOST = os.environ.get("SSH_HOST", "127.0.0.1")
SSH_PORT = int(os.environ.get("SSH_PORT", "33"))
SSH_USER = os.environ.get("SSH_USER", "deploy")
SSH_PASS = os.environ.get("SSH_PASS", "")
LOCAL_PORT = int(os.environ.get("TUNNEL_LOCAL_PORT", "8000"))
REMOTE_HOST = os.environ.get("TUNNEL_REMOTE_HOST", "127.0.0.1")
REMOTE_PORT = int(os.environ.get("TUNNEL_REMOTE_PORT", "8000"))

_transport: paramiko.Transport | None = None
_lock = threading.Lock()


def get_transport() -> paramiko.Transport:
    global _transport
    with _lock:
        if _transport is None or not _transport.is_active():
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(
                SSH_HOST, port=SSH_PORT, username=SSH_USER, password=SSH_PASS,
                timeout=30, banner_timeout=30, auth_timeout=30,
            )
            _transport = client.get_transport()
        return _transport


class Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        peer = self.request.getpeername()
        try:
            chan = get_transport().open_channel(
                "direct-tcpip", (REMOTE_HOST, REMOTE_PORT), peer, timeout=30
            )
        except Exception as exc:
            print(f"[tunnel] open failed: {exc}", file=sys.stderr)
            return
        try:
            while True:
                r, _, _ = select.select([self.request, chan], [], [], 0.5)
                if self.request in r:
                    data = self.request.recv(65536)
                    if not data:
                        break
                    chan.sendall(data)
                if chan in r:
                    data = chan.recv(65536)
                    if not data:
                        break
                    self.request.sendall(data)
        except Exception:
            pass
        finally:
            try:
                chan.close()
            except Exception:
                pass


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    print(f"[tunnel] 127.0.0.1:{LOCAL_PORT} -> {SSH_USER}@{SSH_HOST}:{SSH_PORT} -> {REMOTE_HOST}:{REMOTE_PORT}")
    with Server(("127.0.0.1", LOCAL_PORT), Handler) as srv:
        srv.serve_forever()
