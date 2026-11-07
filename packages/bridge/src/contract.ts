// What the host provides to node code (HostApi), and the shapes on the way: an agent's status and events, a question,
// a data file read or written. The shell implements it; nodes never see how.
import type { ComponentType, CSSProperties } from "react";
import type { ChatTransport, UIMessage } from "ai";
import { t } from "./i18n.ts";

// ---------------------------------------------------------------- host contract

export type AgentRef = { node: string; agent: string };

/**
 * A question an agent asked the user (`pagent ask-user`), waiting for an answer; a permission request; or a form to
 * fill in (`ask-user --field`, or a Secure Form: `--secret --into`, one value that goes to `where` and never to the agent).
 */
export type Question = {
  id: string;
  node: string;
  agent: string;
  kind: "question" | "permission" | "form";
  question: string;
  detail?: string;
  /**
   * A plan the agent asks to go ahead with (a proposal, ToolMeta: Claude Code's ExitPlanMode), as markdown: the card
   * shows it rendered, and besides its options (Approve, Keep planning) takes what to change in it, which keeps it planning.
   */
  plan?: string;
  /** A permission request: what the tool it is about does (ToolKind), for how the card says it; "dialog": a dialog in its TUI (not a tool). */
  toolKind?: ToolKind | "dialog";
  options: string[];
  form?: { fields: { name: string; label: string }[]; secret?: boolean; where?: string; whereSay?: Say };
  /**
   * The engine's own words in it (a permission or trust request), as words of its table (i18n.ts): the question, its
   * detail, each option. The answer is still the option as written ("Allow").
   */
  say?: { question: Say; detail?: Say; options?: Say[] };
  createdAt: number;
};

/**
 * A message waiting for the agent's turn, on the server (it goes on waiting whether a page stays open or not): `id`,
 * the run it starts as (what to withdraw it by, HostApi.unqueue); `user`, the message as the conversation will show it;
 * `caller`, who it is from (`{ kind: "user" }`: the person, queued in a conversation; else another agent, a trigger …).
 */
export type QueuedMessage = { id: string; user: UIMessage; caller: Caller };

/** A rate limit window of the account: how much of it is used (0–100), and when it starts again. */
export type RateLimit = { usedPercent: number; resetsAt: string | null };

/**
 * How much of its model the agent's session uses, as its runner read it at the end of the last turn (or, before one,
 * from the session's record): only numbers. Claude Code: from the session's transcript (each request once), its
 * context window and the rate limits as Claude Code tells them to its status line (TUI) or stream (headless). Codex:
 * what its app-server and rollout say. A sub-agent's own requests are not in the totals.
 */
export type SessionUsage = {
  /** Tokens the last request sent: its input, from the cache or not (what the context holds now, about). */
  context: number;
  /** The model's context window, when the harness says it. */
  window: number | null;
  /** The session's totals: input not from the cache, cache reads, cache writes, output. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** How often its context was compacted. */
  compactions: number;
  /** Requests to the model in the totals (when the harness's record tells them apart). */
  requests?: number;
  model: string | null;
  /** When it last used the model. */
  at: string | null;
  /** The account's rate limits (5 hours, a week) as the harness last told them (at), when it does. */
  limits?: { fiveHour?: RateLimit; weekly?: RateLimit; at: string };
};

/**
 * What an agent is doing, in parts. `label`: in a few plain words, for people ("Running a command", "Editing
 * page.tsx", "Thinking", "Explore: Reading page.tsx"), in the app's language. `say`: the same as words of the engine's
 * table and their values (i18n.ts), which the label is made from. `tool` and `detail`: the call itself, as its harness
 * names it and its most telling argument ("Bash", "git status"), for a closer look (a tooltip). `subagent`: a sub-agent
 * of its is the one doing it (its type).
 */
export type Activity = { label: string; say?: Say; tool?: string; detail?: string; subagent?: string };

/** Words of the engine's table (i18n.ts), by key, with the values that go in them: a label as the server says it. */
export type Say = { key: string; values?: Record<string, string | number | Say> };

