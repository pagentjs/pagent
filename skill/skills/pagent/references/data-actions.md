---
description: Data files (useData, writes with an updater, another node's file), actions ("use server" files, errors, commands, secrets), pagent/server's data, node and settings, another node's server functions, page tools, `pagent run`.
---

# Data and actions

- [Data files: useData](#data-files-usedata)
- [Actions: a "use server" file](#actions-a-use-server-file)
- [Server code's own imports: data, node, settings](#server-codes-own-imports-data-node-settings)
- [Secrets](#secrets)
- [Another node's server functions](#another-nodes-server-functions)
- [Page tools](#page-tools)
- [Running actions: pagent run](#running-actions-pagent-run)

## Data files: useData

`useData<T>(file, initial)` returns `[value, set, loaded]` for a data file in the node's folder. JSON files are
parsed. The page updates live when anyone changes the file, including you. `loaded` is false until the first read
lands. `"~/reading/items.json"` is another node's file, live too (a home page or dashboard showing what other pages
hold).

Writes never overwrite changes the page has not seen: **write with an updater, `set(prev => [...prev, item])`**, which
is re-run on the current file if someone else wrote meanwhile. A plain `set(value)` is refused (it rejects with
`DataConflict` and the page shows the current file) when the file changed since the render that computed it, or when
the page had not read it yet.

## Actions: a "use server" file

Actions are server code, in a `"use server"` file (`.ts` or `.js` directly in the node folder, not a subfolder: e.g.
`actions.ts`, first line `"use server";`). Every exported function is an action that runs on the server, in the
node's folder (relative paths are its data files):

- **The page** imports it and awaits it like any async function (`import { archive } from "./actions"`; `await
  archive({ id })`), with its types as written.
- **Agents** run it with `pagent run /inbox archive '{"id": "…"}'` (below). Give the parameter a type, `{ id }: { id:
  string }`, and `pagent run /inbox --help` shows it and checks the arguments against it; a doc comment above the
  function becomes its description. An argument that may be left out gets a default, `{ n = 20 }: { n?: number } =
  {}`, which applies when the caller passes none (a trigger always does).
- **Triggers** run it by name: `run: "archive"` ([triggers](triggers.md)).

Each is `async`, takes one JSON argument and returns JSON (or nothing). To fail, throw an `Error`: the page's `await`
rejects with an Error of the same message (no stack: that stays on the server, and `pagent run` shows it to you); say
in the message what went wrong in words the user can act on.

A command line is an action too: run it from the function (`execFile` from `node:child_process`, with arguments as a
list, not a string through a shell).

`node:` modules, files, `process.env` and API keys belong in server code: page code that touches `process.env` or
imports `node:*` does not compile.

## Server code's own imports: data, node, settings

From `"pagent/server"` (all of its exports: [reference](reference.md#pagentserver)):

- **Its data files**: `import { data } from "pagent/server"`, then `data.read("cursor.json", { at: 0 })` (parsed for
  .json; the fallback when the file is not there) and `data.write("cursor.json", { at: 42 })`. These are the node's
  data files, the ones its pages read with `useData` (they update live); each write replaces the file whole, so a page
  never reads half of one (a plain `writeFileSync` can be caught half-written).
- **Which node it runs as**: `import { node } from "pagent/server"`: `node.path` (its address, as `useNode()` has it),
  `node.params` (an instance's, so one `actions.ts` of a dynamic page serves every instance:
  `workspaces[node.params.ws]`), `node.dir` (its folder) and `node.root` (the app's folder). A route runs as the root;
  a dynamic page's `agents()` as the instance it is asked for. Never work it out from `process.cwd()`.
- **The person's settings**: `import { settings } from "pagent/server"`, `settings()` → `{ lang, theme, harness }`,
  as they are now (read each call): the same as the pages' `useSettings()`, for every app on the machine. `harness` is
  the default harness, for an `agents()` that picks one itself (write the pick into the instance when it is made, so
  it stays).

## Secrets

`"use server"` code reads a secret as `process.env.NAME`, from the app's `.env`, which the user fills through a Secure
Form (`pagent ask-user "Weather API key" --secret --into env:WEATHER_KEY`; `pagent ask-user --help`). The value is
there from the next call, no restart. Write the code to handle it being missing (say "set up the key first" rather
than crash), and never show it (an action's output, a log line).

## Another node's server functions

They are imported by its address: `import { archive } from "~/mail/actions"` (the node's path, then the `"use
server"` file without extension), in page code and in server code alike. Each call runs as that node: its action, in
its folder (its data files, its checks), and you get its return value, or its error as an exception.

- A relative path into another node's folder (`"../mail/actions"`) does not compile: it would run in the wrong folder.
- Only a `"use server"` file directly in a node's folder (`.ts` or `.js`) has an address; when a child node has its
  name (`tasks.ts` beside the node `/tasks`), `"~/tasks"` is the node, and the file is `"~/tasks.ts"`.

## Page tools

`export const tools` declares a page's tools and `useTool(name, fn)` implements one (`fn(input)` returns the result).
Input types are `"string"`, `"number"`, `"integer"`, `"boolean"`, `"object"`, `"array"` or a choice `"a|b|c"`; a
trailing `?` makes it optional. They are for
view state (which tab, which item is selected, what is filtered: state that lives only in the page). They run in the
user's open page, so they only work while someone is looking at it. Data goes in files (`useData`); commands go in
actions. Agents run them like actions (`pagent run /board show '{"status": "open"}'`).

## Running actions: pagent run

`pagent run <node> --help` lists a node's actions and page tools with their arguments; `pagent run <node> <name>`
runs one, with a JSON object or `--name value` pairs as its arguments. It runs as the node (in its folder, with its
checks), a bridge's included (`pagent run /calculator press '{"keys": ["1", "+", "2"]}'`); only its return value
reaches you. Any node's actions run this way; prefer your own part of the app, and run another part's actions when the
work calls for it.
