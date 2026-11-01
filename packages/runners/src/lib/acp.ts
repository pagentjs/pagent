// A client of an agent that speaks ACP (Agent Client Protocol, agentclientprotocol.com): JSON-RPC 2.0, one message a
// line, over the agent's stdin and stdout. opencode (`opencode acp`), Gemini CLI (`gemini --acp`), Qwen Code (`qwen
// --acp`) and others speak it. pagent is the client: it starts sessions, sends prompts, hears what happens in them
// (session/update) and answers what the agent asks of it (session/request_permission). It offers the agent no file
// system or terminal of its own: the agent uses its own tools, as it does in its CLI.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnError, spawnHarness, stopGroup } from "./process.ts";

export type AcpInit = {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    sessionCapabilities?: { list?: object; resume?: object; fork?: object; close?: object };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
  };
  agentInfo?: { name?: string; title?: string; version?: string };
  authMethods?: { id: string; name?: string }[];
};

/** One of the agent's session/update notifications' update (its sessionUpdate says which). */
export type AcpUpdate = { sessionUpdate: string; [k: string]: any };

export class Acp {
  readonly child: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  /** A session/update: (sessionId, update). */
  onUpdate: (sessionId: string, update: AcpUpdate) => void = () => {};
  /** A request of the agent's (session/request_permission …): what to answer it (a thrown error answers an error). */
  onRequest: (method: string, params: any) => Promise<unknown> = async (method) => {
    throw Object.assign(new Error(`pagent does not offer ${method}`), { code: -32601 });
  };
  readonly closed: Promise<number>;
  private stderr = "";

  constructor(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawnHarness(command, args, { cwd: opts.cwd, env: opts.env });
    this.closed = new Promise((resolve) => this.child.on("close", (code) => resolve(code ?? 1)));
    void this.closed.then((code) => {
      // Never started (its binary is not there): that, and nothing else, is why.
      const why = (m: string) => this.failure ?? `${command} exited (${code}) before it answered ${m}${this.stderr ? `: ${this.stderr.trim().slice(-500)}` : ""}`;
      for (const p of this.pending.values()) p.reject(new Error(why(p.method)));
      this.pending.clear();
    });
    this.child.stderr.setEncoding("utf8").on("data", (d: string) => {
      this.stderr = (this.stderr + d).slice(-4000);
      process.stderr.write(d);
    });
    let buf = "";
    this.child.stdout.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.message(line);
      }
    });
  }

  private message(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return; // not JSON-RPC: a log line on the wrong stream
    }
    if (m.method && m.id !== undefined) {
      this.onRequest(m.method, m.params ?? {}).then(
        (result) => this.send({ jsonrpc: "2.0", id: m.id, result: result ?? null }),
        (e) => this.send({ jsonrpc: "2.0", id: m.id, error: { code: e?.code ?? -32000, message: String(e?.message ?? e) } }),
      );
    } else if (m.method === "session/update") this.onUpdate(m.params?.sessionId, m.params?.update ?? {});
    else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(Object.assign(new Error(m.error.message ?? "error"), { code: m.error.code, data: m.error.data }));
      else p?.resolve(m.result);
    }
  }

  private send(m: unknown) {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(m) + "\n");
  }

  call<T = any>(method: string, params: unknown): Promise<T> {
    const id = ++this.seq;
    // Gone already: nothing will answer (a call sent now would wait for ever).
    if (this.child.exitCode !== null || this.child.signalCode !== null || this.failure) return Promise.reject(new Error(this.failure ?? `the agent exited before it was asked ${method}`));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** The handshake: the protocol's version, and what pagent offers (no file system, no terminal: the agent's own tools). */
  initialize(): Promise<AcpInit> {
    return this.call<AcpInit>("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "pagent", version: "1" } });
  }

  /** Why the agent never ran ("opencode not found"), or undefined. */
  get failure(): string | undefined {
    return spawnError(this.child);
  }

  /**
   * Stop the agent and everything it started (its process group: a shell tool's background processes, its LSP and
   * MCP servers), SIGKILL for what is still there after 3 s. Resolves once they are gone.
   */
  close(): Promise<void> {
    return stopGroup(this.child);
  }
}

/** MCP servers as an agent declares them (by name, as .mcp.json writes one), as ACP's session/new takes them. */
export function acpMcpServers(mcps: Record<string, unknown> | undefined): unknown[] {
  return Object.entries(mcps ?? {}).map(([name, v]) => {
    const s = (v ?? {}) as { command?: string; args?: string[]; env?: Record<string, string>; type?: string; url?: string; headers?: Record<string, string> };
    if (s.url) return { type: s.type === "sse" ? "sse" : "http", name, url: s.url, headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value })) };
    return { name, command: s.command ?? "", args: s.args ?? [], env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })) };
  });
}
