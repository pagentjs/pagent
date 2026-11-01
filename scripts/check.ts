// node scripts/check.ts: compile every node pagent ships, the way the engine does, and fail on any error. The examples
// (each copied into a scratch app), the official bridges and the new-bridge skeleton (installed into one), the app
// `npm create pagent` makes, and the engine skill's examples. Pages and layouts compile as the shell loads them (with
// the app's shared modules);
// "use server" files bundle as their actions run. Nothing is started.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleServerFile } from "../packages/core/src/actions.ts";
import { addNode } from "../packages/core/src/install.ts";
import { Nodes } from "../packages/core/src/nodes.ts";
import { bundleRoute, listRoutes, routeInfo } from "../packages/core/src/routes.ts";
import { codeOf, fileIn, hasFile, isDynamic, listNodes, nodeDir, shadowsOf } from "../packages/core/src/tree.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "pagent-check-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

/** A scratch app: a git repository with a package.json, like the ones pagent makes. */
function app(name: string, from?: string): string {
  const root = join(scratch, name);
  if (from !== root) from ? cpSync(from, root, { recursive: true }) : mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, "package.json"))) writeFileSync(join(root, "package.json"), JSON.stringify({ name, private: true, type: "module" }) + "\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "-c", "user.name=check", "-c", "user.email=check@localhost", "commit", "-q", "--allow-empty", "-m", "init");
  return root;
}

const official = readdirSync(join(repo, "bridges")).filter((n) => !n.startsWith("_"));
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) ? [readFileSync(join(dir, e.name), "utf8")] : []));

const apps: Record<string, string> = {};
// The examples are not in every checkout (the public repo has none).
for (const name of existsSync(join(repo, "examples")) ? readdirSync(join(repo, "examples")) : []) {
  const root = join(scratch, name);
  const example = join(repo, "examples", name);
  cpSync(example, root, { recursive: true, filter: (f) => !f.includes("/node_modules") });
  // Its npm packages (the studio's editor and diffs), as `pagent package add` installed them: from its lockfile, once.
  if (existsSync(join(example, "package-lock.json"))) {
    if (!existsSync(join(example, "node_modules"))) execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: example, stdio: "inherit" });
    symlinkSync(join(example, "node_modules"), join(root, "node_modules"), "dir");
  }
  // An example that uses an official bridge (import … from "~/wechat/actions") expects it installed (`pagent add`).
  const code = sources(root).join("\n");
  for (const b of official) if (code.includes(`"~/${b}/`) || code.includes(`"~/${b}"`)) cpSync(join(repo, "bridges", b), join(root, b), { recursive: true });
  apps[`examples/${name}`] = app(name, root);
}

// The bridges, as `pagent add` installs them; their npm packages are not installed (no network): a bridge that needs
// one fails here, which is the point of checking it.
const bridges = app("bridges");
for (const name of official) cpSync(join(repo, "bridges", name), join(bridges, name), { recursive: true });
await addNode(bridges, { app: "Pagent Check App", path: "/skeleton" }); // the skeleton, filled in
apps.bridges = bridges;

// What `npm create pagent` makes (its home page lives in index.js).
const created = join(scratch, "created");
execFileSync(process.execPath, [join(repo, "packages/create-pagent/index.js"), created], { stdio: "ignore" });
apps["create-pagent"] = created;
const createdZh = join(scratch, "created-zh");
execFileSync(process.execPath, [join(repo, "packages/create-pagent/index.js"), createdZh, "--lang", "zh-CN"], { stdio: "ignore" });
apps["create-pagent --lang zh-CN"] = createdZh;

// The engine skill's examples (SKILL.md and its chapters, SPEC 13.19), one scratch app per doc: a ts / tsx / js block
// whose first line is a path comment (// inbox/page.tsx) is that file, and more path comments in it start more files.
// A block that is no whole file says so in its info string (```tsx fragment). A ~/ node a file imports that no block
// writes is a stub: a page (and its hooks), or a "use server" file with the functions imported from it.
const skill = join(repo, "skill/skills/pagent");
let unmarked = 0;
for (const doc of ["SKILL.md", ...readdirSync(join(skill, "references")).map((f) => `references/${f}`)]) {
  const files: Record<string, string> = {};
  for (const [, lang, rest, body] of readFileSync(join(skill, doc), "utf8").matchAll(/^```(\w+)([^\n]*)\n([\s\S]*?)^```$/gm)) {
    const info = lang + rest;
    if (!/^(tsx?|jsx?)\b/.test(info) || /\bfragment\b/.test(info)) continue;
    const pathOf = (line: string) => /^\/\/ ([\w.\-[\]/]+\.(?:tsx?|jsx?))$/.exec(line)?.[1];
    if (!pathOf(body.split("\n")[0])) {
      console.error(`✗ ${doc}: a \`\`\`${info} block with no path comment on its first line; mark it \`\`\`${info.split(" ")[0]} fragment if it is no whole file`);
      unmarked++;
      continue;
    }
    let file = "";
    for (const line of body.split("\n")) {
      const path = pathOf(line);
      if (path) files[(file = path)] = "";
      else files[file] += line + "\n";
    }
  }
  if (!Object.keys(files).length) continue;
  for (const code of Object.values(files)) {
    for (const [, names, source] of code.matchAll(/^import\s+(.+?)\s+from\s+"~\/([^"]+)"/gm)) {
      const named = /\{([^}]*)\}/.exec(names)?.[1].split(",").map((n) => n.trim().replace(/^type\s+/, "")).filter(Boolean) ?? [];
      const hooks = named.filter((n) => /^use[A-Z]/.test(n));
      const served = named.filter((n) => !/^use[A-Z]/.test(n));
      const page = `${source}/page.tsx`;
      if (served.length && !Object.keys(files).some((f) => f.replace(/\.(tsx?|jsx?)$/, "") === source)) {
        files[`${source}.ts`] = `"use server";\n${served.map((n) => `export async function ${n}(input?: unknown) { return input; }`).join("\n")}\n`;
      } else if (!served.length && !files[page]) {
        files[page] = `export default function Stub() { return null; }\n${hooks.map((h) => `export function ${h}() { return null; }`).join("\n")}\n`;
      }
    }
  }
  // A folder with code but no page (a bridge's actions.ts alone) is a node all the same: its page left out of the doc.
  for (const rel of Object.keys(files).filter((f) => !f.startsWith("api/") && f.includes("/"))) {
    const page = rel.slice(0, rel.lastIndexOf("/")) + "/page.tsx";
    files[page] ??= "export default function Stub() { return null; }\n";
  }
  const root = join(scratch, `docs-${doc.replace(/\W/g, "-")}`);
  for (const [rel, code] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), code);
  }
  apps[`skill ${doc}`] = app(`docs-${doc.replace(/\W/g, "-")}`, root);
}

