// The app server: pages, node modules, data files, agent calls, events, the agents' `pagent` commands. Two planes are
// the engine's own (SPEC 13): /_pagent/*, the browser's runtime plumbing (the shell, the bridge's HostApi, and the
// harnesses' permission hook), as Next.js has /_next/; and /_cli, the agents' `pagent` commands. /api/** is the app's
// own routes (routes.ts), and /mcp the same routes as MCP tools (mcp.ts): the only paths other devices reach without
// the owner key, and the ones any key is for (keys.ts: checked here, before any route runs).
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, normalize, sep } from "node:path";
import { engine, hasShell } from "./engine.ts";
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage } from "ai";
import { WebSocketServer } from "ws";
import { activeRun, agentOf, agentStatus, ask, askOrDecline, declOf, harnesses, harnessOfAgent, recordWaits, saveAttachments, trajectoryPage, trajectoryRecord, uploadFile, closeQuietAgents, refreshAgents, conflictOf, follow, history, interactiveCommand, lastWords, lookAt, restartTerminal, tuiStale, recoverAgents, redeliver, remoteAt, residency, sessionHandle, startRun, stopTurn, turnsQueued, unattended, unqueue, toolCallOf, untilRun, usageOf, viewMessage, viewPart, whenIdle, type AskInput, type Ctx, type Run } from "./agents.ts";
import { restoreQuestions, runCommand } from "./commands.ts";
import { registerApp } from "./daemon-client.ts";
import { forClient, runAction } from "./actions.ts";
import { callOf } from "./calls.ts";
import { makeFor, tell } from "./tell.ts";
import { readData, writeData } from "./data.ts";
import { encode, encodingFor } from "./encoding.ts";
import { answer, askUser, pendingPrompts } from "./questions.ts";
import { attach, closeQuiet, openTerminal, recoverTerminals, terminalOf } from "./terminal.ts";
import { harnessEnv } from "./shell-env.ts";
import { startTriggers } from "./triggers.ts";
import { serveMcp } from "./mcp.ts";
import { matchRoute, serveRemoteDoor, serveRoute } from "./routes.ts";
import { presence, screenResult } from "./screen.ts";
import { broadcast, onEvent, sse, watchTree } from "./events.ts";
import { readSettings, settingsError, SettingsBroken, watchSettings, writeSettings, type Settings } from "./settings.ts";
import { ensureFork } from "./fork.ts";
import { dynamicPages } from "./dynamic.ts";
import { clientInfo, Nodes } from "./nodes.ts";
import { canonical, codeOf, hasCode, instancePathError, instancesOf, isNode, listNodes, nodeDir, normPath, notMade, resolveRoute, settleRecord, type NodeFile } from "./tree.ts";
import { madeOf, migrateRecords, shownPath } from "./made.ts";
import { moveNode, removeInstance } from "./moves.ts";
import { directory } from "./commands/common.ts";
import { movedText } from "./commands/nodes.ts";
import { cookieName, isLoopbackHost, localAddresses, ownHost, remoteAccess } from "./remote.ts";
import { createKey, presentedKey, reaches, resolveKey, revokeKey, type KeyHolder } from "./keys.ts";

const env = (k: string) => process.env[`PAGENT_${k}`];