/** What an agent is doing right now. */
export type AgentStatus = {
  busy: boolean;
  /** The same as `doing`, as one raw line ("Bash git status", "thinking"): what a log would say. */
  activity: string | null;
  /** What it is doing, in parts: show its label; its tool and detail on a closer look. Hosts before it: absent. */
  doing?: Activity | null;
  /** When the turn it is in started (ms), if the host knows: how long it has been at it. */
  since?: number | null;
  /** Busy: when the last sign of it came (a step of its turn, a new state of its TUI), ms: how long it has been quiet. */
  quietSince?: number | null;
  /** Busy and quiet for 15 minutes or more: it may be stuck (a call that never returns, a prompt nobody sees). */
  stuck?: boolean;
  /**
   * Busy, and a message sent with interject (sendMessage(…, { body: { interject: true } })) goes into its turn in
   * progress, which its harness reads between two steps; otherwise it waits for the turn to end.
   */
  interject?: boolean;
  questions: Question[];
  /** The messages waiting for its turn, oldest first (QueuedMessage): each starts as a run when the one before it ends. */
  queued: QueuedMessage[];
  /**
   * usage: null when its session has none yet (or its runner does not say). harness: what runs it (its runner's
   * describe: "claude", "Claude Code"). can: what its harness can do, so a page shows only that (SPEC 13.18): a terminal
   * (<Terminal>), a message into the turn in progress (interject), a timeline (useTrajectory), token use, answers to
   * strangers. Hosts before it: absent (take everything as there).
   */
  session: {
    slashCommands?: string[];
    model?: string;
    sessionId?: string | null;
    resume?: string | null;
    usage?: SessionUsage | null;
    harness?: { id: string; title: string };
    can?: { terminal: boolean; interject: boolean; trajectory: boolean; usage: boolean; strangers: boolean };
  };
  /** A remote agent (another app's) that the other app does not take messages for now: why. Shown as a session that died. */
  offline?: string | null;
  /**
   * The agent's native TUI, when one is open (<Terminal>): its state as the TUI reports it. dialog: blocked on a dialog
   * that is no permission prompt (its harness's own, "We recommend compacting earlier"), its first line; a card asks it.
   * stale: it runs with a declaration that changed since it started ("settings": a model, a cwd), or an older version of
   * its harness ("update": the CLI was updated since): it restarts with what is current before the agent's next
   * message, unless someone is in it (restartTerminal); nobody in it, it does so by itself once quiet for a minute.
   */
  terminal?: { open: boolean; state?: string; kind?: string; msg?: string; dialog?: string; stale?: "settings" | "update" };
  /**
   * Its turns go into its TUI, but that TUI did not come up: they run headless for now, and no message goes into its
   * turn in progress (no interject). why: what kept it (its screen's last words, e.g. a question its shell asked);
   * retryAt: when it is tried again (ms; null: not by itself). Opening its terminal ends it.
   */
  headless?: { why: string; retryAt: number | null } | null;
  /** Asked with `said`: the end of its last reply as one line (where it stopped, often what it asks), and when. */
  said?: { text: string; at: string | null } | null;
  /** Asked with `said`: when it last talked (a message to it or from it). */
  lastAt?: string | null;
  /** Asked with `said`: the session's title, as its harness names it (Claude Code's own title for it), if it has one. */
  title?: string | null;
};

/**
 * What a tool call does, whatever its harness names the tool (SPEC 13.18): every runner says it on each call, as the
 * call's `toolMetadata` (a dynamic-tool part's, and its chunks'). The same type as runners/src/lib/tools.ts.
 *   command    runs a shell command (command)          read, write, edit   files (files)
 *   search     looks through files (query)             web                 reads a page (url)
 *   webSearch  searches the web (query)                subagent            starts a sub-agent (its data-subagent part follows)
 *   subagents  waits for / messages its sub-agents      skill, toolSearch   loads a skill, looks for a tool
 *   steps      changes its list of steps (steps)        proposal            proposes a plan (plan; asks: waits for approval)
 *   planMode   asks to plan first                       ask                 asks the person in the harness's own way
 *   mcp        an MCP server's tool (server)            other               anything else (its name is shown)
 */
