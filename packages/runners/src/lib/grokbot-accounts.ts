// The Grok Bot accounts pagent uses (SPEC 13.28): several of the person's, each its Cursor login. Grok Bot's usage is
// a weekly allowance per account, so a turn goes to the first account (in the order they were added) that has some
// left, and a bot is a name: the same one on each account, made where it is not there yet (grokbot.ts). Which account
// the Grok Bot app shows does not matter: pagent reaches each one by its own login (the bot's computer through gbot,
// a message through Cursor's backend: gbot.ts).
//
// The list (names, when each login expires, the last usage read) is <PAGENT_HOME>/grokbot/accounts.json; the logins
// are in the login keychain (service "pagent-grokbot", one item per account), never in a file or a command line.
// Logins come from the Cursor CLI: `pagent grokbot login <name>` runs `cursor-agent login` and keeps what it got.
// A login lasts about two months; pagent does not renew it (renewing would sign the CLI out), it says when one is near
// its end. GROKBOT_TOKENS_FILE: logins in that file instead of the keychain (tests).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const SERVICE = "pagent-grokbot";

/** usage: as last read (percent of the week's allowance; resetAt: when it starts again, ms; at: when it was read). */
export type Account = { name: string; addedAt: number; expiresAt?: number; usage?: { percent: number; resetAt: number; at: number } };
/** An account to use now: its name and its login. */
export type Login = { name: string; token: string };

const home = () => join(process.env.PAGENT_HOME || join(homedir(), ".pagent"), "grokbot");
const listFile = () => join(home(), "accounts.json");

export function accounts(): Account[] {
  try {
    const list = JSON.parse(readFileSync(listFile(), "utf8")).accounts;
    return Array.isArray(list) ? list.filter((a) => a && typeof a.name === "string") : [];
  } catch {
    return [];
  }
}

function saveList(list: Account[]) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(listFile() + ".tmp", JSON.stringify({ accounts: list }, null, 2) + "\n");
  renameSync(listFile() + ".tmp", listFile());
}

const update = (name: string, f: (a: Account) => Account) => saveList(accounts().map((a) => (a.name === name ? f(a) : a)));

// ---- the logins

const tokensFile = () => process.env.GROKBOT_TOKENS_FILE;
const readTokens = (): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(tokensFile()!, "utf8"));
  } catch {
    return {};
  }
};

