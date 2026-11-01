// The engine skill and its chapters as `pagent docs` prints them (SPEC 13.19). Read from the engine's own copy
// (engine.skill), so what an agent reads is what the engine running its app does. The skill (SKILL.md) is a short core;
// each chapter is a file in references/, one level deep, its first lines a `description:` that the listing shows.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { engine } from "./engine.ts";

/** The engine skill's folder: SKILL.md and references/. */
export const skillDir = () => join(engine.skill, "skills", "pagent");

export type Topic = { name: string; about: string; file: string };

const front = (text: string) => /^---\n([\s\S]*?)\n---\n/.exec(text);
const descriptionOf = (text: string) => /^description:\s*(.*)$/m.exec(front(text)?.[1] ?? "")?.[1].trim() ?? "";

/**
 * Every topic: the skill itself, then its chapters in the order the skill first links them (its last table lists them
 * all); a chapter it does not link, after those.
 */
export function topics(): Topic[] {
  const dir = skillDir();
  const core = readFileSync(join(dir, "SKILL.md"), "utf8");
  const files = existsSync(join(dir, "references")) ? readdirSync(join(dir, "references")).filter((f) => f.endsWith(".md")) : [];
  const linked = [...core.matchAll(/\]\(references\/([\w-]+)\.md/g)].map((m) => m[1]);
  const names = [...new Set([...linked, ...files.map((f) => f.slice(0, -3)).sort()])].filter((n) => files.includes(`${n}.md`));
  return [
    { name: "skill", about: "the skill itself (SKILL.md): what nearly every change needs; start here", file: join(dir, "SKILL.md") },
    ...names.map((name) => {
      const file = join(dir, "references", `${name}.md`);
      return { name, about: descriptionOf(readFileSync(file, "utf8")), file };
    }),
  ];
}

/** A heading's anchor, as GitHub makes it: lower case, punctuation dropped, each space a hyphen. */
export const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

/** The markdown headings of a text outside code blocks, with where each starts. */
export function headings(text: string): { level: number; title: string; slug: string; line: number }[] {
  const out: { level: number; title: string; slug: string; line: number }[] = [];
  let fence = false;
  text.split("\n").forEach((l, line) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.*)$/.exec(l);
    if (m) out.push({ level: m[1].length, title: m[2], slug: slug(m[2]), line });
  });
  return out;
}

/** Links between the docs' files as commands that print them: [pages](references/pages.md#x) → pages (`pagent docs pages#x`). */
const asCommands = (text: string) =>
  text.replace(/\[([^\]]+)\]\((?:references\/|\.\.\/)?([\w-]+)\.md(?:#([^)]*))?\)/g, (_, label: string, name: string, section?: string) => {
    const topic = name === "SKILL" ? "skill" : name;
    return `${label} (\`pagent docs ${topic}${section ? `#${section}` : ""}\`)`;
  });

/** `pagent docs`: the topics; `pagent docs <topic>`: that chapter; `<topic>#<section>`: one section of it. */
export function docs(arg?: string): string {
  const all = topics();
  if (!arg) {
    const width = Math.max(...all.map((t) => t.name.length));
    return [
      "The pagent skill and its chapters, as the engine running this app has them. pagent docs <topic> prints one;",
      "<topic>#<section> one section of it (a heading's anchor, or the start of one: pages#metadata).",
      "",
      ...all.map((t) => `  ${t.name.padEnd(width)}  ${t.about}`),
      "",
      `The same files: ${skillDir()} (SKILL.md, references/).`,
    ].join("\n");
  }
  const [name, section] = arg.split("#");
  const topic = all.find((t) => t.name === name.toLowerCase().replace(/\.md$/, ""));
  if (!topic) throw new Error(`no topic "${name}"; there are: ${all.map((t) => t.name).join(", ")}`);
  const raw = readFileSync(topic.file, "utf8");
  const text = raw.slice(front(raw)?.[0].length ?? 0);
  if (!section) return asCommands(text).trim();
  const hs = headings(text);
  const want = section.toLowerCase();
  const h = hs.find((x) => x.slug === want) ?? hs.find((x) => x.slug.startsWith(want));
  if (!h) throw new Error(`no section "${section}" in ${topic.name}; its sections: ${hs.filter((x) => x.level > 1).map((x) => `${topic.name}#${x.slug}`).join(", ")}`);
  const lines = text.split("\n");
  const end = hs.find((x) => x.line > h.line && x.level <= h.level)?.line ?? lines.length;
  return asCommands(lines.slice(h.line, end).join("\n")).trim();
}
