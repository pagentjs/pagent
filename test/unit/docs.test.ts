// The engine skill stays true to the engine (SPEC 13.19). A short core and chapters, each within its word budget (as
// dsh's verify-doc-budgets: a budget only goes down, unless a change says why); every chapter reachable three ways
// (linked from the core, listed by `pagent docs`, named in every agent's prompt); every link resolving; and what the
// docs name is there: pagent's exports and pagent/server's (and every one of those is documented), and each
// `pagent <command> --flag`. The examples compile in `node --run compile-all` (scripts/check.ts).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { systemPrompt, docsIndex } from "../../packages/core/src/agents/prompt.ts";
import { commands } from "../../packages/core/src/commands/index.ts";
import { docs, headings, skillDir, topics } from "../../packages/core/src/docs.ts";
import { repo } from "../lib/app.ts";

const BUDGET = { core: 2200, chapter: 2000, index: 80 };

const dir = skillDir();
const chapters = readdirSync(join(dir, "references")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
const files = ["SKILL.md", ...chapters.map((c) => `references/${c}.md`)];
const text = (f: string) => readFileSync(join(dir, f), "utf8");
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const BLOCKS = /^(`{3,})[^\n]*\n([\s\S]*?)^\1$/gm;
/** The text without its code blocks and code spans (links in them are examples, not links). */
const prose = (s: string) => s.replace(BLOCKS, "").replace(/`[^`\n]*`/g, "");
/** The lines of its code blocks, and its code spans. */
const code = (s: string) => [...[...s.matchAll(BLOCKS)].flatMap((m) => m[2].split("\n")), ...[...s.replace(BLOCKS, "").matchAll(/`([^`\n]+)`/g)].map((m) => m[1])];

test("word budgets: the core, each chapter, the index in every agent's prompt", () => {
  assert.ok(words(text("SKILL.md")) <= BUDGET.core, `SKILL.md has ${words(text("SKILL.md"))} words (budget ${BUDGET.core})`);
  for (const c of chapters) assert.ok(words(text(`references/${c}.md`)) <= BUDGET.chapter, `${c}.md has ${words(text(`references/${c}.md`))} words (budget ${BUDGET.chapter})`);
  assert.ok(words(docsIndex) <= BUDGET.index, `the prompt's index has ${words(docsIndex)} words (budget ${BUDGET.index})`);
});

test("every chapter: linked from the core (its last table lists them all), listed by `pagent docs`, named in every agent's prompt", () => {
  const core = text("SKILL.md");
  const table = core.slice(core.indexOf("## Where to read more"));
  const listed = docs();
  const prompt = systemPrompt({ node: "/notes", agent: "notes" }, { dir: "/Users/sam/app/notes", cwd: "/Users/sam/app/notes", root: "/Users/sam/app" }, {});
  assert.ok(prompt.includes(docsIndex));
  assert.deepEqual(topics().map((t) => t.name), ["skill", ...topics().slice(1).map((t) => t.name)]);
  assert.deepEqual(topics().slice(1).map((t) => t.name).sort(), [...chapters].sort());
  for (const c of chapters) {
    assert.match(table, new RegExp(`\\]\\(references/${c}\\.md\\)`), `the core's table does not list ${c}`);
    assert.match(listed, new RegExp(`^  ${c} +\\S`, "m"), `pagent docs does not list ${c}`);
    assert.ok(topics().find((t) => t.name === c)?.about, `${c}.md has no description: line`);
    assert.match(docsIndex, new RegExp(`\\b${c}\\b`), `the prompt's index does not name ${c}`);
  }
});

test("every relative link resolves, to a file and a heading in it", () => {
  for (const f of files) {
    for (const [, target] of prose(text(f)).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, anchor] = target.split("#");
      const to = path ? join(dirname(join(dir, f)), path) : join(dir, f);
      let body: string;
      try {
        body = readFileSync(to, "utf8");
      } catch {
        assert.fail(`${f}: link to ${target}: no such file`);
      }
      if (anchor) assert.ok(headings(body).some((h) => h.slug === anchor), `${f}: link to ${target}: no such heading`);
    }
  }
});

test("a chapter over 100 lines starts with its contents, every section in it", () => {
  for (const c of chapters) {
    const t = text(`references/${c}.md`);
    if (t.split("\n").length <= 100) continue;
    const sections = headings(t).filter((h) => h.level === 2);
    const contents = t.slice(0, t.indexOf("\n## "));
    for (const s of sections) assert.ok(contents.includes(`](#${s.slug})`), `${c}.md: its contents leave out "${s.title}"`);
  }
});