export type ToolKind = "command" | "read" | "write" | "edit" | "search" | "web" | "webSearch" | "subagent" | "subagents" | "skill" | "toolSearch" | "steps" | "proposal" | "planMode" | "ask" | "mcp" | "other";

/** A step of the agent's list: what it is, and whether it is to do, under way or done. */
export type PlanStep = { text: string; status: "pending" | "active" | "done" };

/** How a call changes the list of steps: the whole list, one more (its id when numbered), or one of them by id. */
export type StepsChange =
  | { set: PlanStep[]; explanation?: string }
  | { add: PlanStep & { id?: string } }
  | { update: { id: string; status?: PlanStep["status"]; text?: string; deleted?: true } };

export type ToolMeta = {
  kind: ToolKind;
  command?: string;
  files?: string[];
  url?: string;
  query?: string;
  server?: string;
  steps?: StepsChange;
  plan?: string;
  asks?: boolean;
};

/**
 * A sub-agent the agent's harness ran (Claude Code's Agent tool, Codex's spawn_agent), as every runner gives it: the
 * tool call that started it is followed in the message by a `data-subagent` part (id: the call's toolCallId, data:
 * this) and its steps, `data-subagent-step` parts (id: "<toolCallId>:<n>", data: { of: toolCallId, part }), each step
 * a UIMessage part of its own. Live, the same arrive as data chunks, sent again when they change.
 */
export type SubagentInfo = {
  type: string;
  description: string;
  status: "running" | "done" | "error" | "stopped";
  prompt?: string;
  model?: string;
  background?: boolean;
  depth?: number;
  startedAt?: string;
  durationMs?: number;
  toolUses?: number;
  tokens?: number;
  summary?: string;
};

/**
 * What happened in an agent's session, on a timeline (SPEC 13.17; useTrajectory): read from the harness's own record of
 * the session (Claude Code's transcripts, a Codex thread's rollout), with what only the app knows added (the turn's id,
 * who a message came from, the waits on the person). Times are what the record says, never estimated: a record with no
 * end is still going (or its harness never said).
 *   turn        one turn: from its message to the end of what it waited for; its requests' tokens summed (its
 *               sub-agents' too); what it cost when the harness says (costUSD: Claude Code), how long to the first
 *               token (ttftMs: Codex), how it ended (status)
 *   user        a message to the agent: who from (from: a page, an agent, a trigger; none: a person), and how it came
 *               (via: "app", through this app; "terminal", typed into the harness's own terminal; "harness", the
 *               harness's own notice, such as a background sub-agent finishing)
 *   assistant   one request to the model: its reply (output), what it thought (thinking), its tokens (usage), its model
 *   tool        a tool call: name, input, output, error
 *   subagent    a sub-agent (Claude Code's Agent tool, Codex's spawn_agent): its kind (name), prompt, answer, tokens;
 *               its own records have it as their parent; background: the turn went on without it
 *   compaction  the context compacted (name: "auto" or "manual"; input/output: the tokens before and after, the summary)
 *   wait        the agent waited on the person: a permission card, a question, a form (wait), from asking to answering
 *               (name: the question; input: its detail; output: the answer, a form's outcome only)
 */
export type TrajectoryKind = "turn" | "user" | "assistant" | "tool" | "subagent" | "compaction" | "wait";

/** One request's tokens: input not from the cache, cache reads, cache writes, output (reasoning: of the output). */
export type TrajectoryUsage = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning?: number };

