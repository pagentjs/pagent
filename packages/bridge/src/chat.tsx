// Conversations with an agent, on AI SDK's useChat. The native transcript is the history; live turns stream
// as UI message chunks; turns started elsewhere (a bubbled ask, another tab) are attached with resumeStream.
import { createContext, Fragment, memo, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Chat as ChatState, useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { callerLabel, type AgentRef, type Caller, type Question, type StepsChange, type SubagentInfo } from "./contract.ts";
import { commandOf, formAskOf, formStates, type FormAsk, type FormState } from "./forms.ts";
import { useHost, useResolvedAgent, useScope, type AgentHandle, type HostApi } from "./index.tsx";
import { CardsShownContext, NodeCard, splitCards, type CardsShown } from "./cards.tsx";
import { mergeHistory, shownId, shownIds } from "./history.ts";
import { chatterLabels, rowsOf, type Row } from "./turns.ts";
import { t, tn, toolWord, useLanguage } from "./i18n.ts";
import { imageKind, linkKind } from "./links.ts";
import { planOf, proposalOf, stepsAfter, stepsChangeOf, type Plan, type PlanStep, type Proposal } from "./plan.ts";

/** localStorage["pagent:debug"] = "chat": how each history load changed the conversation, in the console. */
function debug(what: string, data: unknown) {
  if (localStorage.getItem("pagent:debug")?.includes("chat")) console.debug(`[pagent chat] ${what}`, JSON.stringify(data));
}

/**
 * One agent's conversation on one page (its scope: what it sends says it came from there): the chat, its history
 * loaded, what streams in. Every useAgentChat (and usePlan) of that agent on that page shares it, so the history is
 * read once and each turn streams once, however many components show it. It lives while one of them is mounted.
 */
type ChatStore = {
  chat: ChatState<UIMessage>;
  /** The history has arrived (reading it can take a moment). */
  loaded: boolean;
  subscribe: (cb: () => void) => () => void;
  /** A component that shows it mounted: the store loads and follows the agent while there is one. */
  use: () => () => void;
  /** Its status changed: a load put off while a reply streamed is made now. */
  settled: () => void;
};

const chatStores = new WeakMap<HostApi, Map<string, ChatStore>>();

function chatStore(host: HostApi, agent: AgentRef, origin: string): ChatStore {
  const key = `${agent.node}#${agent.agent}@${origin}`;
  let stores = chatStores.get(host);
  if (!stores) chatStores.set(host, (stores = new Map()));
  const known = stores.get(key);
  if (known) return known;
  const clientId = Math.random().toString(36).slice(2);
  const chat = new ChatState<UIMessage>({ id: `${agent.node}#${agent.agent}#${clientId}`, transport: host.chatTransport(agent, { origin, clientId }) });
  const listeners = new Set<() => void>();
  const streaming = () => chat.status === "submitted" || chat.status === "streaming";
  let users = 0;
  let stop: (() => void) | null = null;
  // A load put off while a reply streamed (whole or not; null: none), and how to make it.
  let later: boolean | null = null;
  let sync: (whole: boolean) => void = () => {};

  const start = () => {
    let alive = true;
    let last: string | undefined; // the newest message the history gave (its history id): a later load starts there
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queue = Promise.resolve();
    const ids = shownIds();
    const putOff = (whole: boolean) => void (later = !!later || whole);
    const load = async (whole: boolean) => {
      if (streaming()) return putOff(whole);
      // A sub-agent still running in an earlier reply (in the background) changes that reply: all of it is loaded.
      const shown = chat.messages;
      const earlier = shown.some((m) => m.parts.some((p: any) => p.type === "data-subagent" && p.data?.status === "running"));
      const from = !whole && !earlier && last && shown.some((m) => m.id === shownId(ids, last!)) ? last : undefined;
      const got = await host.history(agent, from ? { after: from } : undefined);
      if (!alive) return;
      if (streaming()) return putOff(whole); // a reply started meanwhile
      const partial = !!from && got[0]?.id === from; // else the host gave all of it (that message is gone)
      const prev = chat.messages;
      const next = mergeHistory(prev, got, partial ? from : undefined, ids);
      debug("merge", {
        status: chat.status,
        partial,
        gone: prev.filter((m) => !next.some((n) => n.id === m.id)).map((m) => `${m.role}:${m.id}`),
        shown: next.map((m) => `${m.role}:${m.id}`),
      });
      chat.messages = next;
      last = got.length ? got[got.length - 1].id : partial ? from : undefined;
      if (!store.loaded) {
        store.loaded = true;
        for (const l of listeners) l();
      }
      if (whole) await chat.resumeStream(); // attaches if the agent is mid-turn, no-op otherwise
    };
    sync = (whole: boolean) => void (queue = queue.then(() => load(whole)).catch(() => {}));
    sync(true);
    const off = host.onAgent(agent, (e) => {
      if (e.type === "resync") return sync(true);
      // A turn typed in the terminal is being written: one load for a burst of changes.
      if (e.type === "history") return void (clearTimeout(timer), (timer = setTimeout(() => sync(false), 600)));
      if (e.type === "run-start" && e.clientId !== clientId) {
        if (!chat.messages.some((x) => x.id === e.user.id)) chat.messages = [...chat.messages, e.user];
        void chat.resumeStream();
      }
    });
    stop = () => {
      alive = false;
      clearTimeout(timer);
      off();
      void chat.stop();
    };
  };

  const store: ChatStore = {
    chat,
    loaded: false,
    subscribe: (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    use: () => {
      users++;
      if (!stores.has(key)) stores.set(key, store); // let go of, then taken again (by a component that kept it)
      if (!stop) start();
      return () => {
        users--;
        // The last one gone (not one that mounts again at once: a page's new render, React's checks in development).
        setTimeout(() => {
          if (users || !stop) return;
          stop();
          stop = null;
          if (stores.get(key) === store) stores.delete(key);
        });
      };
    },
    settled: () => {
      if (later === null || streaming()) return;
      const whole = later;
      later = null;
      sync(whole);
    },
  };
  stores.set(key, store);
  return store;
}

/**
 * useChat bound to one agent. Shows every turn of that agent, whoever started it. The history is loaded once; after
 * that only what is new (a turn typed in the agent's terminal) is fetched and added, and messages that did not change
 * are not rendered again. A whole reload happens only when the host reconnected. What is shown keeps its ids
 * (history.ts), and nothing is merged while a reply streams in: a load that comes then is made again once it is done.
 * Components of one page that show the same agent share one conversation (ChatStore).
 */
export function useAgentChat(explicit?: AgentHandle | string) {
  const agent = useResolvedAgent(explicit);
  const host = useHost();
  const scope = useScope();
  const store = chatStore(host, agent, scope.path);
  const chat = useChat<UIMessage>({ chat: store.chat });
  const loaded = useSyncExternalStore(store.subscribe, () => store.loaded, () => store.loaded);
  useEffect(() => store.use(), [store]);
  // A reply finished streaming: the load put off meanwhile.
  useEffect(() => store.settled(), [store, chat.status]);
  return { ...chat, loaded };
}

/**
 * The agent's plan as its conversation says it now (plan.ts): the latest plan it proposed and how that stands, and its
 * list of steps as it works through them; live. For a page that shows the plan beside the conversation: it reads the
 * same conversation as the page's console of that agent (no second one).
 */
export function usePlan(explicit?: AgentHandle | string): Plan & { loaded: boolean } {
  const { messages, loaded } = useAgentChat(explicit);
  return useMemo(() => ({ ...planOf(messages), loaded }), [messages, loaded]);
}

/** Where an agent's unsent draft is kept in this browser. */
export const draftKey = (agent: AgentRef) => `pagent:draft:${agent.node}#${agent.agent}`;

/**
 * A composer's text, kept in this browser (localStorage, under `key`) until it is sent: a page that mounts again (the
 * agent changed its code, a reload) gets back what was being typed. Set it to "" when sending. The key is read once:
 * a composer for another agent is another component (give it a React key).
 */
export function useDraft(key: string): [string, (text: string | ((was: string) => string)) => void] {
  const [draft, setDraft] = useState(() => localStorage.getItem(key) ?? "");
  useEffect(() => {
    try {
      if (draft) localStorage.setItem(key, draft);
      else localStorage.removeItem(key);
    } catch {}
  }, [key, draft]);
  return [draft, setDraft];
}

export const toolLabel = (name: string) => name.replace(/^mcp__/, "");

type ToolPart = Extract<UIMessage["parts"][number], { type: "dynamic-tool" }>;

const toolState = (p: ToolPart) =>
  p.state === "output-error" ? "error" : p.state === "input-streaming" || p.state === "input-available" ? "running" : "done";

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/**
 * A tool call: a chip, or (detailed) an expandable card with its input and output. A sub-agent's call: its row. A form
 * the agent asked the user to fill in (`pagent ask-user --secret | --field`): its card.
 */
function ToolCall({ part, detailed }: { part: ToolPart; detailed?: boolean }) {
  const sub = useContext(Subagents).get(part.toolCallId);
  const states = useContext(FormStates);
  const ask = formAskOf(commandOf(part));
  if (ask) return <FormChip ask={ask} state={states.get(part.toolCallId)} why={part.state === "output-error" ? part.errorText : part.state === "output-available" ? show(part.output) : undefined} />;
  const proposal = proposalOf(part);
  if (proposal) return <ProposalView proposal={proposal} />;
  if (sub && detailed) return <SubagentRow sub={sub} />;
  if (sub) {
    return (
      <span className="pagent-tool" data-state={subState(sub.info.status) === "running" ? "running" : sub.info.status === "error" ? "error" : "done"} title={sub.info.description}>
        {sub.info.type}
      </span>
    );
  }
  if (!detailed) {
    return (
      <span className="pagent-tool" data-state={toolState(part)} title={show(part.input ?? {})}>
        {toolWord(part)}
      </span>
    );
  }
  const output = part.state === "output-available" ? part.output : part.state === "output-error" ? part.errorText : undefined;
  // A call its runner says changes the list of steps: the whole list, ticked off; one step added or changed, in a line
  // (the list it is part of is the plan's, usePlan); never its JSON.
  const change = stepsChangeOf(part);
  const list = change && "set" in change ? stepsAfter([part])!.steps : null;
  return (
    <details className="pagent-toolcard" data-state={toolState(part)}>
      <summary>
        <span className="pagent-tool" data-state={toolState(part)}>{toolWord(part)}</span>
        <span className="pagent-toolcard-brief">
          {list ? t("plan.progress", { done: list.filter((s) => s.status === "done").length, n: list.length }) : change ? stepsLine(change) : brief(part.input)}
        </span>
      </summary>
      {list ? <StepList steps={list} /> : !change && saysMore(part.input) && <pre data-label={t("chat.input")}>{show(part.input)}</pre>}
      {output !== undefined && !change && <pre className="pagent-toolcard-out" data-label={t("chat.output")}>{show(output).slice(0, 4000)}</pre>}
    </details>
  );
}

/** One step added or changed, as a line: "new step: Fix it", "step 2: done · Fix truncate", "step 3: removed". */
function stepsLine(change: StepsChange): string {
  if ("add" in change) return t("plan.added", { text: change.add.text });
  if (!("update" in change)) return "";
  const u = change.update;
  const what = u.deleted ? [t("plan.removed")] : [u.status && t(`plan.step.${u.status}`), u.text].filter(Boolean);
  return t("plan.updated", { id: u.id, what: what.join(" · ") });
}

/** The most telling argument of a tool call, for a one-line summary. */
function brief(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const v = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.question ?? o.message ?? o.skill ?? Object.values(o)[0];
  return typeof v === "string" ? v : "";
}

const BRIEF_KEYS = ["file_path", "path", "command", "pattern", "question", "message", "skill"]; // brief's, in its order

/** Whether a call's input says more than its one-line summary (an edit's text, several arguments): then it is shown. */
function saysMore(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input !== "object") return true;
  const keys = Object.keys(input).filter((k) => k !== "description");
  const shown = BRIEF_KEYS.find((k) => k in input) ?? keys[0];
  return keys.some((k) => k !== shown);
}

/**
 * An agent's markdown (links.ts): no HTML of its own. Web links open in a new tab; a page of the app ("/reading", or
 * with props: "/weather?city=Lisbon") opens in place. Agents also link to files by their local path, which are not
 * pages: those show as code. An image shows when it is the app's own (or in the text: data:); any other is a link to
 * it, its words and its address, which loads nothing until the person opens it.
 */
const markdownComponents = {
  a: ({ href = "", children }: { href?: string; children?: ReactNode }) => {
    const kind = linkKind(href);
    return kind === "web" ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : kind === "app" ? <a href={href}>{children}</a> : <code title={href}>{children}</code>;
  },
  img: ({ src = "", alt = "" }: { src?: string | Blob; alt?: string }) => {
    const url = typeof src === "string" ? src : "";
    const kind = imageKind(url, location.origin);
    if (kind === "image") return <img src={url} alt={alt} loading="lazy" />;
    const words = alt.trim() || t("chat.image");
    return kind === "link" ? (
      <a className="pagent-imagelink-out" href={url} target="_blank" rel="noreferrer">
        {words}: {url}
      </a>
    ) : (
      <span>{words}</span>
    );
  },
};
// The markdown's own check of addresses, but an image in the text (data:image/…) stays: it loads nothing.
const urlTransform = (url: string, key: string) => (key === "src" && /^data:image\//i.test(url) ? url : defaultUrlTransform(url));
const markdown = { remarkPlugins: [remarkGfm], components: markdownComponents, urlTransform };

/**
 * Markdown as a reply shows it (GitHub's flavour, the conversation's type and links), for a page's own text: a file's
 * preview, a plan. Plain text only: a ```pagent block stays a code block here (cards are a reply's).
 */
export function Markdown({ children, className, style }: { children: string; className?: string; style?: CSSProperties }) {
  return (
    <div className={className ? `pagent-text ${className}` : "pagent-text"} style={style}>
      <ReactMarkdown {...markdown}>{children}</ReactMarkdown>
    </div>
  );
}

/**
 * A plan the agent proposed (plan.ts), where it proposed it: its text, open; how it stands (waiting for you, approved,
 * kept planning). The approval itself is the permission card (agent-ui.tsx); this is the record of it.
 */
function ProposalView({ proposal }: { proposal: Proposal }) {
  return (
    // Folded while it asks (the approval card shows it) and once declined (a newer one follows); open otherwise.
    <details className="pagent-plan" data-state={proposal.state} open={proposal.state === "approved" || proposal.state === "proposed"}>
      <summary>
        <Chevron />
        <span className="pagent-plan-title">{t("plan.title")}</span>
        <span className="pagent-plan-state">{t(`plan.${proposal.state}`)}</span>
      </summary>
      <Markdown className="pagent-plan-body">{proposal.text}</Markdown>
    </details>
  );
}

/** A list of steps, ticked off: done, under way (what it is doing now), to do. */
export function StepList({ steps, className }: { steps: PlanStep[]; className?: string }) {
  return (
    <ol className={className ? `pagent-steplist ${className}` : "pagent-steplist"}>
      {steps.map((s, i) => (
        <li key={i} data-status={s.status}>
          <span className="pagent-steplist-mark" aria-hidden="true" />
          <span>
            <span className="pagent-sr">{t(`plan.step.${s.status}`)}: </span>
            {s.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Markdown, with the reply's cards (```pagent blocks) as live nodes in between. */
function Text({ text }: { text: string }) {
  const segments = useMemo(() => splitCards(text), [text]);
  return (
    <>
      {segments.map((s, i) =>
        s.type === "text" ? (
          <div key={i} className="pagent-text">
            <ReactMarkdown {...markdown}>{s.text}</ReactMarkdown>
          </div>
        ) : s.type === "cards" ? (
          s.cards.map((c, j) => <NodeCard key={`${i}.${j}`} card={c} />)
        ) : (
          <div key={i} className="pagent-card pagent-card-pending pagent-muted">…</div>
        ),
      )}
    </>
  );
}

export function Part({ part, detailed }: { part: UIMessage["parts"][number]; detailed?: boolean }) {
  switch (part.type) {
    case "text":
      return <Text text={part.text} />;
    case "reasoning":
      return part.text.trim() ? (
        <details className="pagent-reasoning">
          <summary>{t("chat.thinking")}</summary>
          <div>{part.text}</div>
        </details>
      ) : null;
    case "dynamic-tool":
      return <ToolCall part={part} detailed={detailed} />;
    case "file":
      // An image the person added (its thumbnail; the server's copy opens full size). Other files: their name.
      return part.mediaType.startsWith("image/") ? (
        /^data:/.test(part.url) ? (
          <img className="pagent-image" src={part.url} alt={part.filename ?? t("chat.image")} />
        ) : (
          <a className="pagent-image-link" href={part.url} target="_blank" rel="noreferrer" title={part.filename ?? t("chat.fullSize")}>
            <img className="pagent-image" src={part.url} alt={part.filename ?? t("chat.image")} loading="lazy" />
          </a>
        )
      ) : (
        <div className="pagent-muted">{part.filename ?? t("chat.file")}</div>
      );
    default:
      return null;
  }
}

/**
 * One message. Compact: tool calls collapse into a chip row. Detailed: they stay in order, expandable. Rendered again
 * only when the message changed (a long conversation reloads cheaply).
 */
export const MessageView = memo(function MessageView({ message, detailed }: { message: UIMessage; detailed?: boolean }) {
  useLanguage(); // memo: it renders again in another language, not only when the message changed
  const caller = (message.metadata as { caller?: Caller } | undefined)?.caller;
  const subs = subagentsOf(message.parts);
  const parts = subs.size ? message.parts.filter((p) => !isSubagentData(p)) : message.parts;
  // Compact: the calls are a row of chips, but a form keeps its card, in its place.
  const tools = parts.filter((p) => p.type === "dynamic-tool" && !standsAlone(p));
  return (
    <Subagents.Provider value={subs}>
      <div className={`pagent-turn pagent-${message.role}`}>
        {caller && caller.kind !== "user" && message.role === "user" && <div className="pagent-origin">{t("chat.from", { who: callerLabel(caller) })}</div>}
        {!detailed && tools.length > 0 && <div className="pagent-tools">{tools.map((p, i) => <Part key={i} part={p} />)}</div>}
        {detailed
          ? groupSteps(parts, subs).map((g, i) => (Array.isArray(g) ? <Steps key={i} parts={g} /> : <Part key={i} part={g} detailed />))
          : parts.filter((p) => p.type !== "dynamic-tool" || standsAlone(p)).map((p, i) => <Part key={i} part={p} />)}
      </div>
    </Subagents.Provider>
  );
});

type AnyPart = UIMessage["parts"][number];

const Chevron = () => (
  <svg className="pagent-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 4l4 4-4 4" />
  </svg>
);

/**
 * A turn of the conversation, as a page sees it under itself (AgentConsole's turnFooter): what started it (a person's
 * message, a page's, or, folded, the agents' exchange) and the replies, until the next. id: its first message's, the
 * same a turn trigger's action gets for that turn (TurnEvent.messageId), now and after a reload; prompt: what it was
 * asked, as given (the text of that message); messages: all of it, in order; running: it is the last one and the agent
 * is still at it.
 */
export type ChatTurn = { id: string; prompt: string; messages: UIMessage[]; running: boolean };

/**
 * A conversation's messages as a person reads them (turns.ts): their turns as they are; turns between agents (and
 * the engine's notices) folded into one line each, unless `chatter` is "show"; the summary after a compaction as a
 * divider. `me`: whose conversation it is. `cards`: how the cards in replies show (cards.tsx). `footer`: what to show
 * under each turn, given it and all of them (the same array for every turn of one render: something matched over the
 * whole conversation is worked out once); busy: the agent is in one, so the last turn is running.
 */
export function Turns({ messages, me, detailed, chatter = "fold", cards = "open", footer, busy }: { messages: UIMessage[]; me: AgentRef; detailed?: boolean; chatter?: "fold" | "show"; cards?: CardsShown; footer?: (turn: ChatTurn, turns: ChatTurn[]) => ReactNode; busy?: boolean }) {
  const rows = useMemo(() => rowsOf(messages, { fold: chatter !== "show" }), [messages, chatter]);
  const row = (r: Row) =>
    r.type === "message" ? (
      <MessageView key={r.message.id} message={r.message} detailed={detailed} />
    ) : r.type === "compaction" ? (
      <Compaction key={r.message.id} message={r.message} />
    ) : (
      <Chatter key={r.id} row={r} me={me} detailed={detailed} />
    );
  if (!footer) return <CardsShownContext.Provider value={cards}>{rows.map(row)}</CardsShownContext.Provider>;
  // Rows by turn: one starts at each message to the agent (or folded exchange); its replies follow.
  const turns: { rows: Row[]; messages: UIMessage[] }[] = [];
  for (const r of rows) {
    const starts = r.type === "chatter" || (r.type === "message" && r.message.role === "user");
    if (starts || !turns.length) turns.push({ rows: [], messages: [] });
    const t = turns[turns.length - 1];
    t.rows.push(r);
    t.messages.push(...(r.type === "chatter" ? r.messages : [r.message]));
  }
  const all: ChatTurn[] = turns.map((t, i) => ({
    id: t.messages[0].id,
    prompt: t.messages[0].parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim(),
    messages: t.messages,
    running: !!busy && i === turns.length - 1,
  }));
  return (
    <CardsShownContext.Provider value={cards}>
      {turns.map((t, i) => {
        return (
          <Fragment key={all[i].id}>
            {t.rows.map(row)}
            <div className="pagent-turn-footer">{footer(all[i], all)}</div>
          </Fragment>
        );
      })}
    </CardsShownContext.Provider>
  );
}

/** Turns between agents, as one line: who with, how many, a glimpse. Open, the turns as they were (rendered only then). */
function Chatter({ row, me, detailed }: { row: Extract<Row, { type: "chatter" }>; me: AgentRef; detailed?: boolean }) {
  const [open, setOpen] = useState(false);
  const who = chatterLabels(me, row.with);
  return (
    <details className="pagent-chatter" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <Chevron />
        <span className="pagent-chatter-who">
          {who.me} ↔ {who.with.join(", ")}
        </span>
        <span className="pagent-chatter-count">{tn("chat.exchanges.one", "chat.exchanges.other", row.exchanges)}</span>
        {row.glimpse && <span className="pagent-chatter-glimpse">{row.glimpse}</span>}
      </summary>
      {open && <div className="pagent-chatter-body">{row.messages.map((m) => <MessageView key={m.id} message={m} detailed={detailed} />)}</div>}
    </details>
  );
}

/** Where its context was compacted: a thin divider; open, the summary it goes on from (when its harness keeps one). */
function Compaction({ message }: { message: UIMessage }) {
  const summary = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim();
  if (!summary) return <div className="pagent-compaction"><span className="pagent-compaction-line">{t("chat.compacted")}</span></div>;
  return (
    <details className="pagent-compaction">
      <summary className="pagent-compaction-line">
        {t("chat.compacted")}
        <span className="pagent-compaction-more">{t("chat.summary")}</span>
        <Chevron />
      </summary>
      <div className="pagent-text pagent-compaction-body">
        <ReactMarkdown {...markdown}>{summary}</ReactMarkdown>
      </div>
    </details>
  );
}

/**
 * Runs of tool calls (and the reasoning between them) become one group; text stays as it is. A call that started a
 * sub-agent stands on its own (its row is not folded away: sub-agents working side by side are all in sight), and so
 * does a form the agent asked the user to fill in (its card says how that went), and a plan it proposed.
 */
function groupSteps(parts: AnyPart[], subs: SubagentMap): (AnyPart | AnyPart[])[] {
  const out: (AnyPart | AnyPart[])[] = [];
  for (const p of parts) {
    if (p.type === "step-start") continue;
    const step = (p.type === "dynamic-tool" && !subs.has(p.toolCallId) && !standsAlone(p)) || p.type === "reasoning";
    const last = out[out.length - 1];
    if (step && Array.isArray(last)) last.push(p);
    else out.push(step ? [p] : p);
  }
  return out;
}

// ---------------------------------------------------------------- forms

const isFormAsk = (p: AnyPart) => p.type === "dynamic-tool" && !!formAskOf(commandOf(p));
/** A call shown as a card of its own in its place, never folded into the steps: a form, a proposed plan. */
const standsAlone = (p: AnyPart) => isFormAsk(p) || !!proposalOf(p);

/** Each form card's state in a conversation (forms.ts), by its tool call's id. */
const FormStates = createContext<Map<string, FormState>>(new Map());

/**
 * The states of the form cards in an agent's conversation (forms.ts): from the conversation itself, the agent's forms
 * still open, and how the ones this browser saw end ended (until the conversation says so itself).
 */
function useFormStates(agent: AgentRef, messages: UIMessage[]): Map<string, FormState> {
  const host = useHost();
  const [open, setOpen] = useState<Question[]>([]);
  const [live, setLive] = useState<Map<string, FormState>>(() => new Map());
  const asks = useMemo(() => messages.some((m) => m.parts.some(isFormAsk)), [messages]);
  useEffect(() => {
    if (!asks) return;
    let alive = true;
    const questions = new Map<string, string>(); // id → question, for how an answered one ended
    const forms = (qs: Question[]) => qs.filter((q) => q.kind === "form");
    const load = () =>
      host.status(agent).then((s) => {
        if (!alive) return;
        forms(s.questions).forEach((q) => questions.set(q.id, q.question));
        setOpen(forms(s.questions));
      }, () => {});
    void load();
    const off = host.onAgent(agent, (e) => {
      if (e.type === "resync") return void load();
      if (e.type === "question" && e.question.kind === "form") {
        questions.set(e.question.id, e.question.question);
        setOpen((o) => [...o.filter((q) => q.id !== e.question.id), e.question]);
      } else if (e.type === "answered") {
        setOpen((o) => o.filter((q) => q.id !== e.id));
        const q = questions.get(e.id);
        if (q && e.outcome) setLive((l) => new Map(l).set(q, e.outcome!));
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [host, agent.node, agent.agent, asks]);
  return useMemo(() => formStates(messages, open, live), [messages, open, live]);
}

/** Provides the form cards of a conversation with their states. */
export function FormStatesOf({ agent, messages, children }: { agent: AgentRef; messages: UIMessage[]; children: ReactNode }) {
  return <FormStates.Provider value={useFormStates(agent, messages)}>{children}</FormStates.Provider>;
}

const Glyph = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
export const LOCK_ICON = "M5 7V5.2a3 3 0 0 1 6 0V7M4 7h8v6.5H4z";
const FORM_ICON = "M3.5 3.5h9v9h-9zM5.5 6.5h5M5.5 9.5h3";
const CHECK_ICON = "M3.5 8.5 6.5 11.5 12.5 4.5";
const STATE_LABEL = { waiting: "form.waiting", submitted: "form.submitted", cancelled: "form.cancelled", failed: "form.failed" } as const satisfies Record<FormState, string>;

/**
 * A form the agent asked for, where it asked: "<question> · Secure Form · ✓ Submitted". Never a value (a Secure Form's
 * never reaches the conversation; a form's values are in the message to the agent, below). why: the command's output.
 */
function FormChip({ ask, state, why }: { ask: FormAsk; state?: FormState; why?: string }) {
  const where = ask.secret && ask.into ? t("form.goes", { into: ask.into }) : ask.fields.length ? t("form.fields", { fields: ask.fields.join(", ") }) : undefined;
  return (
    <div className="pagent-formchip" data-state={state ?? "unknown"} title={state === "failed" ? why : where}>
      <Glyph d={ask.secret ? LOCK_ICON : FORM_ICON} />
      <span className="pagent-formchip-title">{ask.question || t(ask.secret ? "form.private" : "form.aForm")}</span>
      <span className="pagent-formchip-kind">{t(ask.secret ? "form.secure" : "form.plain")}</span>
      {state && (
        <span className="pagent-formchip-state">
          {state === "submitted" && <Glyph d={CHECK_ICON} />}
          {t(STATE_LABEL[state])}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- sub-agents

type Sub = { info: SubagentInfo; steps: AnyPart[] };
type SubagentMap = Map<string, Sub>;

/** A message's sub-agents (contract.ts, SubagentInfo): each call's info and steps, by the call's id. Nested ones too. */
function subagentsOf(parts: AnyPart[]): SubagentMap {
  const subs: SubagentMap = new Map();
  const steps = new Map<string, [number, AnyPart][]>();
  for (const p of parts as any[]) {
    if (p.type === "data-subagent" && p.id && p.data) subs.set(p.id, { info: p.data, steps: [] });
    else if (p.type === "data-subagent-step" && p.data?.of && p.data.part) {
      const n = Number(String(p.id).slice(String(p.id).lastIndexOf(":") + 1));
      steps.set(p.data.of, [...(steps.get(p.data.of) ?? []), [n, p.data.part]]);
    }
  }
  for (const [of, list] of steps) {
    const s = subs.get(of);
    if (s) s.steps = list.sort((a, b) => a[0] - b[0]).map(([, part]) => part);
  }
  return subs;
}

const isSubagentData = (p: AnyPart) => p.type === "data-subagent" || p.type === "data-subagent-step";

const Subagents = createContext<SubagentMap>(new Map());

const subState = (s: SubagentInfo["status"]) => (s === "running" ? "running" : s === "error" ? "error" : s === "stopped" ? "stopped" : "done");

const seconds = (ms: number) =>
  ms < 60_000 ? t("duration.s", { s: (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) }) : t("duration.m", { m: Math.floor(ms / 60_000), s: Math.round((ms % 60_000) / 1000) });

/** "Read page.tsx": a call as a few words (its argument's last path segment). */
function doing(p: ToolPart): string {
  const arg = brief(p.input).trim().split("\n")[0];
  const short = /^[~.]?\//.test(arg) ? arg.split("/").filter(Boolean).pop() ?? arg : arg;
  return `${toolWord(p)}${short ? " " + (short.length > 48 ? short.slice(0, 47) + "…" : short) : ""}`;
}

/**
 * A sub-agent, in one quiet row: its kind, what it was asked, and while it runs what it is doing ("Read page.tsx ·
 * 12 steps"); once done, how long it took and the start of what it reported. Open it for its steps, under a thin line.
 */
function SubagentRow({ sub }: { sub: Sub }) {
  const { info, steps } = sub;
  const subs = useContext(Subagents);
  const running = info.status === "running";
  const tools = steps.filter((p): p is ToolPart => p.type === "dynamic-tool");
  const count = steps.length ? tools.length : (info.toolUses ?? 0);
  const current = running ? (tools.findLast((t) => toolState(t) === "running") ?? tools[tools.length - 1]) : undefined;
  const meta = [
    running ? (current ? doing(current) : t("subagent.starting")) : info.status === "error" ? t("subagent.failed") : info.status === "stopped" ? t("subagent.stopped") : null,
    count ? tn("chat.steps.one", "chat.steps.other", count) : null,
    !running && info.durationMs ? seconds(info.durationMs) : null,
    info.background && running ? t("subagent.background") : null,
  ].filter(Boolean);
  // What it reported, as one plain line (its markdown's marks left out).
  const summary = !running && info.summary ? info.summary.replace(/`|\*\*|^#+\s+|^\s*[-*]\s+/gm, "").replace(/\s+/g, " ").trim() : "";
  return (
    <details className="pagent-subagent" data-state={subState(info.status)}>
      <summary>
        <span className="pagent-subagent-line">
          <span className="pagent-subagent-type">{info.type}</span>
          <span className="pagent-subagent-desc" title={info.description}>{info.description}</span>
          {meta.length > 0 && <span className="pagent-subagent-meta">{meta.join(" · ")}</span>}
        </span>
        {summary && <span className="pagent-subagent-result">{summary}</span>}
      </summary>
      <div className="pagent-subagent-body">
        {info.prompt && (
          <details className="pagent-reasoning">
            <summary>{t("subagent.prompt")}</summary>
            <div>{info.prompt}</div>
          </details>
        )}
        {steps.map((p, i) => {
          const nested = p.type === "dynamic-tool" ? subs.get(p.toolCallId) : undefined;
          return nested ? <SubagentRow key={i} sub={nested} /> : <Part key={i} part={p} detailed />;
        })}
        {!steps.length && <div className="pagent-muted">{t(running ? "subagent.startingNow" : "subagent.nothing")}</div>}
      </div>
    </details>
  );
}

/**
 * The work between two pieces of text, folded: what the agent is doing right now while it runs, "N steps" once it
 * is done. Open it to see each call with its input and output.
 */
function Steps({ parts }: { parts: AnyPart[] }) {
  const tools = parts.filter((p): p is ToolPart => p.type === "dynamic-tool");
  if (!tools.length) return <>{parts.map((p, i) => <Part key={i} part={p} detailed />)}</>;
  const running = tools.find((t) => toolState(t) === "running");
  const failed = tools.filter((t) => toolState(t) === "error").length;
  return (
    <details className="pagent-steps" data-state={running ? "running" : failed ? "error" : "done"}>
      <summary>
        {running ? (
          <>
            <span className="pagent-tool" data-state="running">{toolWord(running)}</span>
            <span className="pagent-toolcard-brief">{brief(running.input)}</span>
          </>
        ) : (
          <span className="pagent-muted">
            {tn("chat.steps.one", "chat.steps.other", tools.length)}
            {failed ? <span className="pagent-fail"> · {t("chat.failed", { n: failed })}</span> : null}
          </span>
        )}
      </summary>
      {parts.map((p, i) => <Part key={i} part={p} detailed />)}
    </details>
  );
}

/**
 * A conversation with an agent. Place it anywhere; it shows every turn of that agent, whoever started it (turns between
 * agents folded into a line each; `chatter="show"`: as they are). `cards`: how the cards in replies show ("open",
 * "folded" to their title row, "compact").
 */
export function Chat({ agent: explicit, placeholder, style, chatter, cards }: { agent?: AgentHandle | string; placeholder?: string; style?: CSSProperties; chatter?: "fold" | "show"; cards?: CardsShown }) {
  useLanguage();
  const agent = useResolvedAgent(explicit);
  const { messages, sendMessage, status, loaded } = useAgentChat(agent);
  const [draft, setDraft] = useDraft(draftKey(agent));
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void sendMessage({ text });
  };

  return (
    <div className="pagent-chat" style={style} data-pagent-chrome>
      <div className="pagent-chat-head">
        <span className="pagent-dot" data-busy={busy} /> {agent.agent} <span className="pagent-muted">· {agent.node}</span>
      </div>
      <div className="pagent-chat-log">
        {loaded && messages.length === 0 && <div className="pagent-muted">{t("chat.empty")}</div>}
        <FormStatesOf agent={agent} messages={messages}>
          <Turns messages={messages} me={agent} chatter={chatter} cards={cards} />
        </FormStatesOf>
        {status === "submitted" && <div className="pagent-muted">…</div>}
        <div ref={endRef} />
      </div>
      <form className="pagent-chat-input" onSubmit={(e) => (e.preventDefault(), send())}>
        <textarea
          value={draft}
          placeholder={placeholder ?? t("chat.placeholder")}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="submit" className="pagent-primary" disabled={busy || !draft.trim()}>{t("composer.send")}</button>
      </form>
    </div>
  );
}
