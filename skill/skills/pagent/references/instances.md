---
description: Dynamic pages ([id], [...path]) - one page, an agent per address; agents({ params }); making instances (tell --new, nodes.make), listing, renaming, removing them; the rail; an instance's code shadowed file by file; instance records.
---

# Dynamic pages and instances

- [One page, an agent per address](#one-page-an-agent-per-address)
- [The agents may depend on the params](#the-agents-may-depend-on-the-params)
- [Making an instance](#making-an-instance)
- [Listing, renaming, removing](#listing-renaming-removing)
- [The rail lists every instance](#the-rail-lists-every-instance)
- [An instance's code is its source's](#an-instances-code-is-its-sources)
- [What an instance is, is recorded](#what-an-instance-is-is-recorded)

## One page, an agent per address

A folder named `[id]` (one segment) or `[...path]` (the rest, one segment or more) is code for every address it
matches, as in Next.js: `studio/[ws]/[id]/page.tsx` serves `/studio/harness-app/fix-login`, `/studio/demo/修登录`, …
Each address is a node of its own, an **instance**: its own data, its agents' state and session, its triggers. Its
folder is at its address (`studio/harness-app/fix-login/`) and holds its data; its code is the `[id]` folder's, read
from there.

A static folder wins over `[x]`, which wins over `[...x]`, so every other folder next to an `[x]` folder is one of its
instances: keep data folders elsewhere. The page and its layouts get `params` (`{ ws: "harness-app", id: "fix-login"
}`; `[...x]` is a list); navigation calls an instance by its last param.

## The agents may depend on the params

`export function agents({ params }) { … }` (as Next.js has `generateMetadata`). It runs on the server, for each
instance (with the app's `.env`; only it and what it uses of its file, never in the page), so it may import
server-side helpers. Return `null` (or throw) for params that are no instance: nothing is made, and the error says
why. Declare the folder the agents work in (`cwd`) in code, not in the URL:

```ts
// studio/workspaces.ts
export const workspaces: Record<string, string> = { "harness-app": "/Users/sam/code/harness-app" };
```

```tsx
// studio/[ws]/[id]/page.tsx
import type { Agents, Params } from "pagent";
import { workspaces } from "../../workspaces";

export const metadata = { title: "Session" };

export function agents({ params }: { params: Params }): Agents | null {
  const cwd = workspaces[params.ws as string];
  return cwd ? { main: { cli: "claude", cwd } } : null; // each instance: a session of its own, in the shared folder
}

export default function Session({ params }: { params: { ws: string; id: string } }) {
  return <h1>{params.id}</h1>;
}
```

## Making an instance

- **By opening its page**: the rail's "+", or a button of yours that navigates to a new id (`navigate`).
- **By telling it**: `pagent tell --new /studio/demo/helper "…"` (`tell(address, text, { new: true })` in server code):
  a helper agent of yours, whose reply comes back as any agent's does, and whose page the user can open. Without
  `--new`, telling an instance that is not there is an error that lists the ones there are; `--new` to one that is
  there is an error too.
- **With a choice in it** (which harness a session runs, a template): server code makes it with its data files, `await
  nodes.make("/studio/demo/fix-login", { data: { "harness.json": { cli: "codex" } } })` (an error when it is there
  already, or the page refuses its params), then tells it or navigates to it.

`agents({ params })` may read the instance's own files (`node.dir` in it is the instance's folder) for what its params
do not say: what it returns is kept per instance from when the instance is made (not before), so a file written when it
was made counts from its first turn on. Keep such a choice fixed: it is read again only when the page's code or the
`.env` changes, or the server restarts. For one made without the file (the rail's "+", `tell --new`), the function may
write it then, from a default, once its folder is there (`existsSync(node.dir)`; `{ flag: "wx" }`), so the choice
stays what it was when the instance was made.

## Listing, renaming, removing

From server code (the rail does it for the user): `import { nodes } from "pagent/server"`.

- `await nodes.instances("/studio/[ws]/[id]")`: `[{ path, url, params, createdBy?, createdAt }]`. `path` is the
  address as the engine has it (what `useAgentStatus("<path>#main")`, `tell` and `nodes.move` take; a value that is no
  safe folder name is in its key form, `/studio/demo/+4fee+767b+5f55`); `url` the same as people read it and links
  write it (`/studio/demo/修登录`); `createdBy` who made it with `tell --new` (`"/studio/demo/fix-login#main"`: a
  helper's maker, kept through `pagent mv`; none when a person opened its page).
- `nodes.move(from, to)`: another id of the same page. `nodes.remove(path)`: its folder goes.
- Agents: `pagent mv`, `pagent rm <instance>`.

## The rail lists every instance

As a row of its own, with its agent's state like any page, and one made by another instance's agent (`tell --new`)
under that instance. On the row where a new instance can go (the parent's; the home page's for `[ws]` at the app's
root) a "+" asks for a name, made up until one is typed, and opens it (which makes it; a name `agents()` refuses says
why, there); "⋯" on an instance renames it (`nodes.move`) or deletes it (`nodes.remove`). Give the page a
`metadata.title` (the "+" says "New Session"), and do not build a list of them into the app: the rail is it.

## An instance's code is its source's

Both kinds of instance, a dynamic page's (`studio/demo/fix-login/` of `studio/[ws]/[id]/`) and a fork
(`.mounts/<key>/` of the node it renders, [pages](pages.md#imported-nodes-are-components)), read their code from their
source, where it is: change a file there and every instance changes (open pages reload).

A code file in the instance's own folder beats the same-named file of its source, for that instance alone: **to change
one instance, copy the file into its folder and change the copy** (`studio/demo/fix-login/Extra.tsx`,
`.mounts/work/page.tsx`); to change all of them, change the shared file. It holds for every code file: page.tsx and
layout.tsx, what they import by a relative path (a `.css` file, a file in a `_lib/` folder), `"use server"` files
(`actions.ts`: the instance's own runs for it), an agent's `instructions` (`_agent.md`) and `./` skills. Each layer of
a dynamic address shadows its own: `studio/demo/layout.tsx` (or `studio/demo/Sidebar.tsx`) shadows `studio/[ws]/`'s
for every instance under `/studio/demo`. `pagent tree` lists each instance's source (`instanceOf`) and the files it
shadows (`shadows`); an instance's agent is told where its code is and how many others share it.

- **Replace or extend.** A copy replaces the file. To build on it instead, import the original by its path and wrap
  it: `import Shared from "../../[ws]/[id]/page"` in `studio/demo/fix-login/page.tsx`, `import Todo from
  "../../todo/page"` in `.mounts/work/page.tsx`. A file importing the very file it shadows gets that one, never itself.
  Relative imports are relative to where the file is: the shared file's from its folder, your copy's from yours (a
  copy at another depth needs its `../` adjusted).
- **Declarations carry over.** A page.tsx (or layout.tsx) of the instance's own keeps each of `agents`, `triggers`,
  `tools`, `metadata` and `config` that it does not declare from the file it shadows, so changing the UI never drops
  the instance's agent; declaring one replaces it (`export const agents = {}`: none).
- **Data never falls through.** `useData`, `data.read` / `data.write` and the agents' state are the instance's own
  folder's only, never its source's: code (by extension, and anything in a `_` folder) shadows, data does not.

## What an instance is, is recorded

In its folder (`{ of, by?, at }`: its source, who made it with `tell --new`, when), written when the engine makes it
(opening its page, `tell --new`, rendering a fork). With a record, a folder with a page.tsx of its own is still an
instance (the page shadows the shared one). Without one, a folder beside an `[x]` with no page.tsx or layout.tsx is
taken for an instance and one with a page.tsx is a page of its own, so a real page beside `[ws]` (`settings/page.tsx`)
stays one.

**The record follows the code**: an instance with a page.tsx or layout.tsx of its own keeps it as `_instance.json`
beside them (commit it with them: without it, a fresh clone takes the folder for a page of its own), every other
instance in `.state/instance.json` (not committed: the instances made as the app runs leave git nothing). The engine
moves it when such a page or layout comes or goes; `_instance.json` is no code (nothing imports, shadows or copies
it). To make an instance a page of its own, delete its record.