export type TrajectoryRecord = {
  /** Unique in the session: the harness's own id where it has one (a tool call's, a message's). */
  id: string;
  /** The turn it is part of: the id of the message that started it, as the app has it (ChatTurn.id, TurnEvent.messageId). */
  turnId: string | null;
  kind: TrajectoryKind;
  /** ms since the epoch. No end: still going. */
  start: number;
  end?: number;
  name?: string;
  input?: unknown;
  output?: unknown;
  thinking?: string;
  error?: boolean;
  usage?: TrajectoryUsage;
  model?: string;
  /** The sub-agent record it happened inside. */
  parent?: string;
  background?: boolean;
  from?: Caller;
  via?: "app" | "terminal" | "harness";
  costUSD?: number;
  ttftMs?: number;
  status?: string;
  wait?: "permission" | "question" | "form";
  /** A wait never answered: the server went away with it open (its end: when the next server found it so). */
  gone?: boolean;
  /** Its input, output or thinking was cut for the list: useTrajectory's record(id) has it whole. */
  truncated?: boolean;
};

/**
 * A read of a trajectory: every record (whole: true), or, after the `at` a view had, only the records that changed
 * since and the ids that went away (whole: false). at: what to say next time (none: the host cannot say what changed).
 */
export type TrajectoryPage = { records: TrajectoryRecord[]; removed?: string[]; at?: string; whole?: boolean };

/** Agent activity the host reports. */
export type AgentEvent =
  | { type: "run-start"; runId: string; user: UIMessage; clientId: string | null }
  /** label: the raw line (AgentStatus.activity); doing: the same in parts. */
  | { type: "activity"; runId: string; label: string; doing?: Activity }
  | { type: "run-end"; runId: string }
  /** The messages waiting for its turn changed (one queued, withdrawn, or its turn came, just before its run-start): all of them. */
  | { type: "queued"; queued: QueuedMessage[] }
  | { type: "question"; question: Question }
  /** outcome: how a form ended (cancelled: closed without its values). */
  | { type: "answered"; id: string; outcome?: "submitted" | "cancelled" }
  /** Its status changed outside a run (its terminal opened, closed, or reported a new state): reload the status. */
  | { type: "status" }
  /** Its conversation grew outside the app (a turn typed in its terminal): reload the history (and the status). */
  | { type: "history" }
  /** Anything may have changed (the host reconnected): reload everything. */
  | { type: "resync" };

export type DataRead = { exists: boolean; content: unknown; version: string | null };
export type DataWrite = { ok: true; version: string } | ({ ok: false } & DataRead);

/** A write based on a version of the file that is no longer current; the hook already shows the current one. */
export class DataConflict extends Error {
  name = "DataConflict";
  readonly file: string;
  constructor(file: string) {
    super(`${file} changed since it was read; showing the current version. Write with an updater (set(prev => …)) to merge.`);
    this.file = file;
  }
}

export type ChatOrigin = { origin: string; clientId: string };

/**
 * Who a message in an agent's conversation comes from, as the engine says (its metadata.caller; core: caller.ts): a
 * page's button, another agent, a trigger, the engine itself, or someone outside the app through a route (from: the
 * sender's address). via: the app's code it came through (a route, a server function). A person's own words have none.
 */
export type Caller = (
  | { kind: "user" }
  | { kind: "page"; path: string }
  | { kind: "agent"; node: string; agent: string; noReply?: true } // noReply: the sender asked for none (pagent tell --no-reply)
  | { kind: "trigger"; node: string; name: string }
  | { kind: "pagent" }
  | { kind: "local"; name: string; noReply?: true } // a session on this computer outside the app (pagent tell --as <name>)
  | { kind: "external"; ip: string; from?: string; key?: { name: string; scope: string }; inReplyTo?: string; remote?: string }
) & { via?: string[] };

/** A caller as people read it: "/ideas#ideas", "trigger:/ops#sweep", "http://192.168.0.50:4880/api/message (key sam)". */
export function callerLabel(c: Caller): string {
  switch (c.kind) {
    case "user": return t("caller.you");
    case "page": return c.path;
    case "agent": return `${c.node}#${c.agent}`;
    case "trigger": return `trigger:${c.node}#${c.name}`;
    case "pagent": return "pagent";
    case "local": return `local:${c.name}`;
    case "external": {
      const who = c.from ?? c.ip;
      return c.key ? `${who} (key ${c.key.name})` : c.inReplyTo ? who : t("caller.stranger", { who });
    }
    default: return String((c as { kind: unknown }).kind); // a newer engine's sender
  }
}

