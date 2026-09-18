"use strict";
const electron = require("electron");
const path = require("node:path");
const node_crypto = require("node:crypto");
const node_child_process = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const node_http = require("node:http");
const fs$1 = require("node:fs/promises");
class DaemonError extends Error {
  detail;
  constructor(message, detail = "") {
    super(message);
    this.detail = detail;
  }
}
function bundledBinary() {
  const name = process.platform === "win32" ? "zyvrod.exe" : "zyvrod";
  const candidates = [
    process.env.ZYVROD_PATH,
    path.join(process.resourcesPath || "", "bin", name),
    path.join(electron.app.getAppPath(), "..", "..", "Zyvro-engine", "bin", name),
    path.join(electron.app.getAppPath(), "..", "Zyvro-engine", "bin", name)
  ].filter((p) => Boolean(p));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return name;
}
class Daemon {
  child = null;
  info = null;
  log = [];
  // engineVersion is the version of the binary currently serving this project,
  // read from the handshake. Older engines do not send one.
  version = "";
  get current() {
    return this.info;
  }
  get engineVersion() {
    return this.version;
  }
  // recentLog returns the tail of the daemon's stderr, which is what we show
  // the user when startup fails. Without it a failure is a silent blank window.
  recentLog() {
    return this.log.join("\n");
  }
  // start launches the engine that shipped with this app, and only that one.
  //
  // There used to be an update channel: the app checked a server for a newer
  // engine, verified a signature and ran what it downloaded. It is gone. The
  // engine now travels with the build, so a new engine means a new version of
  // the app — which is one fewer signed channel to get right, one fewer key to
  // keep safe, and no executable fetched at runtime at all.
  async start(projectDir) {
    return this.launch(bundledBinary(), projectDir);
  }
  async launch(bin, projectDir) {
    await this.stop();
    const child = node_child_process.spawn(bin, ["--project", projectDir, "--port", "0"], {
      cwd: projectDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.log.push(line);
        if (this.log.length > 200) this.log.shift();
      }
    });
    const handshake = await this.readHandshake(child, bin);
    this.version = handshake.version || "";
    this.info = { ...handshake, origin: `http://127.0.0.1:${handshake.port}` };
    return this.info;
  }
  // readHandshake waits for the single JSON line the daemon prints once it is
  // listening. Polling a port instead would race: bound is not the same as
  // ready, and we also need the token that line carries.
  readHandshake(child, bin) {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => {
          child.kill();
          reject(new DaemonError("The local Zyvro engine did not start in time.", this.recentLog()));
        });
      }, 15e3);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.startsWith("{")) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.ready && parsed.port && parsed.token) {
                finish(() => resolve(parsed));
                return;
              }
            } catch {
            }
          }
          index = buffer.indexOf("\n");
        }
      });
      child.on("error", (err) => {
        const hint = err.code === "ENOENT" ? `Could not find the local engine at "${bin}". Build it with: cd Zyvro-engine && go build -o bin/zyvrod ./cmd/zyvrod` : err.message;
        finish(() => reject(new DaemonError("The local Zyvro engine could not be launched.", hint)));
      });
      child.on("exit", (code) => {
        finish(
          () => reject(new DaemonError(`The local Zyvro engine exited with code ${code}.`, this.recentLog()))
        );
      });
    });
  }
  async stop() {
    const child = this.child;
    this.child = null;
    this.info = null;
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const done = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3e3);
      child.once("exit", () => {
        clearTimeout(done);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
function pixelRatio(bytes, width, height) {
  if (width <= 0 || height <= 0) return 0;
  const squared = bytes / (width * height * 4);
  const ratio = Math.round(Math.sqrt(squared));
  return ratio > 0 && ratio * ratio === squared ? ratio : 0;
}
function viewScale(pixels, points) {
  if (points <= 0 || pixels <= 0) return 0;
  return pixels / points;
}
function blit(base2, patch, x, y) {
  const left = Math.max(0, Math.round(x));
  const top = Math.max(0, Math.round(y));
  const right = Math.min(base2.width, Math.round(x) + patch.width);
  const bottom = Math.min(base2.height, Math.round(y) + patch.height);
  if (right <= left || bottom <= top) return 0;
  const wide = (right - left) * 4;
  for (let row = top; row < bottom; row++) {
    const from = ((row - Math.round(y)) * patch.width + (left - Math.round(x))) * 4;
    const to = (row * base2.width + left) * 4;
    patch.data.copy(base2.data, to, from, from + wide);
  }
  return bottom - top;
}
const BROWSER_PARTITION = "persist:zyvro-browser";
const TOOL_BROWSER_OPEN = "zyvro_browser_open";
const TOOL_BROWSER_READ = "zyvro_browser_read";
const TOOL_BROWSER_CLICK = "zyvro_browser_click";
const TOOL_BROWSER_TYPE = "zyvro_browser_type";
const TOOL_BROWSER_SHOT = "zyvro_browser_screenshot";
const TOOL_BROWSER_LOGS = "zyvro_browser_logs";
const TOOL_BROWSER_KEY = "zyvro_browser_key";
const TOOL_BROWSER_SCROLL = "zyvro_browser_scroll";
const TOOL_BROWSER_SET = "zyvro_browser_set";
const TOOL_BROWSER_WAIT = "zyvro_browser_wait";
const TOOL_BROWSER_EVAL = "zyvro_browser_eval";
function isLoopback(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}
function projectAllowList(projectDir) {
  if (!projectDir) return [];
  try {
    const raw = fs.readFileSync(path.join(projectDir, ".zyvro", "browser.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.allow)) return [];
    return parsed.allow.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function originOf(url) {
  return new URL(url).origin;
}
function allowed(url, policy) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, why: `"${url}" is not an address` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, why: `${parsed.protocol} is not allowed here — the test browser opens http and https only` };
  }
  if (isLoopback(parsed.hostname)) return { ok: true, url: parsed.toString() };
  const list = projectAllowList(policy.projectDir);
  if (list.length === 0) return { ok: true, url: parsed.toString() };
  const origin = parsed.origin;
  if (list.includes(origin) || list.includes("*")) return { ok: true, url: parsed.toString() };
  if (policy.visited.has(origin)) return { ok: true, url: parsed.toString() };
  return {
    ok: false,
    why: `${origin} is not in this project's browser allow list (.zyvro/browser.json). Add it — {"allow": ["${origin}"]} — or remove the file to let the agent browse freely.`
  };
}
const KEPT = 200;
const guests = /* @__PURE__ */ new Map();
const waiting = /* @__PURE__ */ new Map();
function registerGuest(contents, windowId, view = "") {
  const existing = guests.get(contents.id);
  if (existing) return existing;
  const guest = { id: contents.id, view, contents, windowId, console: [], requests: [], visited: /* @__PURE__ */ new Set() };
  guests.set(contents.id, guest);
  const promised = waiting.get(windowId);
  if (promised) {
    waiting.delete(windowId);
    for (const resolve of promised) resolve(guest);
  }
  contents.on("console-message", (event) => {
    push$1(guest.console, {
      level: String(event.level ?? "info"),
      text: String(event.message ?? ""),
      source: event.sourceId,
      line: event.lineNumber
    });
  });
  contents.on("did-start-navigation", (event) => {
    if (event.isSameDocument || !event.isMainFrame) return;
    guest.console.length = 0;
    guest.requests.length = 0;
  });
  contents.setWindowOpenHandler(({ url }) => {
    void contents.loadURL(url).catch(() => {
    });
    return { action: "deny" };
  });
  contents.on("context-menu", (_event, params) => {
    const window = electron.BrowserWindow.fromId(guest.windowId) ?? void 0;
    electron.Menu.buildFromTemplate(contextTemplate(guest, params)).popup(window ? { window } : {});
  });
  contents.on("destroyed", () => guests.delete(guest.id));
  return guest;
}
function contextTemplate(guest, params) {
  const items = [];
  const hasLink = Boolean(params.linkURL);
  const hasSelection = params.selectionText.trim() !== "";
  if (hasLink) {
    items.push(
      { label: "Open link", click: () => void guest.contents.loadURL(params.linkURL) },
      { label: "Copy link address", click: () => electron.clipboard.writeText(params.linkURL) },
      { type: "separator" }
    );
  }
  if (params.mediaType === "image" && params.srcURL) {
    items.push({ label: "Copy image address", click: () => electron.clipboard.writeText(params.srcURL) }, { type: "separator" });
  }
  if (hasSelection) {
    items.push({ label: "Copy", role: "copy" });
  }
  if (params.isEditable) {
    items.push({ label: "Cut", role: "cut" }, { label: "Paste", role: "paste" }, { label: "Select all", role: "selectAll" });
  }
  if (items.length > 0 && items[items.length - 1].type !== "separator") {
    items.push({ type: "separator" });
  }
  items.push(
    { label: "Back", enabled: canGo(guest, "back"), click: () => navigate(guest, "back") },
    { label: "Forward", enabled: canGo(guest, "forward"), click: () => navigate(guest, "forward") },
    { label: "Reload", click: () => navigate(guest, "reload") },
    { type: "separator" },
    // « Inspecter » ouvre sur l'élément visé, comme dans Chrome : c'est le
    // geste entier, pas « ouvrez les outils puis cherchez ».
    { label: "Inspect", click: () => void inspectAt(guest, params.x, params.y) },
    { label: "Developer tools", click: () => void showDevTools(guest) }
  );
  return items;
}
function showDevTools(guest, bounds = null) {
  if (guest.contents.isDestroyed()) return;
  if (toolsOpen(guest)) {
    placeTools(guest, bounds);
    guest.contents.devToolsWebContents?.focus();
    return;
  }
  dock(guest, bounds);
  guest.contents.openDevTools({ mode: "detach" });
}
function inspectAt(guest, x, y) {
  if (guest.contents.isDestroyed()) return;
  dock(guest, null);
  guest.contents.inspectElement(Math.round(x), Math.round(y));
}
function hideDevTools(guest) {
  if (!guest.contents.isDestroyed()) guest.contents.closeDevTools();
  dropTools(guest);
}
function dropTools(guest) {
  const view = guest.devtools;
  if (!view) return;
  guest.devtools = void 0;
  const window = electron.BrowserWindow.fromId(guest.windowId);
  if (window && !window.isDestroyed()) {
    window.contentView.removeChildView(view);
    window.webContents.send("browser:devtools-closed", { view: guest.view });
  }
  if (!view.webContents.isDestroyed()) view.webContents.close();
}
function dock(guest, bounds) {
  if (guest.devtools) return;
  const window = electron.BrowserWindow.fromId(guest.windowId);
  if (!window || window.isDestroyed()) return;
  const view = new electron.WebContentsView({
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  guest.devtools = view;
  window.contentView.addChildView(view);
  placeTools(guest, bounds);
  guest.contents.setDevToolsWebContents(view.webContents);
  window.webContents.send("browser:devtools-open", { view: guest.view });
  guest.contents.once("devtools-closed", () => dropTools(guest));
  guest.contents.once("destroyed", () => dropTools(guest));
}
function noteRequest(guestId, line) {
  const guest = guests.get(guestId);
  if (guest) push$1(guest.requests, line);
}
function toolsOpen(guest) {
  const view = guest.devtools;
  if (!view) return false;
  return !guest.contents.isDestroyed() && !view.webContents.isDestroyed();
}
function placeTools(guest, bounds) {
  const view = guest.devtools;
  if (!view) return;
  if (!bounds || bounds.width < 2 || bounds.height < 2) {
    view.setVisible(false);
    return;
  }
  view.setBounds(bounds);
  view.setVisible(true);
}
function overlaysIn(windowId) {
  const found = [];
  for (const guest of guests.values()) {
    if (guest.windowId !== windowId) continue;
    const view = guest.devtools;
    if (!view || !toolsOpen(guest)) continue;
    if (view.getVisible() === false) continue;
    const bounds = view.getBounds();
    if (bounds.width < 2 || bounds.height < 2) continue;
    found.push({ bounds, contents: view.webContents });
  }
  return found;
}
function noteVisit(guestId, url) {
  const guest = guests.get(guestId);
  if (!guest) return;
  try {
    guest.visited.add(originOf(url));
  } catch {
  }
}
function push$1(list, line) {
  list.push(line);
  if (list.length > KEPT) list.splice(0, list.length - KEPT);
}
let lastServed = "";
function openViews() {
  return [...guests.values()].filter((g) => !g.contents.isDestroyed());
}
function pickGuest(all, view = "") {
  const open = openViews();
  const wanted2 = view.trim();
  if (wanted2) {
    const named = open.find((g) => g.view === wanted2);
    if (named) lastServed = named.view;
    return named;
  }
  const recent = open.find((g) => g.view === lastServed);
  if (recent) return recent;
  if (open.length <= 1) return open[0];
  const focused = all.find((w) => !w.isDestroyed() && w.isFocused());
  return (focused && open.find((g) => g.windowId === focused.id)) ?? open[0];
}
function serveGuest(guest) {
  lastServed = guest.view;
  return guest;
}
function describeViews() {
  return openViews().map((g) => ({
    view: g.view,
    url: g.contents.getURL(),
    title: g.contents.getTitle(),
    serving: g.view === lastServed
  }));
}
function guestForWindow(windowId) {
  return [...guests.values()].find((g) => g.windowId === windowId && !g.contents.isDestroyed());
}
function waitForGuest(windowId, ms = 1e4, fresh = false) {
  const open = fresh ? void 0 : guestForWindow(windowId);
  if (open) return Promise.resolve(open);
  return new Promise((resolve, reject) => {
    const list = waiting.get(windowId) ?? [];
    const settle = (guest) => {
      clearTimeout(timer);
      resolve(guest);
    };
    list.push(settle);
    waiting.set(windowId, list);
    const timer = setTimeout(() => {
      const left = (waiting.get(windowId) ?? []).filter((fn) => fn !== settle);
      if (left.length === 0) waiting.delete(windowId);
      else waiting.set(windowId, left);
      reject(new Error("the test browser did not open — is the window still there?"));
    }, ms);
  });
}
const REF_ATTR = "data-zyvro-ref";
function readScriptFor(match) {
  return `(() => {
  const wanted = ${JSON.stringify(match.toLowerCase())}
  const seen = []
  let n = 0
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05
  }
  const label = (el) => {
    const own = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || el.getAttribute("title") || "").trim()
    return own.replace(/\\s+/g, " ").slice(0, 120)
  }
  for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"], [onclick], [contenteditable="true"]')) {
    if (!visible(el)) continue
    const ref = "e" + ++n
    el.setAttribute(${JSON.stringify(REF_ATTR)}, ref)
    const text = label(el)
    const value = typeof el.value === "string" ? el.value.slice(0, 120) : undefined
    if (wanted && !((text + " " + (value || "") + " " + (el.getAttribute("href") || "")).toLowerCase().includes(wanted))) continue
    const box = el.getBoundingClientRect()
    seen.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      text,
      // Ce que le champ contient, à part de son nom. Sans ça, un champ dont le
      // texte affiché est son *placeholder* a l'air vide après qu'on y a écrit,
      // et l'agent réécrit — ou conclut que l'écriture n'a pas marché.
      value,
      checked: typeof el.checked === "boolean" ? el.checked : undefined,
      disabled: el.disabled === true ? true : undefined,
      // Ce qui est hors de l'écran demande un défilement avant d'être
      // photographié ; cliquable, ça l'est de toute façon.
      offscreen: box.bottom < 0 || box.top > innerHeight ? true : undefined,
      options: el.tagName === "SELECT" ? Array.from(el.options).map((o) => o.text).slice(0, 30) : undefined,
      href: el.getAttribute("href") || undefined,
    })
    if (seen.length >= 120) break
  }
  const whole = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim()
  // Quand on cherche quelque chose de précis, le texte entier de la page est
  // exactement ce qu'on essayait de ne pas payer : il reste, en plus court.
  const room = wanted ? 800 : 6000
  return {
    url: location.href,
    title: document.title,
    text: whole.slice(0, room),
    truncated: whole.length > room,
    elements: seen,
    scroll: { y: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight), viewport: Math.round(innerHeight) },
    more_below: scrollY + innerHeight < document.documentElement.scrollHeight - 4,
  }
})()`;
}
const PAGE_ANSWER_MS = 8e3;
function limit(work, ms) {
  return Promise.race([
    work,
    new Promise(
      (_, reject) => setTimeout(() => reject(new Error(`the page did not answer in ${Math.round(ms / 1e3)}s — is it still loading?`)), ms)
    )
  ]);
}
async function inPage(guest, script, ms = PAGE_ANSWER_MS) {
  if (guest.contents.isDestroyed()) throw new Error("the test browser was closed");
  try {
    return await limit(guest.contents.executeJavaScript(script, true), ms);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (guest.contents.isDestroyed()) throw new Error("the test browser was closed");
    return await limit(guest.contents.executeJavaScript(script, true), ms);
  }
}
async function readPage(guest, match = "", ms) {
  return await inPage(guest, readScriptFor(match), ms);
}
async function boxOf(guest, ref) {
  const script = `(() => {
    const el = document.querySelector('[${REF_ATTR}=' + ${JSON.stringify(JSON.stringify(ref))} + ']')
    if (!el) return null
    el.scrollIntoView({ block: "center", inline: "center" })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height }
  })()`;
  return await inPage(guest, script);
}
function missing(ref) {
  return new Error(`no element ${ref} on this page — read it again, the page has changed since`);
}
async function clickRef(guest, ref) {
  const box = await boxOf(guest, ref);
  if (!box) throw missing(ref);
  const point = { x: Math.round(box.x), y: Math.round(box.y) };
  guest.contents.sendInputEvent({ type: "mouseMove", ...point });
  guest.contents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  guest.contents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
  return point;
}
async function typeInto(guest, ref, text2, submit = false) {
  const box = await boxOf(guest, ref);
  if (!box) throw missing(ref);
  const point = { x: Math.round(box.x), y: Math.round(box.y) };
  guest.contents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 3 });
  guest.contents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 3 });
  for (const character of text2) {
    guest.contents.sendInputEvent({ type: "char", keyCode: character });
  }
  if (submit) {
    guest.contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    guest.contents.sendInputEvent({ type: "char", keyCode: "\r" });
    guest.contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  }
}
function navigate(guest, go) {
  if (go === "back") guest.contents.navigationHistory.goBack();
  else if (go === "forward") guest.contents.navigationHistory.goForward();
  else guest.contents.reload();
}
function canGo(guest, go) {
  if (go === "back") return guest.contents.navigationHistory.canGoBack();
  if (go === "forward") return guest.contents.navigationHistory.canGoForward();
  return true;
}
async function hoverRef(guest, ref) {
  const box = await boxOf(guest, ref);
  if (!box) throw missing(ref);
  guest.contents.sendInputEvent({ type: "mouseMove", x: Math.round(box.x), y: Math.round(box.y) });
}
const MODIFIERS = ["shift", "control", "ctrl", "alt", "meta", "command", "cmd", "capslock", "numlock"];
function cleanModifiers(raw) {
  return raw.map((m) => m.toLowerCase().trim()).filter((m) => MODIFIERS.includes(m));
}
function pressKey(guest, key, modifiers = []) {
  const mods = cleanModifiers(modifiers);
  guest.contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers: mods });
  if (key.length === 1 && mods.length === 0) guest.contents.sendInputEvent({ type: "char", keyCode: key });
  guest.contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers: mods });
}
async function scrollPage(guest, what) {
  const step = Math.round(what.amount && what.amount > 0 ? what.amount : 600) * (what.direction === "up" ? -1 : 1);
  const target = what.ref ? `document.querySelector('[${REF_ATTR}=' + ${JSON.stringify(JSON.stringify(what.ref))} + ']')` : "null";
  const script = `(() => {
    const el = ${target}
    if (el) el.scrollBy(0, ${step})
    else scrollBy(0, ${step})
    return { y: Math.round(el ? el.scrollTop : scrollY), height: Math.round(el ? el.scrollHeight : document.documentElement.scrollHeight) }
  })()`;
  return await inPage(guest, script);
}
async function setField(guest, ref, value) {
  const script = `(() => {
    const el = document.querySelector('[${REF_ATTR}=' + ${JSON.stringify(JSON.stringify(ref))} + ']')
    if (!el) return null
    if (${JSON.stringify(value.checked !== void 0)}) {
      el.checked = ${JSON.stringify(value.checked === true)}
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.dispatchEvent(new Event("change", { bubbles: true }))
      return "checked=" + el.checked
    }
    const wanted = ${JSON.stringify(value.text ?? "")}
    if (el.tagName === "SELECT") {
      const option = Array.from(el.options).find((o) => o.text === wanted || o.value === wanted)
      if (!option) return "no-option:" + Array.from(el.options).map((o) => o.text).join(" | ")
      el.value = option.value
    } else {
      // Le passage par le setter natif : une entrée contrôlée par React ignore
      // une écriture directe sur .value, et la page garderait l'ancien texte
      // tout en l'affichant changé.
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, "value")
      if (setter && setter.set) setter.set.call(el, wanted)
      else el.value = wanted
    }
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    return "value=" + el.value
  })()`;
  const answer = await inPage(guest, script);
  if (answer === null) throw missing(ref);
  if (answer.startsWith("no-option:")) {
    throw new Error(`no such option — this list offers: ${answer.slice("no-option:".length)}`);
  }
  return answer;
}
async function waitFor(guest, what) {
  const limitMs = Math.min(60, Math.max(1, what.seconds ?? 10)) * 1e3;
  const until = Date.now() + limitMs;
  const wantsText = (what.text ?? "").trim();
  const wantsRef = (what.ref ?? "").trim();
  if (!wantsText && !wantsRef) throw new Error("say what to wait for: a text, or an element ref");
  const script = `(() => {
    const text = ${JSON.stringify(wantsText)}
    const ref = ${JSON.stringify(wantsRef)}
    if (ref) return Boolean(document.querySelector('[${REF_ATTR}=' + JSON.stringify(ref) + ']'))
    return (document.body ? document.body.innerText : "").includes(text)
  })()`;
  for (; ; ) {
    const there = await inPage(guest, script, 5e3);
    if (there === !what.gone) {
      return what.gone ? "it is gone" : "it is there";
    }
    if (Date.now() > until) {
      throw new Error(
        `waited ${Math.round(limitMs / 1e3)}s and ${wantsRef || `"${wantsText}"`} is still ${what.gone ? "there" : "missing"} — read the page to see what it shows instead`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function evalInPage(guest, expression) {
  const script = `(async () => {
    const answer = await (${expression})
    try {
      return JSON.parse(JSON.stringify(answer ?? null))
    } catch {
      return String(answer)
    }
  })()`;
  return await inPage(guest, script);
}
async function shootPage(guest, target, ref) {
  let region;
  if (ref) {
    const box = await boxOf(guest, ref);
    if (!box) throw missing(ref);
    region = {
      x: Math.max(0, Math.round(box.x - box.width / 2)),
      y: Math.max(0, Math.round(box.y - box.height / 2)),
      width: Math.max(1, Math.round(box.width)),
      height: Math.max(1, Math.round(box.height))
    };
  }
  const image = await guest.contents.capturePage(region);
  const png = image.toPNG();
  const file2 = (target ?? "").trim();
  if (!file2) return { png };
  fs.mkdirSync(path.dirname(file2), { recursive: true });
  fs.writeFileSync(file2, png);
  return { png, file: file2 };
}
function waitForLoad(contents, seconds = 15) {
  return new Promise((resolve) => {
    if (!contents.isLoading()) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      contents.off("did-stop-loading", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(1, seconds) * 1e3);
    contents.on("did-stop-loading", done);
  });
}
const SHOTS_SERVER = "zyvro-app";
const TOOL_PERMISSION = "zyvro_permission";
const TOOL_SCREENSHOT = "zyvro_screenshot";
const TOOL_LIST_WINDOWS = "zyvro_list_windows";
function clampScale(scale) {
  const n = typeof scale === "number" && Number.isFinite(scale) ? scale : 1;
  return Math.min(2, Math.max(0.1, n));
}
function cleanRect(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const r = raw;
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;
  const rect = { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) };
  if (Object.values(rect).some(Number.isNaN)) return void 0;
  if (rect.width <= 0 || rect.height <= 0) return void 0;
  return rect;
}
function pickWindow(all, id) {
  const open = all.filter((w) => !w.isDestroyed());
  if (typeof id === "number") return open.find((w) => w.id === id);
  return open.find((w) => w.isFocused()) ?? open[0];
}
function describeWindows(all) {
  return all.filter((w) => !w.isDestroyed()).map((w) => {
    const [width, height] = w.getSize();
    return { id: w.id, title: w.getTitle(), width, height, focused: w.isFocused(), visible: w.isVisible() };
  });
}
const listWindowsTool = {
  name: TOOL_LIST_WINDOWS,
  description: "List what is open in Zyvro Studio: its windows, with their id and size, and the test browser views with their id, address and title. Pass a window id to zyvro_screenshot, or a view id to any zyvro_browser_ tool.",
  inputSchema: { type: "object", properties: {} },
  annotations: { title: "List app windows", readOnlyHint: true, openWorldHint: false }
};
const screenshotTool = {
  name: TOOL_SCREENSHOT,
  description: "Take a screenshot of a Zyvro Studio window. Returns the image, or writes it to a file when a path is given. It captures the application window only — never the screen, another window, or anything in front of it.",
  inputSchema: {
    type: "object",
    properties: {
      window: {
        type: "number",
        description: "Which window, from zyvro_list_windows. Omit for the focused one."
      },
      rect: {
        type: "object",
        description: "A region of the window, in logical pixels. Omit for the whole window.",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" }
        },
        required: ["x", "y", "width", "height"]
      },
      path: {
        type: "string",
        description: "Write the PNG here instead of returning it. An existing file is replaced."
      },
      scale: { type: "number", description: "Scale the result, 0.1 to 2. Default 1." }
    }
  },
  annotations: {
    title: "Screenshot the app",
    // Elle ne change rien à l'état du produit — sauf quand on lui donne un
    // chemin, et c'est alors le seul effet qu'elle a.
    readOnlyHint: true,
    openWorldHint: false
  }
};
const browserOpenTool = {
  name: TOOL_BROWSER_OPEN,
  description: "Open a page in Zyvro Studio's own test browser — a tab inside the IDE, with its own session, so it never touches the user's browser or their logins. Any http or https address, unless the project narrows it with a .zyvro/browser.json allow list. Pass go instead of url to move through this tab's history.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2."
      },
      url: { type: "string", description: "http or https address to open." },
      go: { type: "string", enum: ["back", "forward", "reload"], description: "Move in history instead of opening an address." },
      wait_seconds: { type: "number", description: "How long to wait for the page to finish loading. Default 15." }
    }
  },
  annotations: { title: "Open a page", readOnlyHint: false, openWorldHint: true }
};
const browserReadTool = {
  name: TOOL_BROWSER_READ,
  description: "Read the page open in the test browser: its address, title, visible text, and the elements you can click or type into, each with a ref like e12. Read again after anything that changes the page — the refs belong to the page as it was.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2."
      },
      match: {
        type: "string",
        description: "Only return elements whose text, value or link contains this. Cheaper than reading a whole catalogue page."
      }
    }
  },
  annotations: { title: "Read the page", readOnlyHint: true, openWorldHint: false }
};
const browserClickTool = {
  name: TOOL_BROWSER_CLICK,
  description: "Click an element in the test browser by the ref zyvro_browser_read gave it. Sends a real mouse click, so focus and hover handlers run. Set hover to only move the pointer onto it, which is what opens a menu that appears on hover.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2."
      },
      ref: { type: "string", description: "An element ref from zyvro_browser_read, such as e7." },
      hover: { type: "boolean", description: "Move the pointer onto it without clicking. Default false." }
    },
    required: ["ref"]
  },
  annotations: { title: "Click", readOnlyHint: false, openWorldHint: false }
};
const browserKeyTool = {
  name: TOOL_BROWSER_KEY,
  description: "Press a key in the test browser: Escape, Tab, Enter, ArrowDown, Backspace, or a character with modifiers. It goes to whatever has focus, so click the field first when it matters.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2."
      },
      key: { type: "string", description: "Escape, Tab, Enter, ArrowDown, Backspace, a, …" },
      modifiers: {
        type: "array",
        items: { type: "string" },
        description: "shift, control, alt, meta — anything else is ignored rather than refused."
      }
    },
    required: ["key"]
  },
  annotations: { title: "Press a key", readOnlyHint: false, openWorldHint: false }
};
const browserScrollTool = {
  name: TOOL_BROWSER_SCROLL,
  description: "Scroll the page in the test browser, or an element of it. Needed to photograph what is further down, and to trigger what only loads on approach — an infinite list stays empty for whoever never scrolls.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2."
      },
      ref: { type: "string", description: "Scroll inside this element instead of the page." },
      direction: { type: "string", enum: ["up", "down"], description: "Default down." },
      amount: { type: "number", description: "Pixels. Default 600." }
    }
  },
  annotations: { title: "Scroll", readOnlyHint: false, openWorldHint: false }
};
const browserSetTool = {
  name: TOOL_BROWSER_SET,
  description: "Set a field the keyboard cannot reach: choose in a dropdown by its option text, or put a checkbox in a state. Say what you want it to be, not what to toggle — a checkbox set twice must end up where you asked.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2."
      },
      ref: { type: "string", description: "An element ref from zyvro_browser_read." },
      text: { type: "string", description: "For a select: the option's text. For a field: the value to put in it." },
      checked: { type: "boolean", description: "For a checkbox or a radio." }
    },
    required: ["ref"]
  },
  annotations: { title: "Set a field", readOnlyHint: false, openWorldHint: false }
};
const browserWaitTool = {
  name: TOOL_BROWSER_WAIT,
  description: "Wait until a text or an element appears in the test browser — or disappears, with gone. This is the cure for acting before the page is ready, which is the one real cause of flaky checks.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2."
      },
      text: { type: "string", description: "Wait for this text to appear in the page." },
      ref: { type: "string", description: "Wait for this element, from a previous read." },
      gone: { type: "boolean", description: "Wait for it to disappear instead. Default false." },
      seconds: { type: "number", description: "How long to wait before giving up. Default 10, at most 60." }
    }
  },
  annotations: { title: "Wait for", readOnlyHint: true, openWorldHint: false }
};
const browserEvalTool = {
  name: TOOL_BROWSER_EVAL,
  description: "Run a JavaScript expression in the page and return what it evaluates to, as JSON. The way out when no other tool fits — reading a computed style, a global the app exposes, the contents of a canvas.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2."
      },
      expression: { type: "string", description: "A JavaScript expression, not a statement." }
    },
    required: ["expression"]
  },
  annotations: { title: "Evaluate", readOnlyHint: false, openWorldHint: false }
};
const browserTypeTool = {
  name: TOOL_BROWSER_TYPE,
  description: "Type into a field in the test browser. The field's current contents are replaced. Set submit to press Enter afterwards.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2."
      },
      ref: { type: "string", description: "An element ref from zyvro_browser_read." },
      text: { type: "string" },
      submit: { type: "boolean", description: "Press Enter after typing. Default false." }
    },
    required: ["ref", "text"]
  },
  annotations: { title: "Type", readOnlyHint: false, openWorldHint: false }
};
const browserShotTool = {
  name: TOOL_BROWSER_SHOT,
  description: "Screenshot the page in the test browser. Returns the image, or writes it to a file when a path is given.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2."
      },
      path: { type: "string", description: "Write the PNG here instead of returning it." },
      ref: { type: "string", description: "Frame on this element instead of the whole page." }
    }
  },
  annotations: { title: "Screenshot the page", readOnlyHint: true, openWorldHint: false }
};
const browserLogsTool = {
  name: TOOL_BROWSER_LOGS,
  description: "The console messages and the failed requests of the page in the test browser, since it was last loaded. This is what a broken page says about itself, and it is usually the answer.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2."
      },
      pattern: { type: "string", description: "Only lines matching this regular expression. A console can be noisy." },
      requests: { type: "boolean", description: "Include every request, not only the ones that failed. Default false." }
    }
  },
  annotations: { title: "Console and failed requests", readOnlyHint: true, openWorldHint: false }
};
const BROWSER_TOOLS = [
  browserOpenTool,
  browserReadTool,
  browserClickTool,
  browserTypeTool,
  browserKeyTool,
  browserSetTool,
  browserScrollTool,
  browserWaitTool,
  browserShotTool,
  browserLogsTool,
  browserEvalTool
];
const permissionTool = {
  name: TOOL_PERMISSION,
  description: "Ask the person for permission to use a tool. Zyvro Studio shows the request in its agent panel and returns their answer. This is the permission prompt tool — it is called by the CLI, not by you.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "The tool that needs permission." },
      input: { type: "object", description: "What it would be called with." },
      tool_use_id: { type: "string" }
    },
    required: ["tool_name", "input"]
  },
  annotations: { title: "Ask permission", readOnlyHint: true, openWorldHint: false }
};
function text(value) {
  return { content: [{ type: "text", text: value }] };
}
async function browserCall(name, args, all, host) {
  const win = pickWindow(all);
  if (!win) throw new Error("Zyvro Studio is not open");
  const view = typeof args.view === "string" ? args.view.trim() : "";
  if (name === TOOL_BROWSER_OPEN) {
    const patience = typeof args.wait_seconds === "number" ? args.wait_seconds : 15;
    const go = typeof args.go === "string" ? args.go : null;
    if (go) {
      const guest3 = pickGuest(all, view);
      if (!guest3) throw new Error(missingView(view));
      if (!canGo(guest3, go)) throw new Error(`nothing to go ${go} to in ${guest3.view || "this view"}`);
      navigate(guest3, go);
      await waitForLoad(guest3.contents, patience);
      return text(await describe(serveGuest(guest3)));
    }
    const url = String(args.url ?? "");
    const verdict = allowed(url, {
      visited: pickGuest(all, view)?.visited ?? /* @__PURE__ */ new Set(),
      projectDir: host.projectDir(win)
    });
    if (!verdict.ok) throw new Error(verdict.why);
    const guest2 = await host.open(win, view);
    await guest2.contents.loadURL(verdict.url);
    await waitForLoad(guest2.contents, patience);
    return text(await describe(serveGuest(guest2)));
  }
  const guest = pickGuest(all, view);
  if (!guest) throw new Error(missingView(view));
  serveGuest(guest);
  switch (name) {
    case TOOL_BROWSER_READ:
      return text(JSON.stringify(await readPage(guest, typeof args.match === "string" ? args.match : ""), null, 1));
    case TOOL_BROWSER_CLICK: {
      const ref = String(args.ref ?? "");
      if (args.hover === true) {
        await hoverRef(guest, ref);
        return text(`the pointer is on ${ref} — read the page, a menu may have opened`);
      }
      const at = await clickRef(guest, ref);
      await waitForLoad(guest.contents, 10);
      return text(`clicked ${ref} at ${at.x},${at.y} — the page may have changed, read it again`);
    }
    case TOOL_BROWSER_TYPE:
      await typeInto(guest, String(args.ref ?? ""), String(args.text ?? ""), args.submit === true);
      if (args.submit === true) await waitForLoad(guest.contents, 10);
      return text(`typed into ${args.ref}${args.submit === true ? " and pressed Enter" : ""}`);
    case TOOL_BROWSER_KEY: {
      const key = String(args.key ?? "");
      if (!key) throw new Error("say which key");
      pressKey(guest, key, Array.isArray(args.modifiers) ? args.modifiers.map(String) : []);
      await waitForLoad(guest.contents, 5);
      return text(`pressed ${key}`);
    }
    case TOOL_BROWSER_SET: {
      const done = await setField(guest, String(args.ref ?? ""), {
        text: typeof args.text === "string" ? args.text : void 0,
        checked: typeof args.checked === "boolean" ? args.checked : void 0
      });
      return text(`${args.ref}: ${done}`);
    }
    case TOOL_BROWSER_SCROLL: {
      const where = await scrollPage(guest, {
        ref: typeof args.ref === "string" ? args.ref : void 0,
        direction: args.direction === "up" ? "up" : "down",
        amount: typeof args.amount === "number" ? args.amount : void 0
      });
      return text(`at ${where.y} of ${where.height}`);
    }
    case TOOL_BROWSER_WAIT:
      return text(
        await waitFor(guest, {
          text: typeof args.text === "string" ? args.text : void 0,
          ref: typeof args.ref === "string" ? args.ref : void 0,
          gone: args.gone === true,
          seconds: typeof args.seconds === "number" ? args.seconds : void 0
        })
      );
    case TOOL_BROWSER_EVAL: {
      const answer = await evalInPage(guest, String(args.expression ?? "null"));
      return text(JSON.stringify(answer, null, 1) ?? "undefined");
    }
    case TOOL_BROWSER_SHOT: {
      const shot = await shootPage(
        guest,
        typeof args.path === "string" ? args.path : void 0,
        typeof args.ref === "string" ? args.ref : void 0
      );
      if (shot.file) return text(`Wrote the page to ${shot.file}`);
      return { content: [{ type: "image", data: shot.png.toString("base64"), mimeType: "image/png" }] };
    }
    case TOOL_BROWSER_LOGS: {
      const raw = typeof args.pattern === "string" ? args.pattern.trim() : "";
      let keep2 = () => true;
      if (raw) {
        try {
          const rx = new RegExp(raw, "i");
          keep2 = (line) => rx.test(line);
        } catch {
          keep2 = (line) => line.toLowerCase().includes(raw.toLowerCase());
        }
      }
      return text(
        JSON.stringify(
          {
            console: guest.console.filter((line) => keep2(`${line.level} ${line.text}`)),
            failed: guest.requests.filter((r) => (r.error || r.status >= 400) && keep2(r.url)),
            ...args.requests === true ? { requests: guest.requests.filter((r) => keep2(r.url)) } : {}
          },
          null,
          1
        )
      );
    }
  }
  throw new Error(`no such tool: ${name}`);
}
async function describe(guest) {
  const page = await readPage(guest);
  return `${guest.view ? `${guest.view}: ` : ""}${page.title || "(no title)"} — ${page.url}
${page.elements.length} elements to click or type into${page.more_below ? ", and more below the fold" : ""}. Read it for the text.`;
}
function missingView(view) {
  const open = describeViews();
  if (view) {
    return open.length === 0 ? `there is no browser view open — call ${TOOL_BROWSER_OPEN} with a url` : `no browser view called ${view}. Open: ${open.map((v) => v.view).join(", ")}`;
  }
  return `no page open in the test browser — call ${TOOL_BROWSER_OPEN} with a url first`;
}
async function shootView(contents) {
  try {
    return await contents.capturePage();
  } catch {
  }
  let mine2 = false;
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
      mine2 = true;
    }
    const shot = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
    if (!shot?.data) return null;
    return electron.nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
  } catch {
    return null;
  } finally {
    if (mine2) {
      try {
        contents.debugger.detach();
      } catch {
      }
    }
  }
}
async function shoot(win, rect) {
  const image = await win.webContents.capturePage(rect);
  const overlays = overlaysIn(win.id);
  if (overlays.length === 0) return image;
  const size = image.getSize();
  const data = image.toBitmap();
  const ratio = pixelRatio(data.length, size.width, size.height);
  if (ratio === 0) return image;
  const width = size.width * ratio;
  const height = size.height * ratio;
  const origin = rect ?? { x: 0, y: 0 };
  const across = rect ? rect.width : win.getContentSize()[0];
  const scale = viewScale(width, across);
  if (scale === 0) return image;
  let posed = 0;
  for (const overlay of overlays) {
    const patch = await shootView(overlay.contents);
    if (!patch) continue;
    const shape = patch.getSize();
    const bytes = patch.toBitmap();
    const own = pixelRatio(bytes.length, shape.width, shape.height);
    if (own === 0) continue;
    posed += blit(
      { data, width, height },
      { data: bytes, width: shape.width * own, height: shape.height * own },
      (overlay.bounds.x - origin.x) * scale,
      (overlay.bounds.y - origin.y) * scale
    );
  }
  if (posed === 0) return image;
  return electron.nativeImage.createFromBitmap(data, { width, height });
}
async function takeShot(all, args) {
  const win = pickWindow(all, args.window);
  if (!win) {
    const open = describeWindows(all);
    throw new Error(
      open.length === 0 ? "no window to capture: Zyvro Studio is not open" : `no window with id ${args.window}. Open: ${open.map((w) => `${w.id} (${w.title})`).join(", ")}`
    );
  }
  const rect = cleanRect(args.rect);
  let image = await shoot(win, rect);
  const scale = clampScale(args.scale);
  if (scale !== 1) {
    const size = image.getSize();
    image = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) });
  }
  const png = image.toPNG();
  const target = typeof args.path === "string" ? args.path.trim() : "";
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, png);
    const { width, height } = image.getSize();
    return { content: [{ type: "text", text: `Wrote ${width}×${height} to ${target}` }] };
  }
  return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
}
async function askPermission(ask2, args) {
  const tool = String(args.tool_name ?? "a tool");
  const input = args.input ?? {};
  const answer = await ask2({ tool, input, id: String(args.tool_use_id ?? "") });
  const payload = answer.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: answer.message || `${tool} was not allowed` };
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}
async function captureRegion(win, rect) {
  if (!win || win.isDestroyed()) throw new Error("no window to capture");
  const region = cleanRect(rect);
  if (!region) throw new Error("that is not a region");
  const image = await shoot(win, region);
  return image.toPNG();
}
function saveShot(png, place) {
  const file2 = path.join(place.dir, shotName(place.label));
  fs.mkdirSync(place.dir, { recursive: true });
  fs.writeFileSync(file2, png);
  place.open(file2);
  return file2;
}
async function shareShot(png, label, post) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), shotName(label));
  const answer = await post("/api/uploads", { method: "POST", body: form });
  const url = typeof answer?.url === "string" ? answer.url.trim() : "";
  if (!url) throw new Error("the server accepted the image but returned no link");
  return url;
}
function shotName(label, now = /* @__PURE__ */ new Date()) {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const zone = (label ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `zyvro-${zone ? `${zone}-` : ""}${stamp}.png`;
}
let running = null;
function shotsEndpoint() {
  return running;
}
async function startShotsServer(windows, browser, ask2) {
  if (running) return running;
  const token = node_crypto.randomBytes(24).toString("hex");
  const server = node_http.createServer((req, res) => {
    void handle(req, res, token, windows, browser, ask2);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  running = {
    origin: `http://127.0.0.1:${port}`,
    token,
    close: () => {
      server.close();
      running = null;
    }
  };
  return running;
}
async function handle(req, res, token, windows, browser, ask2) {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  let msg;
  try {
    msg = JSON.parse(body || "{}");
  } catch {
    res.writeHead(400).end(JSON.stringify({ error: "bad json" }));
    return;
  }
  const reply = (result) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result }));
  try {
    switch (msg.method) {
      case "initialize":
        reply({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: SHOTS_SERVER, version: "1" }
        });
        return;
      case "notifications/initialized":
        res.writeHead(202).end();
        return;
      case "tools/list":
        reply({
          tools: [listWindowsTool, screenshotTool, ...browser ? BROWSER_TOOLS : [], ...ask2 ? [permissionTool] : []]
        });
        return;
      case "tools/call": {
        switch (msg.params?.name) {
          case TOOL_LIST_WINDOWS:
            reply({
              content: [
                {
                  type: "text",
                  // Les fenêtres et les vues ensemble : c'est une seule question
                  // — « qu'est-ce qui est ouvert ? » — et deux outils pour y
                  // répondre en feraient un que personne n'appelle.
                  text: JSON.stringify(
                    { windows: describeWindows(windows()), ...browser ? { browser_views: describeViews() } : {} },
                    null,
                    1
                  )
                }
              ]
            });
            return;
          case TOOL_SCREENSHOT:
            reply(await takeShot(windows(), msg.params?.arguments ?? {}));
            return;
          case TOOL_PERMISSION: {
            if (!ask2) throw new Error("this window cannot ask anyone");
            const args = msg.params?.arguments ?? {};
            reply(await askPermission(ask2, args));
            return;
          }
          default:
            if (browser && BROWSER_TOOLS.some((t) => t.name === msg.params?.name)) {
              reply(
                await browserCall(
                  String(msg.params?.name),
                  msg.params?.arguments ?? {},
                  windows(),
                  browser
                )
              );
              return;
            }
            throw new Error(`no such tool: ${msg.params?.name}`);
        }
      }
      default:
        res.writeHead(404).end(JSON.stringify({ error: `unknown method ${msg.method}` }));
    }
  } catch (err) {
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] }
      })
    );
  }
}
const MCP_SERVER = "zyvro";
const MCP_URL_ENV = "ZYVRO_MCP_URL";
const MCP_TOKEN_ENV = "ZYVRO_MCP_TOKEN";
const SHOTS_URL_ENV = "ZYVRO_SHOTS_URL";
const SHOTS_TOKEN_ENV = "ZYVRO_SHOTS_TOKEN";
const MCP_CONFIG_ENV = "ZYVRO_MCP_CONFIG";
function mcpAvailable(ctx) {
  return Boolean(ctx.daemonOrigin && ctx.daemonToken);
}
function mcpUrl(ctx) {
  return `${ctx.daemonOrigin}/mcp`;
}
function mcpServers(ctx) {
  if (!mcpAvailable(ctx)) return {};
  const shots = shotsEndpoint();
  return {
    [MCP_SERVER]: {
      type: "http",
      url: mcpUrl(ctx),
      headers: { Authorization: `Bearer ${ctx.daemonToken}` }
    },
    ...shots ? {
      [SHOTS_SERVER]: {
        type: "http",
        url: shots.origin,
        headers: { Authorization: `Bearer ${shots.token}` }
      }
    } : {}
  };
}
function writeMcpConfig(ctx) {
  const written = mcpDirectory(ctx);
  return { path: written.file, dispose: written.dispose };
}
function mcpDirectory(ctx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zyvro-mcp-"));
  const file2 = path.join(dir, "mcp.json");
  fs.writeFileSync(file2, JSON.stringify({ mcpServers: mcpServers(ctx) }, null, 2), { mode: 384 });
  return { dir, file: file2, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function codexMcpArgs(ctx) {
  const args = [];
  for (const [name, server] of Object.entries(mcpServers(ctx))) {
    args.push(
      "-c",
      `mcp_servers.${name}.url="${server.url}"`,
      "-c",
      `mcp_servers.${name}.bearer_token_env_var="${name === MCP_SERVER ? MCP_TOKEN_ENV : SHOTS_TOKEN_ENV}"`
    );
  }
  return args;
}
function mcpTokenEnv(ctx) {
  const env = {};
  const servers = mcpServers(ctx);
  if (servers[MCP_SERVER]) env[MCP_TOKEN_ENV] = ctx.daemonToken;
  const shots = shotsEndpoint();
  if (servers[SHOTS_SERVER] && shots) env[SHOTS_TOKEN_ENV] = shots.token;
  return env;
}
const HELPER = "zyvro-mcp";
function shellMcp(ctx) {
  if (!mcpAvailable(ctx)) return null;
  const servers = mcpServers(ctx);
  const written = mcpDirectory(ctx);
  const env = {
    ...mcpTokenEnv(ctx),
    [MCP_URL_ENV]: servers[MCP_SERVER]?.url,
    [SHOTS_URL_ENV]: servers[SHOTS_SERVER]?.url,
    [MCP_CONFIG_ENV]: written.file,
    PATH: `${written.dir}${path.delimiter}${process.env.PATH ?? ""}`
  };
  writeHelper(written.dir, ctx);
  return {
    env,
    banner: banner(servers, written.file),
    dispose: written.dispose
  };
}
function banner(servers, config) {
  const names = Object.keys(servers).join(" · ");
  const dim = (line) => `\x1B[2m${line}\x1B[0m\r
`;
  return dim(`MCP ${names} — ${HELPER} claude · ${HELPER} codex · ${HELPER} for the details`) + // Le chemin en entier, pas le nom de la variable : c'est ce qu'on colle
  // dans la configuration d'un autre client, et le jeton reste dans le
  // fichier, lisible par son seul propriétaire.
  dim(`    any other client: ${config}`);
}
function quote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function writeHelper(dir, ctx) {
  const codex = codexMcpArgs(ctx).map(quote).join(" ");
  const lines = [
    "#!/bin/sh",
    "# zyvro-mcp — lance un agent déjà branché sur les serveurs MCP du projet.",
    "# Écrit par Zyvro Studio pour ce shell ; il disparaît avec lui.",
    "info() {",
    `  echo "Zyvro MCP"`,
    ...Object.entries(mcpServers(ctx)).map(
      ([name, server]) => `  echo "  ${name.padEnd(9)} ${server.url}"`
    ),
    `  echo "  config    ${"$" + MCP_CONFIG_ENV}"`,
    `  echo ""`,
    `  echo "  ${HELPER} claude [...]   claude, with both servers wired in"`,
    `  echo "  ${HELPER} codex  [...]   codex, with both servers wired in"`,
    `  echo "  any other client: point it at ${"$" + MCP_CONFIG_ENV}"`,
    "}",
    'case "${1:-}" in',
    // --strict-mcp-config : seulement les serveurs de ce projet. Sans lui, ceux
    // que la personne a déclarés ailleurs se rajoutent, et l'agent n'a pas les
    // mêmes outils d'une machine à l'autre.
    `  claude) shift; exec claude --mcp-config "${"$" + MCP_CONFIG_ENV}" --strict-mcp-config "$@" ;;`,
    `  codex) shift; exec codex ${codex} "$@" ;;`,
    "  ''|-h|--help|info) info ;;",
    `  *) echo "${HELPER}: I do not know how to wire \\"$1\\"" >&2; info; exit 2 ;;`,
    "esac",
    ""
  ];
  fs.writeFileSync(path.join(dir, HELPER), lines.join("\n"), { mode: 448 });
  if (process.platform === "win32") {
    const cmd = [
      "@echo off",
      "echo Zyvro MCP",
      ...Object.entries(mcpServers(ctx)).map(([name, server]) => `echo   ${name} ${server.url}`),
      `echo   config %${MCP_CONFIG_ENV}%`,
      "echo.",
      `echo   claude --mcp-config "%${MCP_CONFIG_ENV}%" --strict-mcp-config`,
      ""
    ];
    fs.writeFileSync(path.join(dir, `${HELPER}.cmd`), cmd.join("\r\n"));
  }
}
let ptyModule;
function loadPty() {
  if (ptyModule !== void 0) return ptyModule;
  try {
    ptyModule = require("node-pty");
  } catch (err) {
    console.warn("node-pty unavailable, terminal runs in pipe mode:", err.message);
    ptyModule = null;
  }
  return ptyModule;
}
function ptyAvailable() {
  return loadPty() !== null;
}
function defaultShell() {
  if (process.platform === "win32") {
    return { file: process.env.COMSPEC || "cmd.exe", args: [] };
  }
  const shell = process.env.SHELL || "/bin/zsh";
  return { file: shell, args: ["-l"] };
}
function makePty(cwd, cols, rows, extra = {}) {
  const mod = loadPty();
  const { file: file2, args } = defaultShell();
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...extra };
  if (mod) {
    const proc = mod.spawn(file2, args, { name: "xterm-256color", cols, rows, cwd, env });
    return {
      write: (d) => proc.write(d),
      resize: (c, r) => proc.resize(c, r),
      kill: () => proc.kill(),
      onData: (cb) => proc.onData(cb),
      onExit: (cb) => proc.onExit((e) => cb(e.exitCode))
    };
  }
  const useScript = process.platform !== "win32";
  const command = useScript ? "/usr/bin/script" : file2;
  const commandArgs = useScript ? process.platform === "darwin" ? ["-q", "/dev/null", file2, ...args] : ["-qfc", [file2, ...args].join(" "), "/dev/null"] : args;
  const child = node_child_process.spawn(command, commandArgs, {
    cwd,
    env: { ...env, LINES: String(rows), COLUMNS: String(cols) }
  });
  return {
    write: (d) => child.stdin?.write(d),
    resize: () => void 0,
    kill: () => child.kill(),
    onData: (cb) => {
      child.stdout?.on("data", (b) => cb(b.toString("utf8")));
      child.stderr?.on("data", (b) => cb(b.toString("utf8")));
    },
    onExit: (cb) => child.on("exit", (code) => cb(code ?? 0))
  };
}
class Terminals {
  sessions = /* @__PURE__ */ new Map();
  // mcp est le contexte du démon de ce projet, quand il y en a un. Chaque shell
  // ouvert par l'application porte de quoi joindre ses serveurs MCP : ce qu'on
  // lance dedans — un autre agent, un client, un curl — ne peut pas deviner un
  // port et un jeton qui changent à chaque démarrage.
  create(target, cwd, cols = 80, rows = 24, mcp = null) {
    const id = node_crypto.randomUUID();
    const wired = mcp ? shellMcp(mcp) : null;
    const pty = makePty(cwd || os.homedir(), cols, rows, wired?.env);
    this.sessions.set(id, { id, pty, dispose: wired?.dispose });
    pty.onData((data) => {
      if (target.isDestroyed()) return;
      target.send("terminal:data", { id, data });
    });
    pty.onExit((code) => {
      this.drop(id);
      if (target.isDestroyed()) return;
      target.send("terminal:exit", { id, code });
    });
    return { id, pty: ptyAvailable(), banner: wired?.banner };
  }
  // drop oublie une session et efface ce qui n'avait de sens que pour elle : le
  // fichier de configuration MCP porte un jeton, et sa durée de vie est celle
  // du shell qui pouvait s'en servir.
  drop(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    this.sessions.delete(id);
    session.dispose?.();
    return session;
  }
  write(id, data) {
    this.sessions.get(id)?.pty.write(data);
  }
  resize(id, cols, rows) {
    this.sessions.get(id)?.pty.resize(cols, rows);
  }
  dispose(id) {
    this.drop(id)?.pty.kill();
  }
  disposeAll() {
    for (const id of [...this.sessions.keys()]) this.dispose(id);
  }
}
const isWindows = process.platform === "win32";
const EXTENSIONS = isWindows ? [".cmd", ".exe", ".bat", ".ps1", ""] : [""];
const TIMEOUT_MS = 5e3;
const MARK = "__zyvro_env__";
function readLoginShellPath() {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    const child = node_child_process.spawn(shell, ["-ilc", `echo "${MARK}"; printf '%s' "$PATH"; echo; echo "${MARK}"`], {
      env: { ...process.env, ZYVRO_SHELL_PROBE: "1" },
      stdio: ["ignore", "pipe", "ignore"]
    });
    let out = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(value);
    };
    const timer = setTimeout(() => done(null), TIMEOUT_MS);
    child.stdout.on("data", (chunk) => out += chunk);
    child.on("error", () => done(null));
    child.on("close", () => {
      const parts = out.split(MARK);
      done(parts.length >= 3 ? parts[1].trim() : null);
    });
  });
}
function merge(current, incoming) {
  const separator = isWindows ? ";" : ":";
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const entry of [...incoming.split(separator), ...current.split(separator)]) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = isWindows ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out.join(separator);
}
function ask$1(command, args) {
  try {
    const result = node_child_process.spawnSync(command, args, { encoding: "utf8", timeout: TIMEOUT_MS, shell: isWindows });
    return result.status === 0 ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}
function installRoots() {
  const home = os.homedir();
  const roots = [];
  const npmPrefix = ask$1("npm", ["prefix", "-g"]);
  if (npmPrefix) roots.push(isWindows ? npmPrefix : path.join(npmPrefix, "bin"));
  if (!isWindows) {
    const brewPrefix = ask$1("brew", ["--prefix"]);
    if (brewPrefix) roots.push(path.join(brewPrefix, "bin"));
    roots.push(path.join(home, ".local", "bin"), path.join(home, ".bun", "bin"));
  } else {
    roots.push(path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "npm"));
    roots.push(path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs"));
  }
  return roots.filter((root) => root && fs.existsSync(root));
}
function locate(name) {
  const separator = isWindows ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(separator)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const extension of EXTENSIONS) {
      const candidate = path.join(trimmed, name + extension);
      if (fs.existsSync(candidate)) {
        return { file: candidate, needsShell: /\.(cmd|bat|ps1)$/i.test(candidate) };
      }
    }
  }
  return null;
}
async function prepare(names) {
  if (!isWindows) {
    const fromShell = await readLoginShellPath();
    if (fromShell) process.env.PATH = merge(process.env.PATH ?? "", fromShell);
  }
  const missing2 = names.filter((name) => !locate(name));
  if (missing2.length === 0) return;
  const roots = installRoots();
  if (roots.length === 0) return;
  process.env.PATH = merge(process.env.PATH ?? "", roots.join(isWindows ? ";" : ":"));
}
function launch(name, args, options = {}) {
  const found = locate(name);
  if (!found) {
    throw new Error(
      `"${name}" was not found on this machine. Install it and sign in, then reopen this panel.`
    );
  }
  return node_child_process.spawn(found.file, args, { ...options, shell: found.needsShell });
}
function launchPiped(name, args, options = {}) {
  return launch(name, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
}
function installed(name) {
  return locate(name) !== null;
}
const helpCache = /* @__PURE__ */ new Map();
function helpOf(name) {
  const cached2 = helpCache.get(name);
  if (cached2 !== void 0) return cached2;
  const found = locate(name);
  if (!found) {
    helpCache.set(name, "");
    return "";
  }
  const result = node_child_process.spawnSync(found.file, ["--help"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    shell: found.needsShell
  });
  const text2 = `${result.stdout ?? ""}
${result.stderr ?? ""}`;
  helpCache.set(name, text2);
  return text2;
}
function str$1(value) {
  return typeof value === "string" ? value : "";
}
function base(file2) {
  const parts = file2.split(/[/\\]/);
  return parts[parts.length - 1] || file2;
}
function short(text2, limit2 = 64) {
  const line = text2.replace(/\s+/g, " ").trim();
  return line.length > limit2 ? `${line.slice(0, limit2 - 1)}…` : line;
}
function describeTool(name, input) {
  const args = input && typeof input === "object" ? input : {};
  const file2 = str$1(args.file_path) || str$1(args.path) || str$1(args.notebook_path);
  const pattern = str$1(args.pattern) || str$1(args.query);
  switch (name) {
    case "Read":
      return { running: `Reading ${base(file2)}`, done: `Read ${base(file2)}`, shape: "read", detail: file2 };
    case "Write":
      return { running: `Writing ${base(file2)}`, done: `Wrote ${base(file2)}`, shape: "edit", detail: file2 };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { running: `Editing ${base(file2)}`, done: `Edited ${base(file2)}`, shape: "edit", detail: file2 };
    case "BashOutput":
      return {
        running: "Checking on a running command",
        done: "Checked on a running command",
        shape: "terminal",
        detail: str$1(args.bash_id) || str$1(args.shell_id)
      };
    case "Bash": {
      const command = str$1(args.command);
      const why = short(str$1(args.description) || command, 48);
      return { running: `Running ${why}`, done: `Ran ${why}`, shape: "terminal", detail: command };
    }
    case "KillShell":
      return { running: "Stopping a command", done: "Stopped a command", shape: "terminal", detail: str$1(args.shell_id) };
    case "Glob":
    case "Grep": {
      const where = str$1(args.path);
      const target = short(pattern, 40);
      const suffix = where ? ` in ${base(where)}` : "";
      return {
        running: `Searching for ${target}${suffix}`,
        done: `Searched for ${target}${suffix}`,
        shape: "search",
        detail: pattern
      };
    }
    case "WebSearch":
      return { running: `Searching the web for ${short(pattern, 40)}`, done: `Searched the web for ${short(pattern, 40)}`, shape: "web", detail: pattern };
    case "WebFetch": {
      const url = str$1(args.url);
      return { running: `Fetching ${short(url, 48)}`, done: `Fetched ${short(url, 48)}`, shape: "web", detail: url };
    }
    case "TodoWrite":
      return { running: "Updating the plan", done: "Updated the plan", shape: "plan", detail: "" };
    case "Task": {
      const what = short(str$1(args.description) || str$1(args.subagent_type), 44);
      return { running: `Delegating ${what}`, done: `Delegated ${what}`, shape: "agent", detail: str$1(args.prompt) };
    }
    default: {
      const mcp = /^mcp__([^_]+)__(.+)$/.exec(name);
      if (mcp) {
        const readable = mcp[2].replace(/_/g, " ");
        return { running: `${readable} (${mcp[1]})`, done: `${readable} (${mcp[1]})`, shape: "zyvro", detail: "" };
      }
      return { running: `Running ${name}`, done: `Ran ${name}`, shape: "other", detail: "" };
    }
  }
}
function planIn(input) {
  const args = input && typeof input === "object" ? input : {};
  const todos = args.todos;
  if (!Array.isArray(todos)) return [];
  return todos.map((todo) => {
    const item = todo && typeof todo === "object" ? todo : {};
    return { title: str$1(item.content) || str$1(item.title), status: str$1(item.status) || "pending" };
  }).filter((item) => item.title !== "");
}
const MAX_OUTPUT = 4e3;
function outputIn(content) {
  let text2;
  if (typeof content === "string") text2 = content;
  else if (Array.isArray(content)) {
    text2 = content.map((block) => {
      const b = block && typeof block === "object" ? block : {};
      return str$1(b.text);
    }).filter(Boolean).join("\n");
  } else text2 = "";
  const trimmed = text2.trimEnd();
  if (trimmed.length <= MAX_OUTPUT) return trimmed;
  return `${trimmed.slice(0, MAX_OUTPUT)}
…(${trimmed.length - MAX_OUTPUT} more characters)`;
}
const PERMISSIONS = ["read", "ask", "project", "yolo"];
const DEFAULT_PERMISSION = "project";
const PERMISSION_TOOL = "mcp__zyvro-app__zyvro_permission";
function preamble(ctx) {
  const lines = [
    `You are the Zyvro Studio assistant, working inside the project at ${ctx.projectDir}.`,
    "Zyvro workflows are visual AI graphs stored in .zyvro/workflows/ as JSON."
  ];
  if (ctx.workflows.length === 0) {
    lines.push("This project has no workflows yet.");
  } else {
    lines.push(
      "This project defines these workflows:",
      ...ctx.workflows.map(
        (w) => `- ${w.name} (id ${w.id})${w.description ? `: ${w.description}` : ""}`
      )
    );
  }
  if (mcpAvailable(ctx)) {
    lines.push(
      "",
      "You have the Zyvro tools for this project. Use them rather than reading the",
      "JSON by hand: zyvro_list_workflows, zyvro_workflow_graph, zyvro_run_workflow,",
      "zyvro_execution_status, zyvro_get_output, zyvro_list_executions.",
      "Running a workflow spends the user's own model account, so run one when the",
      "user asks for it, not to satisfy your own curiosity about what it does."
    );
  }
  return lines.join("\n");
}
function claudeMcpConfig(ctx) {
  return writeMcpConfig(ctx);
}
function argsFor(kind, ctx, resume, model = null, images = []) {
  const pinned = model?.trim() ? model.trim() : null;
  if (kind === "claude") {
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      // Ce que l'agent a le droit de faire, dit à claude.
      //
      // Un tour en mode impression ne peut poser aucune question : sans ça, la
      // CLI demande la permission d'écrire, personne ne peut répondre, et
      // l'agent rend « you haven't granted it yet » pour un fichier du dossier
      // qu'on vient de lui ouvrir.
      // La question ne peut remonter que si le serveur MCP de l'application
      // tourne : c'est lui qui sert l'outil de permission. Sans lui, mieux vaut
      // refuser tout de suite que laisser l'agent attendre une réponse qui
      // n'arrivera pas.
      ...claudePermission(ctx.permission ?? DEFAULT_PERMISSION, Boolean(shotsEndpoint())),
      "--append-system-prompt",
      preamble(ctx),
      ...pinned ? ["--model", pinned] : [],
      ...resume ? ["--resume", resume] : [],
      // claude has no image flag: it reads an image by path with its Read tool,
      // so the paths go in the prompt — see promptWith. But its tools are
      // confined to the working directory, and the attachments live beside the
      // conversation, outside the project. Without this the agent answers "la
      // permission a été refusée" for a file it was just handed, which is
      // exactly what it did the first time this was run.
      //
      // Only the directories the images are actually in, and only when there
      // are images: widening tool access for a turn that does not need it
      // would be paying for a feature nobody used.
      ...images.length > 0 ? ["--add-dir", ...directoriesOf(images)] : []
    ];
  }
  return [
    "exec",
    ...resume ? ["resume"] : [],
    "--json",
    "--skip-git-repo-check",
    // Le pendant côté codex, dans son vocabulaire à lui : un bac à sable.
    ...codexPermission(ctx.permission ?? DEFAULT_PERMISSION),
    ...pinned ? ["--model", pinned] : [],
    // -i takes one path per occurrence. Several paths after a single -i would
    // be swallowed as one argument by some shells and as the prompt by codex.
    ...images.flatMap((file2) => ["-i", file2]),
    ...resume ? [resume] : []
  ];
}
function claudePermission(permission, canAsk = true) {
  switch (permission) {
    case "read":
      return [
        "--disallowedTools",
        "Write,Edit,MultiEdit,NotebookEdit,Bash",
        "--permission-mode",
        "manual",
        "--permission-prompts",
        "none"
      ];
    case "yolo":
      return ["--dangerously-skip-permissions"];
    case "project":
      return ["--permission-mode", "bypassPermissions"];
    default:
      return ["--permission-mode", "manual", ...canAsk ? askFlags() : ["--permission-prompts", "none"]];
  }
}
function askFlags() {
  return ["--permission-prompts", "host", "--permission-prompt-tool", PERMISSION_TOOL];
}
function codexPermission(permission) {
  switch (permission) {
    case "read":
      return ["--sandbox", "read-only"];
    case "yolo":
      return ["--dangerously-bypass-approvals-and-sandbox"];
    default:
      return ["--sandbox", "workspace-write"];
  }
}
function directoriesOf(files) {
  return [...new Set(files.map((file2) => path.dirname(file2)))];
}
function promptWith(kind, prompt, images) {
  if (kind !== "claude" || images.length === 0) return prompt;
  const listed = images.map((file2) => `- ${file2}`).join("\n");
  return `${prompt}

The user attached ${images.length === 1 ? "this image" : "these images"}. Read ${images.length === 1 ? "it" : "them"} with the Read tool before answering:
${listed}`;
}
function modelIn(event) {
  const value = event.model;
  if (typeof value === "string" && value.trim()) return value.trim();
  const usage = event.modelUsage;
  if (usage && typeof usage === "object") {
    const [first] = Object.keys(usage);
    if (first) return first;
  }
  return null;
}
function aliasesFrom(help) {
  const sentence = /alias[^.]*?\(e\.g\.([^)]*)\)/is.exec(help);
  if (!sentence) return [];
  return [...sentence[1].matchAll(/'([a-z0-9][a-z0-9.-]*)'/gi)].map((m) => m[1]);
}
function sessionIn(event) {
  const value = event.session_id ?? event.thread_id;
  return typeof value === "string" && value ? value : null;
}
class AgentRunner {
  turns = /* @__PURE__ */ new Map();
  // The CLI's own id for each conversation, learned from its output stream.
  //
  // This is what makes the agent remember. Without it every message opened a
  // fresh process that knew nothing of the one before: the panel showed a
  // conversation, and the CLI was answering a series of unrelated questions.
  // "Add a function" then "now the tests" got a puzzled answer about tests in
  // general, and nothing in the window explained why.
  //
  // Held here and handed back to the caller, which is what writes it down: this
  // class knows how to talk to a CLI and should not also own a file.
  sessions = /* @__PURE__ */ new Map();
  // sessionFor is what the panel's persistence reads after a turn.
  sessionFor(conversationId) {
    return this.sessions.get(conversationId) ?? null;
  }
  // resumeAt seeds a session learned in a previous run of the app, so a
  // conversation reopened tomorrow carries on rather than starting over.
  resumeAt(conversationId, sessionId) {
    if (sessionId) this.sessions.set(conversationId, sessionId);
    else this.sessions.delete(conversationId);
  }
  available(kind) {
    return kind === "codex" ? "codex" : "claude";
  }
  // installed is what the panel asks before offering the agent at all, and it
  // asks cli.ts rather than the PATH directly: on Windows the thing called
  // `claude` is `claude.cmd`, and a check that only looked for `claude` would
  // report it missing on a machine where it works.
  installed(kind) {
    return installed(this.available(kind));
  }
  // send starts one turn and streams it back.
  //
  // Each turn is still a fresh process — `claude -p` and `codex exec` are
  // one-shot by design — but it is no longer a fresh conversation: both CLIs
  // can pick up a previous session by id, and that id is what turns a row of
  // separate questions into a thread.
  send(target, kind, prompt, ctx, conversationId, model = null, images = []) {
    const id = node_crypto.randomUUID();
    const resume = this.sessions.get(conversationId);
    const bin = this.available(kind);
    const env = { ...process.env };
    let disposeConfig = null;
    const args = argsFor(kind, ctx, resume ?? null, model, images);
    if (mcpAvailable(ctx)) {
      if (kind === "claude") {
        const config = claudeMcpConfig(ctx);
        disposeConfig = config.dispose;
        args.push(
          "--mcp-config",
          config.path,
          // Only this project's server. Without it the user's own MCP servers
          // would also load into the panel, which is a surprise nobody asked
          // for and a different set of tools on every machine.
          "--strict-mcp-config",
          // A print-mode run cannot prompt for permission, so the Zyvro tools
          // are pre-approved. Nothing else is: the CLI's own file and shell
          // tools keep whatever policy the user configured.
          "--allowedTools",
          // La capture est pré-accordée comme le reste : elle ne peut voir que
          // la fenêtre de l'application, et un tour en mode impression ne peut
          // demander la permission à personne.
          // Les serveurs réellement déclarés dans le fichier, et eux seuls :
          // pré-accorder un outil absent ne coûte rien, mais en oublier un
          // rendrait « permission refusée » pour un outil qu'on vient d'offrir.
          Object.keys(mcpServers(ctx)).map((name) => `mcp__${name}`).join(",")
        );
      } else {
        Object.assign(env, mcpTokenEnv(ctx));
        args.push(...codexMcpArgs(ctx));
      }
    }
    if (kind === "codex") args.push("-");
    const withImages = promptWith(kind, prompt, images);
    const text2 = kind === "codex" ? `${preamble(ctx)}

---

${withImages}` : withImages;
    const child = launchPiped(bin, args, { cwd: ctx.projectDir, env });
    this.turns.set(id, { id, conversationId, child, sentText: false });
    child.stdin.write(text2);
    child.stdin.end();
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.emitEvent(target, id, kind, line);
        index = buffer.indexOf("\n");
      }
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 4e3) stderr = stderr.slice(-4e3);
    });
    child.on("error", (err) => {
      this.turns.delete(id);
      disposeConfig?.();
      disposeConfig = null;
      const detail = err.code === "ENOENT" ? `"${bin}" is not on your PATH. Install it and sign in, then reopen this panel.` : err.message;
      if (!target.isDestroyed()) target.send("agent:error", { id, message: detail });
    });
    child.on("exit", (code) => {
      this.turns.delete(id);
      disposeConfig?.();
      disposeConfig = null;
      if (target.isDestroyed()) return;
      if (buffer.trim()) this.emitEvent(target, id, kind, buffer.trim());
      if (code !== 0) {
        target.send("agent:error", { id, message: stderr.trim() || `${bin} exited with code ${code}` });
        return;
      }
      target.send("agent:done", { id });
    });
    return id;
  }
  // emitEvent normalizes the two CLIs' stream formats into one shape. Neither
  // format is contractual, so anything unrecognized is forwarded as raw text
  // rather than dropped: a silent panel is worse than an ugly one.
  emitEvent(target, id, kind, line) {
    if (target.isDestroyed()) return;
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      target.send("agent:text", { id, text: line });
      return;
    }
    const turn = this.turns.get(id);
    const ranWith = modelIn(parsed);
    if (turn && ranWith) target.send("agent:model", { id, conversationId: turn.conversationId, model: ranWith });
    const learned = sessionIn(parsed);
    if (turn && learned) {
      if (this.sessions.get(turn.conversationId) !== learned) {
        this.sessions.set(turn.conversationId, learned);
        target.send("agent:session", { id, conversationId: turn.conversationId, sessionId: learned });
      }
    }
    const send2 = (text2) => {
      if (!text2) return;
      const separator = turn?.sentText ? "\n\n" : "";
      if (turn) turn.sentText = true;
      target.send("agent:text", { id, text: separator + text2 });
    };
    const started = (callId, name, input) => {
      const talk = describeTool(name, input);
      target.send("agent:tool", {
        id,
        callId,
        name,
        running: talk.running,
        done: talk.done,
        shape: talk.shape,
        detail: talk.detail,
        plan: talk.shape === "plan" ? planIn(input) : []
      });
    };
    const finished = (callId, content, isError) => target.send("agent:tool-result", { id, callId, output: outputIn(content), isError });
    if (kind === "claude") {
      const type = parsed.type;
      if (type === "assistant") {
        const message = parsed.message;
        for (const block of message?.content ?? []) {
          const b = block;
          if (b.type === "text" && b.text) send2(b.text);
          if (b.type === "tool_use" && b.name) started(b.id ?? b.name, b.name, b.input);
        }
        return;
      }
      if (type === "user") {
        const message = parsed.message;
        for (const block of message?.content ?? []) {
          const b = block;
          if (b.type === "tool_result" && b.tool_use_id) {
            finished(b.tool_use_id, b.content, Boolean(b.is_error));
          }
        }
        return;
      }
      if (type === "result") {
        const result = parsed.result;
        if (parsed.is_error && typeof result === "string") {
          target.send("agent:error", { id, message: result });
        }
        return;
      }
      return;
    }
    const codexItem = parsed.item;
    if (parsed.type === "item.started" && codexItem?.type === "command_execution") {
      started(codexItem.id ?? "codex", "Bash", { command: codexItem.command });
      return;
    }
    if (parsed.type === "item.completed" && codexItem?.type === "command_execution") {
      finished(codexItem.id ?? "codex", codexItem.output, false);
      return;
    }
    const item = parsed.item;
    if (parsed.type === "item.completed" && item?.type === "agent_message" && item.text) {
      send2(item.text);
      return;
    }
    const msg = parsed.msg;
    if (msg?.type === "agent_message" && msg.message) {
      send2(msg.message);
      return;
    }
    if (typeof parsed.last_agent_message === "string") send2(parsed.last_agent_message);
  }
  cancel(id) {
    const turn = this.turns.get(id);
    if (!turn) return;
    this.turns.delete(id);
    turn.child.kill();
  }
  cancelAll() {
    for (const id of [...this.turns.keys()]) this.cancel(id);
  }
}
const HIDDEN = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".next",
  ".DS_Store",
  "out",
  "dist",
  "__pycache__",
  ".venv",
  "vendor"
]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
class PathOutsideProject extends Error {
  constructor(relative) {
    super(`Refused to access "${relative}": it is outside the open project.`);
  }
}
async function resolveInside(root, relative) {
  const rootReal = await fs$1.realpath(root);
  const target = path.resolve(rootReal, relative);
  const rel = path.relative(rootReal, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new PathOutsideProject(relative);
  let probe = target;
  for (; ; ) {
    try {
      const real = await fs$1.realpath(probe);
      const realRel = path.relative(rootReal, real);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) throw new PathOutsideProject(relative);
      break;
    } catch (err) {
      if (err instanceof PathOutsideProject) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return target;
}
function toRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}
async function listDir(root, relative) {
  const dir = await resolveInside(root, relative || ".");
  const rootReal = await fs$1.realpath(root);
  const entries = await fs$1.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (HIDDEN.has(entry.name)) continue;
    out.push({
      name: entry.name,
      path: toRelative(rootReal, path.join(dir, entry.name)),
      kind: entry.isDirectory() ? "directory" : "file"
    });
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, void 0, { sensitivity: "base" });
  });
  return out;
}
async function readFile(root, relative) {
  const file2 = await resolveInside(root, relative);
  const stat = await fs$1.stat(file2);
  if (stat.size > MAX_TEXT_BYTES) return { path: relative, binary: true };
  const buffer = await fs$1.readFile(file2);
  if (buffer.subarray(0, 8e3).includes(0)) return { path: relative, binary: true };
  return { path: relative, text: buffer.toString("utf8"), truncated: false };
}
async function writeFile(root, relative, text2) {
  const file2 = await resolveInside(root, relative);
  await fs$1.mkdir(path.dirname(file2), { recursive: true });
  const temp = `${file2}.zyvro-tmp`;
  await fs$1.writeFile(temp, text2, "utf8");
  await fs$1.rename(temp, file2);
}
async function createEntry(root, relative, kind) {
  const target = await resolveInside(root, relative);
  if (kind === "directory") {
    await fs$1.mkdir(target, { recursive: true });
    return;
  }
  await fs$1.mkdir(path.dirname(target), { recursive: true });
  const handle2 = await fs$1.open(target, "wx");
  await handle2.close();
}
async function renameEntry(root, from, to) {
  const source = await resolveInside(root, from);
  const target = await resolveInside(root, to);
  await fs$1.mkdir(path.dirname(target), { recursive: true });
  await fs$1.rename(source, target);
}
async function deleteEntry(root, relative) {
  const target = await resolveInside(root, relative);
  const rootReal = await fs$1.realpath(root);
  if (target === rootReal) throw new Error("Refused to delete the project root.");
  await fs$1.rm(target, { recursive: true, force: true });
}
const MAX_MATCHES = 2e3;
const MAX_PER_FILE = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 400;
class BadPattern extends Error {
}
function matcherFor(query2) {
  const raw = query2.query;
  if (raw === "") throw new BadPattern("Type something to search for.");
  let source = query2.regex ? raw : raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (query2.wholeWord) {
    const wordish = /^[\w$]/.test(query2.regex ? raw.replace(/^\\[bB]/, "") : raw);
    if (wordish) source = `\\b${source}\\b`;
  }
  try {
    return new RegExp(source, query2.matchCase ? "g" : "gi");
  } catch (err) {
    throw new BadPattern(`That is not a valid regular expression: ${err.message}`);
  }
}
function globToRegExp(pattern) {
  const trimmed = pattern.trim();
  let body = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "*") {
      if (trimmed[i + 1] === "*") {
        i++;
        if (trimmed[i + 1] === "/") {
          i++;
          body += "(?:.*/)?";
        } else {
          body += ".*";
        }
      } else {
        body += "[^/]*";
      }
    } else if (ch === "?") {
      body += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      body += `\\${ch}`;
    } else {
      body += ch;
    }
  }
  const anchored = trimmed.includes("/") ? `^${body}$` : `(?:^|/)${body}$`;
  return new RegExp(anchored, "i");
}
function listOf(patterns) {
  return (patterns ?? "").split(",").map((p) => p.trim()).filter(Boolean).map(globToRegExp);
}
function wanted(relative, include, exclude) {
  if (exclude.some((r) => r.test(relative))) return false;
  return include.length === 0 || include.some((r) => r.test(relative));
}
function looksBinary(buffer) {
  const end = Math.min(buffer.length, 8192);
  for (let i = 0; i < end; i++) if (buffer[i] === 0) return true;
  return false;
}
async function* walk(root, relative = "") {
  let entries;
  try {
    entries = await fs$1.readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (HIDDEN.has(entry.name)) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(root, child);
    else if (entry.isFile()) yield child;
  }
}
async function search(root, query2) {
  const matcher = matcherFor(query2);
  const include = listOf(query2.include);
  const exclude = listOf(query2.exclude);
  const files = [];
  let matches = 0;
  let truncated = false;
  for await (const relative of walk(root)) {
    if (matches >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    if (!wanted(relative, include, exclude)) continue;
    const full = path.join(root, relative);
    let buffer;
    try {
      const info = await fs$1.stat(full);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      buffer = await fs$1.readFile(full);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;
    const hits = [];
    const lines = buffer.toString("utf8").split("\n");
    for (let i = 0; i < lines.length && hits.length < MAX_PER_FILE; i++) {
      const line = lines[i].replace(/\r$/, "");
      matcher.lastIndex = 0;
      for (let found = matcher.exec(line); found; found = matcher.exec(line)) {
        hits.push({
          line: i,
          column: found.index,
          length: found[0].length,
          text: line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line
        });
        if (found[0] === "") matcher.lastIndex++;
        if (hits.length >= MAX_PER_FILE) break;
      }
    }
    if (hits.length === 0) continue;
    files.push({ path: relative, matches: hits });
    matches += hits.length;
  }
  return { files, matches, truncated };
}
async function replaceAll(root, query2, replacement, targets) {
  const matcher = matcherFor(query2);
  const chosen = /* @__PURE__ */ new Map();
  if (targets) {
    for (const target of targets) {
      chosen.set(target.path, [...chosen.get(target.path) ?? [], target]);
    }
  }
  const found = targets ? [...chosen.keys()] : (await search(root, query2)).files.map((f) => f.path);
  let files = 0;
  let matches = 0;
  let skipped = 0;
  for (const relative of found) {
    const full = await resolveInside(root, relative);
    let text2;
    try {
      text2 = await fs$1.readFile(full, "utf8");
    } catch {
      skipped += chosen.get(relative)?.length ?? 1;
      continue;
    }
    const lines = text2.split("\n");
    let touched = 0;
    const wanted2 = chosen.get(relative);
    if (wanted2) {
      for (const target of [...wanted2].sort((a, b) => b.line - a.line || b.column - a.column)) {
        const line = lines[target.line];
        if (line === void 0) {
          skipped++;
          continue;
        }
        const bare = line.replace(/\r$/, "");
        matcher.lastIndex = target.column;
        const found2 = matcher.exec(bare);
        if (!found2 || found2.index !== target.column || found2[0].length !== target.length) {
          skipped++;
          continue;
        }
        const carriage = line.endsWith("\r") ? "\r" : "";
        lines[target.line] = bare.slice(0, target.column) + expand(found2, replacement, query2) + bare.slice(target.column + target.length) + carriage;
        touched++;
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        const carriage = lines[i].endsWith("\r") ? "\r" : "";
        const bare = lines[i].replace(/\r$/, "");
        matcher.lastIndex = 0;
        if (!matcher.test(bare)) continue;
        matcher.lastIndex = 0;
        let count = 0;
        const next = bare.replace(matcher, (...args) => {
          count++;
          return expand(args, replacement, query2);
        });
        lines[i] = next + carriage;
        touched += count;
      }
    }
    if (touched === 0) continue;
    await fs$1.writeFile(full, lines.join("\n"), "utf8");
    files++;
    matches += touched;
  }
  return { files, matches, skipped };
}
function expand(found, replacement, query2) {
  if (!query2.regex) return replacement;
  return replacement.replace(/\$(\d{1,2}|&|\$)/g, (whole, token) => {
    if (token === "$") return "$";
    if (token === "&") return found[0];
    const group = found[Number(token)];
    return group === void 0 ? whole : group;
  });
}
const MAX = 12;
function storeFile() {
  return path.join(electron.app.getPath("userData"), "recent-projects.json");
}
function loadRecents() {
  try {
    const raw = fs.readFileSync(storeFile(), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry?.path && fs.existsSync(entry.path)).slice(0, MAX);
  } catch {
    return [];
  }
}
function save$1(recents) {
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify(recents, null, 2), "utf8");
  } catch {
  }
}
function rememberRecent(dir) {
  const entry = { path: dir, name: path.basename(dir), openedAt: (/* @__PURE__ */ new Date()).toISOString() };
  const next = [entry, ...loadRecents().filter((r) => r.path !== dir)].slice(0, MAX);
  save$1(next);
  electron.app.addRecentDocument(dir);
  return next;
}
function forgetRecents() {
  save$1([]);
  electron.app.clearRecentDocuments();
  return [];
}
const encoder = new TextEncoder();
async function pbkdf2(secret, salt, iterations) {
  const raw = typeof secret === "string" ? encoder.encode(secret) : new Uint8Array(secret);
  const material = await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations },
    material,
    256
  );
}
async function deriveMasterKey(password, params) {
  return pbkdf2(password, params.kdf_salt, params.kdf_iterations);
}
async function deriveAuthHash(password, params) {
  const master = await deriveMasterKey(password, params);
  return Buffer.from(await pbkdf2(master, password, 1)).toString("base64");
}
const DEFAULT_ORIGIN = "https://server.zyv.ro";
const CURRENT_KDF_VERSION = 1;
function storeOrigin() {
  return process.env.ZYVRO_STORE_ORIGIN || DEFAULT_ORIGIN;
}
function credentialFile() {
  return path.join(electron.app.getPath("userData"), "account.json");
}
let cached;
async function read$2() {
  if (cached !== void 0) return cached;
  try {
    const raw = await fs$1.readFile(credentialFile(), "utf8");
    const parsed = JSON.parse(raw);
    cached = parsed?.key && parsed.origin === storeOrigin() ? parsed : null;
  } catch {
    cached = null;
  }
  return cached;
}
async function write(value) {
  cached = value;
  const file2 = credentialFile();
  if (!value) {
    await fs$1.rm(file2, { force: true });
    return;
  }
  await fs$1.mkdir(path.dirname(file2), { recursive: true });
  const temp = `${file2}.partial`;
  await fs$1.writeFile(temp, JSON.stringify(value, null, 2), { mode: 384 });
  await fs$1.rename(temp, file2);
}
class StoreError extends Error {
  status;
  constructor(message, status2 = 0) {
    super(message);
    this.status = status2;
  }
}
async function call(pathname, init2 = {}, key) {
  return (await callWithResponse(pathname, init2, key)).body;
}
async function callWithResponse(pathname, init2 = {}, key) {
  const headers = new Headers(init2.headers);
  if (!(init2.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (key) headers.set("Authorization", `Bearer ${key}`);
  let response;
  try {
    response = await fetch(`${storeOrigin()}${pathname}`, { ...init2, headers, redirect: "error" });
  } catch (err) {
    throw new StoreError(`Could not reach ${storeOrigin()}: ${err.message}`);
  }
  const text2 = await response.text();
  const body = text2 ? JSON.parse(text2) : {};
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
    throw new StoreError(message, response.status);
  }
  return { body, setCookie: response.headers.get("set-cookie") };
}
async function signIn(email, password) {
  const params = await kdfParamsFor(email);
  const payload = params.kdf_version === 0 ? {
    email,
    password,
    kdf_version: CURRENT_KDF_VERSION,
    upgrade_hash: await deriveAuthHash(password, { ...params })
  } : { email, password: await deriveAuthHash(password, params), kdf_version: params.kdf_version };
  const { body, setCookie } = await callWithResponse("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const login = body;
  const cookieless = await mintKey(setCookie);
  const account = { id: login.id, email: login.email, name: login.name };
  await write({ origin: storeOrigin(), key: cookieless, account });
  return account;
}
async function mintKey(setCookie) {
  if (!setCookie) {
    throw new StoreError("The server signed this account in but issued no session, so no key could be made.");
  }
  const cookie = setCookie.split(";", 1)[0];
  const created = await call("/api/keys", {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({ name: `Zyvro Studio on ${hostLabel()}` })
  });
  const key = created.key || created.token;
  if (!key) throw new StoreError("The server did not return an API key for this app.");
  return key;
}
function hostLabel() {
  return `${process.platform}-${process.arch}`;
}
async function currentAccount() {
  return (await read$2())?.account ?? null;
}
async function signOut() {
  await write(null);
}
async function authorized(pathname, init2 = {}) {
  const stored = await read$2();
  if (!stored) throw new StoreError("Sign in to publish to the store.", 401);
  try {
    return await call(pathname, init2, stored.key);
  } catch (err) {
    if (err instanceof StoreError && err.status === 401) await write(null);
    throw err;
  }
}
async function anonymous(pathname) {
  return call(pathname);
}
async function kdfParamsFor(email) {
  return await call("/api/auth/prelogin", {
    method: "POST",
    body: JSON.stringify({ email })
  });
}
function webOrigin() {
  const override = process.env.ZYVRO_WEB_ORIGIN;
  if (override) return override.replace(/\/+$/, "");
  const api = storeOrigin().replace(/\/+$/, "");
  return api.replace(/^(https?:\/\/)server\./, "$1");
}
const KEY_INFO = "zyvro-vault-v1";
async function vaultKey(password, params) {
  const master = await deriveMasterKey(password, params);
  const hkdf = await node_crypto.webcrypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);
  return node_crypto.webcrypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(KEY_INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function generateIdentity(password, params) {
  const { publicKey, privateKey } = node_crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    // The raw 32 bytes, not the DER wrapper: that is what Ed25519 verification
    // takes on the other side, and what the server stores.
    publicKey: spki.subarray(spki.length - 32).toString("base64"),
    wrappedPrivateKey: await seal(pkcs8, password, params),
    kdfVersion: params.kdf_version
  };
}
async function seal(plain, password, params) {
  const key = await vaultKey(password, params);
  const iv = node_crypto.randomBytes(12);
  const ciphertext = await node_crypto.webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return Buffer.concat([iv, Buffer.from(ciphertext)]).toString("base64");
}
async function unseal(wrapped, password, params) {
  const raw = Buffer.from(wrapped, "base64");
  const key = await vaultKey(password, params);
  try {
    const plain = await node_crypto.webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.subarray(0, 12) },
      key,
      raw.subarray(12)
    );
    return Buffer.from(plain);
  } catch {
    throw new Error("That password does not open this signing key.");
  }
}
async function signDigest(digest, sealed, password, params) {
  const pkcs8 = await unseal(sealed.wrappedPrivateKey, password, params);
  const key = node_crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return node_crypto.sign(null, Buffer.from(digest), key).toString("base64");
}
function verifyDigest(digest, signature, publicKey) {
  try {
    const raw = Buffer.from(publicKey, "base64");
    if (raw.length !== 32) return false;
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const key = node_crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    return node_crypto.verify(null, Buffer.from(digest), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
function fingerprint(publicKey) {
  const hash = node_crypto.createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
  return hash.slice(0, 16).replace(/(.{4})(?=.)/g, "$1-");
}
function file() {
  return path.join(electron.app.getPath("userData"), "known-publishers.json");
}
async function read$1() {
  try {
    return JSON.parse(await fs$1.readFile(file(), "utf8"));
  } catch {
    return {};
  }
}
async function judge(publisherName, publicKey, signed) {
  if (!signed || !publicKey) return { kind: "unsigned" };
  const known = (await read$1())[publisherName];
  if (!known) return { kind: "first-sight", fingerprint: fingerprint(publicKey) };
  if (known.publicKey === publicKey) return { kind: "known", fingerprint: fingerprint(publicKey) };
  return {
    kind: "changed",
    knownFingerprint: fingerprint(known.publicKey),
    offeredFingerprint: fingerprint(publicKey),
    firstSeen: known.firstSeen
  };
}
async function remember$1(publisherName, publicKey) {
  const all = await read$1();
  if (all[publisherName]) return;
  all[publisherName] = { name: publisherName, publicKey, firstSeen: (/* @__PURE__ */ new Date()).toISOString() };
  await fs$1.mkdir(path.dirname(file()), { recursive: true });
  await fs$1.writeFile(file(), JSON.stringify(all, null, 2), "utf8");
}
const PACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SOURCE_NAME = /^[A-Za-z0-9_-]{1,64}\.lua$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,32})?$/;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_SOURCES = 64;
function packDigest(name, version, sources) {
  const field = (value) => {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from(`${bytes.length}
`, "ascii"), bytes, Buffer.from("\n", "ascii")]);
  };
  const names = Object.keys(sources).sort(
    (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
  );
  const parts = [
    Buffer.from("zyvro-pack-digest-v1\n", "ascii"),
    field(name),
    field(version),
    Buffer.from(`${names.length}
`, "ascii")
  ];
  for (const file2 of names) {
    parts.push(field(file2), field(sources[file2]));
  }
  return node_crypto.createHash("sha256").update(Buffer.concat(parts)).digest("hex");
}
function sourceMap(sources, pack) {
  const out = {};
  for (const source of sources ?? []) {
    if (typeof source?.path !== "string" || typeof source?.code !== "string") {
      throw new StoreError(`The pack "${pack}" contains a malformed source entry.`);
    }
    if (source.path in out) {
      throw new StoreError(`The pack "${pack}" lists "${source.path}" twice.`);
    }
    out[source.path] = source.code;
  }
  return out;
}
async function vetPublisher(pack) {
  const publisher = pack.publisher_name || pack.author || pack.name;
  const verdict = await judge(publisher, pack.publisher_key, Boolean(pack.signature));
  if (verdict.kind === "changed") {
    throw new StoreError(
      `${publisher} signed this pack with a key you have not seen before. You first installed from them on ${verdict.firstSeen.slice(0, 10)} with key ${verdict.knownFingerprint}, and this one is ${verdict.offeredFingerprint}. That is either a key they replaced or somebody else using their name. Refusing to install it until you say which.`
    );
  }
  if (verdict.kind === "first-sight" && pack.publisher_key) {
    await remember$1(publisher, pack.publisher_key);
  }
  return verdict;
}
function query(params) {
  const search2 = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0 && value !== "") search2.set(key, String(value));
  }
  const text2 = search2.toString();
  return text2 ? `?${text2}` : "";
}
async function listNodes(q = "", limit2 = 50) {
  const body = await anonymous(`/api/store/nodes${query({ q, limit: limit2 })}`);
  return Array.isArray(body?.packs) ? body.packs : [];
}
async function listWorkflows(q = "", limit2 = 50) {
  const body = await anonymous(`/api/store/workflows${query({ q, limit: limit2 })}`);
  return (body?.workflows ?? body?.templates ?? []).map(withAbsolutePreview);
}
function withAbsolutePreview(workflow) {
  const preview = workflow.preview;
  if (!preview) return workflow;
  const absolute = (path2) => !path2 || /^(https?:|data:)/.test(path2) ? path2 : `${storeOrigin()}${path2.startsWith("/") ? "" : "/"}${path2}`;
  return {
    ...workflow,
    preview: { ...preview, input_image: absolute(preview.input_image), output_image: absolute(preview.output_image) }
  };
}
async function readPack(name, version) {
  assertName(name);
  if (version) assertVersion(version);
  const suffix = version ? `/${encodeURIComponent(version)}` : "";
  const body = await anonymous(`/api/store/nodes/${encodeURIComponent(name)}${suffix}`);
  if (body && typeof body === "object" && "pack" in body) {
    if (body.warning) console.warn(`store: ${body.warning}`);
    return body.pack;
  }
  return body;
}
function assertName(name) {
  if (!PACK_NAME.test(name)) throw new StoreError(`"${name}" is not a valid pack name.`);
}
function assertVersion(version) {
  if (!VERSION.test(version)) throw new StoreError(`"${version}" is not a valid version.`);
}
async function writePack(projectDir, pack) {
  assertName(pack.name);
  assertVersion(pack.version);
  const sources = sourceMap(pack.sources, pack.name);
  if (pack.digest) {
    const computed = packDigest(pack.name, pack.version, sources);
    if (computed !== pack.digest.toLowerCase()) {
      throw new StoreError(
        `The content of ${pack.name}@${pack.version} does not match the digest the store published for it. Refusing to install it.`
      );
    }
    if (pack.signature && pack.publisher_key) {
      if (!verifyDigest(pack.digest.toLowerCase(), pack.signature, pack.publisher_key)) {
        throw new StoreError(
          `The signature on ${pack.name}@${pack.version} does not match its content and the key it names. Refusing to install it.`
        );
      }
    }
  }
  const names = Object.keys(sources);
  if (names.length === 0) throw new StoreError(`The pack "${pack.name}" carries no nodes.`);
  if (names.length > MAX_SOURCES) {
    throw new StoreError(`The pack "${pack.name}" declares ${names.length} files; the limit is ${MAX_SOURCES}.`);
  }
  for (const name of names) {
    if (!SOURCE_NAME.test(name)) {
      throw new StoreError(`The pack "${pack.name}" contains a file named "${name}", which is refused.`);
    }
    const size = Buffer.byteLength(sources[name], "utf8");
    if (size > MAX_SOURCE_BYTES) {
      throw new StoreError(`"${name}" is ${size} bytes; the limit is ${MAX_SOURCE_BYTES}.`);
    }
  }
  const root = await fs$1.realpath(projectDir);
  const dir = path.join(root, ".zyvro", "packs", pack.name);
  const packsRoot = path.join(root, ".zyvro", "packs");
  if (path.relative(packsRoot, dir).startsWith("..")) {
    throw new StoreError(`Refused to install "${pack.name}" outside the packs folder.`);
  }
  await fs$1.rm(dir, { recursive: true, force: true });
  await fs$1.mkdir(path.join(dir, "nodes"), { recursive: true });
  await fs$1.writeFile(
    path.join(dir, "zyvro-pack.json"),
    JSON.stringify({ ...pack.manifest, name: pack.name, version: pack.version }, null, 2),
    "utf8"
  );
  for (const [name, source] of Object.entries(sources)) {
    await fs$1.writeFile(path.join(dir, "nodes", name), source, "utf8");
  }
}
async function installPack(projectDir, name, version) {
  const pack = await readPack(name, version);
  const verdict = await vetPublisher(pack);
  await writePack(projectDir, pack);
  return {
    packs: [{ name: pack.name, version: pack.version }],
    publishers: [{ pack: pack.name, publisher: pack.publisher_name || pack.author, verdict }]
  };
}
async function installWorkflow(projectDir, name) {
  const body = await anonymous(`/api/store/workflows/${encodeURIComponent(name)}`);
  if (!body?.template) throw new StoreError(`The store returned no workflow named "${name}".`);
  if (body.installable === false) {
    const named = (body.problems ?? []).join("; ");
    throw new StoreError(named || `This workflow cannot be installed.`);
  }
  const packs = [];
  for (const dep of body.packs ?? []) {
    if (!dep.pack) {
      throw new StoreError(`This workflow needs ${dep.name}@${dep.version}, which the store did not send.`);
    }
    packs.push(dep.pack);
  }
  const publishers = [];
  for (const pack of packs) {
    assertName(pack.name);
    assertVersion(pack.version);
    publishers.push({
      pack: pack.name,
      publisher: pack.publisher_name || pack.author,
      verdict: await vetPublisher(pack)
    });
  }
  for (const pack of packs) await writePack(projectDir, pack);
  return {
    workflow: body.template.name,
    packs: packs.map((p) => ({ name: p.name, version: p.version })),
    publishers
  };
}
async function listInstalledPacks(projectDir) {
  const root = await fs$1.realpath(projectDir);
  const packsRoot = path.join(root, ".zyvro", "packs");
  let entries;
  try {
    entries = await fs$1.readdir(packsRoot);
  } catch {
    return [];
  }
  const packs = [];
  for (const name of entries) {
    if (!PACK_NAME.test(name)) continue;
    try {
      packs.push(await readInstalledPack(root, name));
    } catch {
    }
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name));
}
async function readInstalledPack(projectDir, name) {
  assertName(name);
  const root = await fs$1.realpath(projectDir);
  const dir = path.join(root, ".zyvro", "packs", name);
  const manifest = JSON.parse(await fs$1.readFile(path.join(dir, "zyvro-pack.json"), "utf8"));
  const nodesDir = path.join(dir, "nodes");
  const files = (await fs$1.readdir(nodesDir)).filter((f) => SOURCE_NAME.test(f)).sort();
  const sources = [];
  for (const file2 of files) {
    sources.push({ path: file2, code: await fs$1.readFile(path.join(nodesDir, file2), "utf8") });
  }
  return {
    name,
    version: String(manifest.version ?? "0.0.0"),
    description: String(manifest.description ?? ""),
    author: String(manifest.author ?? ""),
    capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
    sources
  };
}
async function publishPack(projectDir, name, password) {
  const pack = await readInstalledPack(projectDir, name);
  const sources = sourceMap(pack.sources, pack.name);
  const digest = packDigest(pack.name, pack.version, sources);
  const signature = await signAs(digest, password);
  return authorized("/api/store/nodes", {
    method: "POST",
    body: JSON.stringify({
      name: pack.name,
      version: pack.version,
      description: pack.description,
      author: pack.author,
      capabilities: pack.capabilities,
      sources: pack.sources,
      signature
    })
  });
}
async function signAs(digest, password) {
  const account = await currentAccount();
  if (!account) throw new StoreError("Sign in before publishing.");
  const params = await kdfParamsFor(account.email);
  const existing = await authorized("/api/store/identity");
  let sealed;
  if (existing?.identity) {
    sealed = {
      publicKey: existing.identity.public_key,
      wrappedPrivateKey: existing.identity.wrapped_private_key,
      kdfVersion: existing.identity.kdf_version
    };
  } else {
    sealed = await generateIdentity(password, params);
    await authorized("/api/store/identity", {
      method: "PUT",
      body: JSON.stringify({
        public_key: sealed.publicKey,
        wrapped_private_key: sealed.wrappedPrivateKey,
        kdf_version: sealed.kdfVersion
      })
    });
  }
  return signDigest(digest, sealed, password, params);
}
function storeName(title) {
  const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return slug;
}
function nextVersion(latest) {
  if (!latest) return "1.0.0";
  const parts = latest.split(".");
  const numeric = parts.length === 3 && parts.every((p) => /^\d+$/.test(p));
  if (!numeric) return `${latest}.1`;
  return `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;
}
async function publishedVersion(name) {
  try {
    const body = await anonymous(`/api/store/workflows/${encodeURIComponent(name)}`);
    return body?.template?.version ?? null;
  } catch {
    return null;
  }
}
async function publishWorkflow(payload) {
  const name = storeName(payload.name);
  if (!name) {
    throw new StoreError(
      `"${payload.name}" has no letters or digits to make a store name from. Rename the workflow and try again.`
    );
  }
  const body = {
    name,
    version: nextVersion(await publishedVersion(name)),
    description: payload.description,
    graph_json: payload.graph,
    source_workflow_id: payload.id
  };
  return authorized("/api/store/workflows", { method: "POST", body: JSON.stringify(body) });
}
class GitError extends Error {
  code;
  stderr;
  constructor(message, code, stderr) {
    super(message);
    this.code = code;
    this.stderr = stderr;
  }
}
class NotARepository extends Error {
  constructor() {
    super("This folder is not a Git repository.");
  }
}
const LOG_LIMIT = 200;
const commandLog = [];
function output() {
  return [...commandLog];
}
function record(entry) {
  commandLog.push(entry);
  if (commandLog.length > LOG_LIMIT) commandLog.splice(0, commandLog.length - LOG_LIMIT);
}
function run(root, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = node_child_process.spawn("git", args, {
      cwd: root,
      env: {
        ...process.env,
        // Git must never stop to ask this window for anything: there is no
        // terminal attached, so a prompt would hang the call forever instead of
        // failing. A push that needs a credential fails and says so.
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        // Output has to be the machine's, not the reader's: a French locale
        // would translate the messages this file matches on.
        LC_ALL: "C",
        LANG: "C"
      }
    });
    const started = Date.now();
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => out += chunk);
    child.stderr.on("data", (chunk) => err += chunk);
    child.on("error", (error) => {
      reject(
        new GitError(
          `Could not run git: ${error.message}. Install Git, or make sure it is on the PATH this app was started with.`,
          -1,
          ""
        )
      );
    });
    child.on("close", (code) => {
      const status2 = code ?? -1;
      record({ at: (/* @__PURE__ */ new Date()).toISOString(), args, code: status2, stderr: err.trim(), ms: Date.now() - started });
      if (status2 === 0 || options.allow?.includes(status2)) return resolve(out);
      reject(new GitError(firstLine(err) || `git ${args[0]} failed (${status2})`, status2, err));
    });
    if (options.stdin !== void 0) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}
function firstLine(text2) {
  return text2.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}
function fromCode(code) {
  switch (code) {
    case "M":
      return { status: "modified", letter: "M" };
    case "A":
      return { status: "added", letter: "A" };
    case "D":
      return { status: "deleted", letter: "D" };
    case "R":
      return { status: "renamed", letter: "R" };
    case "C":
      return { status: "copied", letter: "C" };
    case "T":
      return { status: "type-changed", letter: "T" };
    case "?":
      return { status: "untracked", letter: "U" };
    case "!":
      return { status: "ignored", letter: "I" };
    default:
      return null;
  }
}
const CONFLICTED = /* @__PURE__ */ new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
function parseStatus(output2) {
  const staged = [];
  const unstaged = [];
  const conflicts = [];
  const fields = output2.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const record2 = fields[i];
    if (record2.length < 4) continue;
    const x = record2[0];
    const y = record2[1];
    const filePath = record2.slice(3);
    const code = `${x}${y}`;
    if (CONFLICTED.has(code)) {
      conflicts.push({ path: filePath, status: "conflicted", letter: code, staged: false });
      continue;
    }
    if (x === "?" && y === "?") {
      unstaged.push({ path: filePath, status: "untracked", letter: "U", staged: false });
      continue;
    }
    if (x === "!" && y === "!") {
      continue;
    }
    let from;
    if (x === "R" || x === "C") {
      from = fields[++i];
    }
    const indexSide = fromCode(x);
    if (indexSide) {
      staged.push({ path: filePath, from, status: indexSide.status, letter: indexSide.letter, staged: true });
    }
    const treeSide = fromCode(y);
    if (treeSide) {
      unstaged.push({ path: filePath, status: treeSide.status, letter: treeSide.letter, staged: false });
    }
  }
  return { staged, unstaged, conflicts };
}
function parseBranchHeader(line) {
  const empty = { branch: null, upstream: null, ahead: 0, behind: 0, unborn: false };
  if (!line.startsWith("## ")) return empty;
  let rest = line.slice(3);
  const unborn = /^No commits yet on /.test(rest);
  if (unborn) rest = rest.replace(/^No commits yet on /, "");
  if (rest.startsWith("HEAD (no branch)")) return { ...empty, unborn };
  const counts = /\[(.+)\]$/.exec(rest);
  let ahead = 0;
  let behind = 0;
  if (counts) {
    ahead = Number(/ahead (\d+)/.exec(counts[1])?.[1] ?? 0);
    behind = Number(/behind (\d+)/.exec(counts[1])?.[1] ?? 0);
    rest = rest.slice(0, counts.index).trim();
  }
  const [branch, upstream] = rest.split("...");
  return { branch: branch || null, upstream: upstream || null, ahead, behind, unborn };
}
async function status(root) {
  let top;
  try {
    top = (await run(root, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return { repository: false, root };
  }
  const output2 = await run(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--branch"
  ]);
  const cut = output2.indexOf("\0");
  const header = (cut === -1 ? output2 : output2.slice(0, cut)).split("\n")[0];
  const rest = cut === -1 ? "" : output2.slice(cut + 1);
  const branchInfo = parseBranchHeader(header);
  const groups = parseStatus(rest);
  const head = branchInfo.unborn ? null : (await run(root, ["rev-parse", "--short", "HEAD"], { allow: [128] })).trim() || null;
  const remotes = (await run(root, ["remote"])).split("\n").map((r) => r.trim()).filter(Boolean);
  return { repository: true, root: top, head, ...branchInfo, ...groups, remotes };
}
async function diff(root, relative, staged) {
  await resolveInside(root, relative);
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (staged) args.push("--staged");
  args.push("--", relative);
  return run(root, args);
}
async function fileAt(root, relative, revision) {
  await resolveInside(root, relative);
  try {
    return await run(root, ["show", `${revision}:${relative}`]);
  } catch {
    return "";
  }
}
async function log(root, limit2 = 50) {
  const out = await run(
    root,
    ["log", `--max-count=${Math.max(1, Math.min(500, limit2))}`, "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%x00"],
    { allow: [128] }
  );
  return out.split("\0\0").map((row) => row.replace(/^\n/, "")).filter((row) => row.trim().length > 0).map((row) => {
    const [hash, short2, author, date, subject] = row.split("\0");
    return { hash, short: short2, author, date, subject: subject ?? "" };
  }).filter((entry) => Boolean(entry.hash));
}
async function remoteList(root) {
  const out = await run(root, ["remote", "-v"], { allow: [128] });
  const seen = /* @__PURE__ */ new Map();
  for (const line of out.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match) seen.set(match[1], match[2]);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}
async function addRemote(root, name, url) {
  await run(root, ["remote", "add", name, url]);
}
async function removeRemote(root, name) {
  await run(root, ["remote", "remove", name]);
}
async function stashList(root) {
  const out = await run(root, ["stash", "list", "--format=%gd%x00%s%x00%x00"], { allow: [128] });
  return out.split("\0\0").map((row) => row.replace(/^\n/, "")).filter((row) => row.trim()).map((row, index) => {
    const [, subject] = row.split("\0");
    return { index, label: subject ?? "" };
  });
}
async function stash(root, message, includeUntracked) {
  const args = ["stash", "push"];
  if (includeUntracked) args.push("--include-untracked");
  if (message.trim()) args.push("--message", message.trim());
  await run(root, args);
}
async function stashPop(root, index) {
  await run(root, ["stash", "pop", `stash@{${Math.max(0, Math.trunc(index))}}`]);
}
async function stashApply(root, index) {
  await run(root, ["stash", "apply", `stash@{${Math.max(0, Math.trunc(index))}}`]);
}
async function stashDrop(root, index) {
  await run(root, ["stash", "drop", `stash@{${Math.max(0, Math.trunc(index))}}`]);
}
async function tags(root) {
  const out = await run(root, ["tag", "--sort=-creatordate"], { allow: [128] });
  return out.split("\n").map((t) => t.trim()).filter(Boolean);
}
async function createTag(root, name, message) {
  if (message.trim()) await run(root, ["tag", "--annotate", name, "--message", message.trim()]);
  else await run(root, ["tag", name]);
}
async function deleteTag(root, name) {
  await run(root, ["tag", "--delete", name]);
}
async function renameBranch(root, from, to) {
  await run(root, ["branch", "--move", from, to]);
}
async function deleteBranch(root, name, force) {
  await run(root, ["branch", force ? "-D" : "--delete", name]);
}
async function branches(root) {
  const out = await run(root, ["branch", "--format=%(refname:short)"], { allow: [128] });
  return out.split("\n").map((b) => b.trim()).filter(Boolean);
}
async function init(root) {
  await run(root, ["init"]);
}
async function checkedPaths(root, relatives) {
  if (relatives.length === 0) throw new Error("No file was named.");
  for (const relative of relatives) await resolveInside(root, relative);
  return relatives;
}
async function stage(root, relatives) {
  const paths = await checkedPaths(root, relatives);
  await run(root, ["add", "--all", "--", ...paths]);
}
async function unstage(root, relatives) {
  const paths = await checkedPaths(root, relatives);
  if (await isUnborn(root)) {
    await run(root, ["rm", "--cached", "--", ...paths]);
    return;
  }
  await run(root, ["restore", "--staged", "--", ...paths]);
}
async function isUnborn(root) {
  try {
    await run(root, ["rev-parse", "--verify", "HEAD"]);
    return false;
  } catch {
    return true;
  }
}
async function discard(root, relatives) {
  const paths = await checkedPaths(root, relatives);
  const tracked = [];
  const untracked = [];
  for (const relative of paths) {
    const known = await run(root, ["ls-files", "--error-unmatch", "--", relative], { allow: [1, 128] });
    if (known.trim()) tracked.push(relative);
    else untracked.push(relative);
  }
  if (tracked.length > 0) await run(root, ["checkout", "--", ...tracked]);
  for (const relative of untracked) {
    const absolute = await resolveInside(root, relative);
    await fs$1.rm(absolute, { recursive: true, force: true });
  }
}
async function commit(root, message, options = {}) {
  const text2 = message.trim();
  if (!text2 && !options.amend) throw new Error("A commit needs a message.");
  if (options.stageAll) await run(root, ["add", "--all"]);
  const args = ["commit", "--file=-"];
  if (options.amend) args.push("--amend");
  args.push("--cleanup=strip");
  await run(root, args, { stdin: text2 });
}
async function checkout(root, branch) {
  await run(root, ["checkout", branch]);
}
async function createBranch(root, name) {
  await run(root, ["checkout", "-b", name]);
}
async function fetch$1(root) {
  await run(root, ["fetch", "--prune"]);
}
async function pull(root) {
  await run(root, ["pull", "--ff-only"]);
}
async function pushTo(root, remote, setUpstream) {
  const state = await status(root);
  if (!state.repository) throw new NotARepository();
  if (!state.branch) throw new Error("A detached HEAD has no branch to push.");
  const args = ["push"];
  if (setUpstream) args.push("--set-upstream");
  args.push(remote, state.branch);
  await run(root, args);
}
async function pushTags(root) {
  await run(root, ["push", "--tags"]);
}
async function push(root) {
  const state = await status(root);
  if (!state.repository) throw new NotARepository();
  if (!state.branch) throw new Error("A detached HEAD has no branch to push.");
  if (state.remotes.length === 0) {
    throw new Error("This repository has no remote yet, so there is nowhere to push.");
  }
  if (state.upstream) {
    await run(root, ["push"]);
    return;
  }
  await run(root, ["push", "--set-upstream", state.remotes[0], state.branch]);
}
async function clone(parent, url) {
  const name = cloneFolderName(url);
  const target = path.join(parent, name);
  if (path.dirname(target) !== path.resolve(parent)) {
    throw new Error(`That URL would clone outside the folder you chose.`);
  }
  await run(parent, ["clone", "--", url, name]);
  return target;
}
function cloneFolderName(url) {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "";
  const name = last.replace(/\.git$/, "");
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`Could not work out a folder name from "${url}".`);
  }
  return name;
}
function fileFor(projectDir) {
  const key = node_crypto.createHash("sha256").update(path.resolve(projectDir)).digest("hex").slice(0, 16);
  return path.join(electron.app.getPath("userData"), "conversations", `${key}.json`);
}
async function load(projectDir) {
  try {
    const raw = await fs$1.readFile(fileFor(projectDir), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.conversations) ? parsed.conversations : [];
  } catch {
    return [];
  }
}
async function save(projectDir, conversations) {
  const file2 = fileFor(projectDir);
  await fs$1.mkdir(path.dirname(file2), { recursive: true });
  const temp = `${file2}.partial`;
  await fs$1.writeFile(temp, JSON.stringify({ conversations }, null, 2), "utf8");
  await fs$1.rename(temp, file2);
}
async function remember(projectDir, conversation) {
  const all = await load(projectDir);
  const index = all.findIndex((c) => c.id === conversation.id);
  const next = { ...conversation, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  if (index === -1) all.unshift(next);
  else all[index] = next;
  await save(projectDir, all);
}
async function forget$1(projectDir, id) {
  await save(
    projectDir,
    (await load(projectDir)).filter((c) => c.id !== id)
  );
}
const SIGNATURES = [
  { extension: "png", mime: "image/png", magic: [[137, 80, 78, 71, 13, 10, 26, 10]] },
  { extension: "jpg", mime: "image/jpeg", magic: [[255, 216, 255]] },
  { extension: "gif", mime: "image/gif", magic: [[71, 73, 70, 56]] },
  // WEBP is RIFF....WEBP: the four bytes at offset 8 are what tell it from a
  // wav file, so the check has to look past the header rather than at it.
  { extension: "webp", mime: "image/webp", magic: [[82, 73, 70, 70]] }
];
const MAX_BYTES = 20 * 1024 * 1024;
function kindOf(bytes) {
  for (const candidate of SIGNATURES) {
    for (const magic of candidate.magic) {
      if (magic.every((byte, index) => bytes[index] === byte)) {
        if (candidate.extension !== "webp") return candidate;
        const tail = [87, 69, 66, 80];
        if (tail.every((byte, index) => bytes[8 + index] === byte)) return candidate;
      }
    }
  }
  return null;
}
function folder(conversationId) {
  const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "unfiled";
  return path.join(electron.app.getPath("userData"), "attachments", safe);
}
async function keep(conversationId, name, bytes) {
  if (bytes.length === 0) throw new Error("That file is empty.");
  if (bytes.length > MAX_BYTES) {
    throw new Error(`That image is ${Math.round(bytes.length / 1024 / 1024)} MB; the limit is 20 MB.`);
  }
  const kind = kindOf(bytes);
  if (!kind) {
    throw new Error("That is not an image this app recognises — PNG, JPEG, GIF and WebP are.");
  }
  const dir = folder(conversationId);
  await fs$1.mkdir(dir, { recursive: true });
  const id = node_crypto.randomUUID();
  const file2 = path.join(dir, `${id}.${kind.extension}`);
  await fs$1.writeFile(file2, bytes);
  return { id, name: displayName(name, kind.extension), mime: kind.mime, file: file2 };
}
function displayName(name, extension) {
  const trimmed = path.basename(name ?? "").trim();
  if (trimmed && trimmed !== "." && trimmed !== "..") return trimmed;
  const now = /* @__PURE__ */ new Date();
  const stamp = `${now.getHours()}`.padStart(2, "0") + `${now.getMinutes()}`.padStart(2, "0") + `${now.getSeconds()}`.padStart(2, "0");
  return `pasted-${stamp}.${extension}`;
}
async function drop(conversationId) {
  await fs$1.rm(folder(conversationId), { recursive: true, force: true });
}
async function forget(conversationId, id) {
  const safe = id.replace(/[^a-zA-Z0-9-]/g, "");
  if (!safe) return;
  const dir = folder(conversationId);
  for (const entry of await fs$1.readdir(dir).catch(() => [])) {
    if (entry.startsWith(`${safe}.`)) await fs$1.rm(path.join(dir, entry), { force: true });
  }
}
function pathsFor(conversationId, ids) {
  const dir = folder(conversationId);
  const out = [];
  for (const id of ids) {
    const safe = id.replace(/[^a-zA-Z0-9-]/g, "");
    if (!safe) continue;
    for (const candidate of SIGNATURES) {
      const file2 = path.join(dir, `${safe}.${candidate.extension}`);
      if (fs.existsSync(file2)) {
        out.push(file2);
        break;
      }
    }
  }
  return out;
}
function str(value) {
  return typeof value === "string" ? value : "";
}
function countNodes(graphJSON) {
  try {
    const graph = JSON.parse(graphJSON);
    return Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  } catch {
    return 0;
  }
}
async function read(projectDir) {
  const root = path.resolve(projectDir);
  const dir = path.join(root, ".zyvro", "workflows");
  let entries;
  try {
    entries = await fs$1.readdir(dir);
  } catch {
    throw new Error(
      `"${path.basename(root)}" is not a Zyvro project: it has no .zyvro/workflows folder.`
    );
  }
  const workflows = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs$1.readFile(path.join(dir, entry), "utf8");
      const stored = JSON.parse(raw);
      const graphJSON = str(stored.graph_json);
      if (!graphJSON) continue;
      workflows.push({
        id: str(stored.id) || entry,
        name: str(stored.name) || entry.replace(/\.json$/, ""),
        description: str(stored.description),
        graphJSON,
        nodes: countNodes(graphJSON)
      });
    } catch {
    }
  }
  return { project: root, name: path.basename(root), workflows };
}
async function choose(win) {
  const picked = await electron.dialog.showOpenDialog(win, {
    title: "Import workflows from another project",
    properties: ["openDirectory"],
    buttonLabel: "Read this project"
  });
  if (picked.canceled || picked.filePaths.length === 0) return null;
  return read(picked.filePaths[0]);
}
async function share(payload) {
  const created = await authorized("/api/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: payload.name,
      description: payload.description,
      graph_json: payload.graph,
      // Unlisted, never public: sharing with a friend is not publishing to a
      // catalogue, and the two are one word apart in this API.
      visibility: "unlisted"
    })
  });
  if (!created?.id) throw new Error("The server accepted the workflow but did not say where it went.");
  return { id: created.id, name: created.name ?? payload.name, url: `${webOrigin()}/w/${created.id}` };
}
async function mine() {
  const listed = await authorized("/api/workflows");
  return Array.isArray(listed) ? listed : [];
}
const MAX_DIFF_BYTES = 6e4;
async function availableAgent() {
  for (const agent of ["claude", "codex"]) {
    if (installed(agent) && await runs(agent)) return agent;
  }
  return null;
}
function runs(bin) {
  return new Promise((resolve) => {
    try {
      const child = launch(bin, ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}
const INSTRUCTIONS = `You write one git commit message and nothing else.

Rules:
- One subject line, at most 72 characters, in the imperative mood.
- Use a Conventional Commits prefix when one clearly fits (feat, fix, docs, refactor, test, chore, perf, build, ci).
- Say what the change does and, when the diff makes it plain, why. Never restate the file names.
- No quotes around it, no backticks, no code fences, no preamble, no trailing full stop.
- If the diff is too small to justify a body, write only the subject line.
- You may add a blank line and a short body only when the change needs a reason that is not obvious.

Output the message. Nothing before it, nothing after it.`;
async function suggest(root) {
  const agent = await availableAgent();
  if (!agent) {
    throw new Error(
      "No agent CLI was found on this machine. Install claude or codex and it will appear here."
    );
  }
  const state = await status(root);
  if (!state.repository) throw new Error("This folder is not a Git repository.");
  const staged = state.staged.length > 0;
  const paths = (staged ? state.staged : state.unstaged).map((c) => c.path);
  if (paths.length === 0) throw new Error("There is nothing to describe: no file has changed.");
  let diff$1 = "";
  for (const relative of paths) {
    if (diff$1.length >= MAX_DIFF_BYTES) break;
    try {
      diff$1 += await diff(root, relative, staged);
    } catch {
    }
  }
  if (diff$1.length > MAX_DIFF_BYTES) {
    diff$1 = diff$1.slice(0, MAX_DIFF_BYTES);
    diff$1 = diff$1.slice(0, diff$1.lastIndexOf("\n")) + "\n\n[diff truncated]\n";
  }
  if (!diff$1.trim()) {
    diff$1 = `No textual diff. The change is these files:
${paths.map((p) => `- ${p}`).join("\n")}
`;
  }
  const answer = await ask(agent, `${INSTRUCTIONS}

---

Here is the diff:

${diff$1}`, root);
  return clean(answer);
}
function ask(agent, prompt, cwd) {
  return new Promise((resolve, reject) => {
    const args = agent === "claude" ? ["-p"] : ["exec", "--skip-git-repo-check", "-"];
    let child;
    try {
      child = launchPiped(agent, args, { cwd });
    } catch (error) {
      reject(error);
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => out += chunk);
    child.stderr.on("data", (chunk) => err += chunk);
    child.on("error", (error) => reject(new Error(`Could not run ${agent}: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0 && out.trim()) return resolve(out);
      reject(new Error(err.trim().split("\n")[0] || `${agent} wrote nothing back.`));
    });
    child.stdin.end(prompt);
  });
}
function clean(raw) {
  let text2 = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/.exec(text2);
  if (fence) text2 = fence[1].trim();
  const lines = text2.split("\n");
  while (lines.length > 0 && /^\[\d{4}-\d{2}-\d{2}T|^(thinking|codex|tokens used|User instructions|--------)\b/i.test(lines[0].trim())) {
    lines.shift();
  }
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  text2 = lines.join("\n").trim();
  const quoted = /^"([\s\S]+)"$/.exec(text2);
  if (quoted) text2 = quoted[1].trim();
  return text2;
}
class Workspace {
  root = null;
  daemon = new Daemon();
  terminals = new Terminals();
  agent = new AgentRunner();
  async dispose() {
    this.agent.cancelAll();
    this.terminals.disposeAll();
    await this.daemon.stop();
  }
}
async function realpathOfParent(target) {
  const parent = await fs$1.realpath(path.dirname(target));
  return path.join(parent, path.basename(target));
}
const browserHost = {
  open: async (win, view = "") => {
    const named = view && view !== "new" ? viewNamed(view) : null;
    if (named) {
      win.webContents.send("browser:open", { view });
      return named;
    }
    if (view !== "new") {
      const already = guestForWindow(win.id);
      if (already) {
        win.webContents.send("browser:open", { view: "" });
        return already;
      }
    }
    win.webContents.send("browser:open", { view });
    return waitForGuest(win.id, 1e4, view === "new");
  },
  projectDir: (win) => workspaces.get(win)?.root ?? null
};
function viewNamed(view) {
  return openViews().find((g) => g.view === view) ?? null;
}
const pendingAsks = /* @__PURE__ */ new Map();
const ASK_PATIENCE_MS = 10 * 60 * 1e3;
const askHost = async (request) => {
  const [win] = electron.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isFocused());
  const target = win ?? electron.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!target) return { allow: false, message: "Zyvro Studio is not open" };
  const id = node_crypto.randomUUID();
  target.webContents.send("agent:permission", { id, tool: request.tool, input: request.input });
  return await new Promise((resolve) => {
    const settle = (answer) => {
      clearTimeout(timer);
      pendingAsks.delete(id);
      resolve(answer);
    };
    pendingAsks.set(id, settle);
    const timer = setTimeout(
      () => settle({ allow: false, message: "nobody answered — ask again, or change what the agent may do" }),
      ASK_PATIENCE_MS
    );
  });
};
const workspaces = /* @__PURE__ */ new WeakMap();
function workspaceFor(win) {
  let ws = workspaces.get(win);
  if (!ws) {
    ws = new Workspace();
    workspaces.set(win, ws);
  }
  return ws;
}
function requireWorkspace(event) {
  const win = electron.BrowserWindow.fromWebContents(event.sender);
  if (!win) throw new Error("This request came from a window that no longer exists.");
  return { win, ws: workspaceFor(win) };
}
function requireRoot(ws) {
  if (!ws.root) throw new Error("No project is open.");
  return ws.root;
}
let onRecentsChanged = null;
function registerIpc(onRecents) {
  onRecentsChanged = onRecents ?? null;
  electron.ipcMain.handle("project:choose", async (event) => {
    const { win } = requireWorkspace(event);
    const result = await electron.dialog.showOpenDialog(win, {
      title: "Open a project folder",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Open project"
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  electron.ipcMain.handle("project:create", async (event) => {
    const { win } = requireWorkspace(event);
    const result = await electron.dialog.showSaveDialog(win, {
      title: "Create a project",
      buttonLabel: "Create project",
      nameFieldLabel: "Project name",
      defaultPath: path.join(electron.app.getPath("documents"), "zyvro-project"),
      properties: ["createDirectory"]
    });
    if (result.canceled || !result.filePath) return null;
    const target = result.filePath;
    const existing = await fs$1.stat(target).catch(() => null);
    if (existing && !existing.isDirectory()) {
      throw new Error(`There is already a file at ${target}. Choose another name.`);
    }
    if (!existing) await fs$1.mkdir(target, { recursive: true });
    return target;
  });
  electron.ipcMain.handle("project:open", async (event, dir) => {
    const { win, ws } = requireWorkspace(event);
    if (typeof dir !== "string" || !dir) throw new Error("A project path is required.");
    try {
      const daemon = await ws.daemon.start(dir);
      ws.root = dir;
      win.setTitle(`${path.basename(dir)} — Zyvro Studio`);
      win.setRepresentedFilename?.(dir);
      rememberRecent(dir);
      onRecentsChanged?.();
      return { project: dir, name: path.basename(dir), daemon };
    } catch (err) {
      ws.root = null;
      if (err instanceof DaemonError) {
        throw new Error(err.detail ? `${err.message}

${err.detail}` : err.message);
      }
      throw err;
    }
  });
  electron.ipcMain.handle("project:current", async (event) => {
    const { ws } = requireWorkspace(event);
    if (!ws.root || !ws.daemon.current) return null;
    return { project: ws.root, name: path.basename(ws.root), daemon: ws.daemon.current };
  });
  let pending = null;
  electron.ipcMain.handle("shots:capture", async (event, rect, label) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    const png = await captureRegion(win ?? void 0, rect);
    pending = { png, label: typeof label === "string" ? label : "" };
    return { preview: `data:image/png;base64,${png.toString("base64")}`, bytes: png.length };
  });
  electron.ipcMain.handle("shots:save", async () => {
    if (!pending) throw new Error("nothing captured");
    return saveShot(pending.png, {
      dir: electron.app.getPath("downloads"),
      label: pending.label,
      open: (file2) => void electron.shell.openPath(file2)
    });
  });
  electron.ipcMain.handle("shots:share", async () => {
    if (!pending) throw new Error("nothing captured");
    return shareShot(
      pending.png,
      pending.label,
      (pathname, init2) => authorized(pathname, init2)
    );
  });
  electron.ipcMain.handle("project:recents", async () => loadRecents());
  electron.ipcMain.handle("project:forget-recents", async () => {
    const recents = forgetRecents();
    onRecentsChanged?.();
    return recents;
  });
  electron.ipcMain.handle("project:close", async (event) => {
    const { ws } = requireWorkspace(event);
    await ws.dispose();
    ws.root = null;
    return true;
  });
  electron.ipcMain.handle(
    "files:pick",
    async (event, request) => {
      const { win, ws } = requireWorkspace(event);
      const root = await fs$1.realpath(requireRoot(ws));
      const startIn = request?.current ? path.resolve(root, path.dirname(request.current)) : root;
      const chosen = request?.save ? await electron.dialog.showSaveDialog(win, {
        title: request?.title || "Write to",
        defaultPath: request.current ? path.resolve(root, request.current) : root,
        buttonLabel: "Use this path"
      }) : await electron.dialog.showOpenDialog(win, {
        title: request?.title || "Choose a file",
        defaultPath: startIn,
        properties: ["openFile"],
        buttonLabel: "Use this file"
      });
      const picked = "filePath" in chosen ? chosen.filePath : chosen.filePaths?.[0];
      if (chosen.canceled || !picked) return null;
      const relative = path.relative(root, await realpathOfParent(picked));
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(
          "That file is outside the open project. Workflows can only read and write inside the project folder."
        );
      }
      return relative.split(path.sep).join("/");
    }
  );
  electron.ipcMain.handle("files:list", async (event, relative) => {
    const { ws } = requireWorkspace(event);
    return listDir(requireRoot(ws), relative ?? ".");
  });
  electron.ipcMain.handle("files:read", async (event, relative) => {
    const { ws } = requireWorkspace(event);
    return readFile(requireRoot(ws), relative);
  });
  electron.ipcMain.handle("files:write", async (event, relative, text2) => {
    const { ws } = requireWorkspace(event);
    await writeFile(requireRoot(ws), relative, String(text2));
    return true;
  });
  electron.ipcMain.handle("files:create", async (event, relative, kind) => {
    const { ws } = requireWorkspace(event);
    await createEntry(requireRoot(ws), relative, kind === "directory" ? "directory" : "file");
    return true;
  });
  electron.ipcMain.handle("files:rename", async (event, from, to) => {
    const { ws } = requireWorkspace(event);
    await renameEntry(requireRoot(ws), from, to);
    return true;
  });
  electron.ipcMain.handle("files:delete", async (event, relative) => {
    const { ws } = requireWorkspace(event);
    await deleteEntry(requireRoot(ws), relative);
    return true;
  });
  electron.ipcMain.handle("browser:attach", async (event, contentsId, view) => {
    const { win } = requireWorkspace(event);
    const guest = electron.webContents.fromId(Number(contentsId));
    if (!guest || guest.getType() !== "webview") throw new Error("that is not a browser view");
    registerGuest(guest, win.id, String(view ?? ""));
    return true;
  });
  electron.ipcMain.handle(
    "browser:devtools",
    async (event, contentsId, open, bounds) => {
      requireWorkspace(event);
      const guest = openViews().find((g) => g.id === Number(contentsId));
      if (!guest) throw new Error("no such browser view");
      if (open) showDevTools(guest, bounds ?? null);
      else hideDevTools(guest);
      return toolsOpen(guest);
    }
  );
  electron.ipcMain.handle("browser:devtools-bounds", async (event, contentsId, bounds) => {
    requireWorkspace(event);
    const guest = openViews().find((g) => g.id === Number(contentsId));
    if (guest) placeTools(guest, bounds ?? null);
    return true;
  });
  electron.ipcMain.handle("browser:visited", async (event, contentsId, url) => {
    requireWorkspace(event);
    noteVisit(Number(contentsId), String(url));
    return true;
  });
  electron.ipcMain.handle("agent:permission-answer", async (event, id, allow) => {
    requireWorkspace(event);
    const settle = pendingAsks.get(String(id));
    if (!settle) return false;
    settle({ allow: allow === true, message: allow === true ? void 0 : "you said no" });
    return true;
  });
  electron.ipcMain.handle("search:find", async (event, query2) => {
    const { ws } = requireWorkspace(event);
    return search(requireRoot(ws), query2);
  });
  electron.ipcMain.handle(
    "search:replace",
    async (event, query2, replacement, targets) => {
      const { ws } = requireWorkspace(event);
      return replaceAll(
        requireRoot(ws),
        query2,
        String(replacement ?? ""),
        Array.isArray(targets) && targets.length > 0 ? targets : void 0
      );
    }
  );
  electron.ipcMain.handle("terminal:create", async (event, cols, rows) => {
    const { ws } = requireWorkspace(event);
    return ws.terminals.create(event.sender, requireRoot(ws), cols || 80, rows || 24, {
      daemonOrigin: ws.daemon.current?.origin,
      daemonToken: ws.daemon.current?.token
    });
  });
  electron.ipcMain.handle("terminal:write", async (event, id, data) => {
    const { ws } = requireWorkspace(event);
    ws.terminals.write(id, data);
    return true;
  });
  electron.ipcMain.handle("terminal:resize", async (event, id, cols, rows) => {
    const { ws } = requireWorkspace(event);
    ws.terminals.resize(id, cols, rows);
    return true;
  });
  electron.ipcMain.handle("terminal:dispose", async (event, id) => {
    const { ws } = requireWorkspace(event);
    ws.terminals.dispose(id);
    return true;
  });
  electron.ipcMain.handle(
    "agent:send",
    async (event, kind, prompt, ctx, conversationId, model, images) => {
      const { ws } = requireWorkspace(event);
      const root = requireRoot(ws);
      return ws.agent.send(
        event.sender,
        kind === "codex" ? "codex" : "claude",
        String(prompt),
        {
          projectDir: root,
          workflows: Array.isArray(ctx?.workflows) ? ctx.workflows : [],
          daemonOrigin: ws.daemon.current?.origin,
          daemonToken: ws.daemon.current?.token,
          // Ce que l'agent a le droit de faire vient du panneau : c'est un
          // choix par conversation, et la personne le voit à côté de son texte.
          // La liste des niveaux vient du module partagé : l'écrire ici une
          // seconde fois, c'est ce qui vient d'arriver — « ask » n'y était pas,
          // et le panneau demandait un mode que le principal remplaçait par le
          // sien sans rien dire.
          permission: PERMISSIONS.includes(ctx?.permission) ? ctx.permission : DEFAULT_PERMISSION
        },
        String(conversationId),
        typeof model === "string" && model.trim() ? model.trim() : null,
        // Only paths this process wrote itself are accepted. The renderer names
        // an attachment by its id; it never hands over a path, so it cannot ask
        // the CLI to read /etc/passwd by calling it an image.
        Array.isArray(images) ? pathsFor(String(conversationId), images.map(String)) : []
      );
    }
  );
  electron.ipcMain.handle("agent:conversations", async (event) => {
    const { ws } = requireWorkspace(event);
    const all = await load(requireRoot(ws));
    for (const conversation of all) ws.agent.resumeAt(conversation.id, conversation.sessionId);
    return all;
  });
  electron.ipcMain.handle("agent:remember", async (event, conversation) => {
    const { ws } = requireWorkspace(event);
    return remember(requireRoot(ws), {
      ...conversation,
      // The id the CLI actually reported wins over whatever the renderer last
      // saw: it is learned from the output stream, and the renderer only hears
      // about it through an event that may still be in flight.
      sessionId: ws.agent.sessionFor(conversation.id) ?? conversation.sessionId ?? null
    });
  });
  electron.ipcMain.handle("agent:forget", async (event, id) => {
    const { ws } = requireWorkspace(event);
    ws.agent.resumeAt(String(id), null);
    await drop(String(id));
    return forget$1(requireRoot(ws), String(id));
  });
  electron.ipcMain.handle(
    "agent:attach",
    async (_event, conversationId, name, bytes) => {
      const kept = await keep(String(conversationId), String(name ?? ""), new Uint8Array(bytes));
      return { id: kept.id, name: kept.name, mime: kept.mime };
    }
  );
  electron.ipcMain.handle(
    "agent:detach",
    async (_event, conversationId, id) => forget(String(conversationId), String(id))
  );
  electron.ipcMain.handle("agent:models", async (_event, kind) => {
    const bin = kind === "codex" ? "codex" : "claude";
    return aliasesFrom(helpOf(bin));
  });
  electron.ipcMain.handle("agent:cancel", async (event, id) => {
    const { ws } = requireWorkspace(event);
    ws.agent.cancel(id);
    return true;
  });
  electron.ipcMain.handle("account:current", async () => currentAccount());
  electron.ipcMain.handle(
    "account:sign-in",
    async (_event, email, password) => signIn(String(email), String(password))
  );
  electron.ipcMain.handle("account:sign-out", async () => {
    await signOut();
    return null;
  });
  electron.ipcMain.handle("store:nodes", async (_event, q) => listNodes(String(q ?? "")));
  electron.ipcMain.handle("store:workflows", async (_event, q) => listWorkflows(String(q ?? "")));
  electron.ipcMain.handle(
    "store:read-pack",
    async (_event, name, version) => readPack(String(name), version ? String(version) : void 0)
  );
  electron.ipcMain.handle("store:install-pack", async (event, name, version) => {
    const { ws } = requireWorkspace(event);
    return installPack(requireRoot(ws), String(name), version ? String(version) : void 0);
  });
  electron.ipcMain.handle("store:install-workflow", async (event, name) => {
    const { ws } = requireWorkspace(event);
    return installWorkflow(requireRoot(ws), String(name));
  });
  electron.ipcMain.handle("store:installed-packs", async (event) => {
    const { ws } = requireWorkspace(event);
    return listInstalledPacks(requireRoot(ws));
  });
  electron.ipcMain.handle("store:publish-pack", async (event, name, password) => {
    const { ws } = requireWorkspace(event);
    return publishPack(requireRoot(ws), String(name), String(password));
  });
  electron.ipcMain.handle(
    "store:publish-workflow",
    async (event, payload) => {
      requireWorkspace(event);
      return publishWorkflow(payload);
    }
  );
  electron.ipcMain.handle("git:status", async (event) => {
    const { ws } = requireWorkspace(event);
    return status(requireRoot(ws));
  });
  electron.ipcMain.handle("git:init", async (event) => {
    const { ws } = requireWorkspace(event);
    return init(requireRoot(ws));
  });
  electron.ipcMain.handle("git:stage", async (event, paths) => {
    const { ws } = requireWorkspace(event);
    return stage(requireRoot(ws), paths.map(String));
  });
  electron.ipcMain.handle("git:unstage", async (event, paths) => {
    const { ws } = requireWorkspace(event);
    return unstage(requireRoot(ws), paths.map(String));
  });
  electron.ipcMain.handle("git:discard", async (event, paths) => {
    const { ws } = requireWorkspace(event);
    return discard(requireRoot(ws), paths.map(String));
  });
  electron.ipcMain.handle("git:commit", async (event, message, options) => {
    const { ws } = requireWorkspace(event);
    return commit(requireRoot(ws), String(message), {
      amend: Boolean(options?.amend),
      stageAll: Boolean(options?.stageAll)
    });
  });
  electron.ipcMain.handle("git:diff", async (event, relative, staged) => {
    const { ws } = requireWorkspace(event);
    return diff(requireRoot(ws), String(relative), Boolean(staged));
  });
  electron.ipcMain.handle("git:file-at", async (event, relative, revision) => {
    const { ws } = requireWorkspace(event);
    return fileAt(requireRoot(ws), String(relative), String(revision));
  });
  electron.ipcMain.handle("git:log", async (event, limit2) => {
    const { ws } = requireWorkspace(event);
    return log(requireRoot(ws), Number(limit2) || 50);
  });
  electron.ipcMain.handle("git:branches", async (event) => {
    const { ws } = requireWorkspace(event);
    return branches(requireRoot(ws));
  });
  electron.ipcMain.handle("git:checkout", async (event, branch) => {
    const { ws } = requireWorkspace(event);
    return checkout(requireRoot(ws), String(branch));
  });
  electron.ipcMain.handle("git:create-branch", async (event, name) => {
    const { ws } = requireWorkspace(event);
    return createBranch(requireRoot(ws), String(name));
  });
  electron.ipcMain.handle("git:fetch", async (event) => {
    const { ws } = requireWorkspace(event);
    return fetch$1(requireRoot(ws));
  });
  electron.ipcMain.handle("git:pull", async (event) => {
    const { ws } = requireWorkspace(event);
    return pull(requireRoot(ws));
  });
  electron.ipcMain.handle("git:push", async (event) => {
    const { ws } = requireWorkspace(event);
    return push(requireRoot(ws));
  });
  electron.ipcMain.handle("git:push-to", async (event, remote, setUpstream) => {
    const { ws } = requireWorkspace(event);
    return pushTo(requireRoot(ws), String(remote), Boolean(setUpstream));
  });
  electron.ipcMain.handle("git:push-tags", async (event) => {
    const { ws } = requireWorkspace(event);
    return pushTags(requireRoot(ws));
  });
  electron.ipcMain.handle("git:remotes", async (event) => {
    const { ws } = requireWorkspace(event);
    return remoteList(requireRoot(ws));
  });
  electron.ipcMain.handle("git:add-remote", async (event, name, url) => {
    const { ws } = requireWorkspace(event);
    return addRemote(requireRoot(ws), String(name), String(url));
  });
  electron.ipcMain.handle("git:remove-remote", async (event, name) => {
    const { ws } = requireWorkspace(event);
    return removeRemote(requireRoot(ws), String(name));
  });
  electron.ipcMain.handle("git:stash-list", async (event) => {
    const { ws } = requireWorkspace(event);
    return stashList(requireRoot(ws));
  });
  electron.ipcMain.handle("git:stash", async (event, message, includeUntracked) => {
    const { ws } = requireWorkspace(event);
    return stash(requireRoot(ws), String(message ?? ""), Boolean(includeUntracked));
  });
  electron.ipcMain.handle("git:stash-pop", async (event, index) => {
    const { ws } = requireWorkspace(event);
    return stashPop(requireRoot(ws), Number(index));
  });
  electron.ipcMain.handle("git:stash-apply", async (event, index) => {
    const { ws } = requireWorkspace(event);
    return stashApply(requireRoot(ws), Number(index));
  });
  electron.ipcMain.handle("git:stash-drop", async (event, index) => {
    const { ws } = requireWorkspace(event);
    return stashDrop(requireRoot(ws), Number(index));
  });
  electron.ipcMain.handle("git:tags", async (event) => {
    const { ws } = requireWorkspace(event);
    return tags(requireRoot(ws));
  });
  electron.ipcMain.handle("git:create-tag", async (event, name, message) => {
    const { ws } = requireWorkspace(event);
    return createTag(requireRoot(ws), String(name), String(message ?? ""));
  });
  electron.ipcMain.handle("git:delete-tag", async (event, name) => {
    const { ws } = requireWorkspace(event);
    return deleteTag(requireRoot(ws), String(name));
  });
  electron.ipcMain.handle("git:rename-branch", async (event, from, to) => {
    const { ws } = requireWorkspace(event);
    return renameBranch(requireRoot(ws), String(from), String(to));
  });
  electron.ipcMain.handle("git:delete-branch", async (event, name, force) => {
    const { ws } = requireWorkspace(event);
    return deleteBranch(requireRoot(ws), String(name), Boolean(force));
  });
  electron.ipcMain.handle("git:output", async () => output());
  electron.ipcMain.handle("git:agent", async () => availableAgent());
  electron.ipcMain.handle("git:suggest-message", async (event) => {
    const { ws } = requireWorkspace(event);
    return suggest(requireRoot(ws));
  });
  electron.ipcMain.handle("git:clone", async (event, url) => {
    const { win } = requireWorkspace(event);
    const chosen = await electron.dialog.showOpenDialog(win, {
      title: "Where should the repository be cloned?",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Clone here"
    });
    if (chosen.canceled || chosen.filePaths.length === 0) return null;
    return clone(chosen.filePaths[0], String(url));
  });
  electron.ipcMain.handle("workflows:choose-source", async (event) => {
    const { win } = requireWorkspace(event);
    return choose(win);
  });
  electron.ipcMain.handle(
    "workflows:share",
    async (_event, payload) => share({
      name: String(payload?.name ?? ""),
      description: String(payload?.description ?? ""),
      graph: payload?.graph ?? {}
    })
  );
  electron.ipcMain.handle("workflows:mine", async () => mine());
  electron.ipcMain.handle("shell:open-external", async (_event, url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error("Refused to open a non-web URL.");
    await electron.shell.openExternal(url);
    return true;
  });
  electron.ipcMain.handle("shell:reveal", async (event, relative) => {
    const { ws } = requireWorkspace(event);
    const target = await resolveInside(requireRoot(ws), relative);
    electron.shell.showItemInFolder(target);
    return true;
  });
}
async function disposeWorkspace(win) {
  const ws = workspaces.get(win);
  if (ws) await ws.dispose();
}
const isDev = !electron.app.isPackaged;
if (isDev) {
  electron.app.setPath("userData", path.join(electron.app.getPath("appData"), "zyvro-desktop"));
}
function appIcon() {
  const candidates = [
    path.join(process.resourcesPath || "", "icon.png"),
    path.join(electron.app.getAppPath(), "resources", "icon.png")
  ];
  for (const candidate of candidates) {
    const image = electron.nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image;
  }
  return void 0;
}
function folderFromArgv(argv) {
  const args = argv.slice(electron.app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (arg.startsWith("-") || arg === ".") continue;
    try {
      if (fs.statSync(arg).isDirectory()) return path.resolve(arg);
    } catch {
    }
  }
  return null;
}
function createWindow() {
  const win = new electron.BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0b0f",
    icon: appIcon(),
    // A hidden title bar with inset traffic lights is what makes the window
    // read as an editor rather than a web page in a frame.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      // The renderer compiles workflow graphs and renders model output. It gets
      // no Node access at all; everything it needs arrives over the narrow
      // surface in preload/index.ts.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Le navigateur de test est une <webview> : un WebContents à part, avec
      // sa propre session, que l'agent pilote sans toucher au navigateur de la
      // personne. `will-attach-webview` ci-dessous fixe ce qu'elle a le droit
      // d'être — l'attribut ne dit pas « le rendu peut tout », il dit « le rendu
      // peut en demander une ».
      webviewTag: true,
      spellcheck: false
    }
  });
  win.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.disableDialogs = true;
    params.partition = BROWSER_PARTITION;
    params.allowpopups = "false";
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.on("console-message", (event) => {
    if (event.level !== "error" && event.level !== "warning") return;
    console.error(`[renderer ${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer gone] ${details.reason} (exit code ${details.exitCode})`);
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[preload error] ${preloadPath}: ${error.message}`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL;
    if (dev && url.startsWith(dev)) return;
    event.preventDefault();
  });
  win.on("closed", () => {
    void disposeWorkspace(win);
  });
  workspaceFor(win);
  const startupFolder = folderFromArgv(process.argv);
  if (startupFolder) {
    win.webContents.once("did-finish-load", () => {
      win.webContents.send("menu:open-path", startupFolder);
    });
  }
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return win;
}
function send(win, channel, payload) {
  if (win instanceof electron.BrowserWindow) win.webContents.send(channel, payload);
}
function recentSubmenu() {
  const recents = loadRecents();
  if (recents.length === 0) {
    return [{ label: "No recent projects", enabled: false }];
  }
  return [
    ...recents.map((recent) => ({
      label: recent.name,
      // The full path is the useful part when two folders share a name, and a
      // sublabel keeps it out of the way until the user looks for it.
      sublabel: recent.path,
      toolTip: recent.path,
      click: (_item, win) => send(win, "menu:open-path", recent.path)
    })),
    { type: "separator" },
    {
      label: "Clear Recently Opened",
      click: (_item, win) => send(win, "menu:forget-recents")
    }
  ];
}
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...isMac ? [{ role: "appMenu" }] : [],
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => createWindow()
        },
        { type: "separator" },
        {
          label: "New Project…",
          accelerator: "CmdOrCtrl+N",
          click: (_item, win) => send(win, "menu:new-project")
        },
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+O",
          click: (_item, win) => send(win, "menu:open-project")
        },
        { label: "Open Recent", submenu: recentSubmenu() },
        { type: "separator" },
        {
          label: "New Workflow",
          accelerator: "CmdOrCtrl+Alt+N",
          click: (_item, win) => send(win, "menu:new-workflow")
        },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: (_item, win) => send(win, "menu:save")
        },
        { type: "separator" },
        {
          label: "Close Folder",
          accelerator: "CmdOrCtrl+K CmdOrCtrl+F",
          click: (_item, win) => send(win, "menu:close-project")
        },
        isMac ? { role: "close" } : { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        // Les deux recherches, et le raccourci que tout le monde a dans les
        // doigts. Sans une entrée de menu, l'accélérateur n'existe pas pour le
        // système : ⌘F n'atteindrait l'éditeur que lorsqu'il a déjà le focus, et
        // ⇧⌘F n'ouvrirait jamais le panneau.
        {
          label: "Find in File",
          accelerator: "CmdOrCtrl+F",
          click: (_item, win) => send(win, "menu:find-in-file")
        },
        {
          label: "Find in Project",
          accelerator: "CmdOrCtrl+Shift+F",
          click: (_item, win) => send(win, "menu:find-in-project")
        }
      ]
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+B",
          click: (_item, win) => send(win, "menu:toggle-sidebar")
        },
        {
          label: "Toggle Terminal",
          accelerator: "CmdOrCtrl+`",
          click: (_item, win) => send(win, "menu:toggle-terminal")
        },
        {
          label: "Toggle Agent",
          accelerator: "CmdOrCtrl+Shift+A",
          click: (_item, win) => send(win, "menu:toggle-agent")
        },
        {
          // La même commande que celle qu'un agent déclenche : l'onglet
          // navigateur n'appartient pas à l'agent, c'est l'onglet de la
          // personne, qu'un agent peut aussi ouvrir.
          label: "Test Browser",
          accelerator: "CmdOrCtrl+Shift+B",
          click: (_item, win) => send(win, "browser:open")
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" }
      ]
    },
    { role: "windowMenu" }
  ];
  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
