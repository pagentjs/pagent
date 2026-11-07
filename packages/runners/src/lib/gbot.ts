// The seam to Grok Bot (runner:grokbot): its community CLI, `gbot` (npm grok-bot-cli), which reuses the Grok Bot
// desktop app's session. Grok Bot has no API of its own; the runner talks to it only through gbot, never through the
// app's files or its keychain item. GBOT_BIN: another gbot (a script is run with node: the tests' stand-in).
//
// Its computer sleeps about half a minute after the bot last did something, and the app's way in then fails (417, or
// the descriptor gone: below). gbot's other way in wakes it: with CURSOR_ACCESS_TOKEN it asks Cursor's backend for the
// computer (EnsureSandBox), which starts it (seen live 2026-10-20: 417 on the app's way, then the token's way answered
// in 12 s and the app's way worked again). So a call that finds it asleep is made again that way, with the person's
// Cursor login (CURSOR_ACCESS_TOKEN, else Cursor.app's own store, else the Cursor CLI's keychain item; read when
// needed and kept nowhere) and the Grok Bot app's version (older clients are refused: "This version of Grok Bot is no
// longer supported"). While it starts, the gateway's calls on it time out ("getAgentTranscriptTail failed: 500
// [deadline_exceeded]", or 503): a read is tried again for up to a minute, a send only while it fails finding the bot
// (after that it may have gone through).
// Asleep is no one's business then: what to do by hand is said only when there is no Cursor login to wake it with, or
// Cursor's backend refused it ("wake").
//
// Every call of gbot's but doctor goes to the gateway on that computer (gbot 0.12.4: listAgents, getAgentTranscriptTail,
// sendPrompt …), so each wakes it: there is nothing cheaper to ask (no last-activity, no list of the bot's schedules,
// no stream; `--ndjson` is gbot's own rendering, `history` its local log of what it sent).
//
// What gbot says (0.12.4, its --json): a command's value on stdout, exit 0; a failure as {error: {code, message}}
// (send: {delivery: "rejected", error, reason}), exit 1; a usage error as text. Its known breakage (grok-bot-cli #147,
// #143) is said here as what to do: the app keeps the gateway's descriptor only when its computer was awake as the app
// connected, so gbot falls back to its files mode ("Could not find a Grok Bot agents directory"); the app's newer
// descriptor (version 3) is refused by an unpatched 0.12.4.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { Login } from "./grokbot-accounts.ts";

export const RELAUNCH = `osascript -e 'tell application "Grok Bot" to quit' && open -a "Grok Bot"`;
const AWAKE = `relaunch it while its computer is awake (\`${RELAUNCH}\`), e.g. right after the bot did something`;
const NO_SESSION = `Grok Bot app has no live session: ${AWAKE}`;
const V3 = "gbot too old for descriptor v3: the Grok Bot app writes a version 3 gateway descriptor, which grok-bot-cli 0.12.4 refuses; update it (`npm i -g grok-bot-cli@latest`) or apply https://github.com/ScriptedAlchemy/grok-bot-cli/pull/143";
const BY_HAND = `wake it (open the bot in the Grok Bot app and send it something), or ${AWAKE.replace("relaunch it", "relaunch the app")}; with a Cursor login (Cursor.app or \`cursor-agent\` signed in, or CURSOR_ACCESS_TOKEN) pagent wakes it itself`;

/**
 * Why gbot failed, as what to do about it. kind: no-bot (the declared bot is not there); gateway (its computer did not
 * answer: asleep, starting); wake (Cursor's backend refused to wake it: a person must act); send-refused (a message was
 * refused, not sent: sendByLogin); else anything else.
 */
export class GbotError extends Error {
  kind: "missing" | "no-session" | "descriptor" | "no-bot" | "gateway" | "wake" | "send-refused" | "unknown-delivery" | "other";
  /** gateway: what gbot said, or how long it went unanswered. */
  said?: string;
  constructor(kind: GbotError["kind"], message: string, said?: string) {
    super(message);
    this.kind = kind;
    if (said) this.said = said;
  }
}

/** A failure as the app shows it: saying it is Grok Bot's (or gbot's). */
export const said = (m: string) => (/^(Grok Bot|gbot)\b/i.test(m) ? m : `Grok Bot: ${m}`);

