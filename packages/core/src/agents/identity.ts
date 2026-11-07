// How an agent reaches its app: its token, the `pagent` command first on its PATH, and the environment that
// carries them.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appId, daemonPaths } from "../daemon-protocol.ts";
import { engine } from "../engine.ts";
import { nodeBin } from "../program.ts";
import { keyOf, type AgentRef } from "../refs.ts";
import { harnessEnv } from "../shell-env.ts";
import type { Ctx } from "./types.ts";

// ---------------------------------------------------------------- how an agent reaches its app

/**
 * An agent's token: proof, for its `pagent` commands, that the shell is this agent of this app. Made from the daemon's
 * secret, so it holds as long as the agent's process does (both are the daemon's), and no file keeps it.
 */
function agentToken(ctx: Ctx, ref: AgentRef): string {
  return createHmac("sha256", ctx.secret ?? "").update(`${appId(ctx.root)}\n${keyOf(ref)}`).digest("hex").slice(0, 40);
}

/** The agent a `pagent` command comes from, if its token is that agent's. */
export function agentOf(ctx: Ctx, node: string, agent: string, token: string): AgentRef | null {
  if (!ctx.secret || !node || !agent || !token) return null;
  const ref = { node, agent };
  const want = Buffer.from(agentToken(ctx, ref));
  const got = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want) ? ref : null;
}

/**
 * The `pagent` command agents run: this engine's CLI, under PAGENT_HOME, put first on their PATH so it is this
 * engine's even when the user has another pagent installed.
 */
let bin: { node: string; dir: string } | null = null;
export function agentBin(): string {
  const node = nodeBin();
  if (bin?.node === node) return bin.dir;
  const cli = engine.core("cli");
  const dir = join(daemonPaths().home, "bin", createHash("sha1").update(`${node}\n${cli}`).digest("hex").slice(0, 10));
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pagent"), `#!/bin/sh\nexec ${q(node)} ${q(cli)} "$@"\n`);
  chmodSync(join(dir, "pagent"), 0o755);
  return (bin = { node, dir }).dir;
}

/**
 * Where the agent's harness reaches its app, the same for every agent (none is special): its identity for the
 * `pagent` command, as environment (never in argv, where any process could read it): PAGENT_NODE, PAGENT_AGENT,
 * PAGENT_TOKEN, the app (PAGENT_APP) and the socket (PAGENT_SOCK, which a sandbox must let it reach), with the
 * command first on PATH (the harness environment's PATH after it); and the permission hook for the harness's own tools.
 */
export async function agentAccess(ctx: Ctx, ref: AgentRef) {
  const base = ctx.hookBase ?? ctx.baseUrl;
  const path = (await harnessEnv()).PATH ?? process.env.PATH ?? "/usr/bin:/bin";
  const env: Record<string, string> = {
    PAGENT_APP: appId(ctx.root),
    PAGENT_NODE: ref.node,
    PAGENT_AGENT: ref.agent,
    PAGENT_TOKEN: agentToken(ctx, ref),
    ...(ctx.agentSock ? { PAGENT_SOCK: ctx.agentSock } : {}),
    PATH: `${agentBin()}:${path}`,
  };
  return { env, agentSocket: ctx.agentSock ?? null, permissionUrl: `${base}/_pagent/permission?node=${encodeURIComponent(ref.node)}&agent=${encodeURIComponent(ref.agent)}` };
}
