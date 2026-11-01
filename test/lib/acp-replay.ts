#!/usr/bin/env node
// A recorded ACP agent (test/fixtures/acp/<harness>.json, made by scripts/record-acp.ts from the real CLI against the
// stand-in model API): it answers a client as the real agent did. Each request of the client's is matched to the next
// recorded one of the same method, and what the agent sent after it, up to its answer, is sent again (its requests,
// such as a permission request, wait for the client's answer first). "$CWD" in the recording is the folder it runs in.
// Run in place of the harness's CLI ($ACP_FIXTURE; OPENCODE_BIN / GEMINI_BIN / QWEN_BIN point here), it also answers
// `export <id>` (opencode's own record) with the recorded one. No model, no network.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

type Msg = { t?: number; dir: ">" | "<"; m: any };
const fixture = JSON.parse(readFileSync(process.env.ACP_FIXTURE!, "utf8")) as { messages: Msg[]; export?: unknown };
const here = (v: unknown) => JSON.parse(JSON.stringify(v).split("$CWD").join(process.cwd()));
const args = process.argv.slice(2);

if (args[0] === "export") {
  if (!fixture.export) process.exit(1);
  process.stdout.write(JSON.stringify(here(fixture.export), null, 2) + "\n");
  process.exit(0);
}

const messages = fixture.messages;
let at = 0;
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
let answered = null as (() => void) | null;

/** Plays what the agent sent after the recorded request at `i` up to its answer, which gets the client's id. */
async function play(i: number, id: unknown) {
  const recordedId = messages[i].m.id;
  for (let j = i + 1; j < messages.length; j++) {
    const { dir, m } = messages[j];
    if (dir !== "<") continue;
    if (m.id === recordedId && !m.method) {
      at = j + 1;
      return send({ ...here(m), id });
    }
    if (m.method && m.id !== undefined) {
      // The agent's own request (a permission): sent, and the rest waits for its answer.
      await new Promise<void>((resolve) => ((answered = resolve), send(here(m))));
      continue;
    }
    send(here(m));
  }
  at = messages.length;
  send({ jsonrpc: "2.0", id, error: { code: -32603, message: "the recording ends here" } });
}

let queue: Promise<unknown> = Promise.resolve();
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    continue;
  }
  if (m.method === undefined && m.id !== undefined) {
    answered?.();
    answered = null;
    continue;
  }
  if (m.id === undefined) continue; // a notification (session/cancel)
  queue = queue.then(() => {
    let i = at;
    while (i < messages.length && !(messages[i].dir === ">" && messages[i].m.method === m.method && messages[i].m.id !== undefined)) i++;
    if (i >= messages.length) return void send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `nothing recorded for ${m.method}` } });
    return play(i, m.id);
  });
}
