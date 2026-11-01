// node --env-file=<a file with ANTHROPIC_API_KEY> scripts/docs-eval.ts [--model haiku] [--only pages,routes] [--jobs 4]
// Does the engine skill reach the agents that need it (SPEC 13.19)? A handful of small tasks, one per chapter or so,
// each given to a real Claude Code agent of a fresh scratch app, as a person writing in its conversation. Each result
// is judged: the app compiles as `pagent status` has it, plus a check of its own; and from the agent's session (the
// app's /_pagent/trajectory) what it read: the skill, its chapters (a file under references/, or `pagent docs <topic>`).
// A chapter nobody finds is linked badly; one every task reads belongs in the core.
//
// Not part of `node --run check`: it costs model calls. Claude Code only, and nothing of the person's: its own
// CLAUDE_CONFIG_DIR and PAGENT_HOME under the temp folder, the key from the environment through an apiKeyHelper (a file
// only this run reads, removed after), no CLAUDE* variables of the caller's. Each app is removed when its task is done.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Nodes } from "../packages/core/src/nodes.ts";
import { bundleRoute, listRoutes, routeInfo } from "../packages/core/src/routes.ts";
import { listNodes } from "../packages/core/src/tree.ts";
import { topics } from "../packages/core/src/docs.ts";
import { parse, flagValue } from "../packages/core/src/commands/args.ts";

const a = parse(process.argv.slice(2));
const model = flagValue(a, "model") ?? "haiku";
const only = flagValue(a, "only")?.split(",");
const jobs = Number(flagValue(a, "jobs") ?? 4);
const minutes = Number(flagValue(a, "minutes") ?? 10);

const key = process.env.ANTHROPIC_API_KEY;
if (!key) throw new Error("no ANTHROPIC_API_KEY in the environment (node --env-file=<file> scripts/docs-eval.ts)");
// Nothing of the caller's Claude Code (a session this runs inside of) or its key reaches the apps.
for (const k of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC_)/.test(k)) delete process.env[k];
const { testApp, until } = await import("../test/lib/app.ts");

const base = mkdtempSync(join(tmpdir(), "pagent-docs-eval-"));
const keyFile = join(base, "key");
writeFileSync(keyFile, key);
chmodSync(keyFile, 0o600);
const config = join(base, "claude");
mkdirSync(config);
const claudeBin = execFileSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
const env = {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_BIN: claudeBin,
  PAGENT_CLAUDE_SETTINGS: JSON.stringify({ apiKeyHelper: `cat '${keyFile}'` }),
};

// The app every task starts from: a home page with one Claude Code agent, the person's builder, as `npm create pagent`
// gives. Headless turns (no terminal to drive); what it may do without a card: read anything, change files in the app.
const home = `import { AgentConsole, type Agents } from "pagent";
export const metadata = { title: "Workbench" };
export const agents = {
  main: { cli: "claude", model: ${JSON.stringify(model)}, tui: false, allow: ["Read", "Edit", "Write", "Glob", "Grep", "Skill", "Bash(ls:*)", "Bash(cat:*)", "Bash(mkdir:*)", "Bash(find:*)", "Bash(grep:*)"] },
} satisfies Agents;
export default function Home() { return <AgentConsole inline />; }
`;

type Task = { name: string; chapter: string; ask: string; check: (root: string, reply: string) => string | null };
const read = (root: string, f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : "");
const need = (cond: boolean, why: string) => (cond ? null : why);