/** What gbot said when it failed, said as what to do. */
export function explain(text: string): GbotError {
  const s = text.trim();
  if (/Could not find a Grok Bot agents directory|requires the live gateway|Set CURSOR_ACCESS_TOKEN/.test(s)) return new GbotError("no-session", NO_SESSION);
  const v = /Unsupported Grok Bot gateway descriptor version (\d+)/.exec(s);
  if (v) return new GbotError("descriptor", v[1] === "3" ? V3 : `gbot does not read the Grok Bot app's gateway descriptor (version ${v[1]}): update grok-bot-cli (\`npm i -g grok-bot-cli@latest\`)`);
  // Since 2026-11 (seen with Grok Bot 0.78): a message sent by the Cursor login is refused; it still reads and wakes.
  // Since Grok Bot 0.78 (2026-11-04) its computer's gateway refuses gbot's sendPrompt, whichever way gbot came in; it
  // still reads and wakes. The app sends through Cursor's backend instead (sendByLogin).
  if (/Sand ?box session is not permitted/i.test(s)) return new GbotError("send-refused", `Grok Bot's computer refused gbot's message (${s.replace(/ \(delivery unknown[^)]*\)/, "")}; it was not sent)`);
  if (/No bot or group named|Ambiguous name/.test(s)) return new GbotError("no-bot", `${s} (gbot bots list shows them; a name that is not unique needs the bot's id)`);
  if (/delivery unknown/.test(s)) return new GbotError("unknown-delivery", `Grok Bot may or may not have the message (${s}); its reply, if it comes, shows in the history`);
  // The Cursor login's way in (gbot's EnsureSandBox): an old client version, or a login that no longer works.
  if (/no longer supported/i.test(s)) return new GbotError("wake", `Cursor's backend refused gbot's Grok Bot version (${s}): set SAND_CLIENT_VERSION to the Grok Bot app's version, or update the app`);
  if (/EnsureSandBox failed: 40[13]\b/.test(s)) return new GbotError("wake", `Cursor's backend refused the Cursor login gbot used to wake Grok Bot's computer (${s}): sign in to Cursor again (open Cursor.app once, or \`cursor-agent login\`), or ${AWAKE.replace("relaunch it", "relaunch the Grok Bot app")}`);
  const http = /(\w+) failed: (\d{3})\b/.exec(s);
  if (http || /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|aborted due to timeout|socket hang up|deadline_exceeded/i.test(s)) {
    // Seen live (2026-10-20): "listAgents failed: 417" from about half a minute after the bot last did something, the
    // app's session still "usable" by gbot's doctor; it answered again once the computer was awake.
    return asleep(s);
  }
  return new GbotError("other", `gbot: ${s}`);
}

/** Its computer did not answer: likely asleep (what to do about it is gbot()'s to say, by whether it can wake it). */
const asleep = (s: string) => new GbotError("gateway", `Grok Bot's computer did not answer gbot (${s}): it is likely asleep`, s);

const script = (bin: string) => /\.(ts|mjs|js)$/.test(bin);

/**
 * Run gbot, its JSON value. Its environment is the harness's, without what makes gbot say the message comes from a
 * Codex thread (CODEX_THREAD_ID, set when pagent itself runs inside Codex).
 */
/**
 * The account this process works on (grokbot-accounts.ts), or null: whichever the Grok Bot app is on. Set, every call
 * goes to that account by its login (the Cursor login's way in below), never through the app's session.
 */
let account: Login | null = null;
export const useAccount = (a: Login | null) => void (account = a);
export const accountNow = () => account;

