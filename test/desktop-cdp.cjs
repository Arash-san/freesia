const fs = require("node:fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.timeoutMs = 30000;
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          m.error
            ? p.reject(new Error(JSON.stringify(m.error)))
            : p.resolve(m.result);
        }
      } else if (m.method === "Runtime.exceptionThrown") {
        this.errors.push(
          m.params.exceptionDetails.exception?.description ||
            m.params.exceptionDetails.text,
        );
      }
    });
  }
  async call(method, params = {}) {
    const id = ++this.id;
    let timer;
    const p = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    try {
      return await p;
    } finally {
      clearTimeout(timer);
    }
  }
  async js(expression) {
    if (/\bawait\b/.test(expression) && !expression.startsWith("(async"))
      expression = `(async()=>{${expression}})()`;
    const out = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (out.exceptionDetails)
      throw new Error(
        out.exceptionDetails.exception?.description ||
          out.exceptionDetails.text,
      );
    return out.result?.value;
  }
  close() {
    this.ws.close();
    for (const p of this.pending.values()) p.reject(new Error("CDP closed"));
    this.pending.clear();
  }
}
async function connect(port, filter = "index.html", timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      const target = list.find(
        (t) =>
          t.type === "page" &&
          (t.url.includes(filter) ||
            (filter === "index.html" &&
              /^https?:\/\/tauri\.localhost\/?$/.test(t.url))),
      );
      if (target?.webSocketDebuggerUrl) {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener("open", resolve, { once: true });
          ws.addEventListener("error", reject, { once: true });
        });
        const cdp = new CDP(ws);
        await cdp.call("Runtime.enable");
        return cdp;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error(`No ${filter} target on ${port}`);
}
async function ready(cdp) {
  for (let i = 0; i < 150; i++) {
    if (
      await cdp.js(
        `typeof window.__freesiaTest==='object' && !!document.querySelector('.screen.active')`,
      )
    )
      return;
    await sleep(100);
  }
  throw new Error("Freesia did not initialize");
}
async function screenshot(cdp, path) {
  const out = await cdp.call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  fs.writeFileSync(path, Buffer.from(out.data, "base64"));
}
module.exports = { CDP, connect, ready, sleep, screenshot };
