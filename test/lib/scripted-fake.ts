#!/usr/bin/env node
// The fake runner (packages/runners/test/fake.ts) with a script per agent, for agents that are woken by an app's code
// rather than by a test's message (a meeting's turns): each turn takes the next entry of <cwd>/script.json (an array
// of strings) and puts it before the message it got, so the fake runs those steps ("!sh pagent run …", "!say …"; an
// empty entry: the fake's plain echo). "{{meeting}}" in an entry is the meeting the message names (/meetings/<id>),
// else the last one this agent heard of. Every message it got is kept, as it got it, in <cwd>/.received.jsonl.
// Declare it as the fake is: agents = { main: { runner: "/…/scripted-fake.ts" } }. Headless turns only.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const fake = fileURLToPath(new URL("../../packages/runners/test/fake.ts", import.meta.url));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
const first = await lines.next();
const input = JSON.parse(first.done ? "{}" : first.value) as { op: string; cwd: string; message?: string };

if (input.op === "ask" && input.message !== undefined) {
  const at = (f: string) => join(input.cwd, f);
  appendFileSync(at(".received.jsonl"), JSON.stringify({ at: Date.now(), message: input.message }) + "\n");
  const named = /\/meetings\/[\w+-]+/.exec(input.message)?.[0];
  if (named) writeFileSync(at(".meeting"), named);
  const meeting = named ?? (existsSync(at(".meeting")) ? readFileSync(at(".meeting"), "utf8") : "");
  const script: string[] = existsSync(at("script.json")) ? JSON.parse(readFileSync(at("script.json"), "utf8")) : [];
  const steps = script.shift() ?? "";
  writeFileSync(at("script.json"), JSON.stringify(script));
  if (steps) input.message = `${steps.replaceAll("{{meeting}}", meeting)}\n${input.message}`;
}

const child = spawn(process.execPath, [fake, ...process.argv.slice(2)], { stdio: ["pipe", "inherit", "inherit"] });
child.stdin.write(JSON.stringify(input) + "\n");
void (async () => {
  for await (const line of { [Symbol.asyncIterator]: () => lines }) child.stdin.write(line + "\n");
  child.stdin.end();
})();
child.on("exit", (code) => process.exit(code ?? 0));