export type ServerOptions = { root: string; port: number; /** Where to listen: 127.0.0.1 (default), or e.g. 0.0.0.0 for other devices (remote.ts). */ host?: string };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/** A header's text, percent-encoded by cli.ts when it is not plain ASCII (a path may be /工作); a plain one reads as it is. */
function headerText(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** A response compressed as the browser accepts (compiled modules: small, so fast settings). */
function sendEncoded(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>, body: Buffer) {
  const encoding = encodingFor(String(req.headers["accept-encoding"] ?? ""), body.length);
  const out = encoding ? encode(body, encoding) : body;
  res.writeHead(200, { ...headers, vary: "accept-encoding", ...(encoding ? { "content-encoding": encoding } : {}) });
  res.end(out);
}

const TYPES: Record<string, string> ={ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };

/** Only the app's own pages may show it in a frame: framed by another site's page, the app's buttons (Allow on a
 *  permission, an action's) could sit under that page's own, and the user's click would be the app's (clickjacking). */
const FRAMING = { "content-security-policy": "frame-ancestors 'self'", "x-frame-options": "SAMEORIGIN" };

/** The built shell's entry script ("/assets/index-<hash>.js"), as its index.html loads it: which build it serves now. */
export function shellBuild(): string | null {
  try {
    return /\/assets\/index-[\w-]+\.js/.exec(readFileSync(join(engine.shell, "index.html"), "utf8"))?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * A file of the built shell, or its index.html for any route (the shell routes on the client). That page carries the
 * person's settings as they are now (window.__PAGENT_SETTINGS__, before its own scripts), for its first paint: each app
 * is its own origin, so what this browser remembers from this one may be older than the file.
 */
function serveShell(res: ServerResponse, pathname: string, settings: () => object, key: string | null) {
  const file = normalize(join(engine.shell, decodeURIComponent(pathname)));
  const asset = file.startsWith(engine.shell + sep) && existsSync(file) && statSync(file).isFile();
  const index = join(engine.shell, "index.html");
  const path = asset ? file : index;
  res.writeHead(200, {
    "content-type": TYPES[extname(path)] ?? "application/octet-stream",
    "cache-control": asset && pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    ...(path.endsWith(".html") ? FRAMING : {}),
  });
  if (path !== index) return void res.end(readFileSync(path));
  const inline = JSON.stringify(settings()).replace(/</g, "\\u003c"); // never a "</script>" in it
  const own = key ? `window.__PAGENT_KEY__ = ${JSON.stringify(key)};` : "";
  res.end(readFileSync(path, "utf8").replace("<head>", `<head><script>window.__PAGENT_SETTINGS__ = ${inline};${own}</script>`));
}

/** The app's icon (icon.png at its root, else the shell's) and its size, from the PNG's header. */
function appIcon(root: string): { file: string | null; size: [number, number] | null } {
  const file = [join(root, "icon.png"), join(engine.shell, "icon.png")].find((f) => existsSync(f)) ?? null;
  if (!file) return { file, size: null };
  const head = readFileSync(file).subarray(0, 24);
  const png = head.length === 24 && head.toString("latin1", 12, 16) === "IHDR";
  return { file, size: png ? [head.readUInt32BE(16), head.readUInt32BE(20)] : null };
}

/** Stream a run as an AI SDK UI message stream (SSE), replaying what already happened. */
function streamRun(req: IncomingMessage, res: ServerResponse, run: Run) {
  res.writeHead(200, UI_MESSAGE_STREAM_HEADERS);
  const stop = follow(run, (chunk) => {
    if (chunk) return void res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  req.on("close", stop);
}

// Who may drive this server. It runs actions and agents, so a web page the user happens to open must not reach
// it (CSRF), nor a page whose domain re-resolves to 127.0.0.1 (DNS rebinding). Local processes need no Origin;
// browsers always send one with cross-origin writes and WebSockets, and Sec-Fetch-Site with everything else.
// PAGENT_ALLOWED_HOSTS adds host names beyond loopback (e.g. a tailnet name), each at any port, or at the one it names
// (box.tailnet.ts.net:443); listening beyond loopback (--host) adds this machine's own names and addresses, and asks
// for the access token any device that calls by them, this one too (remote.ts).
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const allowedHosts = (env("ALLOWED_HOSTS") ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean)
  .map((h) => /^(?<name>\[[^\]]*\]|[^:]+):(?<port>\d+)$/.exec(h)?.groups ?? { name: h, port: undefined });
const allowedName = (host: string) => allowedHosts.some((a) => a.name === host.toLowerCase().replace(/:\d+$/, ""));
let remoteOpen = false;
/** A Host this machine's own pages and processes use: loopback, or a name the user allowed. By it, this machine needs no
 *  token (remote.ts). */
const localName = (host: string) => LOOPBACK.test(host) || allowedName(host);
const hostOk = (host: string) => localName(host) || (remoteOpen && ownHost(host));

// The app's public face: its routes and /mcp. Everything else is the user's own.
const PUBLIC = /^\/(api|mcp)(\/|$)/;

// A page that may drive the user's own plane is one of the app's own: its origin is the address the browser reached
// this server at (the Host), whichever name that was: this server's own, the shell's dev server in front of it (vite
// keeps the Host), this machine's name as another device opened it. Another port of localhost is another server (a
// dev server, another pagent app), so the host name alone does not do. A name in PAGENT_ALLOWED_HOSTS is the user's
// word (a proxy in front may rewrite the Host): at the port it names, if it names one (another server may be at another
// port of that name). The public face takes pages from any of this machine's names.
function originOk(req: IncomingMessage, url: URL, origin: URL): boolean {
  if (PUBLIC.test(url.pathname)) return hostOk(origin.host);
  const port = origin.port || (origin.protocol === "https:" ? "443" : "80");
  return origin.host === new URL(`${origin.protocol}//${req.headers.host}`).host || allowedHosts.some((a) => a.name === origin.hostname && (!a.port || a.port === port));
}

/** Why this request is refused, or null. */
function refused(req: IncomingMessage, url: URL): string | null {
  if (!hostOk(req.headers.host ?? "")) return `unexpected Host ${req.headers.host}`;
  const origin = req.headers.origin;
  if (origin) {
    if (origin === "null") return "opaque origin";
    try {
      return originOk(req, url, new URL(origin)) ? null : `cross-origin request from ${origin}`;
    } catch {
      return `bad Origin ${origin}`;
    }
  }
  // No Origin: a local process, a same-origin GET, or a cross-site GET (an <img>, a link). A plain link to a
  // page is fine; anything else from another site is not. Nor, but on the public face, from a page at another port of
  // this machine: its fetch is refused by its Origin (above), but its <img> sends none, and a browser calls it the same
  // site (a site has no port). Such a GET could still fork a node.
  const site = req.headers["sec-fetch-site"];
  const page = req.headers["sec-fetch-mode"] === "navigate" && req.method === "GET" && !/^\/(_pagent|_cli|api|mcp)(\/|$)/.test(url.pathname);
  const foreign = site === "cross-site" || (site === "same-site" && !PUBLIC.test(url.pathname));
  return foreign && !page ? `${site} request` : null;
}

export function startServer(opts: ServerOptions) {
  const { root, port } = opts;
  const host = opts.host ?? "127.0.0.1";
  const remote = isLoopbackHost(host) ? null : remoteAccess(root, localName);
  remoteOpen = !!remote;
  /** The owner key, for a request from another device that has passed the check (it holds the key): what a page of
   *  it needs to hand the key on (a home screen's app, index.html). Null for this machine's own. */
  const deviceKey = (req: IncomingMessage): string | null => {
    if (!remote) return null;
    const from = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    return isLoopbackHost(from) && localName(req.headers.host ?? "") ? null : remote.token;
  };
  // Instances as an older pagent recorded them (or did not) are recorded as this one does (made.ts, SPEC 13.11).
  migrateRecords(root);
  const nodes = new Nodes(root);
  // Without a daemon (it did not start), agents' tokens hold for this server's life.
  const ctx: Ctx = { root, nodes, baseUrl: `http://127.0.0.1:${port}`, secret: randomBytes(32).toString("hex") };
  nodes.url = ctx.baseUrl;
  // Where other machines reach this app (replies to its agents' messages go there): its LAN address when it listens
  // beyond loopback.
  nodes.self = remote ? `http://${host === "0.0.0.0" || host === "::" ? (localAddresses()[0] ?? "127.0.0.1") : host}:${port}` : ctx.baseUrl;
  watchTree(root, (file) => nodes.usersOf(file));
  // Every question asked of the person, and when it was answered: the waits on a trajectory (agents/waits.ts).
  recordWaits(ctx);
  // The person's settings, the same for every app of theirs (settings.ts): a change, made in any of them or by hand,
  // reaches this one's pages.
  const settings = watchSettings((s, rev) => broadcast({ type: "settings", settings: s, rev }));
  /** The settings now, with their rev (the file as it is read now: a change the watcher has not seen yet is one). */
  const settingsNow = () => {
    const now = readSettings();
    return { ...now, rev: settings.changed(now) };
  };
  onEvent((e) => {
    if (e.type !== "code") return;
    nodes.changed(); // what was read or compiled is read again
    // An instance's folder that gained (or lost) a page or layout of its own: its record goes with that code (tree.ts).
    settleRecord(nodeDir(root, e.path));
  });
  // npm packages: pre-bundle what the pages import now, and again when package.json or a lockfile changes. Open
  // pages hear of each new build (the shell reloads if it runs modules of an older one).
  void nodes.deps.start((id) => broadcast({ type: "deps", id }));
  // The environment agents start in (the user's login shell's): read now, so the first agent does not wait for it.
  void harnessEnv();
  // The daemon holds the agents' processes: take back what it kept running for this app, then start triggers
  // (so they see those agents as busy). Requests wait for this: before it, an agent would get a second terminal.
  const ready = (async () => {
    try {
      await registerApp({ root, port, pid: process.pid }, (a) => {
        ctx.hookBase = a.proxy ?? undefined;
        ctx.agentSock = a.agents ?? undefined;
        ctx.secret = a.secret;
      });
      await recoverTerminals(root);
      await recoverAgents(ctx); // sessions, then headless turns (each driver its own)
    } catch (e) {
      console.error(`pagent daemon: ${(e as Error).message}`);
    }
    // What a previous server owed its agents (inbox.ts): messages not delivered yet, questions not answered yet.
    try {
      await redeliver(ctx);
      await restoreQuestions(ctx);
    } catch (e) {
      console.error(`pagent inbox: ${(e as Error).message}`);
    }
  })();
  void ready.then(() => startTriggers(ctx));
  // Agents are resident by default; the ones declared resident: false give their process back when quiet. A harness
  // updated meanwhile reaches the TUIs and the services that run an older one, once they are quiet (refreshAgents).
  setInterval(() => (void closeQuiet((ref) => residency(ctx, ref)), closeQuietAgents(), void refreshAgents(ctx)), Number(process.env.PAGENT_SWEEP_MS) || 60_000).unref(); // tests make it short

  const server = createServer(async (req, res) => {
    await ready;
    const url = new URL(req.url ?? "/", ctx.baseUrl);
    const q = (k: string) => url.searchParams.get(k) ?? "";
    const no = refused(req, url);
    if (no) return json(res, 403, { error: `refused: ${no}` });
    // The app's public face (its routes, and /mcp: the same routes as MCP tools) answers anyone the Host and Origin
    // checks let through; the route decides from its caller. A key it comes with must be valid (else 401: never a
    // stranger instead) and reach the path (else 403); without one it is a stranger. Everything else is the user's own:
    // other devices need the owner key.
    const open = PUBLIC.test(url.pathname);
    let key: KeyHolder | null = null;
    if (open) {
      const presented = presentedKey(req.headers, cookieName(root));
      if (presented) {
        const r = resolveKey(root, presented);
        if ("refused" in r) return json(res, 401, { error: r.refused === "expired" ? `refused: the key "${r.name}" has expired` : "refused: no such key (revoked, or never made here)" });
        key = r.holder;
        if (url.pathname !== "/mcp" && !reaches(key.scope, url.pathname)) return json(res, 403, { error: `refused: the key "${key.name}" is for ${key.scope}, and ${url.pathname} is outside it` });
      }
    }
    const access = open ? "ok" : remote?.check(req, url);
    if (access === "refused") return json(res, 401, { error: "refused: open the URL with ?token=… that `pagent serve` printed" });
    // The manifest's link carries another device's key (index.html): a home screen may fetch it without the cookie.
    if (access === "set" && url.pathname !== "/_pagent/manifest.webmanifest") {
      url.searchParams.delete("token");
      res.writeHead(303, { "set-cookie": remote!.cookie, location: url.pathname + url.search });
      return void res.end();
    }
    // Every client of the user's own plane writes JSON. A page can send text/plain, a form or no body without asking
    // first; JSON only after a CORS preflight, which this server never answers.
    if (!open && (req.method === "POST" || req.method === "PUT") && !/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
      return json(res, 415, { error: "refused: send JSON (content-type: application/json)" });
    }
    try {
      // The app's routes: api/**/route.ts (routes.ts); and a remote agent's message route when the app wrote none.
      if (/^\/api(\/|$)/.test(url.pathname)) {
        const door = matchRoute(root, url.pathname) ? null : await remoteAt(ctx, url.pathname);
        return await (door ? serveRemoteDoor(ctx, door, req, res, url, key) : serveRoute(root, nodes, req, res, url, key));
      }
      // The same routes as MCP tools (mcp.ts).
      if (url.pathname === "/mcp") return await serveMcp(root, nodes, req, res, key);
      // The app's shared npm modules: /_pagent/deps/<build id>/<file>, content-addressed, so cached for good.
      if (req.method === "GET" && url.pathname.startsWith("/_pagent/deps/")) {
        const [id, name] = url.pathname.slice("/_pagent/deps/".length).split("/");
        const f = nodes.deps.file(id ?? "", decodeURIComponent(name ?? ""), String(req.headers["accept-encoding"] ?? ""));
        if (!f) return json(res, 404, { error: "no such dependency module (the app's dependencies were rebuilt: reload)" });
        res.writeHead(200, {
          "content-type": f.type,
          "cache-control": "public, max-age=31536000, immutable",
          vary: "accept-encoding",
          ...(f.encoding ? { "content-encoding": f.encoding } : {}),
        });
        return res.end(f.body);
      }
      switch (`${req.method} ${url.pathname}`) {
        case "GET /_pagent/events":
          return sse(req, res, q("client") || null, shellBuild());

        // The layouts and the page a URL shows; the page's params (the shell's useParams); whether it fills the window
        // (metadata.fill of the page, else of the nearest layout above it that says; a page above it does not say for it).
        case "GET /_pagent/route": {
          const chain = resolveRoute(root, q("path") || "/");
          if (!chain) return json(res, 404, { error: "not found" });
          const page = chain[chain.length - 1].path;
          const fills = await Promise.all(chain.map((e) => nodes.declarations(e.path).then((d) => d.fill[e.file], () => undefined)));
          const fill = fills.reduce<boolean | undefined>((was, f) => f ?? was, undefined) ?? false;
          return json(res, 200, { chain, params: codeOf(root, page)?.params ?? {}, fill });
        }

        // The app's pages with their titles and agents, and where a new page can be made (a dynamic page's instance):
        // the shell's navigation.
        case "GET /_pagent/pages":
          return json(res, 200, { pages: await nodes.pages(), dynamic: dynamicPages(root) });

        // from: an instance (<node>/.mounts/<its key's folder>) of that node, made when it is not there yet; notes: what
        // its frame shows besides it (fork.ts). An instance of a dynamic page is made when it is opened, unless its agents
        // function refuses its params (Nodes.make: the 404 says why); again=1, a page on screen looking again after a
        // change, is no opening: one moved or removed meanwhile is not made again.
        case "GET /_pagent/node": {
          let path = normPath(q("path"));
          let notes: string[] = [];
          if (q("from")) {
            const bad = instancePathError(path);
            if (bad) return json(res, 400, { error: bad });
            notes = await ensureFork(root, path, q("from"));
          } else if (!isNode(root, path)) return json(res, 404, { error: `no node at ${path}` }); // e.g. a card naming a page that is gone
          else {
            // Only a page is made by opening it: a layout above it (/studio/<ws> of studio/[ws]/layout.tsx) is its folder's
            // parent, made with it, or nothing when the page refuses its params.
            path = canonical(root, path);
            const page = hasCode(root, path, "page");
            const no = !page ? null : q("again") && notMade(root, path) ? "it is not there any more (moved or removed)" : await nodes.make(path).then(() => null, (e: Error) => e.message);
            if (no) return json(res, 404, { error: `no node at ${path}: ${no}` });
          }
          return json(res, 200, { ...clientInfo(await nodes.info(path)), ...(notes.length ? { notes } : {}) });
        }

        // Added to a home screen (index.html): the app as its own app, opening at the page it was added from (start), by
        // that page's title. Another device's start carries its key: a home screen's app keeps its own cookies, not the
        // browser's, so it would open refused; with it, it opens as the browser did (a ?token= sets its cookie).
        case "GET /_pagent/manifest.webmanifest": {
          const start = new URL(q("start") || "/", "http://x").pathname;
          const read = (() => {
            try {
              return decodeURIComponent(start);
            } catch {
              return start;
            }
          })();
          const pages = await nodes.pages();
          const here = pages.find((p) => p.url === read)?.title;
          const home = pages.find((p) => p.path === "/")?.title ?? basename(root);
          const key = deviceKey(req);
          const icon = appIcon(root);
          res.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-cache" });
          return res.end(
            JSON.stringify({
              name: here && read !== "/" ? `${here} · ${home}` : (here ?? home),
              short_name: here ?? home,
              start_url: key ? `${start}?token=${key}` : start,
              scope: "/",
              display: "standalone",
              background_color: "#fafaf9",
              theme_color: "#fafaf9",
              icons: [{ src: "/_pagent/icon.png", sizes: icon.size ? `${icon.size[0]}x${icon.size[1]}` : "any", type: "image/png", purpose: "any" }],
            }),
          );
        }

        // Where a phone opens this app (the settings' QR code): its addresses on the LAN and the tailnet, each with the
        // owner key; none when it listens on loopback only (HOST=0.0.0.0 opens it).
        case "GET /_pagent/devices":
          return json(res, 200, { listening: !!remote, urls: remote ? remote.urls(port) : [] });

        // The app's icon: its own icon.png at its root (Next.js's app/icon.png), else pagent's.
        case "GET /_pagent/icon.png": {
          const icon = appIcon(root);
          if (!icon.file) return json(res, 404, { error: "no icon (put an icon.png at the app's root)" });
          res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
          return res.end(readFileSync(icon.file));
        }

        case "GET /_pagent/module": {
          const compiled = await nodes.module(normPath(q("path")), q("file") as NodeFile);
          const code = compiled.errors.length
            ? `export default function CompileError() { throw new Error(${JSON.stringify(compiled.errors.join("\n"))}); }`
            : compiled.code;
          return sendEncoded(req, res, { "content-type": "text/javascript", "cache-control": "no-store" }, Buffer.from(code));
        }

        // The person's settings (settings.ts): read, and changed ({ key: value }, null: its default; 400 says why one
        // cannot be). Every app's pages hear of the change on their event stream, this one's at once.
        // harnesses: the ones there are (each engine runner's, as it names its harness), for the default harness's choice.
        // rev, with both and with the event: which change they are, so a page keeps the newest of what reaches it.
        case "GET /_pagent/settings":
          return json(res, 200, { ...settingsNow(), harnesses: await harnesses() });

        case "PUT /_pagent/settings": {
          const patch = await readBody(req).catch(() => null);
          const no = settingsError(patch);
          if (no) return json(res, 400, { error: no });
          let now: Settings;
          try {
            now = writeSettings(patch as Record<string, unknown>);
          } catch (e) {
            // The file is there and does not read: the person's, not written over (settings.ts).
            if (e instanceof SettingsBroken) return json(res, 409, { error: e.message });
            throw e;
          }
          return json(res, 200, { ...now, rev: settings.changed(now) });
        }

        case "GET /_pagent/data":
          return json(res, 200, readData(root, q("path"), q("file")));

        // { content, base? }: with base (the version the content was computed from), a stale write gets 409 + the current file.
        case "PUT /_pagent/data": {
          const { content, base } = (await readBody(req)) as { content: unknown; base?: string | null };
          const r = writeData(root, q("path"), q("file"), content, base);
          return json(res, r.ok ? 200 : 409, r);
        }

        case "POST /_pagent/ask": {
          // A page's ask (a button, an event): an instruction from the app, which says where it comes from.
          const body = (await readBody(req)) as Omit<AskInput, "caller"> & { origin?: string };
          const node = normPath(body.node);
          const input: AskInput = { node, agent: body.agent, message: body.message, interject: body.interject, caller: { kind: "page", path: normPath(body.origin || node) } };
          return json(res, 200, { text: await ask(ctx, input) });
        }

        // after=<message id>: only from that message on (a view that has the rest), when it is still there. While the
        // agent is in a turn, up to that turn's message: a view then attaches to the turn, which replays its reply.
        // last=<n>: a view's part (viewPart): from after, else the last n turns, before=<message id> (earlier ones, as
        // they are: no turn to attach to there) or the end; earlier: how many messages come before it; long tool input
        // and output cut to a few lines (viewMessage; a card, opened, fetches its call whole: tool-call).
        case "GET /_pagent/history": {
          const ref = { node: normPath(q("node")), agent: q("agent") };
          const turns = Number(q("last"));
          if (!turns) return json(res, 200, { messages: untilRun(await history(ctx, ref, q("after") || undefined), activeRun(ref)) });
          const part = viewPart(await history(ctx, ref), { after: q("after") || undefined, before: q("before") || undefined, turns });
          const messages = part.messages.map(viewMessage);
          const body = { messages: q("before") ? messages : untilRun(messages, activeRun(ref)), earlier: part.earlier };
          return sendEncoded(req, res, { "content-type": "application/json" }, Buffer.from(JSON.stringify(body))); // a phone's, over the network
        }

        // One tool call of the conversation as it is (the view's history has a few lines of each): id=<its tool call id>.
        case "GET /_pagent/tool-call": {
          const call = toolCallOf(await history(ctx, { node: normPath(q("node")), agent: q("agent") }), q("id"));
          return call ? json(res, 200, call) : json(res, 404, { error: `no tool call ${q("id")}` });
        }

        // The agent's session as a timeline (agents/trajectory.ts): its records, long ones cut, and `at`; after=<at>: only
        // what changed since (records, removed: ids, whole: false), or all of it (whole: true); id=<record>: that one whole.
        case "GET /_pagent/trajectory": {
          const ref = { node: normPath(q("node")), agent: q("agent") };
          if (!(await declOf(ctx, ref).catch(() => undefined))) return json(res, 404, { error: `no agent ${ref.node}#${ref.agent}` });
          if (q("id")) {
            const record = await trajectoryRecord(ctx, ref, q("id"));
            return record ? json(res, 200, { record }) : json(res, 404, { error: `no record ${q("id")} in ${ref.node}#${ref.agent}'s trajectory` });
          }
          return json(res, 200, await trajectoryPage(ctx, ref, q("after") || undefined));
        }

        // useChat transport: send a message and stream the reply as a UI message stream. A person writing in a
        // conversation: their words reach the agent as they are; images they added, as files it reads (attachments.ts).
        case "POST /_pagent/chat": {
          const body = (await readBody(req)) as Pick<AskInput, "node" | "agent" | "clientId" | "interject"> & { message: UIMessage };
          const ref = { node: normPath(body.node), agent: body.agent };
          const { text, user } = saveAttachments(ctx, ref, body.message);
          const run = await startRun(ctx, { ...ref, clientId: body.clientId, interject: body.interject, message: text, user, caller: { kind: "user" } });
          return streamRun(req, res, run);
        }

        // A person's message written while the agent works, queued here (not in the page, which may go): it waits for
        // the agent's turn, shown in its status to every page (queued), and starts as any other run then. id: its run's.
        case "POST /_pagent/queue": {
          const body = (await readBody(req)) as Pick<AskInput, "node" | "agent"> & { message: UIMessage };
          const ref = { node: normPath(body.node), agent: body.agent };
          const { text, user } = saveAttachments(ctx, ref, body.message);
          const run = await startRun(ctx, { ...ref, queue: true, message: text, user, caller: { kind: "user" } });
          return json(res, 200, { id: run.id });
        }

        // Withdraw a queued message before its turn comes (its × in the console): it never reaches the agent. withdrawn:
        // false when it no longer waits (its turn came already).
        case "POST /_pagent/unqueue": {
          const body = (await readBody(req)) as { node?: string; agent?: string; id?: string };
          if (!body?.node || !body.agent || !body.id) return json(res, 400, { error: "node, agent and id" });
          return json(res, 200, { withdrawn: unqueue({ node: normPath(body.node), agent: body.agent }, body.id) });
        }

        // An image a person added to a message (attachments.ts), for the conversation's thumbnail.
        case "GET /_pagent/upload": {
          const f = uploadFile(ctx, { node: normPath(q("node")), agent: q("agent") }, q("file"));
          if (!f) return json(res, 404, { error: "no such upload" });
          res.writeHead(200, { "content-type": f.type, "cache-control": "private, max-age=31536000, immutable" });
          return void res.end(readFileSync(f.path));
        }

        // What an agent is doing right now, for status components. said=1: also where it stopped (its last words), for
        // glancing at it (the rail).
        case "GET /_pagent/agent-status": {
          const ref = { node: normPath(q("node")), agent: q("agent") };
          // A remote agent: whether the other app answers is looked at again when the last look is old.
          const [handle, last, usage, can, stale] = await Promise.all([q("handle") ? sessionHandle(ctx, ref) : undefined, q("said") ? lastWords(ctx, ref).catch(() => undefined) : undefined, usageOf(ctx, ref).catch(() => null), harnessOfAgent(ctx, ref).catch(() => ({})), tuiStale(ctx, ref), lookAt(ctx, ref)]);
          // As it is once those are read (they ask its runner, which takes a moment): read before, a turn that started
          // meanwhile would arrive after its run-start as "idle", and undo it. stale: its TUI runs an older declaration
          // ("settings") or an older version of its harness ("update").
          const status = agentStatus(ref);
          const terminal = stale && status.terminal.open ? { ...status.terminal, stale } : status.terminal;
          return json(res, 200, { ...status, terminal, ...last, session: { ...status.session, usage, ...handle, ...can } });
        }

        // A node's action, a function of its "use server" file: a page calling the function it imported (from: the page,
        // the stub says which), or server code calling another node's, which carries on the call it runs in (calls.ts:
        // whom it runs for) and its turn (quit.ts). The value, or the error's message (actions.ts).
        case "POST /_pagent/action": {
          const { node, name, input, from, turn, call } = (await readBody(req)) as { node: string; name: string; input?: unknown; from?: unknown; turn?: unknown; call?: unknown };
          const path = canonical(root, normPath(node)); // /studio/demo/修登录 is /studio/demo/+4fee+767b+5f55
          const caller = callOf(call)?.caller ?? { kind: "page" as const, path: typeof from === "string" ? normPath(from) : path };
          const r = await runAction(root, nodes, path, name, input, { caller, turn: typeof turn === "string" ? turn : undefined });
          if (!r.ok) console.error(`action ${path}:${name} failed:\n${r.stack ?? r.error}\n${r.logs}`.trim());
          return json(res, 200, forClient(r));
        }

        // tell() from the app's server code ("pagent/server"): it names the call it runs in (calls.ts), which says whom
        // it runs for. A process the engine did not start has none.
        case "POST /_pagent/tell": {
          const b = (await readBody(req)) as { call?: string; to?: string; message?: string; from?: string; stranger?: boolean; interject?: boolean; wait?: boolean | number; new?: boolean; noReply?: boolean };
          const call = callOf(b.call);
          if (!call) return json(res, 403, { error: "tell() works in the app's server code (an action, a route), as the engine runs it" });
          try {
            return json(res, 200, await tell(ctx, call, String(b.to ?? ""), String(b.message ?? ""), { from: b.from, stranger: !!b.stranger, interject: !!b.interject, wait: b.wait, new: !!b.new, noReply: !!b.noReply }));
          } catch (e) {
            return json(res, 422, { error: (e as Error).message });
          }
        }

        // `pagent tell --as <name>` from a session on this computer outside the app (cli.ts): the person's own plane, as
        // stop and move are. It waits for the reply (wait), or asks for none: it has no address a later one could go to.
        case "POST /_pagent/local-tell": {
          const b = (await readBody(req)) as { as?: string; to?: string; message?: string; wait?: boolean | number; interject?: boolean };
          const name = String(b.as ?? "");
          if (!/^[\w.-]{1,40}$/.test(name)) return json(res, 400, { error: `--as names the session telling, a short word ([A-Za-z0-9_.-], up to 40): "${name}"` });
          try {
            return json(res, 200, await tell(ctx, { caller: { kind: "local", name } }, String(b.to ?? ""), String(b.message ?? ""), { interject: !!b.interject, ...(b.wait ? { wait: b.wait } : { noReply: true }) }));
          } catch (e) {
            return json(res, 422, { error: (e as Error).message });
          }
        }

        // nodes.make from the app's server code ("pagent/server"): an instance of a dynamic page, made now with data files
        // in it, recorded as made by whom the call runs for (as `tell --new` records it). It, as nodes.instances lists it.
        case "POST /_pagent/make": {
          const b = (await readBody(req)) as { call?: string; path?: string; data?: unknown };
          const call = callOf(b.call);
          if (!call) return json(res, 403, { error: "nodes.make works in the app's server code (an action, a route), as the engine runs it" });
          if (b.data !== undefined && (typeof b.data !== "object" || b.data === null || Array.isArray(b.data))) return json(res, 400, { error: "nodes.make: data is { file: content }" });
          try {
            const path = await makeFor(ctx, String(b.path ?? ""), call.caller, (b.data ?? {}) as Record<string, unknown>);
            const made = madeOf(root, path);
            return json(res, 200, { path, url: shownPath(root, path), params: codeOf(root, path)?.params ?? {}, ...(made.by ? { createdBy: made.by } : {}), createdAt: made.at });
          } catch (e) {
            return json(res, 422, { error: (e as Error).message });
          }
        }

        // keys.create / keys.revoke from the app's server code ("pagent/server"), in a call the engine runs (calls.ts).
        case "POST /_pagent/key": {
          const b = (await readBody(req)) as { call?: string; create?: { scope?: string; name?: string; ttl?: string | number }; revoke?: string };
          if (!callOf(b.call)) return json(res, 403, { error: "keys work in the app's server code (an action, a route), as the engine runs it" });
          try {
            if (b.revoke !== undefined) return json(res, 200, { revoked: revokeKey(root, String(b.revoke)) });
            return json(res, 200, createKey(root, { scope: String(b.create?.scope ?? ""), name: b.create?.name, ttl: b.create?.ttl }));
          } catch (e) {
            return json(res, 422, { error: (e as Error).message });
          }
        }

        // Screen relay: browsers report what they show; a job's result comes back here.
        case "POST /_pagent/presence":
          presence((await readBody(req)) as Parameters<typeof presence>[0]);
          return json(res, 200, { ok: true });

        case "POST /_pagent/screen-result": {
          const { id, text } = (await readBody(req)) as { id: string; text: string };
          return json(res, screenResult(id, text) ? 200 : 404, { ok: true });
        }

        // A harness asks before a tool runs (runners/src/lib/contract.ts, PermissionRequest): what the runner of any
        // harness sends, for its TUI and its headless turns alike. Unattended runs are declined; while someone watches
        // the agent's terminal, no decision (the harness asks in its own prompt); otherwise the request becomes a
        // permission card the shell shows on any page, and the answer is the decision.
        case "POST /_pagent/permission": {
          const ref = { node: normPath(q("node")), agent: q("agent") };
          if (!(await declOf(ctx, ref).catch(() => undefined))) return json(res, 404, { error: `no agent ${ref.node}#${ref.agent}` });
          const body = ((await readBody(req).catch(() => null)) ?? {}) as { tool?: string; input?: unknown; meta?: { kind?: string; command?: string; files?: string[]; url?: string; plan?: string }; detail?: string; tool_name?: unknown };
          // A harness process older than this server (an old Claude Code TUI's HTTP hook, an old Codex session) asks in
          // the shape it was started with ({ tool_name, tool_input }) and reads only a hook's answer: it is told no at
          // once, in the words it reads, rather than shown a card about nothing or left waiting.
          if (body.tool === undefined && body.tool_name !== undefined) {
            const why = `${ref.node}#${ref.agent}: this harness process is older than the server: restart its agents (pagent daemon restart)`;
            console.warn(`${why}; denied ${String(body.tool_name)}`);
            return json(res, 200, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: why } }, decision: { allow: false, message: why } });
          }
          const decide = (allow: boolean, message?: string) => json(res, 200, { decision: { allow, ...(message ? { message } : {}) } });
          if (terminalOf(ref)?.viewers.size && !unattended(ref)) return json(res, 200, {});
          const tool = body.tool || undefined;
          const meta = body.meta ?? { kind: "other" };
          // A question it asks the user (Claude Code's AskUserQuestion) in its TUI: no decision, so its own dialog shows
          // the question with its choices, and that becomes the card (agents/tui.ts), not "Allow AskUserQuestion?".
          if (meta.kind === "ask" && terminalOf(ref) && !unattended(ref)) return json(res, 200, {});
          const gone = new AbortController();
          res.on("close", () => res.writableEnded || gone.abort());
          // A plan to go ahead with (a proposal: its plan, markdown): the card shows it rendered; only the option
          // Approve allows; Keep planning keeps it planning, and anything typed ("Approve, but use pnpm") is what to change.
          if (meta.kind === "proposal") {
            const say = { question: { key: "ask.plan" }, options: [{ key: "ask.planYes" }, { key: "ask.planKeep" }] };
            const r = await askOrDecline(ref, () => askUser(ref, "Go ahead with this plan?", ["Approve", "Keep planning"], { kind: "permission", plan: meta.plan ?? "", toolKind: meta.kind, say, signal: gone.signal }));
            if (gone.signal.aborted) return;
            if (r.declined) return decide(false, r.answer);
            if (r.answer === "Approve") return decide(true);
            const change = r.answer && r.answer !== "Keep planning" ? r.answer : "";
            return decide(false, change ? `The user did not approve the plan yet. What they want changed: ${change}` : "The user did not approve the plan yet: keep planning.");
          }
          const detail = body.detail ?? meta.command ?? meta.files?.join("\n") ?? meta.url ?? JSON.stringify(body.input ?? {}, null, 2);
          const say = { question: tool ? { key: "ask.allow", values: { tool } } : { key: "ask.allowThisTool" }, options: [{ key: "ask.allowYes" }, { key: "ask.deny" }] };
          const r = await askOrDecline(ref, () => askUser(ref, `Allow ${tool ?? "this tool"}?`, ["Allow", "Deny"], { kind: "permission", detail, toolKind: meta.kind, say, signal: gone.signal }));
          if (gone.signal.aborted) return;
          if (r.declined) return decide(false, r.answer);
          // Only the option Allow allows: anything typed ("allow, but not in src/") is a no, with what they said.
          return r.answer === "Allow" ? decide(true) : decide(false, `The user declined${r.answer && r.answer !== "Deny" ? `: ${r.answer}` : ""}.`);
        }

        // An agent's `pagent` command (cli.ts), from its shell through the daemon's socket. Only an agent of this app
        // may run one: its token (from its environment) must be that agent's.
        case "POST /_cli": {
          const { argv, cwd } = (await readBody(req)) as { argv?: string[]; cwd?: string };
          const h = (k: string) => headerText(String(req.headers[`x-pagent-${k}`] ?? ""));
          const me = agentOf(ctx, h("node"), h("agent"), h("token"));
          if (!me) return json(res, 200, { stderr: "pagent: this shell is not an agent of this app (its PAGENT_NODE / PAGENT_AGENT / PAGENT_TOKEN are missing or wrong). Agents get them from the app; people use `pagent serve` and `pagent add`.", exit: 2 });
          const args = Array.isArray(argv) ? argv.map(String) : [];
          const out = await runCommand(ctx, me, args, typeof cwd === "string" ? cwd : root);
          console.log(`${me.node}#${me.agent} $ pagent ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ").slice(0, 200)} → ${out.exit ?? 0}`);
          return json(res, 200, out);
        }

        // What the shell shows on any page: permission requests and forms.
        case "GET /_pagent/prompts":
          return json(res, 200, { questions: pendingPrompts() });

        // values: a form's (none: cancelled). A Secure Form's value is in this request and nowhere else: it goes where
        // it goes (into.ts) and is not logged, nor is this body.
        case "POST /_pagent/answer": {
          const body = (await readBody(req).catch(() => null)) as { id: string; answer?: string; values?: Record<string, string> } | null; // a parse error quotes the body
          if (!body) return json(res, 400, { ok: false, error: "not JSON" });
          const { id, answer: text, values } = body;
          const r = await answer(id, String(text ?? ""), values && typeof values === "object" ? values : undefined);
          return json(res, r.ok ? 200 : r.error?.startsWith("no such question") ? 404 : 422, r);
        }

        // Stop the agent's turn in progress (a page's Stop button; `pagent stop` from an agent or a terminal). said: what
        // was done, null when it was in no turn.
        case "POST /_pagent/stop": {
          const body = (await readBody(req)) as { node?: string; agent?: string };
          if (!body?.node || !body.agent) return json(res, 400, { error: "node and agent" });
          return json(res, 200, { said: await stopTurn(ctx, { node: normPath(body.node), agent: body.agent }) });
        }

        // Restart the agent's terminal on its session, to take its declaration and its harness as they are now (its
        // status says the one running is stale): a page's button. 409 during a turn.
        case "POST /_pagent/terminal/restart": {
          const body = (await readBody(req)) as { node?: string; agent?: string };
          if (!body?.node || !body.agent) return json(res, 400, { error: "node and agent" });
          try {
            return json(res, 200, { said: await restartTerminal({ node: normPath(body.node), agent: body.agent }) });
          } catch (e) {
            return json(res, 409, { error: (e as Error).message });
          }
        }

        // Moving a node and removing an instance of a dynamic page (moves.ts): the person's `pagent mv`, and server code's
        // nodes.move / nodes.remove ("pagent/server"). 422 with why when it is refused.
        case "POST /_pagent/move":
        case "POST /_pagent/remove": {
          const body = (await readBody(req)) as { from?: string; to?: string; path?: string };
          try {
            if (url.pathname === "/_pagent/remove") return json(res, 200, { removed: await removeInstance(ctx, String(body.path ?? "")) });
            const moved = await moveNode(ctx, String(body.from ?? ""), String(body.to ?? ""));
            return json(res, 200, { ...moved, text: movedText(moved) });
          } catch (e) {
            return json(res, 422, { error: (e as Error).message });
          }
        }

        // The instances of a dynamic page that are made (of: its code's path, /studio/[ws]/[id]): their address as the
        // engine has it (path) and as people read it (url), their params, who made them and when (made.ts).
        // What every agent of the app is doing now, for server code (agentStatus() of "pagent/server"): the same as
        // agent-status, in short.
        case "GET /_pagent/agents": {
          const list = await directory(ctx);
          return json(res, 200, {
            agents: list.map((a) => {
              const s = agentStatus(a);
              return { address: a.address, busy: s.busy, activity: s.activity, since: s.since, quietSince: s.quietSince, stuck: s.stuck, queued: s.queued.length, ...(s.offline ? { offline: s.offline } : {}) };
            }),
          });
        }

        // What the person's `pagent agents` and `pagent tree` print (cli.ts), for a session outside the app: its pages
        // (route: a URL of its own; title, its metadata's) and the agents on each, as an agent's `pagent agents` has them.
        case "GET /_pagent/directory": {
          const agents = await directory(ctx);
          const rows = [];
          for (const path of listNodes(root)) {
            const d = await nodes.declarations(path).catch(() => null);
            if (!d) continue;
            rows.push({
              path,
              url: shownPath(root, path),
              ...(d.manifest.title ? { title: d.manifest.title } : {}),
              route: !path.split("/").some((x) => x.startsWith(".")) && hasCode(root, path, "page"),
              agents: agents.filter((a) => a.node === path).map(({ node: _, folder: __, ...a }) => a),
            });
          }
          return json(res, 200, { root, nodes: rows });
        }

        case "GET /_pagent/instances":
          return json(res, 200, {
            instances: instancesOf(root, q("of")).map((path) => {
              const made = madeOf(root, path);
              return { path, url: shownPath(root, path), params: codeOf(root, path)?.params ?? {}, ...(made.by ? { createdBy: made.by } : {}), createdAt: made.at };
            }),
          });

        // useChat transport: attach to whatever the agent is doing right now (204 = idle).
        case "GET /_pagent/chat/stream": {
          const run = activeRun({ node: normPath(q("node")), agent: q("agent") });
          if (!run) return void res.writeHead(204).end();
          return streamRun(req, res, run);
        }

      }
      // The shell itself (the published package carries it prebuilt; in the repository vite serves it).
      if (req.method === "GET" && !/^\/(_pagent|_cli|api|mcp)(\/|$)/.test(url.pathname) && hasShell()) return serveShell(res, url.pathname, settingsNow, deviceKey(req));
      json(res, 404, { error: "not found" });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
    }
  });

  // An agent's native TUI over a WebSocket: output as text frames, input / resize / kill as JSON.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", ctx.baseUrl);
    if (url.pathname !== "/_pagent/terminal" || refused(req, url) || remote?.check(req, url) === "refused") return void socket.destroy();
    const ref = { node: normPath(url.searchParams.get("node") ?? "/"), agent: url.searchParams.get("agent") ?? "" };
    const size = { cols: Number(url.searchParams.get("cols")) || 100, rows: Number(url.searchParams.get("rows")) || 30 };
    wss.handleUpgrade(req, socket, head, async (ws) => {
      // A frame ws cannot take (a text frame that is not UTF-8, say) is an error, and ws closes the connection itself;
      // unheard, the error would take the server down.
      ws.on("error", () => {});
      try {
        await ready;
        // One process per session: the app's own runs finish first, and another process holding the session is
        // the user's call (fork it, open anyway, or close that one). A shared thread takes the TUI as one
        // more client, mid-turn too. Control frames start with NUL.
        let term = terminalOf(ref);
        if (!term) {
          const choice = url.searchParams.get("choice");
          if (await turnsQueued(ctx, ref)) await whenIdle(ref);
          const conflict = choice ? null : await conflictOf(ctx, ref);
          term = terminalOf(ref); // opened meanwhile by another view; the holder seen may be that very process
          if (!term && conflict) {
            ws.send(`\0${JSON.stringify({ type: "conflict", ...conflict })}`);
            return void ws.close(4009, "session busy");
          }
          term ??= await openTerminal(ref, await interactiveCommand(ctx, ref, choice === "fork"), size);
        }
        // null: the TUI was restarted (its thread's session came back); the view reconnects to the new one.
        const io = attach(term, (data) => ws.readyState === ws.OPEN && (data === null ? ws.close(4000, "restarted") : ws.send(data)));
        io.resize(size.cols, size.rows);
        ws.on("message", (raw) => {
          // A frame that is not JSON (or not an object) is dropped: thrown here, it would take the server down.
          let m: { type?: "input" | "resize" | "kill"; data?: string; cols?: number; rows?: number } | null;
          try {
            m = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (m?.type === "input") io.input(m.data ?? "");
          else if (m?.type === "resize") io.resize(m.cols ?? 0, m.rows ?? 0);
          else if (m?.type === "kill") io.kill();
        });
        ws.on("close", io.detach);
      } catch (e) {
        ws.send(`\r\n${(e as Error).message}\r\n`);
        ws.close();
      }
    });
  });

  server.listen(port, host, () => {
    console.log(`pagent serving ${root} on ${ctx.baseUrl}`);
    if (remote) console.log(`other devices (listening on ${host}):\n${remote.urls(port).map((u) => `  ${u}`).join("\n")}`);
  });
  return server;
}
