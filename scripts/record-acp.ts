// node scripts/record-acp.ts <opencode|gemini|qwen>: record what a real ACP harness says to its runner, for the
// conformance suite's fixtures (test/fixtures/acp/<harness>.json, replayed by test/lib/acp-replay.ts). The CLI runs in
// an environment of its own (a fresh HOME and XDG folders under the temp folder, none of the person's config, keys or
// accounts) against the stand-in model API (test/lib/model-stub.ts): no model, no network. Through its runner, as the
// daemon runs it: a session, two messages (a greeting; a shell command, a list of steps, a file written), the quick ops.
// Paths are made neutral: the work folder is "$CWD", the rest is under /Users/sam.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStub } from "../test/lib/model-stub.ts";

const harness = process.argv[2];
const repo = fileURLToPath(new URL("..", import.meta.url));
const which = (bin: string) => spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).stdout.trim();
const real = which(harness);
if (!real) throw new Error(`${harness} is not installed`);
const version = spawnSync(real, ["--version"], { encoding: "utf8" }).stdout.trim();

const root = realpathSync(mkdtempSync(join(tmpdir(), "pagent-record-")));
const home = join(root, "home");
const cwd = join(root, "lisbon");
for (const d of [home, join(root, "config"), join(root, "data"), join(root, "cache"), join(root, "state"), cwd]) mkdirSync(d, { recursive: true });
writeFileSync(join(cwd, "notes.txt"), "Lisbon: sunny, 24°C\n");
const stub = await startStub(0);
const api = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;

// Each CLI pointed at the stand-in, in its own config under the fresh HOME.
const config: Record<string, () => Record<string, string>> = {
  opencode: () => {
    mkdirSync(join(root, "config", "opencode"), { recursive: true });
    writeFileSync(join(root, "config", "opencode", "opencode.json"), JSON.stringify({ provider: { stub: { npm: "@ai-sdk/openai-compatible", name: "Stand-in", options: { baseURL: `${api}/v1`, apiKey: "stand-in" }, models: { "stand-in": { name: "Stand-in", limit: { context: 200000, output: 8000 } } } } }, model: "stub/stand-in", small_model: "stub/stand-in", autoupdate: false, share: "disabled" }));
    return { OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1" };
  },
  gemini: () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" }, folderTrust: { enabled: false } }, general: { enableAutoUpdate: false }, telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false }, model: { name: "gemini-2.5-flash" } }));
    return { GEMINI_API_KEY: "stand-in", GOOGLE_GEMINI_BASE_URL: api, GEMINI_CLI_NO_RELAUNCH: "1", GEMINI_CLI_HOME: home };
  },
  qwen: () => {
    mkdirSync(join(home, ".qwen"), { recursive: true });
    writeFileSync(join(home, ".qwen", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "openai" }, folderTrust: { enabled: false } }, general: { disableAutoUpdate: true }, telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false }, model: { name: "stand-in" } }));
    return { OPENAI_API_KEY: "stand-in", OPENAI_BASE_URL: `${api}/v1`, OPENAI_MODEL: "stand-in" };
  },
};
const log = join(root, "tap.jsonl");
writeFileSync(log, "");
const tap = join(root, "tap.ts");
writeFileSync(tap, readFileSync(join(repo, "test/lib/acp-tap.ts")));
chmodSync(tap, 0o755);
const env: Record<string, string> = {
  PATH: [...new Set([real.replace(/\/[^/]+$/, ""), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":"),
  HOME: home,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
  TMPDIR: join(root, "cache") + "/",
  LANG: "en_US.UTF-8",
  TAP_REAL: real,
  TAP_LOG: log,
  [`${harness.toUpperCase()}_BIN`]: tap,
  ...config[harness](),
};

// The app's end of a permission request: allowed.
const app = createServer((req, res) => {
  req.resume();
  req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ decision: { allow: true } })));
});
await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
const stateDir = join(root, "agent-state");
const base = { cwd, stateDir, env: { PAGENT_NODE: "/lisbon", PAGENT_AGENT: "main" }, permissionUrl: `http://127.0.0.1:${(app.address() as { port: number }).port}/perm`, systemPrompt: "You are the agent of the page /lisbon of a pagent app.", pluginDirs: [] };
const runner = join(repo, "packages/runners/src", `${harness}.ts`);

const child = spawn(process.execPath, [runner], { env, cwd, stdio: ["pipe", "pipe", "inherit"] });
child.stdin.write(JSON.stringify({ op: "session", ...base }) + "\n");
const seen: any[] = [];
const waiting: { test: (e: any) => boolean; resolve: (e: any) => void }[] = [];
let buf = "";
child.stdout.setEncoding("utf8").on("data", (d: string) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0; ) {
    const e = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    seen.push(e);
    for (const w of [...waiting]) if (w.test(e)) waiting.splice(waiting.indexOf(w), 1), w.resolve(e);
  }
});
const until = (test: (e: any) => boolean) => new Promise<any>((resolve, reject) => (waiting.push({ test, resolve }), setTimeout(() => reject(new Error(`no event in 3 minutes (${JSON.stringify(seen.at(-1))})`)), 180_000)));
const ready = await until((e) => e.type === "ready" || e.type === "failed");
if (ready.type === "failed") throw new Error(ready.errorText);
const messages = ["hello Ada", `!sh ls\n!todo read the notes | write a summary\n!write ${join(cwd, "summary.txt")} Lisbon is sunny today.\n!say Done: the summary is in summary.txt.`];
for (const [i, message] of messages.entries()) {
  child.stdin.write(JSON.stringify({ op: "ask", run: `run-${i + 1}`, message }) + "\n");
  await until((e) => e.type === "turn-end" && e.turnId === `run-${i + 1}`);
}
child.stdin.write(JSON.stringify({ op: "stop" }) + "\n");
await new Promise((r) => child.on("close", r));
// opencode's own record of the session (its export), as the history op reads it.
spawnSync(process.execPath, [runner], { env, cwd, input: JSON.stringify({ op: "history", ...base, thread: ready.threadId }), encoding: "utf8" });
app.close();
stub.close();

// Neutral paths: the work folder is $CWD; the rest of the temporary root is /Users/sam.
const neutral = (s: string) => s.split(cwd).join("$CWD").split(root).join("/Users/sam");
const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(neutral(l)));
const exported = lines.find((l) => l.export);
const fixture = {
  harness,
  version,
  recorded: new Date().toISOString().slice(0, 10),
  note: "Recorded by scripts/record-acp.ts: the real CLI against test/lib/model-stub.ts in an isolated HOME, through its runner.",
  messages: lines.filter((l) => l.dir),
  ...(exported ? { export: JSON.parse(exported.stdout.slice(exported.stdout.indexOf("{"))) } : {}),
};
mkdirSync(join(repo, "test/fixtures/acp"), { recursive: true });
writeFileSync(join(repo, "test/fixtures/acp", `${harness}.json`), JSON.stringify(fixture, null, 1) + "\n");
rmSync(root, { recursive: true, force: true });
console.log(`test/fixtures/acp/${harness}.json: ${fixture.messages.length} messages${exported ? ", an export" : ""} (${version})`);
process.exit(0);