test("`pagent docs`: a chapter, one section of it, links as commands, and errors that say what there is", () => {
  const pages = docs("pages");
  assert.doesNotMatch(pages, /^---/);
  assert.match(pages, /^# Pages/);
  assert.match(pages, /\(`pagent docs instances`\)/);
  const one = docs("pages#metadata");
  assert.match(one, /^## Metadata: title, language, order, fill/);
  assert.doesNotMatch(one, /## The person's settings/);
  assert.match(docs("skill"), /^# Writing pagent nodes/);
  assert.throws(() => docs("nope"), /no topic "nope"; there are: skill, pages/);
  assert.throws(() => docs("pages#nope"), /no section "nope" in pages; its sections: pages#metadata-title-language-order-fill/);
});

// ---------------------------------------------------------------- what the docs name is there

/** Names a module exports, read from its source: declarations, `export { … } from`, `export type { … } from`. */
function exportsOf(file: string): Set<string> {
  const src = readFileSync(join(repo, file), "utf8");
  const names = new Set<string>();
  for (const [, n] of src.matchAll(/^export (?:async )?(?:const|function|type|class|let) (\w+)/gm)) names.add(n);
  for (const [, n] of src.matchAll(/^export const \{ (\w+) \}/gm)) names.add(n);
  for (const [, list] of src.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) for (const n of list.split(",")) names.add(n.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!);
  names.delete("");
  return names;
}

// What `pagent` exports for the shell and the compiler, not for pages (packages/bridge/src/index.tsx): never documented.
const INTERNAL = new Set([
  "HostContext", "provideHost", "useHost", "HostApi", "Scope", "ScopeContext", "useScope", "useResolvedAgent", "serverFunction", "nodeComponent",
  "nodeHook", "RouteInfo", "RouteContext", "callPageTool", "mountedPageTools", "onPageToolsChange", "planOf", "NodeCard", "pageUrl", "parseCard",
  "propsFromQuery", "splitCards", "CardRef", "CardsShown", "QuestionCard", "doingOf", "quietNote", "ChatOrigin", "DataRead", "DataWrite", "UIMessage",
  "TrajectoryPage",
]);

const reference = text("references/reference.md");
function section(t: string, heading: string) {
  const from = t.indexOf(`## ${heading}`);
  const to = t.indexOf("\n## ", from + 3);
  return t.slice(from, to < 0 ? undefined : to);
}
const spans = (t: string) => [...t.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join("\n");

test("everything `pagent` exports for pages is in the reference, and everything the reference names is exported", () => {
  const exported = exportsOf("packages/bridge/src/index.tsx");
  for (const n of INTERNAL) assert.ok(exported.has(n), `${n} is listed as internal but not exported`);
  const documented = spans(reference.slice(0, reference.indexOf("## pagent/server")));
  for (const n of exported) if (!INTERNAL.has(n)) assert.match(documented, new RegExp(`\\b${n}\\b`), `pagent exports ${n}, which the reference does not document`);
  // Its table's first column and its types: each a name pagent exports.
  const named = [
    ...section(reference, "Hooks and components").split("\n").filter((l) => l.startsWith("| `")).flatMap((l) => [...spans(l.split(" | ")[0]).matchAll(/(?:^|[\s<,(])((?:use|set)[A-Z]\w*|navigate|[A-Z]\w+)(?=[\s(/<>,]|$)/gm)].map((m) => m[1])),
    ...[...spans(section(reference, "Types")).matchAll(/^([A-Z]\w+)$/gm)].map((m) => m[1]),
  ];
  assert.ok(named.length > 40, `read ${named.length} names from the reference`);
  for (const n of named) assert.ok(exported.has(n), `the reference names ${n}, which pagent does not export`);
});

test("everything pagent/server exports is in the reference, and the reference's table names only those", () => {
  const exported = exportsOf("packages/core/src/server-api.ts");
  const table = section(reference, "pagent/server");
  for (const n of exported) assert.match(spans(table), new RegExp(`\\b${n}\\b`), `pagent/server exports ${n}, which the reference does not document`);
  const named = table.split("\n").filter((l) => l.startsWith("| `")).map((l) => /^\| `(\w+)/.exec(l)![1]);
  for (const n of named) assert.ok(exported.has(n), `the reference names ${n} in pagent/server, which it does not export`);
});

test("what the docs' examples import from pagent and pagent/server is exported", () => {
  const page = exportsOf("packages/bridge/src/index.tsx");
  const server = exportsOf("packages/core/src/server-api.ts");
  for (const f of files) {
    for (const [, list, from] of text(f).matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(pagent|pagent\/server)"/g)) {
      for (const n of list.split(",").map((x) => x.trim().replace(/^type\s+/, "")).filter(Boolean)) {
        assert.ok((from === "pagent" ? page : server).has(n), `${f}: imports ${n} from "${from}", which it does not export`);
      }
    }
  }
});

// The person's commands (cli.ts), from its usage text: serve, daemon, and --root on the ones an agent has too.
const cliUsage = readFileSync(join(repo, "packages/core/src/cli.ts"), "utf8").split("\n").filter((l) => /^\s*"(usage: | {7})pagent /.test(l));

/** The flags a command takes: its usage (an agent's command), and the person's usage lines for it; any, for `run`. */
function flagsOf(name: string): Set<string> | "any" | null {
  if (name === "run") return "any";
  const cmd = commands.find((c) => c.name === name);
  const person = cliUsage.filter((l) => new RegExp(`pagent ${name}\\b`).test(l));
  if (!cmd && !person.length) return null;
  const all = [cmd?.usage ?? "", ...Object.keys(cmd?.flags ?? {}).map((f) => `--${f}`), ...person].join(" ");
  return new Set([...all.matchAll(/--([a-z][\w-]*)/g)].map((m) => m[1]).concat("help"));
}

test("every `pagent <command> --flag` the docs mention is a command that takes that flag", () => {
  let seen = 0;
  for (const f of files) {
    for (const line of code(text(f))) {
      for (const [, rest] of line.matchAll(/(?:^|[\s`'"(])pagent ([a-z][\w-]*(?: [a-z][\w-]*)?[^`'"]*)/g)) {
        const words = rest.split(/\s+/);
        const name = [`${words[0]} ${words[1]}`, words[0]].find((n) => flagsOf(n) !== null);
        assert.ok(name, `${f}: \`pagent ${rest}\`: no such command`);
        const takes = flagsOf(name)!;
        for (const [, flag] of rest.matchAll(/(?:^|\s|\[)--([a-z][\w-]*)/g)) {
          assert.ok(takes === "any" || takes.has(flag), `${f}: \`pagent ${rest}\`: pagent ${name} takes no --${flag}`);
          seen++;
        }
      }
    }
  }
  assert.ok(seen > 10, `checked ${seen} flags`);
});
