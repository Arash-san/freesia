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
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ACCOUNT = json.load(open(sys.argv[2] if len(sys.argv) > 2 else "/testdata/account.json"))
UPSTREAM = ACCOUNT["server"].rstrip("/")
# The app's own User-Agent goes along too: the server's edge rejects urllib's default one (HTTP 403)
FORWARD_HEADERS = ("Authorization", "Content-Type", "User-Agent")
DECIDED_FILE = "/tmp/smoke-contrib-choice"


def contrib_state(enabled, decided):
    terms = {"version": 1, "title": "Help Freesia Voice understand you better",
             "summary": "You can let Freesia keep your recordings to train its speech model. It stays off unless you turn it on.",
             "paragraphs": ["Smoke test terms, first paragraph.", "Smoke test terms, second paragraph."]}
    return {"available": True, "version": 1, "enabled": enabled, "decided": decided, "terms": terms,
            "shared": {"recordings": 0, "seconds": 0, "labeled": 0}}


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
        if self.path.startswith("/api/contribute"):
            # Answered here, never by the live server: every run sees the first-time
            # question, and the test account's real choice is never changed
            # The answer outlives restarts of this stub, so a later app start is not asked again
            if self.command == "POST":
                enabled = json.loads(data or b"{}").get("enabled") is True
                open(DECIDED_FILE, "w").write("on" if enabled else "off")
            choice = open(DECIDED_FILE).read() if os.path.exists(DECIDED_FILE) else ""
            return self.reply(200, json.dumps(contrib_state(choice == "on", decided=bool(choice))).encode())
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

    do_GET = do_POST = do_DELETE = forward


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
