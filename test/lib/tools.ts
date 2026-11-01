// A tool call as a runner gives it (runners/src/lib/tools.ts): with what it does, its toolMetadata, from Claude Code's
// table, else Codex's (as the fake runner does). For tests of what the app reads from a call.
import { claudeTool } from "../../packages/runners/src/lib/claude-tools.ts";
import { codexTool } from "../../packages/runners/src/lib/codex-tools.ts";
import type { ToolMeta } from "../../packages/runners/src/lib/tools.ts";

export function metaFor(name: string, input?: unknown, output?: unknown): ToolMeta {
  const m = claudeTool(name, input ?? {}, output);
  return m.kind !== "other" ? m : codexTool(name, input ?? {}, output);
}

/** The call with its toolMetadata, as every runner sends it. */
export const withMeta = <T extends { toolName: string; input?: unknown; output?: unknown }>(c: T): T & { toolMetadata: ToolMeta } => ({ ...c, toolMetadata: metaFor(c.toolName, c.input, c.output) });
