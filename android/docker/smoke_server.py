"""Stand-in Freesia Cloud server for the emulator smoke test (plain http on the
emulator's loopback via `adb reverse`).

* POST /api/auth/login answers with the token of the temporary test account, so
  the app can sign in through its real sign-in screen without a password.
* Every other request is forwarded unchanged to the live test server, so a Retry
  is transcribed by the real speech model.
* Stopping this process is the "server is down" case: the app gets connection refused.

The account file (JSON with "server" and "token") is mounted read-only by build.sh.
Neither value is printed.
"""
import json
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ACCOUNT = json.load(open(sys.argv[2] if len(sys.argv) > 2 else "/testdata/account.json"))
UPSTREAM = ACCOUNT["server"].rstrip("/")
# The app's own User-Agent goes along too: the server's edge rejects urllib's default one (HTTP 403)
FORWARD_HEADERS = ("Authorization", "Content-Type", "User-Agent")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[stub] %s %s\n" % (self.command, self.path.split("?")[0]))

    def reply(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def forward(self):
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length) if length else None
        if self.path == "/api/auth/login":
            body = json.dumps({"username": "smoke", "token": ACCOUNT["token"], "expiresInDays": 1}).encode()
            return self.reply(200, body)
        req = urllib.request.Request(UPSTREAM + self.path, data=data, method=self.command)
        for h in FORWARD_HEADERS:
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                self.reply(res.status, res.read(), res.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as e:
            self.reply(e.code, e.read(), e.headers.get("Content-Type", "application/json"))
        except Exception as e:  # upstream unreachable
            self.reply(502, json.dumps({"error": {"message": "Upstream unreachable: %s" % type(e).__name__}}).encode())

    do_GET = do_POST = forward


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