/** An account's login, or "" (none kept, or the keychain would not give it). */
export function tokenOf(name: string): string {
  if (tokensFile()) return readTokens()[name] ?? "";
  if (platform() !== "darwin") return "";
  const r = spawnSync("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : "";
}

function keepToken(name: string, token: string) {
  if (tokensFile()) return writeFileSync(tokensFile()!, JSON.stringify({ ...readTokens(), [name]: token }));
  if (platform() !== "darwin") throw new Error("Grok Bot accounts keep their logins in the macOS keychain");
  // Through security's own prompt (stdin), so the login is never on a command line another process can read.
  const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
  const r = spawnSync("/usr/bin/security", ["-i"], { input: `add-generic-password -U -s ${SERVICE} -a ${q(name)} -w ${q(token)}\n`, encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) throw new Error(`the keychain did not keep the login (${(r.stderr || r.stdout).trim()})`);
}

function dropToken(name: string) {
  if (tokensFile()) {
    const t = readTokens();
    delete t[name];
    return writeFileSync(tokensFile()!, JSON.stringify(t));
  }
  if (platform() === "darwin") spawnSync("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", name], { stdio: "ignore", timeout: 10_000 });
}

/** When a Cursor login expires (its JWT's exp, ms), if it says. */
function expiryOf(token: string): number | undefined {
  try {
    const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp;
    return typeof exp === "number" ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** The Cursor CLI's login now (what `cursor-agent login` signed in), or "". */
export function cliToken(): string {
  if (platform() !== "darwin") return "";
  const r = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** Keep a login as an account (a new one goes last; one of that name gets the new login). */
export function addAccount(name: string, token: string): Account {
  if (!/^[\w.-]{1,40}$/.test(name)) throw new Error(`an account's name is a short word ([A-Za-z0-9_.-], up to 40): "${name}"`);
  if (!token) throw new Error("no login to keep");
  keepToken(name, token);
  const list = accounts();
  const a: Account = { name, addedAt: list.find((x) => x.name === name)?.addedAt ?? Date.now(), ...(expiryOf(token) ? { expiresAt: expiryOf(token) } : {}) };
  saveList(list.some((x) => x.name === name) ? list.map((x) => (x.name === name ? a : x)) : [...list, a]);
  return a;
}

export function removeAccount(name: string): boolean {
  const list = accounts();
  if (!list.some((a) => a.name === name)) return false;
  dropToken(name);
  saveList(list.filter((a) => a.name !== name));
  return true;
}

// ---- usage

const backend = () => (process.env.GROKBOT_BACKEND_URL || "https://api2.cursor.sh").replace(/\/$/, "");

/** What Grok Bot says of an account's week: how much of it is used, and when it starts again. */
export async function readUsage(token: string, version = ""): Promise<{ percent: number; resetAt: number }> {
  const res = await fetch(`${backend()}/aiserver.v1.DashboardService/GetSandUsageStatus`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: { "content-type": "application/json", "connect-protocol-version": "1", authorization: `Bearer ${token}`, ...(version ? { "x-cursor-client-version": version } : {}) },
    body: "{}",
  });
  const body = (await res.json().catch(() => ({}))) as { usagePercent?: number; nextResetTimestampUtc?: string; message?: string };
  if (res.status === 401 || res.status === 403) throw new Error(`its login no longer works (${res.status}): \`pagent grokbot login <name>\` again`);
  if (!res.ok) throw new Error(`Cursor's backend did not say its usage (${res.status} ${body.message ?? ""})`);
  return { percent: Number(body.usagePercent ?? 0), resetAt: Date.parse(body.nextResetTimestampUtc ?? "") || 0 };
}

const FRESH = Number(process.env.GROKBOT_USAGE_FRESH_MS) || 5 * 60_000; // a usage read this recent is taken as it is
const NEAR_END = 7 * 24 * 3_600_000; // a login this close to its end is said in the log

/** "Mon 11-07 22:36": a time as the person reads it. */
export const when = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * The account a turn goes to: the first, in order, whose login works and whose week is not used up (its usage read
 * again when older than 5 minutes, or once its week starts again). null: no accounts (pagent then takes whichever the
 * Grok Bot app is on, as before). An Error: none can take a turn now, saying when the first one can.
 */
export async function pick(version = "", opts: { fresh?: boolean } = {}): Promise<Login | null | Error> {
  const list = accounts();
  if (!list.length) return null;
  const why: string[] = [];
  for (const a of list) {
    const token = tokenOf(a.name);
    if (!token) {
      why.push(`${a.name}: no login kept (\`pagent grokbot login ${a.name}\`)`);
      continue;
    }
    if (a.expiresAt && a.expiresAt < Date.now()) {
      why.push(`${a.name}: its login ended ${when(a.expiresAt)} (\`pagent grokbot login ${a.name}\`)`);
      continue;
    }
    if (a.expiresAt && a.expiresAt - Date.now() < NEAR_END) console.error(`grokbot: the login of account ${a.name} ends ${when(a.expiresAt)}: \`pagent grokbot login ${a.name}\` before then`);
    let u = a.usage;
    if (opts.fresh || !u || Date.now() - u.at > FRESH || (u.percent >= 100 && u.resetAt && u.resetAt <= Date.now())) {
      try {
        const r = await readUsage(token, version);
        u = { ...r, at: Date.now() };
        update(a.name, (x) => ({ ...x, usage: u }));
      } catch (e) {
        why.push(`${a.name}: ${(e as Error).message}`);
        continue;
      }
    }
    if (u.percent < 100) return { name: a.name, token };
    why.push(`${a.name}: this week's usage is used up${u.resetAt ? `, back ${when(u.resetAt)}` : ""}`);
  }
  return new Error(`no Grok Bot account can take a turn now (${why.join("; ")})`);
}

/** An account's usage seen used up just now (a turn that could not run): read again before it is picked. */
export const markFull = (name: string) => update(name, (a) => ({ ...a, usage: { percent: 100, resetAt: a.usage?.resetAt ?? 0, at: 0 } }));

// ---- which account a bot of an agent is on (the quick ops read it, the session writes it)

const pinFile = (stateDir: string) => join(stateDir, "grokbot-account.json");
export function accountOf(stateDir: string): string | undefined {
  try {
    return JSON.parse(readFileSync(pinFile(stateDir), "utf8")).account;
  } catch {
    return undefined;
  }
}
export function keepAccountOf(stateDir: string, account: string | undefined) {
  if (!account && !existsSync(pinFile(stateDir))) return;
  writeFileSync(pinFile(stateDir), JSON.stringify({ account: account ?? null }) + "\n");
}