const tasks: Task[] = [
  {
    name: "pages",
    chapter: "pages",
    ask: 'Add a page at /recipes called "Recipes" that lists the recipes in its recipes.json (name, minutes) and has a small form to add one. It should come first among the pages in the navigation.',
    check: (root) => {
      const page = read(root, "recipes/page.tsx");
      return need(!!page, "no recipes/page.tsx") ?? need(/title:\s*"Recipes"/.test(page), "no metadata.title") ?? need(/order:\s*-?\d/.test(page), "no metadata.order") ?? need(/useData[^(]*\(\s*"recipes\.json"/.test(page), "recipes.json not read with useData") ?? need(/set\w*\(\s*\(?\s*\w+\s*\)?\s*=>/.test(page), "no write with an updater");
    },
  },
  {
    name: "actions",
    chapter: "data-actions",
    ask: "Add a page /counter with a button that adds one to a count kept in count.json, done on the server by an action named increment that agents can run too.",
    check: (root) => {
      const files = existsSync(join(root, "counter")) ? readdirSync(join(root, "counter")).filter((f) => /\.(ts|js)$/.test(f)) : [];
      const server = files.map((f) => read(root, `counter/${f}`)).find((t) => /^\s*["']use server["']/.test(t)) ?? "";
      return need(!!server, 'no "use server" file in counter/') ?? need(/export\s+async\s+function\s+increment\b/.test(server), "no exported async increment") ?? need(/import\s*\{[^}]*\bincrement\b[^}]*\}\s*from\s*"\.\//.test(read(root, "counter/page.tsx")), "the page does not import increment");
    },
  },
  {
    name: "triggers",
    chapter: "triggers",
    ask: "Make a page /inbox whose agent hears about new mail: whenever its inbox.json gets new items, tell the agent once about the new ones so it can triage them. No polling.",
    check: (root) => {
      const page = read(root, "inbox/page.tsx");
      const server = (existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")) : []).map((f) => (/\.(ts|js)$/.test(f) ? read(root, `inbox/${f}`) : "")).find((t) => /^\s*["']use server["']/.test(t)) ?? "";
      return need(/triggers\s*=/.test(page) && /watch:\s*"inbox\.json"/.test(page), "no trigger watching inbox.json") ?? need(/\btell\b/.test(server) && /pagent\/server/.test(server), "the action does not tell() the agent") ?? need(/agents\s*=/.test(page), "/inbox has no agent");
    },
  },
  {
    name: "instances",
    chapter: "instances",
    ask: "Add chats: a page per chat under /chats/<id>, each chat with an agent of its own (Claude Code), the page showing the conversation with it.",
    check: (root) => {
      const dirs = existsSync(join(root, "chats")) ? readdirSync(join(root, "chats")).filter((d) => /^\[.+\]$/.test(d)) : [];
      const page = dirs.length ? read(root, `chats/${dirs[0]}/page.tsx`) : "";
      return need(!!page, "no chats/[id]/page.tsx") ?? need(/agents/.test(page), "no agents") ?? need(/<(AgentConsole|Chat)\b/.test(page), "no conversation surface");
    },
  },
  {
    name: "bridges",
    chapter: "bridges",
    ask: "Install the Calculator bridge in this app and add a page /calc that shows Calculator's current display, using the bridge.",
    check: (root) => {
      const page = read(root, "calc/page.tsx");
      return need(existsSync(join(root, "calculator", "actions.ts")), "the bridge is not installed") ?? need(/from\s*"~\/calculator/.test(page), "calc/page.tsx does not use the bridge");
    },
  },
  {
    name: "routes",
    chapter: "routes",
    ask: "Give the app a public HTTP endpoint, POST /api/notes, that adds { text } to a list of notes, and refuses callers without a key.",
    check: (root) => {
      const route = read(root, "api/notes/route.ts");
      return need(!!route, "no api/notes/route.ts") ?? need(/export\s+(async\s+)?function\s+POST/.test(route), "no POST") ?? need(/caller/.test(route) && /key/.test(route), "the caller's key is not checked");
    },
  },
  {
    name: "cards",
    chapter: "cards",
    ask: "Show me, right here in your reply, a small card with a 3-day weather outlook for Lisbon (made-up numbers are fine for now).",
    check: (root, reply) => {
      const card = /```pagent\n(\/[^\s]+)/.exec(reply)?.[1];
      return need(!!card, "no ```pagent block in the reply") ?? need(existsSync(join(root, `.${card!.split("?")[0]}`, "page.tsx")), `the card's node ${card} is not there`);
    },
  },
  {
    name: "reference",
    chapter: "reference",
    ask: "Add a page /usage that shows how much of its context window the home page's agent has used, and whether it is working right now.",
    check: (root) => {
      const page = read(root, "usage/page.tsx");
      return need(!!page, "no usage/page.tsx") ?? need(/useAgentStatus/.test(page), "no useAgentStatus") ?? need(/usage/.test(page) && /busy/.test(page), "neither usage nor busy shown");
    },
  },
];

/** `pagent status` for every node of the app, and every route: what does not compile. */
async function errors(root: string): Promise<string[]> {
  const nodes = new Nodes(root);
  const out: string[] = [];
  const paths = [...listNodes(root)];
  // A dynamic page with no instance yet: as one would be (check.ts does the same).
  const walk = (rel: string) => {
    for (const d of existsSync(join(root, rel)) ? readdirSync(join(root, rel), { withFileTypes: true }) : []) {
      if (!d.isDirectory() || /^[._]|^node_modules$/.test(d.name)) continue;
      if (/^\[.+\]$/.test(d.name) && existsSync(join(root, rel, d.name, "page.tsx"))) paths.push(`/${rel ? rel + "/" : ""}eval`.replace(/\/+/g, "/"));
      walk(rel ? `${rel}/${d.name}` : d.name);
    }
  };
  walk("");
  for (const p of new Set(paths)) {
    const i = await nodes.info(p).catch((e) => ({ manifest: { errors: [(e as Error).message] } }));
    out.push(...i.manifest.errors.filter((e) => !/refuse|no instance/i.test(e)).map((e) => `${p}: ${e}`));
  }
  for (const r of listRoutes(root)) {
    out.push(...routeInfo(root, r).errors.map((e) => `${r.path}: ${e}`));
    await bundleRoute(root, r).catch((e) => out.push(`${r.path}: ${(e as Error).message.split("\n")[0]}`));
  }
  return out;
}

/**
 * What the agent read, from its session: the skill (its Skill tool, SKILL.md, `pagent docs skill`), and each chapter,
 * with how (a references/ file, or `pagent docs <topic>`; only the topics there are, so a shell loop's `pagent docs $t`
 * names none). Only the commands it ran and the files it opened are looked at, never what it wrote.
 */
const TOPICS = topics().map((t) => t.name).filter((n) => n !== "skill");
function reading(records: { kind: string; name?: string; input?: unknown }[]) {
  const read = new Map<string, string>();
  let skill = false;
  const tools: string[] = [];
  for (const r of records.filter((r) => r.kind === "tool")) {
    const input = (r.input ?? {}) as Record<string, unknown>;
    const s = typeof r.input === "string" ? r.input : String(input.command ?? input.file_path ?? input.skill ?? JSON.stringify(input));
    tools.push(`${r.name} ${s.slice(0, 300)}`);
    if (r.name === "Write" || r.name === "Edit") continue;
    if ((r.name === "Skill" && /pagent(?!-builder)/.test(s)) || /skills\/pagent\/SKILL\.md|pagent docs skill\b/.test(s)) skill = true;
    for (const [, c] of s.matchAll(/skills\/pagent\/references\/([\w-]+)\.md/g)) read.set(c, read.get(c) ?? "file");
    for (const [, c] of s.matchAll(/pagent docs ([\w-]+)/g)) if (TOPICS.includes(c)) read.set(c, read.get(c) ?? "pagent docs");
    if (/pagent docs(?![ \w-])|pagent docs \$/.test(s)) read.set("(the list)", "pagent docs");
  }
  return { skill, chapters: [...read.keys()], how: Object.fromEntries(read), tools };
}

// The apps running now: their permission cards are answered (answerCards).
const open = new Set<string>();

async function run(t: Task) {
  const app = await testApp({ "page.tsx": home }, { env });
  const started = Date.now();
  open.add(app.url);
  try {
    const reply = await (async () => {
      const res = await fetch(`${app.url}/_pagent/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ node: "/", agent: "main", message: { id: `eval-${t.name}`, role: "user", parts: [{ type: "text", text: t.ask }] } }),
        signal: AbortSignal.timeout(minutes * 60_000),
      });
      const stream = await res.text();
      return [...stream.matchAll(/"type":"text-delta"[^}]*"delta":("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]) as string).join("");
    })();
    // Its session as a timeline (the transcript is written as it goes: the last records may come a moment later).
    const records = await until(async () => {
      const r = (await app.get<{ records: { kind: string; name?: string; input?: unknown }[] }>("/_pagent/trajectory?node=/&agent=main")).records;
      return r.some((x) => x.kind === "turn" && "end" in x) ? r : null;
    }, "the turn in its trajectory", 30_000).catch(async () => (await app.get<{ records: any[] }>("/_pagent/trajectory?node=/&agent=main")).records);
    const failed = [...(await errors(app.root)), t.check(app.root, reply)].filter(Boolean) as string[];
    return { task: t.name, chapter: t.chapter, ok: !failed.length, failed, seconds: Math.round((Date.now() - started) / 1000), reply: reply.slice(-400), ...reading(records) };
  } finally {
    open.delete(app.url);
    await app.close();
  }
}

/** Permission cards nobody is there to answer: allowed when what they ask stays in the eval's folder, else declined. */
async function answerCards(stop: AbortSignal) {
  while (!stop.aborted) {
    for (const url of open) {
      const { questions } = await fetch(`${url}/_pagent/prompts`).then((r) => r.json() as Promise<{ questions: { id: string; question: string; detail?: string }[] }>).catch(() => ({ questions: [] }));
      for (const q of questions) {
        const inside = !/(\/Users\/|\/Volumes\/|~\/|\$HOME)/.test(q.detail ?? "") || (q.detail ?? "").includes(base);
        console.log(`  card: ${q.question} ${(q.detail ?? "").slice(0, 120).replace(/\n/g, " ")} → ${inside ? "Allow" : "Deny"}`);
        await fetch(`${url}/_pagent/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: q.id, answer: inside ? "Allow" : "Deny" }) }).catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const chosen = tasks.filter((t) => !only || only.includes(t.name));
const stop = new AbortController();
const cards = answerCards(stop.signal);
const results: Awaited<ReturnType<typeof run>>[] = [];
try {
  const queue = [...chosen];
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        console.log(`… ${t.name}`);
        const task = t;
        const r = await run(task).catch((e) => ({ task: task.name, chapter: task.chapter, ok: false, failed: [String((e as Error).message).slice(0, 300)], seconds: 0, reply: "", skill: false, chapters: [] as string[], how: {}, tools: [] as string[] }));
        results.push(r);
        console.log(`${r.ok ? "✓" : "✗"} ${r.task} (${r.seconds}s) skill: ${r.skill ? "loaded" : "not loaded"}; chapters: ${r.chapters.join(", ") || "none"}${r.failed.length ? `\n    ${r.failed.join("\n    ")}` : ""}`);
      }
    }),
  );
} finally {
  stop.abort();
  await cards;
  rmSync(base, { recursive: true, force: true });
}

const tally = new Map<string, number>();
for (const r of results) for (const c of r.chapters) tally.set(c, (tally.get(c) ?? 0) + 1);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; skill loaded in ${results.filter((r) => r.skill).length}`);
console.log(`chapters read: ${[...tally].map(([c, n]) => `${c} ×${n}`).join(", ") || "none"}`);
console.log(`never read: ${TOPICS.filter((t) => !tally.has(t)).join(", ") || "none"}`);
console.log(`its own chapter read:${results.filter((r) => r.chapters.includes(r.chapter)).map((r) => r.task).join(", ") || "none"}`);
writeFileSync(join(tmpdir(), "pagent-docs-eval.json"), JSON.stringify(results, null, 2));
console.log(`details (each tool call, the end of each reply): ${join(tmpdir(), "pagent-docs-eval.json")}`);
