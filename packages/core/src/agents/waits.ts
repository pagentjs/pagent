// How long an agent waited on the person (SPEC 13.17): a permission card, its question (`pagent ask-user`), a form,
// from the moment it was asked to the moment it was answered. Only the app knows this (the harness sees a tool call
// that took long), so it is written down here as it happens, per agent, in its state (<node>/.state/<agent>/waits.json,
// the latest 500), with the turn it was asked in (the run's message id: the turn's id, ids.ts). A form's values are
// never kept (a Secure Form's go where they go): only how it ended.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { onQuestion, questionOf, type Question } from "../questions.ts";
import type { AgentRef } from "../refs.ts";
import { activeRun } from "./runs.ts";
import { nodeFolder } from "./runner.ts";
import type { Ctx } from "./types.ts";

export type Wait = {
  id: string;
  kind: Question["kind"];
  question: string;
  detail?: string;
  /** When it was asked and answered (ms). No end: it still waits (or the server went away before an answer). */
  start: number;
  end?: number;
  /** The answer ("Allow", "Deny", what they typed); a form: "submitted" or "cancelled"; "" withdrawn (answered elsewhere). */
  answer?: string;
  /** The turn it was asked in, when the agent was in one. */
  turnId?: string;
  /**
   * Never answered: the server went away with it open (a permission card's request died with it; a question it put on
   * screen again is pending, so not this). Its end is when the next server found it so: it ended by then.
   */
  gone?: true;
};

const KEEP = 500;
/** An agent's name as a folder of its state: never one that leaves it (the name comes from a request). */
const safeName = (agent: string) => !!agent && agent !== "." && agent !== ".." && !/[/\\\0]/.test(agent);
const fileOf = (ctx: Ctx, ref: AgentRef) => (safeName(ref.agent) ? join(nodeFolder(ctx, ref), ".state", ref.agent, "waits.json") : null);

// When this server began keeping waits: one with no end from before then is not waited on any more, unless its
// question is on screen again (restored: pending).
let since = Date.now();

function read(ctx: Ctx, ref: AgentRef): Wait[] {
  const file = fileOf(ctx, ref);
  if (!file) return [];
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const left = (w: Wait) => w.end === undefined && w.start < since && !questionOf(w.id);

/** The agent's waits on the person; the ones a previous server left open, and nobody waits on now, closed (gone). */
export function waitsOf(ctx: Ctx, ref: AgentRef): Wait[] {
  const waits = read(ctx, ref);
  if (!waits.some(left)) return waits;
  const close = (ws: Wait[]) => ws.map((w): Wait => (left(w) ? { ...w, end: since, answer: "", gone: true } : w));
  update(ctx, ref, close);
  return close(waits);
}

function update(ctx: Ctx, ref: AgentRef, change: (waits: Wait[]) => Wait[]) {
  const file = fileOf(ctx, ref);
  if (!file || !existsSync(nodeFolder(ctx, ref))) return; // its node is gone
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(change(read(ctx, ref)).slice(-KEEP)) + "\n");
    renameSync(tmp, file);
  } catch (e) {
    console.warn(`${ref.node}#${ref.agent}: could not keep a wait on the person (${(e as Error).message})`);
  }
}

/**
 * Write down every question asked of the person and its answer, for this app's agents, from now on. A wait a previous
 * server left open is closed when it is next read (waitsOf), once the questions it left are on screen again.
 */
export function recordWaits(ctx: Ctx): () => void {
  since = Date.now();
  return onQuestion((e) => {
    const q = e.question;
    const ref = { node: q.node, agent: q.agent };
    if (e.type === "asked") {
      // A question a restarted server put on screen again is the same wait.
      const turnId = activeRun(ref)?.user.id;
      const wait: Wait = { id: q.id, kind: q.kind, question: q.question, ...(q.detail ? { detail: q.detail } : {}), start: q.createdAt, ...(turnId ? { turnId } : {}) };
      update(ctx, ref, (ws) => (ws.some((w) => w.id === q.id) ? ws : [...ws, wait]));
    } else {
      const answer = q.kind === "form" ? (e.outcome ?? "") : e.answer;
      update(ctx, ref, (ws) => ws.map((w) => (w.id === q.id ? { ...w, end: Date.now(), answer } : w)));
    }
  });
}
