// The runner contract (SPEC 13.18): everything the engine and the bridge rely on a runner for, in one place. A runner is
// a script the engine spawns with node: one JSON object on the first line of stdin (an op and its input), JSON lines on
// stdout (its events), its log on stderr. The engine knows no harness by name; what a runner says here is all it goes
// by. A new harness is a new runner that passes the conformance suite (test/conformance/).
//
// Every op is required or optional. A runner says which optional ones it answers in its describe (`ops`); the engine
// asks for nothing else, and where an optional one is missing it does without, as each says below (so a page can hide
// what a harness cannot do, instead of knowing harnesses by name: AgentStatus.session.can).
//
// What a turn streams (ask, follow, a session's turns) is AI SDK's UIMessageChunk, plus:
//   transient data chunks:  data-session {sessionId, slashCommands?, model?}   the session the turn is on
//                           data-user {id}        the transcript's own id for the turn's message (core: agents/ids.ts)
//                           data-usage SessionUsage   the session's token use, before the turn ends (lib/usage.ts)
//                           data-result {text, isError?}   the turn's answer: the last text the agent wrote
//   each tool call's toolMetadata: what it does, whatever the harness names it (lib/tools.ts, ToolMeta). Required.
//   sub-agents: data-subagent / data-subagent-step chunks and parts (lib/subagents.ts).
// A history (the history op) is UIMessage[] in the same shape: tool parts with toolMetadata, sub-agents' parts after the
// call that started them, a user message's metadata.kind "compaction" (the summary a compacted session goes on from)
// or "background" (the harness's own notification that a background task ended).
//
// Permission requests: a runner whose harness asks before a tool runs sends the question to the app (permissionUrl,
// PermissionRequest below) and does as the answer says; no answer (someone watches the agent's terminal) means the
// harness asks in its own way.
import type { UIMessage } from "ai";
import type { ToolMeta } from "./tools.ts";
import type { TrajectoryRecord } from "./trajectory.ts";
import type { SessionUsage } from "./usage.ts";

export type { ToolMeta, ToolKind, StepsChange, PlanStep } from "./tools.ts";

// ---------------------------------------------------------------- input

/** What every op but describe gets: where the agent works and keeps its state, and how to find its session. */
export type BaseInput = {
  /** Where the harness runs: the node's folder, or the folder an adopted session lives in. */
  cwd: string;
  /** The agent's own state (the node's .state/<agent>): what the runner remembers of it (session.json …). */
  stateDir: string;
  /** More folders the agent may write (its node's, when it works elsewhere). */
  addDirs?: string[];
  /** An existing session to adopt the first time (the declaration's sessionId). */
  seedSession?: string;
  /** Its cwd is not its node's folder (others may work there): its session is its own, never that folder's latest. */
  ownSession?: boolean;
  /** The agent's TUI is running, as this process: the session that TUI is on is the agent's. */
  tui?: number;
  /** A thread runner's quick ops: the thread the agent's session has open. */
  thread?: string;
  /** A thread runner's interactive op: where another client attaches to the session (its ready event's endpoint). */
  endpoint?: string;
};

/** What starts the harness (ask, interactive, session) gets besides: the agent's identity and the engine's additions. */
export type AgentInput = BaseInput & {
  message?: string;
  /** The agent's identity for the `pagent` command (PAGENT_*), and PATH with the engine's `pagent` first. */
  env?: Record<string, string>;
  /** Where `pagent` reaches the app: a sandbox must let commands connect to it. */
  agentSocket?: string | null;
  /** Where permission requests go (PermissionRequest). */
  permissionUrl?: string;
  /** The engine's skills (plugin folders with skills/<name>/SKILL.md). */
  pluginDirs?: string[];
  /** Declared: the agent's skills (SKILL.md folders) instead of the user's. */
  skills?: string[];
  /** Declared: the agent's MCP servers (by name, as .mcp.json writes one) instead of the user's. */
  mcps?: Record<string, unknown>;
  systemPrompt?: string;
  /** The rest of the agent's declaration, as written: model, effort, permission mode … each runner reads its own. */
  options?: Record<string, unknown>;
  /** The app's folder. */
  appRoot?: string;
};

// ---------------------------------------------------------------- describe

export type Turns = "tui" | "thread" | "headless";