export async function gbot(args: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<any> {
  try {
    return await run(args, opts, account ? (cursorEnv() ?? {}) : {});
  } catch (e) {
    // Asleep, or the app's descriptor gone: by the Cursor login, which wakes the computer.
    if (!(e instanceof GbotError) || !["gateway", "no-session", "descriptor"].includes(e.kind) || opts.signal?.aborted) throw e;
    const cursor = cursorEnv();
    if (!cursor) throw e.kind === "gateway" ? new GbotError("gateway", `${e.message}; ${BY_HAND}`, e.said) : e;
    // A read, again until it is up (the gateway's calls time out while it starts); anything else too while it failed
    // finding the bot (gbot's first call: nothing was done), but a send that may have gone through only once.
    const read = args[0] === "thread" || (args[0] === "bots" && args[1] === "get") || (args[0] === "approvals" && args[1] === "list");
    const until = Date.now() + num(process.env.GBOT_WAKE_MS, 60_000);
    for (;;) {
      try {
        return await run(args, { ...opts, timeoutMs: read ? Math.max(until - Date.now(), 15_000) : Math.max(opts.timeoutMs ?? 60_000, 90_000) }, cursor);
      } catch (f) {
        if (!(f instanceof GbotError) || f.kind !== "gateway") throw f; // refused to wake it ("wake"), or anything else
        if (!(read || /^listAgents failed/.test(f.said ?? "")) || Date.now() >= until || opts.signal?.aborted) throw new GbotError("gateway", `Grok Bot's computer did not answer gbot, though pagent woke it with the Cursor login (${f.said ?? f.message}): it may still be starting`, f.said);
        await new Promise((r) => setTimeout(r, num(process.env.GBOT_WAKE_RETRY_MS, 3000)));
      }
    }
  }
}

const num = (v: unknown, d: number) => (Number(v) > 0 ? Number(v) : d);

function run(args: string[], { timeoutMs = 60_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}, more: NodeJS.ProcessEnv = {}): Promise<any> {
  const bin = process.env.GBOT_BIN || "gbot";
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", ...more };
  delete env.CODEX_THREAD_ID;
  return new Promise((resolve, reject) => {
    const child = spawn(script(bin) ? process.execPath : bin, script(bin) ? [bin, ...args] : args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
    const kill = () => child.kill("SIGTERM");
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? new GbotError("missing", `gbot not found (${bin}): install grok-bot-cli (\`npm i -g grok-bot-cli\`), or set GBOT_BIN`) : e);
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (sig) return reject(new GbotError("gateway", signal?.aborted ? "stopped" : `gbot ${args[0]} took longer than ${Math.round(timeoutMs / 1000)} s: Grok Bot's computer may be asleep`, `no answer in ${Math.round(timeoutMs / 1000)} s`));
      let value: any;
      try {
        value = JSON.parse(out);
      } catch {
        return reject(code === 0 ? new GbotError("other", `gbot ${args[0]} said no JSON: ${out.slice(0, 300)}`) : explain(`${out}\n${err}`.trim() || `exit ${code}`));
      }
      if (value && typeof value === "object" && (value.error || value.delivery === "rejected" || (typeof value.exitCode === "number" && value.exitCode !== 0))) {
        const said = typeof value.error === "string" ? value.error : String(value.error?.message ?? value.detail ?? JSON.stringify(value));
        return reject(explain(said));
      }
      if (code !== 0) return reject(explain(err || out));
      resolve(value);
    });
  });
}

/**
 * Can gbot reach Grok Bot now (its doctor, a local look at the app's session: no gateway call)? null: it can; else what
 * to do. Checked before a turn, kept for a while (30 s).
 */
let doctorAt = 0;
let doctorSaid: string | null = null;
export async function doctor(fresh = false): Promise<string | null> {
  if (account) return null; // an account of pagent's own: reached by its login, the app's session does not matter
  if (!fresh && Date.now() - doctorAt < 30_000) return doctorSaid;
  try {
    const d = await gbot(["doctor", "--json"], { timeoutMs: 15_000 });
    const s = d?.grokBotAppSession ?? {};
    if (s.usable) doctorSaid = null;
    else if (cursorEnv()) doctorSaid = null; // the app's session is not there or not usable, but the Cursor login reaches (and wakes) the computer
    else if (s.present && (s.code === "UNSUPPORTED_VERSION" || /descriptor version/.test(String(s.error ?? "")))) doctorSaid = explain(String(s.error ?? "Unsupported Grok Bot gateway descriptor version 3")).message;
    else if (s.present) doctorSaid = `Grok Bot app's session is there but gbot cannot use it (${s.error ?? s.code ?? "unusable"}): ${AWAKE.replace("it", "the app")}`;
    else if (d?.gatewayAuthPresent) doctorSaid = null; // a gateway or Cursor token in the environment instead of the app's session
    else doctorSaid = (await appRunning()) === false ? `Grok Bot app is not running: open it (\`open -a "Grok Bot"\`), signed in, while its computer is awake` : NO_SESSION;
  } catch (e) {
    doctorSaid = (e as Error).message;
  }
  doctorAt = Date.now();
  return doctorSaid;
}

/**
 * gbot's environment for the Cursor login's way in, or null when there is no login to use. HOME is an empty folder of
 * its own, so gbot does not take the app's session first (it prefers it to a token); SAND_CLIENT_VERSION: the app's.
 * The stand-in (GBOT_BIN) gets only what the environment has, never the person's real login.
 */
let emptyHome: string | undefined;
function cursorEnv(): NodeJS.ProcessEnv | null {
  const real = !process.env.GBOT_BIN;
  const token = account?.token || process.env.CURSOR_ACCESS_TOKEN || (real ? cursorStoreToken() : "");
  if (!token) return null;
  const version = process.env.SAND_CLIENT_VERSION || (real ? appVersion() : "");
  emptyHome ??= mkdtempSync(join(tmpdir(), "pagent-gbot-"));
  return { CURSOR_ACCESS_TOKEN: token, HOME: emptyHome, ...(version ? { SAND_CLIENT_VERSION: version } : {}) };
}

