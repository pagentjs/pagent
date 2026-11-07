---
description: The app's public face - api/**/route.ts (typed or raw handlers), keys and caller, tell() from server code, strangers, /mcp, an agent's message route (inbox), remote agents of other apps, one-off messages to another app, a session on this computer telling an agent (pagent tell --as).
---

# Routes: the app's public face

- [Routes](#routes)
- [Typed or raw](#typed-or-raw)
- [Keys: who a caller is](#keys-who-a-caller-is)
- [caller](#caller)
- [tell() from server code](#tell-from-server-code)
- [/mcp](#mcp)
- [An agent's message route](#an-agents-message-route)
- [Remote agents](#remote-agents)
- [A one-off message to another app](#a-one-off-message-to-another-app)
- [From a session on this computer](#from-a-session-on-this-computer)

## Routes

The app's only door to the outside is the routes it writes: `api/**/route.ts` is `/api/**`, Next.js Route Handlers
(`api/ideas/route.ts` → `/api/ideas`; `[id]` and `[...path]` folders are params). A route is a thin layer of HTTP
around actions: it imports any node's server functions (`~/ideas/actions`) and `tell` from `"pagent/server"`. Nothing
else the engine serves is for anyone but this machine's user and the app's own agents; other devices on the network
reach `/api/**` and `/mcp` without the owner's token. So **whatever you write there is public on the network: look at
`caller` first**, and keep it to what you mean to offer.

```ts
// api/ideas/route.ts
import type { RouteContext } from "pagent/server";
import { add } from "~/ideas/actions";

/** Add an idea to the board. */
export async function POST(input: { text: string; tags?: string[] }, { caller }: RouteContext) {
  if (caller.kind === "external" && !caller.key) return Response.json({ error: "who are you?" }, { status: 403 });
  return add(input);   // JSON out; or return a Response for a status, headers, a file, an image
}
```

```ts
// ideas/actions.ts
"use server";
import { data } from "pagent/server";

export async function add({ text, tags = [] }: { text: string; tags?: string[] }) {
  const ideas = data.read<{ text: string; tags: string[] }[]>("ideas.json", []) ?? [];
  data.write("ideas.json", [...ideas, { text, tags }]);
  return { count: ideas.length + 1 };
}
```

It runs as a `"use server"` function does: a process per request, 120 s at most, the app's `.env` loaded, in the app's
folder (`data` from `"pagent/server"` is the root's data files; reach a node's through its actions). A body over 10 MB
is refused (413) before it runs, on `/mcp` too.

## Typed or raw

A handler whose first parameter has an object type gets the JSON body (a GET: the query) checked against it (a 400
otherwise), and `/mcp` has its schema. One whose first parameter is a `Request` gets the request as it is and returns a
`Response`: third-party payloads (GitHub, CI) and status codes of your own. Methods: GET, POST, PUT, PATCH, DELETE.
The doc comment above a handler is its description on `/mcp`. The second parameter is `{ caller, params, url }`.

## Keys: who a caller is

`pagent key create /ideas --name sam [--ttl 1h]` makes a key for one subtree (the node and everything under it; `/` is
every route) and shows it once; hand it over (or have the person do it: `pagent key create … --root <app>` in their
terminal). Whoever holds it sends `Authorization: Bearer <key>` and is that name; a route outside its subtree answers
403, a revoked or expired key 401 (never quietly a stranger). `pagent key list`, `pagent key revoke sam`. From server
code: `keys.create({ scope, ttl?, name? })` and `keys.revoke(name)` from `"pagent/server"` (a demo gives each visitor a
key to its own agent, for an hour). Keys live in the engine's state, as hashes: never in the app's code or data.

**The key is the only thing that says who someone is**; an IP address says nothing (if your app wants "anyone on my
LAN", write that rule yourself with `caller.ip`).

## caller

From outside, `{ kind: "external", ip, from?, key?, inReplyTo? }`: `key` is `{ name, scope }` of the key it came with
(none: a **stranger**), `from` the sender's own message route as its JSON body says, `inReplyTo` that it is the reply
to a message of ours (let in without a key, once), `remote` the remote agent of this app it is (below) when that agent
starts a message itself. When an agent of this app sends through the route (`pagent tell`), `{ kind: "agent", node,
agent }`. `via` lists the code it came through.

## tell() from server code

`tell(agent, text, { from?, stranger?, interject?, wait? })` (from `"pagent/server"`, in routes and actions) gives an
agent a message, the same way a chat and `pagent tell` do (and the way a trigger's action wakes one); it says who it is
from by itself. Serving a caller from outside:

- One with a key is told as itself (`{ from: caller.from }` sends the reply there; without `from`, nothing goes back).
- One without a key: `{ stranger: true }`, and **its words never reach the agent's session**: the agent answers them
  in a one-off turn of its own with no tools and a short answer (400 output tokens; the agent's `strangers: 200`
  changes that, `strangers: false` answers none; Codex agents answer none), which is the `reply`, and nothing else goes
  back.
- Or, if your code knows the caller its own way (a webhook's signature, your LAN rule), `{ from: <its address> }` lets
  it in. Without either it is refused.

`wait: true` (or seconds, up to 100) resolves with `{ id, reply }`; otherwise `{ id }`, and the reply goes where `from`
says (an agent's own call: back to that agent). A URL as the agent is another app's message route.

## /mcp

The same routes as MCP tools, made fresh on every request (stateless JSON-RPC, no handshake): one tool per method,
named by path and method (`/api/ideas` POST is `api_ideas_post`, `[id]` is `id`), with the handler's doc comment and
input type. `curl -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://…/mcp` is the app's card.

## An agent's message route

An agent's address outside is its message route, `/api/<node>/message` (the root's: `/api/message`): one agent per
page, so the path says which. Not written, the agent takes no messages from outside (404), and the app's own agents'
`pagent tell` tells it directly. **Written, the agent is open**, and both go through it. One line opens it with the
default handler:

```ts
// api/helper/message/route.ts
export { inbox as POST } from "pagent/server";
```

A sender with a key is told as itself and gets the reply POSTed back; anyone else is a stranger: a short answer
without tools, in the response, and nothing in your session. Write your own POST instead to decide (keep it as mail in
a data file, interject, refuse, tell), checking `caller` first; it takes `{ text, from, id }`. A stranger's message
still costs a short turn of yours: an inbox open to the network is for people you would answer.

## Remote agents

Another app's agent: declare it, then tell it like your own. A node (any folder with a page) declares it as a
**remote agent**, by the other app's node address (its page URL; `/` for its root agent), and the key that app gave
you for it (the name of a variable in the app's `.env`: `SAM_KEY=pk_…`; never the key itself in code):

```tsx
// remote/sam/page.tsx
import { AgentConsole, type Agents } from "pagent";
export const agents = { sam: { remote: "http://sam-mac:4870/dev", key: "SAM_KEY" } } satisfies Agents;
export default function Page() { return <AgentConsole inline />; }
```

Then it is an agent of this app: `pagent tell /remote/sam "…"` (and `tell()`, a trigger's action, a person in its
console) sends it there, from its own message route here, which the engine opens for it; the reply comes back to
whoever asked, as any agent's result does (`--wait` works too). `pagent agents` lists it, the navigation shows it busy
or offline (the other app does not take messages), and its page's `AgentConsole` is the conversation with it.

- Without a key you are a stranger there (a short answer, no tools on their side).
- A message it starts itself comes in with the key **you** gave it (`pagent key create /remote/sam --name sam`, which
  it names in its own remote agent for you); it goes to the agent above it (as `pagent tell ..`), marked as coming
  from it, and that agent's reply goes back to it. Anyone else at that door is a stranger.
- A reply to your message needs no key (it names your message's id, which nobody else knows, once). For its messages,
  and for a reply that takes longer than 100 s, the other app must reach this one: serve with `--host`. **To be
  reachable yourself, open your inbox** (the one line above) and give the other app a key to it.

## A one-off message to another app

`pagent tell http://192.168.0.50:4880/api/message "…"` (its message route) POSTs `{ text, from, id }`, `from` being
your own message route (the engine fills it in). With no key of theirs you are a stranger there: their agent's short
answer comes back at once. If their own route lets you in, its reply reaches you as a message ("The reply to your
message <id>") **only if your own message route is open**; else use `--wait` (up to 100 s). A reply is never answered
automatically, so two apps do not talk forever: to go on, tell again.

## From a session on this computer

A session outside any app on the same computer (a terminal, another harness's agent) tells an app's agent with the
person's `pagent`, by a name it gives itself: `pagent tell /ops#ops "…" --as openarea [--root <app-root>]` (the app:
--root, or the running one its folder is in). The agent reads "(from local:openarea) …": the person's own machine, so
taken as their words are. With `--wait` the reply is printed (up to 100 s); without, it is a notice (", no reply"):
the session has no address a later reply could go to. No key: it is the person's own plane, as `pagent stop` is.
Whom it can tell: `pagent agents` (each agent, busy or not), `pagent tree` (the pages): the app at --root, the one
its folder is in, or every running app.