/** What the host (the shell) provides. */
export type HostApi = {
  ask(target: AgentRef, message: string, opts: { origin: string }): Promise<string>;
  /**
   * A view's part of the history: from `after` on (it included), if the host still has it; else the last `last` turns
   * before `before` (earlier ones), or before the end. earlier: how many messages come before the part (0: none). Long
   * tool input and output are cut to a few lines ("\n… (N more characters)"): toolCall has a call whole.
   */
  history(target: AgentRef, opts: { after?: string; before?: string; last: number }): Promise<{ messages: UIMessage[]; earlier: number }>;
  /** One tool call of the agent's conversation (or of a sub-agent's) as it is, by its id (null: no such call). */
  toolCall(target: AgentRef, id: string): Promise<{ input?: unknown; output?: unknown; errorText?: string } | null>;
  chatTransport(target: AgentRef, opts: ChatOrigin): ChatTransport<UIMessage>;
  /**
   * The agent's session as a timeline (long records cut): all of it, or what changed after the `at` of a page the view
   * has (TrajectoryPage); trajectoryRecord: one whole (null: no such record).
   */
  trajectory(target: AgentRef, opts?: { after?: string }): Promise<TrajectoryPage>;
  trajectoryRecord(target: AgentRef, id: string): Promise<TrajectoryRecord | null>;
  /** handle: with the session's id and resume command; said: with its last words (said, lastAt). */
  status(target: AgentRef, opts?: { handle?: boolean; said?: boolean }): Promise<AgentStatus>;
  /** Call a node's "use server" function as the page `from`: what it returned, or the message it threw. */
  action(node: string, name: string, input: unknown, from: string): Promise<{ ok: true; value?: unknown } | { ok: false; error: string }>;
  /** Stop the agent's turn in progress (as Esc in its TUI): what was done, or null when it was in none. */
  stop(target: AgentRef): Promise<string | null>;
  /**
   * The person's message (as useChat holds one: text, images), queued on the server for after the agent's turn in
   * progress: it shows in status.queued until its turn comes, then starts as a run every view of the agent picks up.
   * What it resolves to: the id it waits by (QueuedMessage.id).
   */
  queue(target: AgentRef, message: UIMessage): Promise<string>;
  /** Withdraw a queued message: it never reaches the agent. false: it no longer waits (its turn came). */
  unqueue(target: AgentRef, id: string): Promise<boolean>;
  /** Restart its TUI on its session, to take a changed declaration or an updated harness (status.terminal.stale); fails during a turn. Hosts before it: absent. */
  restartTerminal?(target: AgentRef): Promise<string>;
  /** values: a form's, by field name (none: cancelled). Fails with what went wrong (the form stays open). */
  answer(questionId: string, answer: string, values?: Record<string, string>): Promise<void>;
  onAgent(target: AgentRef, cb: (e: AgentEvent) => void): () => void;
  /** version: a hash of the file (null: it does not exist). */
  readData(node: string, file: string): Promise<DataRead>;
  /** With base, a file that changed since is not written; its current content comes back instead (ok: false). */
  writeData(node: string, file: string, content: unknown, base?: string | null): Promise<DataWrite>;
  onData(node: string, file: string, cb: () => void): () => void;
  NodeFrame: ComponentType<{ path: string; from?: string; props: Record<string, unknown>; handlers: Record<string, unknown> }>;
  /** Render another server's MCP App (an mcp:// import). */
  McpApp: ComponentType<{ source: string; args?: Record<string, unknown> }>;
  /** The agent's native TUI (Claude Code / Codex) in a terminal. */
  Terminal: ComponentType<{ target: AgentRef; style?: CSSProperties }>;
  /** A page's title (its metadata.title, else its folder's name), to name it to people (a card's head). */
  pageTitle(path: string): Promise<string | null>;
};