/**
 * The dynamic pages ([x] and [...x] folders) no made instance of the app covers, each as a made-up instance ("check"
 * for each dynamic segment, its folder made in the scratch copy): listNodes() only has the instances that are made, so
 * a dynamic page would otherwise be checked only once someone had opened it. An instance with code of its own (a file
 * that shadows the page's, SPEC 13.11) compiles its copy instead of the shared file, so it covers nothing.
 */
function madeUp(root: string, made: string[]): string[] {
  const covered = new Set(made.filter((m) => !shadowsOf(root, m).length).map((m) => codeOf(root, m)?.code));
  const out: string[] = [];
  const walk = (code: string[], at: string[]) => {
    for (const e of readdirSync(join(root, ...code), { withFileTypes: true })) {
      if (!e.isDirectory() || /^[._]/.test(e.name) || e.name === "node_modules") continue;
      const [c, a] = [[...code, e.name], [...at, isDynamic(e.name) ? "check" : e.name]];
      const dir = join(root, ...c);
      if (isDynamic(e.name) && (hasFile(dir, "page") || hasFile(dir, "layout")) && !covered.has("/" + c.join("/"))) {
        mkdirSync(join(root, ...a), { recursive: true });
        out.push("/" + a.join("/"));
      }
      walk(c, a);
    }
  };
  walk([], []);
  return out;
}

let failed = 0;
let compiled = 0;
for (const [label, root] of Object.entries(apps)) {
  const nodes = new Nodes(root);
  const made = listNodes(root);
  for (const path of [...made, ...madeUp(root, made)]) {
    const errors: string[] = [];
    const { sources, files, manifest, refused } = await nodes.declarations(path);
    // A made-up instance's params may well be refused by its agents() (an unknown workspace): not an error of its code.
    errors.push(...manifest.errors.filter((e) => e !== refused || made.includes(path)));
    for (const file of files) {
      const c = await nodes.module(path, file);
      errors.push(...c.errors.map((e) => `${file}.tsx: ${e}`));
      compiled++;
    }
    for (const file of new Set(manifest.actions.flatMap((a) => (a.file ? [a.file] : [])))) {
      // An instance's own copy of the file, else its source's: bundled as this node's.
      await bundleServerFile(root, fileIn(sources, file) ?? join(root, path, file), path).then(
        () => compiled++,
        (e) => errors.push(`${file}: ${(e as { errors?: { text: string }[] }).errors?.map((x) => x.text).join("; ") ?? (e as Error).message}`),
      );
    }
    const where = `${label}${path === "/" ? "" : path} (${nodeDir(root, path).slice(root.length) || "/"})`;
    if (errors.length) {
      failed++;
      console.error(`✗ ${where}\n${[...new Set(errors)].map((e) => `    ${e}`).join("\n")}`);
    } else console.log(`✓ ${where}`);
  }
  // Its routes (api/**/route.ts): what they export, and that they bundle as they run.
  for (const route of listRoutes(root)) {
    const errors = [...routeInfo(root, route).errors];
    await bundleRoute(root, route).then(
      () => compiled++,
      (e) => errors.push(`${(e as { errors?: { text: string }[] }).errors?.map((x) => x.text).join("; ") ?? (e as Error).message}`),
    );
    if (errors.length) {
      failed++;
      console.error(`✗ ${label} ${route.path}\n${errors.map((e) => `    ${e}`).join("\n")}`);
    } else console.log(`✓ ${label} ${route.path}`);
  }
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${compiled} compiled; ${failed ? `${failed} node${failed > 1 ? "s" : ""} with errors` : "no errors"}`);
process.exit(failed || unmarked ? 1 : 0);
