---
description: A page's metadata (title, lang, order, fill), the app's own settings, layouts, rendering other nodes (forks, keys, shared), events, hooks from a node, npm packages, shared code, props from the URL.
---

# Pages

- [Metadata: title, language, order, fill](#metadata-title-language-order-fill)
- [The person's settings, and the app's own](#the-persons-settings-and-the-apps-own)
- [Layouts](#layouts)
- [Imported nodes are components](#imported-nodes-are-components)
- [Events go up as callback props](#events-go-up-as-callback-props)
- [Hooks from a node](#hooks-from-a-node)
- [You import only from this app](#you-import-only-from-this-app)
- [npm packages](#npm-packages)
- [A page's props come from where it is shown](#a-pages-props-come-from-where-it-is-shown)

## Metadata: title, language, order, fill

`export const metadata = { title: "Meal plan" }` (as in Next.js; a literal). The app's navigation shows titles, not
paths: the rail listing the pages, the trail of titles above a page, the browser tab. Without one, the folder's name
stands in. Give every page a short, plain title (the home page's title is the app's name); cards may keep the default.

- **`lang`**: the home page's is the app's language. `metadata = { title: "工作台", lang: "zh-CN" }` puts the engine's
  own words on its pages in that language (what `useAgentStatus` says an agent is doing, the conversation surfaces'
  buttons, hints and placeholders, the navigation; English and `zh-CN` so far, English for any other), so they read as
  part of pages written in it. Without it, both the engine's words and the app's own (`useLanguage()`) follow the
  reader's browser. A page's own `lang` (else the app's) is also what the browser is told the page is in (`<html
  lang>`: its fonts, line breaking, a screen reader's voice), so a page in another language than the app's says so.
  Give it whenever the app's pages are not in English. An app in several languages writes its own words by
  `useLanguage()`.
- **`order`**: siblings are listed by title; `metadata = { title: "Health", order: 1 }` puts them in the order the user
  thinks of them (lower first).
- **`fill: true`** (on a page, or a layout for every page under it) gives the page the whole window below the shell's
  top bar, edge to edge, for an app with a frame of its own (a sidebar, a chat that scrolls inside): its outermost
  element takes `height: 100%`; never `calc(100vh - …)` and negative margins (`--pagent-top-height` is the bar's height
  if you need it).

On a phone, any page can be added to the home screen (Safari: Share → Add to Home Screen; Chrome: Install app). It
then opens on its own, without the browser's bars, at the page it was added from, named by that page's title. Its icon
is the app's `icon.png` at its root (square, 512×512 or more; as Next.js's `app/icon.png`), else pagent's.

The rail also shows, for every page with agents, what its agent is doing or waiting on and the last thing it said, and
it is the app's way through its pages (new ones, renaming, deleting: [instances](instances.md)). A page does not need
its own overview of the app's agents, nor its own list of the app's pages (no "threads", "status" or "sessions" column
repeating the rail).

## The person's settings, and the app's own

**The language, light or dark, and the default harness are the person's settings, not a page's**: one file for every
pagent app on the machine, which the shell's Settings (the gear at the bottom of the rail) changes, and every open tab
of every app follows at once. The reader's language wins over `lang`, for the engine's words too; the theme is followed
by the shell and every page. So an app does not make its own language or theme switch, and never sets `data-theme`
itself; a page may still read them all (`useSettings()`) and change one (`setSetting("theme", "dark")`,
`setLanguage`, `setTheme`: [reference](reference.md)).

**Settings of the app's own** (how wide its editor wraps, a default it offers) go in the same dialog: the home page
exports `export function Settings() { … }`, a component shown under the person's settings, with the app's name over
it, in the home page's scope (its `useData` files, its agents). It keeps them in the app's own data, not in the
person's settings.

## Layouts

`layout.tsx` receives `children` and wraps every child route. Declare an agent in a layout to make it the agent for
that whole section.

## Imported nodes are components

`import Todo from "~/todo"` renders another node of this app. Each rendered instance is a fork under
`.mounts/<key>/`: its own data (a copy of the node's data files, made once when the instance is), its own agents'
state and sessions, and the node's code, read where it is (a change to the node's code reaches every instance of it;
one instance's own copy of a file shadows it for that instance: [instances](instances.md)).

- **Keys.** Rendering the same node twice in one page needs distinct `key`s, and so do two different nodes: a key is
  one folder under the page, so `<Todo key="a" />` next to `<Notes key="a" />` is an error (so are keys that differ
  only in case: one folder on macOS). Any text is a key (`key="工作"`): letters, digits, `_` and `-` stay as they are
  in the folder's name, any other character becomes `+` and its code (`工作` → `.mounts/+5de5+4f5c`; `pagent tree`
  lists the instances).
- An instance remembers the node it is a fork of: renaming that node (and the import) keeps its instances, while
  another node rendered with an existing instance's key is an error that says what to do (another key; or delete the
  instance's folder to start afresh).
- **`<X shared />`** renders the original node instead of a fork. **A node that stands for one thing declares it**:
  `export const config = { shared: true }` (a bridge to an app on this Mac: there is one Calculator). Every `<X />` of
  it, anywhere, renders the node itself: no fork, no key needed.

## Events go up as callback props

A child's `useEmit("mail.received")` arrives at the parent as `onMailReceived`. The parent may pass a function or an
agent (from `useAgent`): `<Mailbox key="work" onMailReceived={helper} />`.

## Hooks from a node

A node's page.tsx may export hooks (`export function useCalculator()`), and any page imports them next to the
component: `import Calculator, { useCalculator } from "~/calculator"`. Such a hook always runs as the node it comes
from: its `useData("display.json")` is that node's file, the server functions it calls are that node's. So a page can
use a node headless (its data and actions, none of its UI). Only `useXxx` names can be imported from a node, and only
from `~/` nodes.

## You import only from this app

A node import is always `~/<path>`, a node of this app (plus `mcp://…`, another server's MCP App shown in an iframe).
Something from outside the app is installed first, never imported: `pagent add wechat` copies it in as an ordinary
folder, then you import `~/wechat`; `import X from "official:wechat"` does not compile. Reuse inside the app: a node,
by `~/` import (an instance per render, or `shared`), its hooks or its server functions; plain code (components,
helpers, types) by a relative import (`./Card`, or a helper file in another node's folder) or an npm package.

Code several pages share may live outside their folders (a `_ui/` folder at the app root, imported by a relative
path): changing it reloads every open page and layout that imports it, CSS included.

## npm packages

A bare import (`import CodeMirror from "@uiw/react-codemirror"`, deep imports like `@pierre/diffs/react`, a package's
CSS file) resolves from the app root's `node_modules`. React and `pagent` always come from the host: never install your
own copy. Each package is bundled once for the whole app and shared by every page that imports it, so two pages get the
same instance (editors, registries, custom elements); the server does this by itself when `package.json` or the
lockfile changes, or when a page imports a package for the first time. You never run a build.

- Prefer a package the app already has (`package.json` at the app root) over adding one.
- Only the app root has a `package.json`; never create one in a node folder. Add a package with `pagent package add
  date-fns`: it adds it to the root `package.json`, installs it with the app's package manager and commits
  `package.json` and the lockfile. Packages are shared by every page: add one only when it is clearly better than
  writing the code, and say why.
- Code that needs Node (`fs`, `child_process`, secrets) belongs in a `"use server"` file; its packages run on the
  server.
- Workers that a package creates with `new Worker(new URL("./x.worker.js", import.meta.url))` (Monaco's language
  workers) work; that pattern in your own node code does not.

## A page's props come from where it is shown

The JSX that renders it, a card's JSON ([cards](cards.md)), or its URL's query. `/cards/weather?city=Lisbon&days=3`
opens the page with `{ city: "Lisbon", days: 3 }` (a value that parses as JSON is JSON, else a string). Link to a page
in your text the same way (`[Lisbon](/cards/weather?city=Lisbon)`), go there in code with `navigate(url)`, or take the
user's screen there with `pagent screen open /cards/weather?city=Lisbon`.
