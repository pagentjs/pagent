// A stand-in for Codex's app-server, for the conformance suite's quick ops of the codex runner (history, info, usage):
// it serves the threads of recorded rollouts (test/fixtures/trajectory/codex: codex-cli 0.163.0's own) on the socket the
// runner connects to, answering what those ops ask (thread/list, thread/read, thread/turns/list, account/rateLimits/read),
// each turn's items turned from the rollout's (item_completed: UserMessage, AgentMessage, CommandExecution, FileChange,
// ContextCompaction) into the app-server's shapes. Not a Codex: no turns run here (its live session is the smoke tests').
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createRequire } from "node:module";

// ws is the runners' dependency (the codex runner speaks WebSocket to its app-server): from there.
type Socket = { on(e: "message", cb: (raw: unknown) => void): void; send(data: string): void };
const { WebSocketServer } = createRequire(new URL("../../packages/runners/package.json", import.meta.url))("ws") as {
  WebSocketServer: new (o: { server: Server }) => { on(e: "connection", cb: (ws: Socket) => void): void };
};

type Rollout = { id: string; path: string; cwd: string; turns: { id: string; items: any[]; startedAt?: number; completedAt?: number; status: string }[] };

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".jsonl") ? [join(dir, e.name)] : []));

/** An item as the app-server says it (camelCase, v2), from the rollout's. */
function itemOf(it: any): any | null {
  switch (it.type) {
    case "UserMessage":
      return { type: "userMessage", id: it.id, content: (it.content ?? []).map((c: any) => ({ type: "text", text: c.text ?? "" })) };
    case "AgentMessage":
      return { type: "agentMessage", id: it.id, text: (it.content ?? []).map((c: any) => c.text ?? "").join("") };
    case "CommandExecution":
      return { type: "commandExecution", id: it.id, command: Array.isArray(it.command) ? it.command.at(-1) : it.command, aggregatedOutput: it.aggregated_output ?? "", exitCode: it.exit_code ?? 0, status: it.status };
    case "FileChange":
      return { type: "fileChange", id: it.id, changes: Object.entries(it.changes ?? {}).map(([path, c]: [string, any]) => ({ path, kind: { type: c.type }, diff: c.content ?? c.unified_diff ?? "" })), status: it.status };
    case "ContextCompaction":
      return { type: "contextCompaction", id: it.id };
    default:
      return null;
  }
}

function read(path: string): Rollout {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const meta = lines.find((l) => l.type === "session_meta")?.payload ?? {};
  const turns = new Map<string, Rollout["turns"][number]>();
  for (const l of lines) {
    const p = l.payload ?? {};
    if (l.type !== "event_msg") continue;
    const id = p.turn_id;
    if (!id) continue;
    const t: Rollout["turns"][number] = turns.get(id) ?? { id, items: [], status: "inProgress" };
    turns.set(id, t);
    if (p.type === "task_started") t.startedAt = Date.parse(l.timestamp) / 1000;
    if (p.type === "task_complete") (t.completedAt = Date.parse(l.timestamp) / 1000), (t.status = "completed");
    if (p.type === "item_completed") {
      const item = itemOf(p.item);
      if (item) t.items.push(item);
    }
  }
  return { id: meta.id ?? meta.thread_id, path, cwd: meta.cwd, turns: [...turns.values()] };
}

/** What the codex runner's appServer() names a version by: the program `command` runs, through links, and its mtime. */
function installed(command: string): string {
  const dirs = command.includes("/") ? [""] : (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const d of dirs) {
    try {
      const file = realpathSync(d ? join(d, command) : command);
      return `${file}\t${Math.round(statSync(file).mtimeMs)}`;
    } catch {}
  }
  return "";
}

/**
 * Serve the rollouts under `codexHome` for the codex runner whose PAGENT_HOME is `pagentHome` (the socket it looks for,
 * as its appServer() names it). Returns the server, to close.
 */
export async function standInAppServer(codexHome: string, pagentHome: string): Promise<Server> {
  const threads = new Map(files(join(codexHome, "sessions")).map((f) => read(f)).map((r) => [r.id, r]));
  const id = createHash("sha1").update(codexHome).digest("hex").slice(0, 10);
  const version = createHash("sha1").update(installed(process.env.CODEX_BIN ?? "codex")).digest("hex").slice(0, 6);
  // Where the runner looks (its appServer()): under PAGENT_HOME, or the temp folder when that is too long for a socket;
  // one per version of the Codex it would run.
  const inHome = join(pagentHome, `codex-${id}-${version}.sock`);
  const socket = inHome.length < 100 ? inHome : join(tmpdir(), `pagent-codex-${id}-${version}.sock`);
  rmSync(socket, { force: true });
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.id === undefined) return;
      const p = m.params ?? {};
      const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, result }));
      const fail = (message: string) => ws.send(JSON.stringify({ id: m.id, error: { message } }));
      const t = threads.get(p.threadId);
      switch (m.method) {
        case "initialize":
          return reply({ userAgent: "stand-in" });
        case "thread/list":
          return reply({ data: [...threads.values()].filter((r) => !p.cwd || r.cwd === p.cwd).map((r) => ({ id: r.id, cwd: r.cwd, path: r.path })), nextCursor: null });
        case "thread/read":
          return t ? reply({ thread: { id: t.id, cwd: t.cwd, path: t.path, model: "gpt-5.1-codex" } }) : fail("no thread");
        case "thread/turns/list":
          return t ? reply({ data: t.turns, nextCursor: null }) : fail("no thread");
        case "account/rateLimits/read":
          return reply({ rateLimits: null });
        default:
          return fail(`the stand-in has no ${m.method}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  return server;
}
