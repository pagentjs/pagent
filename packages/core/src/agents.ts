// Calling an agent = invoking its runner (a separate process speaking the CGI-like contract:
// JSON on stdin, AI SDK UIMessageChunk lines on stdout). The core knows nothing about any particular harness:
// a runner says what it does (agents/runner.ts), and that picks the session driver its turns go through
// (agents/driver.ts: typed, one turn at a time into its TUI or headless; or thread, a long-lived client of a shared thread).
//
// Each call is a run: its chunks are buffered so any viewer can attach mid-way (AI SDK resumable streams),
// and each agent runs one turn at a time (an actor). The modules, in agents/: types, runner, identity, prompt, runs,
// driver, typed, tui, thread, remote (another app's agent, declared as one of this app's), status, history,
// attachments, trajectory (the session as a timeline) and waits (on the person, for it). This file is the entry the rest of the core imports.
export { type AgentRef, type AskInput, type Caller, type Conflict, type Ctx, type Holder, type ReplyPost, type Run, type SessionInfo } from "./agents/types.ts";
export { activeRun, ask, askOrDecline, chainOf, closeQuietAgents, refreshAgents, conflictOf, follow, inChain, lineageOf, NOBODY, notify, onTurn, postReply, recoverAgents, redeliver, type StartOptions, startRun, stopTurn, triggerFiring, turnsQueued, unattended, unattendedFrom, unqueue, whenIdle } from "./agents/runs.ts";
export { declOf, harnesses, type Capabilities } from "./agents/runner.ts";
export { agentOf } from "./agents/identity.ts";
export { callerOf } from "./agents/prompt.ts";
export { interactiveCommand, restartTerminal, tuiStale } from "./agents/tui.ts";
export { agentStatus, harnessOfAgent, residency } from "./agents/status.ts";
export { lookAt, remoteAt } from "./agents/remote.ts";
export { attachmentsOf, saveAttachments, uploadFile } from "./agents/attachments.ts";
export { history, lastLine, type LastWords, lastWords, sessionHandle, toolCallOf, untilRun, usageOf, viewMessage, viewPart } from "./agents/history.ts";
export { listed, trajectory, trajectoryPage, trajectoryRecord, type TrajectoryRecord } from "./agents/trajectory.ts";
export { recordWaits, type Wait, waitsOf } from "./agents/waits.ts";