async function forgetDownloadedEngines() {
  const root = path.join(electron.app.getPath("userData"), "engines");
  try {
    await fs.promises.rm(root, { recursive: true, force: true });
  } catch {
  }
}
if (!electron.app.requestSingleInstanceLock()) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", (_event, argv) => {
    const folder2 = folderFromArgv(argv);
    const [win] = electron.BrowserWindow.getAllWindows();
    if (!win) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
    if (folder2) win.webContents.send("menu:open-path", folder2);
  });
  void electron.app.whenReady().then(async () => {
    await prepare(["claude", "codex"]);
    if (isDev && process.platform === "darwin") {
      const icon = appIcon();
      if (icon) electron.app.dock?.setIcon(icon);
    }
    void forgetDownloadedEngines();
    void startShotsServer(() => electron.BrowserWindow.getAllWindows(), browserHost, askHost).catch((err) => {
      console.error("[shots] le serveur de capture n'a pas démarré:", err);
    });
    const browsing = electron.session.fromPartition(BROWSER_PARTITION);
    browsing.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browsing.webRequest.onCompleted((details) => {
      if (!details.webContentsId || details.statusCode < 400) return;
      noteRequest(details.webContentsId, { url: details.url, status: details.statusCode });
    });
    browsing.webRequest.onErrorOccurred((details) => {
      if (!details.webContentsId) return;
      noteRequest(details.webContentsId, { url: details.url, status: 0, error: details.error });
    });
    registerIpc(buildMenu);
    buildMenu();
    createWindow();
    electron.app.on("open-file", (event, filePath) => {
      event.preventDefault();
      const [win] = electron.BrowserWindow.getAllWindows();
      if (win) win.webContents.send("menu:open-path", filePath);
      else createWindow();
    });
    electron.app.on("activate", () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  electron.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") electron.app.quit();
  });
  electron.app.on("before-quit", () => {
    for (const win of electron.BrowserWindow.getAllWindows()) void disposeWorkspace(win);
  });
}