/**
 * The person's Cursor access token (macOS), or "": Cursor.app's (its state database), else the Cursor CLI's
 * (`cursor-agent` keeps it in the login keychain), for a person who has only the CLI.
 */
function cursorStoreToken(): string {
  if (platform() !== "darwin") return "";
  const db = join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  if (existsSync(db)) {
    const r = spawnSync("sqlite3", ["-readonly", db, "select value from ItemTable where key='cursorAuth/accessToken';"], { encoding: "utf8", timeout: 10_000 });
    const token = r.status === 0 ? r.stdout.trim().replace(/^"|"$/g, "") : "";
    if (token) return token;
  }
  const k = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"], { encoding: "utf8", timeout: 10_000 });
  return k.status === 0 ? k.stdout.trim() : "";
}

/**
 * A message to the bot as the Grok Bot app sends one since 0.78: to Cursor's backend (GrokBotService/
 * SendGrokBotUserMessage, the service gbot already wakes the computer with), with the person's Cursor login, read now
 * and kept nowhere. It carries gbot's envelope ([gbot msg=… corr=…]), so the thread shows it as gbot's would (the run
 * finds its turn by that correlation id: grokbot-thread.ts). The stand-in (GBOT_BIN) gets only the environment's
 * login; GROKBOT_BACKEND_URL: another backend (tests).
 */
export async function sendByLogin(botId: string, text: string, corr: string): Promise<{ messageId: string }> {
  const real = !process.env.GBOT_BIN;
  const token = account?.token || process.env.CURSOR_ACCESS_TOKEN || (real ? cursorStoreToken() : "");
  if (!token) throw new GbotError("send-refused", "and there is no Cursor login to send it the way the Grok Bot app does: sign in to Cursor (Cursor.app, or `cursor-agent login`)");
  const messageId = randomUUID();
  const who = (s: string) => s.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64) || "unknown";
  const envelope = `[gbot msg=${messageId} corr=${corr} hop=0 from=${who(process.env.USER ?? "")}@${who(hostname())}]\n`;
  const version = process.env.SAND_CLIENT_VERSION || (real ? appVersion() : "");
  const base = (process.env.GROKBOT_BACKEND_URL || "https://api2.cursor.sh").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/aiserver.v1.GrokBotService/SendGrokBotUserMessage`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/json", "connect-protocol-version": "1", authorization: `Bearer ${token}`, ...(version ? { "x-cursor-client-version": version } : {}) },
      body: JSON.stringify({ agentId: botId, messageId, text: envelope + text, sentAtMs: String(Date.now()), isFork: false }),
    });
  } catch (e) {
    throw new GbotError("unknown-delivery", `Grok Bot may or may not have the message (Cursor's backend did not answer: ${(e as Error).message}); its reply, if it comes, shows in the history`);
  }
  const body = (await res.json().catch(() => ({}))) as { delivery?: string; refusal?: { message?: string }; message?: string; code?: string };
  if (res.status === 401 || res.status === 403) throw new GbotError("wake", `Cursor's backend refused the Cursor login (${res.status} ${body.message ?? body.code ?? ""}): sign in to Cursor again (open Cursor.app once, or \`cursor-agent login\`)`);
  if (!res.ok) throw new GbotError("send-refused", `Cursor's backend did not take the message (${res.status} ${body.message ?? body.code ?? ""})`);
  if (/ACCEPTED|DUPLICATE/.test(body.delivery ?? "")) return { messageId };
  if (/REFUSED/.test(body.delivery ?? "")) throw new GbotError("send-refused", `Grok Bot refused the message: ${body.refusal?.message ?? "no reason given"}`);
  throw new GbotError("unknown-delivery", `Grok Bot may or may not have the message (Cursor's backend said ${body.delivery ?? "nothing"}); its reply, if it comes, shows in the history`);
}

/** The Grok Bot app's version (macOS), or "". */
export function appVersion(): string {
  if (platform() !== "darwin") return "";
  const r = spawnSync("defaults", ["read", "/Applications/Grok Bot.app/Contents/Info.plist", "CFBundleShortVersionString"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** Whether the Grok Bot app runs (macOS; elsewhere, or when it cannot tell: undefined). */
function appRunning(): Promise<boolean | undefined> {
  if (platform() !== "darwin" || process.env.GBOT_BIN) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const p = spawn("pgrep", ["-x", "Grok Bot"], { stdio: "ignore" });
    p.on("error", () => resolve(undefined));
    p.on("close", (code) => resolve(code === 0 ? true : code === 1 ? false : undefined));
  });
}
