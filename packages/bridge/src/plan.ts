// An agent's plan, as its harness keeps it in the conversation (SPEC 13.16): a plan it proposes before it changes
// anything (a call whose meta is a "proposal": its plan, and whether the harness waits for the person's approval), and
// its list of steps as it works ("steps" calls: the whole list, one more, or one changed). Every runner says what each
// call is (its toolMetadata, ToolMeta, SPEC 13.18), so nothing here knows a harness; nothing adds what the harness
// does not say.
import type { UIMessage } from "ai";
import type { PlanStep, StepsChange, ToolMeta } from "./contract.ts";

export type { PlanStep } from "./contract.ts";

type Part = UIMessage["parts"][number];
type ToolPart = Extract<Part, { type: "dynamic-tool" }>;

/**
 * A plan the agent proposed: its text (markdown), and how it stands. `asking`: waiting for the person's approval;
 * `approved`; `declined` (the person kept it planning); `proposed`: a harness that asks nothing (Codex: you answer in
 * the conversation).
 */
export type Proposal = { id: string; text: string; state: "asking" | "approved" | "declined" | "proposed" };

/** What a conversation says of the agent's plan now: the latest proposal, the latest list of steps (null: none). */
export type Plan = { proposal: Proposal | null; steps: PlanStep[] | null; explanation?: string };

const tool = (p: Part): ToolPart | null => (p.type === "dynamic-tool" ? (p as ToolPart) : null);

/** What a call does, as its runner says (none: nothing the app reads it for). */
export const metaOf = (p: { toolMetadata?: unknown }): ToolMeta | null => {
  const m = p.toolMetadata as ToolMeta | undefined;
  return m && typeof m.kind === "string" ? m : null;
};

/** A proposed plan, when this call is one: its plan, and (when its harness asks) how the person answered. */
export function proposalOf(p: Part): Proposal | null {
  const t = tool(p);
  const m = t && metaOf(t);
  if (!t || m?.kind !== "proposal" || !m.plan?.trim()) return null;
  if (!m.asks) return { id: t.toolCallId, text: m.plan, state: "proposed" };
  const state = t.state === "output-available" ? "approved" : t.state === "output-error" ? "declined" : "asking";
  return { id: t.toolCallId, text: m.plan, state };
}

/** What this call changes of the agent's list of steps (null: it is no such call). */
export const stepsChangeOf = (p: Part): StepsChange | null => {
  const t = tool(p);
  const m = t && metaOf(t);
  return m?.kind === "steps" && m.steps ? m.steps : null;
};

/** Whether this call says something of the agent's list of steps. */
export const isSteps = (p: Part) => !!stepsChangeOf(p);

/**
 * The list of steps after these calls, in order (null: none says anything): a whole list replaces it; one more is
 * added (its id, when the harness numbers them, else one past the highest number so far); one changed is found by its
 * id.
 */
export function stepsAfter(parts: Part[]): { steps: PlanStep[]; explanation?: string } | null {
  let steps: (PlanStep & { id?: string })[] | null = null;
  let explanation: string | undefined;
  for (const p of parts) {
    const t = tool(p);
    const change: StepsChange | undefined = t ? metaOf(t)?.steps : undefined;
    if (!change) continue;
    if ("set" in change) {
      steps = change.set.map((s) => ({ text: s.text, status: s.status }));
      explanation = change.explanation?.trim() ? change.explanation : undefined;
    } else if ("add" in change) {
      steps ??= [];
      // Not its place: after a step was deleted, that would be the number of one still there.
      const next = steps.reduce((max, s) => Math.max(max, Number(s.id) || 0), 0) + 1;
      steps.push({ id: change.add.id ?? String(next), text: change.add.text, status: change.add.status });
    } else if (steps) {
      const at = steps.findIndex((s) => s.id === change.update.id);
      if (at < 0) continue;
      if (change.update.deleted) steps.splice(at, 1);
      else steps[at] = { ...steps[at], ...(change.update.status ? { status: change.update.status } : {}), ...(change.update.text !== undefined ? { text: change.update.text } : {}) };
    }
  }
  return steps && { steps: steps.map(({ text, status }) => ({ text, status })), ...(explanation ? { explanation } : {}) };
}

/**
 * What one message says of the plan: its latest proposal, its calls that change the steps. By the message itself: a
 * message that did not change is the same object (useChat and history.ts keep it), so a reply streaming in is read
 * again, not the whole conversation with each chunk.
 */
const read = new WeakMap<UIMessage, { proposal: Proposal | null; steps: Part[] }>();
function planIn(m: UIMessage) {
  let r = read.get(m);
  if (!r) {
    let proposal: Proposal | null = null;
    for (let i = m.parts.length - 1; i >= 0 && !proposal; i--) proposal = proposalOf(m.parts[i]);
    r = { proposal, steps: m.parts.filter(isSteps) };
    read.set(m, r);
  }
  return r;
}

/** The plan as the conversation has it now: the latest proposal, the list of steps after every call. */
export function planOf(messages: UIMessage[]): Plan {
  const said = messages.filter((m) => m.role === "assistant").map(planIn);
  let proposal: Proposal | null = null;
  for (let i = said.length - 1; i >= 0 && !proposal; i--) proposal = said[i].proposal;
  const steps = stepsAfter(said.flatMap((s) => s.steps));
  return { proposal, steps: steps?.steps ?? null, ...(steps?.explanation ? { explanation: steps.explanation } : {}) };
}