/**
 * What a runner says it is and does: the describe op's answer, asked once per runner. Every engine runner answers it;
 * a minimal headless runner of an app's own may not (it runs, says nothing of itself): the engine takes it as headless,
 * with ask and history only, named by its file (core/agents/runner.ts).
 */
export type Describe = {
  type: "describe";
  /** The harness: id is what an agent's `cli` names it by (the runner's file name); title is for people. */
  harness: { id: string; title: string };
  /**
   * How a turn reaches the harness. tui: typed into its native TUI and followed in its transcript (ask runs one
   * headless when the agent says tui: false, or its TUI cannot start); thread: sent to a long-lived session in the
   * daemon, a client of a thread that its TUI may share; headless: one process per turn (ask).
   */
  turns: Turns;
  /** The optional ops it answers (OPS). */
  ops: Op[];
  /** A message sent during a turn goes into that turn (typed into the TUI between two steps, steered into a thread). */
  interject?: boolean;
  /**
   * Where an agent's session is found when it adopts none: "folder", the harness's latest in the folder it works in
   * (two agents of this harness in one folder would share it: the core refuses that); "agent", one the runner keeps
   * for each agent (in its stateDir: any number of agents in one folder). Not said: "folder".
   */
  sessions?: "folder" | "agent";
  /** pagent started from inside this harness's own session: that session's variables, which must not reach the harnesses pagent starts. */
  outerSession?: { marker: string; prefix: string; keep: string[] };
};

// ---------------------------------------------------------------- ops

export type Op = "describe" | "ask" | "history" | "last" | "info" | "usage" | "trajectory" | "holder" | "move" | "stranger" | "interactive" | "follow" | "service" | "session";

type OpSpec = { required: boolean | ((d: Describe) => boolean); without: string };

/**
 * Every op: whether a runner must answer it, and what the engine does when an optional one is missing. A required op
 * is not listed in `ops` (it is always there).
 */
export const OPS: Record<Op, OpSpec> = {
  describe: { required: true, without: "" },
  ask: { required: (d) => d.turns !== "thread", without: "a thread runner sends turns to its session" },
  session: { required: (d) => d.turns === "thread", without: "" },
  follow: { required: (d) => d.turns === "tui", without: "" },
  history: { required: true, without: "" },
  last: { required: false, without: "the end of its history (read whole)" },
  info: { required: false, without: "no session id and no command to resume it outside the app" },
  usage: { required: false, without: "only what a turn's data-usage said, none after a restart" },
  trajectory: { required: false, without: "no trajectory (the view says the harness keeps no timeline)" },
  holder: { required: false, without: "no check for another process on the session" },
  move: { required: false, without: "its sessions stay where they were when its node moves (pagent mv)" },
  stranger: { required: false, without: "it answers no strangers" },
  interactive: { required: false, without: "no terminal (<Terminal> says its harness has none)" },
  service: { required: false, without: "its sessions need no shared background process" },
};

export const requiredOps = (d: Describe): Op[] => (Object.keys(OPS) as Op[]).filter((op) => (typeof OPS[op].required === "function" ? (OPS[op].required as (d: Describe) => boolean)(d) : OPS[op].required));

/** Whether a runner answers an op: a required one always; an optional one when its describe lists it. */
export const answers = (d: Describe, op: Op) => requiredOps(d).includes(op) || d.ops.includes(op);

// ---------------------------------------------------------------- what each op answers

/**
 *   { op: "ask", …AgentInput, message } → a turn's chunks, headless (one process); its exit ends it.
 *   { op: "history", …BaseInput } → History: the session's conversation. file: the transcript (watched: a change made
 *     outside the app, a turn typed in its terminal, reloads the views); watch: more it read (sub-agents' transcripts).
 *   { op: "last", …BaseInput } → Last: where it stopped, cheaply (the rail reads it for every agent).
 *   { op: "info", …BaseInput } → Info: the session, and the command that resumes it outside the app.
 *   { op: "usage", …BaseInput } → { type: "usage", usage: SessionUsage | null, file }.
 *   { op: "trajectory", …BaseInput } → { type: "trajectory", records: TrajectoryRecord[], file, watch }.
 *   { op: "holder", …BaseInput } → { type: "holder", holder, choices }: another process that has the session open.
 *   { op: "move", …BaseInput, from, to } → { type: "moved", sessions }: the agent's folder moved (pagent mv).
 *   { op: "stranger", message, systemPrompt, maxOutputTokens, options } → a one-off answer's chunks: no tools, no session.
 *   { op: "interactive", …AgentInput, fork? } → Command: the native TUI on the agent's session.
 *   { op: "follow", …BaseInput } → { type: "mark" } once it noted where the transcript ends, then the chunks of the
 *     next turn the TUI writes; { type: "taken", text, id? } when a message typed during it is taken in.
 *   { op: "service" } → Service: a background process the daemon keeps for the runner's sessions.
 *   { op: "session", …AgentInput } → long-lived: Session events; further stdin lines are SessionCommand.
 */
export type History = { type: "history"; messages: UIMessage[]; file?: string; watch?: string[] };
export type Last = { type: "last"; text: string | null; at: string | null; lastAt: string | null; title: string | null; file: string | null };
export type Info = { type: "info"; sessionId: string | null; resume: string | null };
export type Usage = { type: "usage"; usage: SessionUsage | null; file: string | null };
export type Trajectory = { type: "trajectory"; records: TrajectoryRecord[]; file?: string; watch?: string[] };
export type HolderOut = { type: "holder"; holder: { pid: number; name?: string; startedAt?: string; cwd?: string } | null; choices: ("fork" | "open")[] };
export type Moved = { type: "moved"; sessions: number };
/**
 * The TUI: the command, where and with what environment; the dialog it may put up first (trust: the text to look for,
 * the keys that accept it); the keys that stop a turn, answer a permission prompt or dismiss any other dialog in it
 * (default Esc; its choices are made with the arrow keys and Enter, core/agents/dialogs.ts); prompt: how its permission
 * prompt reads in its OSC 7501 status message (a regular expression: the tool, then what it asks about).
 */
export type Command = {
  type: "command";
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  trust?: { prompt: string; keys: string[]; harness: string };
  keys?: { interrupt?: string[]; allow?: string[]; deny?: string[]; dismiss?: string[] };
  prompt?: string;
};
export type Service = { type: "service"; id: string; command: string; args: string[]; envDrop: string[]; cwd: string };

/**
 * What the agent said outside any turn, when its harness acts on its own (a Grok Bot's schedules, a reply that came
 * after its turn ended, its answer to someone who wrote to it elsewhere): each once, from a session or from any quick
 * op (which may go on after its answer to look for it). The engine hands it to turn triggers (phase "message"); the
 * views hear of it from the transcript. id: its words' own id; to: the message it answers, as the history has it (its
 * id there, its words with their "(from …)" line, the app's run that sent it).
 */
export type Said = { type: "said"; id: string; text: string; to?: { id: string; text: string; run?: string } };

/** A session's events (thread runners): ready, then per turn: turn, a user per message in it, its chunks, turn-end. */
export type Session =
  | Said // between turns, or during one (what is not that turn's)
  | { type: "ready"; threadId: string; endpoint?: string } // endpoint: where another client (its TUI) attaches
  | { type: "failed"; errorText: string }
  | { type: "turn"; turnId: string }
  | { type: "user"; turnId: string; id?: string; text: string; clientId: string | null; meta?: unknown } // clientId: the run that sent it (null: typed in its TUI)
  | { type: "turn-end"; turnId: string; status: string; text: string; durationMs?: number }
  | { type: "ask-failed"; run: string; errorText: string };
export type SessionCommand = { op: "ask"; run: string; message: string; meta?: unknown } | { op: "interrupt" } | { op: "state" } | { op: "stop" };

// ---------------------------------------------------------------- permission requests

/**
 * What a runner POSTs to permissionUrl when its harness asks before a tool runs. tool: the harness's name for it;
 * meta: what it does (a proposal shows its plan, a command its command line …); detail: what to show of it, when the
 * runner knows better than meta. The answer: { decision: { allow, message? } }, the message going back to the agent
 * (why not, what to change in a plan); no decision: the harness asks in its own way (someone watches its terminal).
 */
export type PermissionRequest = { tool: string; input: unknown; meta: ToolMeta; detail?: string };
export type PermissionAnswer = { decision?: { allow: boolean; message?: string } };
