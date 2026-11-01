// Ways to interact with an agent when a page wants one. The agent itself renders nothing; pick a surface:
//   <AgentBar>      a bottom input; the reply is one bubble above it
//   <AgentConsole>  full screen: every turn, tool calls, questions, slash commands
//   <AgentFab>      a status button in the corner that opens either
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import type { FileUIPart, UIMessage } from "ai";
import { draftKey, FormStatesOf, LOCK_ICON, Markdown, Part, toolLabel, Turns, useAgentChat, useDraft, type ChatTurn } from "./chat.tsx";
import { IMAGE_TYPES, imagePart, imagesIn } from "./attach.ts";
import type { CardsShown } from "./cards.tsx";
import { labelOf, sayIn, t, tn, useLanguage } from "./i18n.ts";
import { useHost, useResolvedAgent, type Activity, type AgentHandle, type AgentStatus, type Question, type SessionUsage } from "./index.tsx";

// ---------------------------------------------------------------- status

/**
 * What an agent is doing right now: busy, current activity, pending questions, its slash commands. `said`: also where it
 * stopped (the end of its last reply) and when it last talked. `loaded`: the server has said it once (before, it is a
 * guess: idle, and nothing of its session, so what its harness can do is not known yet).
 */
export function useAgentStatus(explicit?: AgentHandle | string, opts: { handle?: boolean; said?: boolean } = {}): AgentStatus & { loaded: boolean } {
  const agent = useResolvedAgent(explicit);
  const host = useHost();
  const lang = useLanguage();
  const [status, setStatus] = useState<AgentStatus>({ busy: false, activity: null, questions: [], queued: [], session: {} });
  const [loaded, setLoaded] = useState(false);
  // How long it has been quiet grows with nothing new from it: said again every half minute while it is busy.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!status.busy) return;
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [status.busy]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoaded(false); // another agent: not read yet
    // What the events told since a read was asked for: a read made before is out of date when it arrives (the response
    // and the events come by different ways, in either order). A turn that started or ended since: all of it (it would
    // say idle after the turn's start), so it is read again. A step, a question, an answer or the queue since: what it
    // says of those (it would say "Working" after the turn's first step was told), so ours stay, and the rest is taken.
    let turns = 0;
    let steps = 0;
    const load = (): Promise<void> => {
      const [t, st] = [turns, steps];
      return host.status(agent, opts).then((s) => {
        if (!alive) return;
        if (t !== turns) return void load();
        setStatus((cur) => (st === steps ? s : { ...s, activity: cur.activity, doing: cur.doing, questions: cur.questions, queued: cur.queued, quietSince: cur.quietSince, stuck: cur.stuck }));
        setLoaded(true);
      }, () => void (alive && setLoaded(true))); // unreadable: what it guessed is all there is
    };
    // A TUI at work reports a new state every few seconds: one reload for a burst of them.
    const soon = () => (clearTimeout(timer), (timer = setTimeout(load, 250)));
    void load();
    const off = host.onAgent(agent, (e) => {
      if (e.type === "resync" || e.type === "status" || e.type === "history") return void soon();
      if (e.type === "run-start" || e.type === "run-end") turns++;
      if (e.type === "activity" || e.type === "question" || e.type === "answered" || e.type === "queued") steps++;
      setStatus((s) => {
        switch (e.type) {
          case "run-start":
            // Busy already: a message joining the turn in progress (an interjection), which goes on doing what it did.
            if (s.busy) return { ...s, quietSince: Date.now(), stuck: false };
            return { ...s, busy: true, activity: "starting", doing: { label: "Starting", say: { key: "doing.starting" } }, since: Date.now(), quietSince: Date.now(), stuck: false };
          case "activity":
            return { ...s, activity: e.label, doing: e.doing ?? { label: toolLabel(e.label) }, quietSince: Date.now(), stuck: false };
          case "run-end":
            void load(); // pick up the session info the turn reported
            return { ...s, busy: false, activity: null, doing: null, since: null };
          case "question":
            return { ...s, questions: [...s.questions.filter((q) => q.id !== e.question.id), e.question] };
          case "answered":
            return { ...s, questions: s.questions.filter((q) => q.id !== e.id) };
          case "queued":
            return { ...s, queued: e.queued };
          default:
            return s;
        }
      });
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
  }, [host, agent.node, agent.agent]);
  // Its label in the app's language (i18n.ts): what the server says it is doing, in the words of the page.
  return useMemo(() => ({ ...status, ...(status.doing ? { doing: { ...status.doing, label: labelOf(status.doing) } } : {}), loaded }), [status, loaded, lang]);
}

/** What it is doing, in parts (a host before `doing` gives only the raw line: that is the label then). */
export const doingOf = (s: AgentStatus): Activity => s.doing ?? { label: s.activity ? toolLabel(s.activity) : t("doing.working") };

const QUIET = 2 * 60_000;
const STUCK = 15 * 60_000;

/** How long, roughly: "3 min", "8 h", "2 days". */
const span = (ms: number) => {
  const min = Math.floor(ms / 60_000);
  return min < 120 ? t("span.min", { n: min }) : min < 48 * 60 ? t("span.h", { n: Math.round(min / 60) }) : t("span.days", { n: Math.round(min / 1440) });
};

/**
 * A busy agent that has been quiet a while (no step, nothing from its TUI): for how long, and past 15 minutes that it
 * may be stuck ("quiet for 8 h, may be stuck"). null while it is not busy, or not quiet long.
 */
export function quietNote(s: AgentStatus, now = Date.now()): string | null {
  if (!s.busy || !s.quietSince) return null;
  const ms = now - s.quietSince;
  if (ms < QUIET) return null;
  return t(s.stuck || ms >= STUCK ? "quiet.stuck" : "quiet", { span: span(ms) });
}

/**
 * Its state in a few words: what it is doing (its label, and how long it has been quiet), waiting for an answer, idle,
 * or offline (a remote agent the other app does not take messages for).
 */
const activityText = (s: AgentStatus) => (s.questions.length ? t("status.needsAnswer") : s.busy ? [doingOf(s).label, quietNote(s)].filter(Boolean).join(" · ") : s.offline ? t("status.offline") : t("status.idle"));

/** The call behind the label, for a closer look (a tooltip): "Bash git status"; offline: why. Nothing when there is no call. */
const activityDetail = (s: AgentStatus) => {
  if (!s.busy && s.offline) return s.offline;
  if (!s.busy || s.questions.length || !s.activity) return undefined;
  return !s.doing || s.doing.tool || s.doing.detail ? s.activity : undefined;
};

/** "ctx 84k / 200k": how much context the session's last request sent, of the model's window. */
const tokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const contextText = (u?: SessionUsage | null) => (u?.context ? (u.window ? t("context.of", { used: tokens(u.context), window: tokens(u.window) }) : t("context", { used: tokens(u.context) })) : null);

// ---------------------------------------------------------------- question

/** What a permission request is about, from what the tool does (its toolKind): who wants to do what. */
const wantsTo = (q: Question, who: string) => {
  switch (q.toolKind) {
    case "command": return t("question.command", { who });
    case "edit":
    case "write": return t("question.edit", { who });
    case "web":
    case "webSearch": return t("question.web", { who });
    case "planMode": return t("question.planMode", { who });
    case "dialog": return t("question.dialog", { who });
    default: return t("question.permission", { who });
  }
};

/**
 * A question the agent asked. Pick an option or type an answer. `from`: where it comes from, when that is not plain
 * from where it shows (the page's title, on another page).
 */
export function QuestionCard({ question, from }: { question: Question; from?: string }) {
  if (question.kind === "form" && question.form) return <FormCard question={question} form={question.form} from={from} />;
  return <PlainQuestion question={question} from={from} />;
}

function PlainQuestion({ question, from }: { question: Question; from?: string }) {
  useLanguage();
  const host = useHost();
  const [text, setText] = useState("");
  const reply = (a: string) => a.trim() && void host.answer(question.id, a.trim());
  const permission = question.kind === "permission";
  // A plan to go ahead with: rendered, and what to change in it may be typed (it keeps the agent planning).
  const plan = question.plan !== undefined;
  const who = from && from.toLowerCase() !== question.agent.toLowerCase() ? `${from} · ${question.agent}` : (from ?? question.agent);
  return (
    <div className="pagent-question" data-pagent-chrome data-plan={plan || undefined}>
      <div className="pagent-question-eyebrow">
        <span className="pagent-dot" data-asking="true" />
        {plan ? t("question.plan", { who }) : permission ? wantsTo(question, who) : t("question.waiting", { who })}
      </div>
      {/* The engine's own words (a permission, a trust request) in the app's language; the answer is the option as written. */}
      <div className="pagent-question-text">{(question.say && sayIn(question.say.question)) ?? question.question}</div>
      {plan && question.plan && <Markdown className="pagent-question-plan">{question.plan}</Markdown>}
      {question.detail && <pre className="pagent-question-detail">{(question.say?.detail && sayIn(question.say.detail)) ?? question.detail}</pre>}
      {question.options.length > 0 && (
        <div className="pagent-question-options">
          {question.options.map((o, i) => (
            <button key={o} className={permission && i === 0 ? "pagent-primary" : undefined} onClick={() => reply(o)}>{(question.say?.options?.[i] && sayIn(question.say.options[i])) ?? o}</button>
          ))}
        </div>
      )}
      {(!permission || plan) && (
        <form onSubmit={(e) => (e.preventDefault(), reply(text))}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t(plan ? "question.planType" : "question.type")} />
        </form>
      )}
    </div>
  );
}

const EYE_ICON = "M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8zM8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z";
const EYE_OFF_ICON = "M2.5 2.5l11 11M6.6 4A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.9 2.4M10.9 11.7A6.4 6.4 0 0 1 8 12.5C3.9 12.5 1.5 8 1.5 8a11.3 11.3 0 0 1 2.6-3";

/**
 * A form the agent asked the user to fill in. A Secure Form (form.secret) asks for one private value: typed masked (Show
 * to check it), it goes from here straight to where the card says, and the agent only hears that it is there. Its value
 * lives in this card until it is sent, and the card is chrome (never in what an agent reads of the screen).
 */
function FormCard({ question, form, from }: { question: Question; form: NonNullable<Question["form"]>; from?: string }) {
  useLanguage();
  const host = useHost();
  const [values, setValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = from && from.toLowerCase() !== question.agent.toLowerCase() ? `${from} · ${question.agent}` : (from ?? question.agent);
  const secret = !!form.secret;
  const ready = form.fields.every((f) => !secret || (values[f.name] ?? "") !== "");
  const send = async (cancel: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await host.answer(question.id, "", cancel ? undefined : Object.fromEntries(form.fields.map((f) => [f.name, values[f.name] ?? ""])));
      setValues({}); // gone from here too
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="pagent-question pagent-form" data-pagent-chrome data-secret={secret || undefined} onSubmit={(e) => (e.preventDefault(), ready && void send(false))}>
      <div className="pagent-question-eyebrow">
        {secret ? (
          <span className="pagent-form-badge">
            <Icon d={LOCK_ICON} size={13} />
            {t("form.secure")}
          </span>
        ) : (
          <span className="pagent-dot" data-asking="true" />
        )}
        <span>{secret ? t("form.for", { who }) : t("form.asks", { who })}</span>
      </div>
      <div className="pagent-question-text">{question.question}</div>
      {/* Not focused by itself: it may appear while the person is typing somewhere else. */}
      {form.fields.map((f) => (
        <label key={f.name} className="pagent-form-field">
          {!secret && <span className="pagent-form-label">{f.label}</span>}
          <span className="pagent-form-input">
            <input
              type={secret && !visible ? "password" : "text"}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              aria-label={f.label}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
            />
            {secret && (
              <button type="button" className="pagent-ghost pagent-icon" aria-pressed={visible} aria-label={t(visible ? "form.hide" : "form.show")} title={t(visible ? "form.hide" : "form.show")} onClick={() => setVisible((x) => !x)}>
                <Icon d={visible ? EYE_OFF_ICON : EYE_ICON} size={15} />
              </button>
            )}
          </span>
        </label>
      ))}
      <div className="pagent-form-note">
        {secret
          ? t("form.secretNote", { where: (form.whereSay && sayIn(form.whereSay)) ?? form.where ?? t("form.where"), agent: question.agent })
          : t("form.note", { agent: question.agent })}
      </div>
      {error && <div className="pagent-form-error" role="alert">{error}</div>}
      <div className="pagent-question-options">
        <button type="submit" className="pagent-primary" disabled={busy || !ready}>{t(busy ? "form.sending" : "form.submit")}</button>
        <button type="button" className="pagent-ghost" disabled={busy} onClick={() => void send(true)}>{t("form.cancel")}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- input

const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const SEND_ICON = "M8 12.5v-9M4 7.5 8 3.5l4 4";
const STOP_ICON = "M5 5h6v6H5z";
const INTERJECT_ICON = "M2.5 8h7M6.5 4.5 10 8l-3.5 3.5M13 3v10";
const TERMINAL_ICON = "M3 4.5 6 7.5 3 10.5M8 11h5";
const CLIP_ICON = "M13.5 7.5 8.2 12.8a3.4 3.4 0 0 1-4.8-4.8l5.4-5.4a2.3 2.3 0 0 1 3.2 3.2l-5.3 5.3a1.1 1.1 0 0 1-1.6-1.6l4.9-4.9";

function useAutoFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

/** Images for the message being written: added by the clip, a paste, or a drop anywhere on the conversation. */
type Attaching = { add: (files: File[]) => void };

/**
 * What a composer's completion offers for what follows its character (AgentConsole's `complete`): the text it puts in
 * (`value`: "@src/slug.ts " goes in for "src/slug.ts"), and how the list shows it (`label`, else the value).
 */
export type Completion = string | { value: string; label?: ReactNode };
const valueOf = (c: Completion) => (typeof c === "string" ? c : c.value);

// The composers on screen, by the draft they keep (an agent's): what useComposer's insert reaches.
const composers = new Map<string, (text: string) => void>();

/**
 * The composer of an agent's conversation (AgentConsole's), from elsewhere on the page: `insert(text)` adds to what is
 * being written there (a file's "Mention" button), at its end. With no console on screen, it goes into the draft the
 * console finds when it opens.
 */
export function useComposer(explicit?: AgentHandle | string): { insert: (text: string) => void } {
  const agent = useResolvedAgent(explicit);
  const key = draftKey(agent);
  return useMemo(
    () => ({
      insert(text: string) {
        const live = composers.get(key);
        if (live) return live(text);
        try {
          localStorage.setItem(key, joined(localStorage.getItem(key) ?? "", text));
        } catch {}
      },
    }),
    [key],
  );
}
/** Text added at the end of a draft, a space between them. */
const joined = (draft: string, text: string) => `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${text}`;

/**
 * Text input that sends on Enter; offers slash commands when the text starts with "/", and `complete`'s suggestions
 * when one of its characters starts a word ("@" + what follows: the files). What is typed and not sent is kept in this
 * browser under `keep` (useDraft), so it survives the page mounting again. Images go with the message: the clip, a
 * paste, or (`attach`: how the conversation around it hands one over) a drop; they show above the text until it is
 * sent. The agent gets each as a file it reads (core: agents/attachments.ts).
 */
function Composer({ onSend, onInterject, disabled, commands = [], complete, placeholder, keep, attach }: {
  onSend: (text: string, files: FileUIPart[]) => void;
  /** Given: a second button (and ⌘/Ctrl+Enter) that sends into the agent's turn in progress. */
  onInterject?: (text: string, files: FileUIPart[]) => void;
  disabled?: boolean;
  commands?: string[];
  complete?: Record<string, (query: string) => Completion[]>;
  placeholder: string;
  keep: string;
  attach?: { current: Attaching | null };
}) {
  useLanguage();
  const [draft, setDraft] = useDraft(keep);
  const [pick, setPick] = useState(0);
  const [files, setFiles] = useState<FileUIPart[]>([]);
  const [adding, setAdding] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const ref = useAutoFocus<HTMLTextAreaElement>();
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(true);
  const [closed, setClosed] = useState<number | null>(null); // Escape on the suggestions at this word: closed
  const matches = useMemo(() => {
    const m = draft.match(/^\/(\S*)$/);
    return m ? commands.filter((c) => c.toLowerCase().includes(m[1].toLowerCase())).slice(0, 8) : [];
  }, [draft, commands]);
  // A completion: a word starting with one of complete's characters right before the caret, and what it offers.
  const word = useMemo(() => {
    if (!complete || matches.length) return null;
    const before = draft.slice(0, caret);
    for (const [char, source] of Object.entries(complete)) {
      const esc = char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = new RegExp(`(?:^|\\s)${esc}([^\\s${esc}]*)$`).exec(before);
      if (!m) continue;
      const start = before.length - m[1].length - char.length;
      const items = start === closed ? [] : source(m[1]).slice(0, 8);
      return items.length ? { char, start, items } : null;
    }
    return null;
  }, [draft, caret, complete, matches.length, closed]);
  const suggesting = focused && !!word;
  // Where the caret goes once the text it was put in is on screen (-1: the end): set before the next key comes in,
  // not a frame later, or what is typed right after a pick lands where the caret was.
  const place = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (place.current === null || !el) return;
    const at = place.current < 0 ? el.value.length : place.current;
    place.current = null;
    el.setSelectionRange(at, at);
    setCaret(at);
  }, [draft]);
  const choose = (c: Completion) => {
    if (!word) return;
    const head = `${draft.slice(0, word.start)}${word.char}${valueOf(c)} `;
    place.current = head.length;
    setDraft(head + draft.slice(caret).replace(/^\s/, ""));
  };
  // useComposer().insert: at the end of what is written, then the caret there.
  useEffect(() => {
    const insert = (text: string) => {
      place.current = -1;
      setDraft((d) => joined(d, text));
      ref.current?.focus();
    };
    composers.set(keep, insert);
    return () => void (composers.get(keep) === insert && composers.delete(keep));
  }, [keep]);

  const add = (list: File[]) => {
    if (!list.length) return;
    setFailed(null);
    setAdding((n) => n + list.length);
    for (const f of list) {
      imagePart(f)
        .then((part) => setFiles((x) => [...x, part]), (e) => setFailed((e as Error).message))
        .finally(() => setAdding((n) => n - 1));
    }
    ref.current?.focus();
  };
  if (attach) attach.current = { add };

  const send = (to = onSend) => {
    const text = draft.trim();
    if ((!text && !files.length) || adding || disabled) return;
    setDraft("");
    setFiles([]);
    setFailed(null);
    to(text, files);
  };
  return (
    <form className="pagent-composer" onSubmit={(e) => (e.preventDefault(), send())}>
      {(files.length > 0 || adding > 0 || failed) && (
        <div className="pagent-composer-files">
          {files.map((f, i) => (
            <span key={i} className="pagent-composer-file">
              <img src={f.url} alt={f.filename ?? ""} title={f.filename} />
              <button type="button" className="pagent-icon" aria-label={t("composer.remove")} title={t("composer.remove")} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
          {adding > 0 && <span className="pagent-muted">{t("composer.adding")}</span>}
          {failed && <span className="pagent-composer-failed" role="alert">{failed}</span>}
        </div>
      )}
      {matches.length > 0 && (
        <div className="pagent-commands">
          {matches.map((c, i) => (
            <button type="button" key={c} data-active={i === pick} onMouseDown={(e) => (e.preventDefault(), setDraft(`/${c} `))}>
              /{c}
            </button>
          ))}
        </div>
      )}
      {suggesting && word && (
        <div className="pagent-commands pagent-completions" role="listbox">
          {word.items.map((c, i) => (
            <button type="button" role="option" key={valueOf(c)} aria-selected={i === pick} data-active={i === pick} title={valueOf(c)} onMouseDown={(e) => (e.preventDefault(), choose(c))}>
              {typeof c === "string" ? c : (c.label ?? c.value)}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={draft}
        rows={1}
        placeholder={placeholder}
        onChange={(e) => (setDraft(e.target.value), setCaret(e.target.selectionStart), setPick(0), setClosed(null))}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          // The suggestions take the keys that move through them, pick one, or close them.
          if (suggesting && word) {
            const n = word.items.length;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") return void (e.preventDefault(), setPick((p) => (p + (e.key === "ArrowDown" ? 1 : n - 1)) % n));
            if ((e.key === "Enter" && !e.nativeEvent.isComposing) || e.key === "Tab") return void (e.preventDefault(), choose(word.items[Math.min(pick, n - 1)]), setPick(0));
            if (e.key === "Escape") return void (e.preventDefault(), e.stopPropagation(), setClosed(word.start));
          }
          if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
          } else if (matches.length && e.key === "Tab") {
            e.preventDefault();
            setDraft(`/${matches[pick]} `);
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send((e.metaKey || e.ctrlKey) && onInterject ? onInterject : onSend);
          }
        }}
        onPaste={(e) => {
          const images = imagesIn(e.clipboardData?.files);
          if (images.length) (e.preventDefault(), add(images));
        }}
      />
      <label className="pagent-ghost pagent-icon pagent-composer-clip" title={t("composer.image")}>
        <input type="file" accept={IMAGE_TYPES.join(",")} multiple hidden onChange={(e) => (add(imagesIn(e.target.files)), (e.target.value = ""))} />
        <Icon d={CLIP_ICON} />
      </label>
      {onInterject && (
        <button type="button" className="pagent-ghost pagent-icon pagent-interject" aria-label={t("composer.now")} title={t("composer.nowHint")} disabled={disabled || adding > 0 || (!draft.trim() && !files.length)} onClick={() => send(onInterject)}>
          <Icon d={INTERJECT_ICON} />
        </button>
      )}
      <button type="submit" className="pagent-primary" aria-label={t("composer.send")} title={t("composer.send")} disabled={disabled || adding > 0 || (!draft.trim() && !files.length)}>
        <Icon d={SEND_ICON} />
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- bar

/** A message's words (its text parts, together). */
const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

const lastAssistant = (messages: UIMessage[]) => {
  const last = messages[messages.length - 1];
  return last?.role === "assistant" ? last : null;
};

/** A bottom input. The agent's reply shows as one bubble above it, until dismissed or the next message. */
export function AgentBar({ agent: explicit, onExpand, onClose, placeholder }: { agent?: AgentHandle | string; onExpand?: () => void; onClose?: () => void; placeholder?: string }) {
  useLanguage();
  const agent = useResolvedAgent(explicit);
  const { messages, sendMessage } = useAgentChat(agent);
  const status = useAgentStatus(agent);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const reply = lastAssistant(messages);
  const tools = reply?.parts.filter((p) => p.type === "dynamic-tool") ?? [];
  const texts = reply?.parts.filter((p) => p.type === "text") ?? [];
  const lastText = texts[texts.length - 1];
  const showBubble = !!reply && dismissed !== reply.id && (status.busy || !!lastText);

  return (
    <div className="pagent-bar-dock" data-pagent-chrome>
      {status.questions.map((q) => <QuestionCard key={q.id} question={q} />)}
      {showBubble && (
        <div className="pagent-bubble">
          <button className="pagent-icon" title={t("bar.dismiss")} onClick={() => setDismissed(reply!.id)}>×</button>
          {tools.length > 0 && (
            <FormStatesOf agent={agent} messages={messages}>
              <div className="pagent-tools">{tools.map((p, i) => <Part key={i} part={p} />)}</div>
            </FormStatesOf>
          )}
          {lastText ? <Part part={lastText} /> : <div className="pagent-muted">{activityText(status)}…</div>}
        </div>
      )}
      <div className="pagent-bar">
        <span className="pagent-dot" data-busy={status.busy} data-asking={status.questions.length > 0} data-offline={!!status.offline && !status.busy} title={[activityText(status), activityDetail(status)].filter(Boolean).join("\n")} />
        <Composer key={draftKey(agent)} keep={draftKey(agent)} placeholder={placeholder ?? t("bar.placeholder")} disabled={status.busy} commands={status.session.slashCommands} onSend={(text, files) => void sendMessage(text ? { text, files } : { files })} />
        {onExpand && <button className="pagent-icon" title={t("bar.fullScreen")} onClick={onExpand}>⤢</button>}
        {onClose && <button className="pagent-icon" title={t("close")} onClick={onClose}>×</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- terminal

/**
 * The agent's own CLI (Claude Code, Codex, opencode …), live, on the same session as everything else. It keeps running
 * when the page closes; while it is open, messages the app sends to the agent are typed into it (or, on a harness whose
 * TUI is one more client of the session, go to that session as always). A harness without a TUI of its own (its runner
 * has no interactive op: status.session.can.terminal) says so instead. Until its status has come, nothing (in its
 * place): opened on a guess, a harness without one would start a process and show an error for a moment.
 */
export function Terminal({ agent: explicit, style }: { agent?: AgentHandle | string; style?: CSSProperties }) {
  const agent = useResolvedAgent(explicit);
  const host = useHost();
  const status = useAgentStatus(agent);
  if (!status.loaded) return <div className="pagent-terminal-wait" style={style} aria-busy="true" />;
  if (status.session.can?.terminal === false) {
    return (
      <div className="pagent-empty" style={style}>
        {t("terminal.none", { harness: status.session.harness?.title ?? agent.agent })}
      </div>
    );
  }
  return (
    <div data-pagent-chrome style={{ display: "contents" }}>
      <host.Terminal target={{ node: agent.node, agent: agent.agent }} style={style} />
    </div>
  );
}

// ---------------------------------------------------------------- console

/** "8s", "2m 05s", "1h 12m": how long, short. */
const lasted = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60
    ? t("duration.s", { s })
    : s < 3600
      ? t("duration.m", { m: Math.floor(s / 60), s: String(s % 60).padStart(2, "0") })
      : t("duration.h", { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
};

/**
 * At the end of the conversation while the agent works: that it is at it (before it has said or done anything too,
 * when there is nothing else to see), what it is doing in a few words (the call itself on hover), and for how long.
 * Quiet so long it may be stuck: Stop right there, as in the head (its messages waiting go on after).
 */
function Working({ agent, status }: { agent: AgentHandle; status: AgentStatus }) {
  const host = useHost();
  const [stopping, setStopping] = useState(false);
  const doing = doingOf(status);
  // Since the turn started (the host says, for a page opened mid-turn), else since this view saw it busy.
  const seen = useRef<number | null>(null);
  seen.current = status.busy ? (seen.current ?? Date.now()) : null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!status.busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status.busy]);
  if (!status.busy || status.questions.length) return null;
  const since = status.since ?? seen.current ?? now;
  const at = Math.max(now, Date.now());
  const stuck = !!status.quietSince && (!!status.stuck || at - status.quietSince >= STUCK);
  return (
    <div className="pagent-working" role="status" title={activityDetail(status)}>
      <span className="pagent-working-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="pagent-working-label">{[doing.label, quietNote(status, at)].filter(Boolean).join(" · ")}</span>
      {stuck && (
        <button className="pagent-ghost pagent-stop" title={t("console.stopHint")} disabled={stopping} onClick={() => (setStopping(true), void host.stop(agent).finally(() => setStopping(false)))}>
          <Icon d={STOP_ICON} size={14} />
          {t(stopping ? "console.stopping" : "console.stop")}
        </button>
      )}
      <span className="pagent-working-time">{lasted(at - since)}</span>
    </div>
  );
}

/** Where the reader of each agent's console was (scrollTop), or -1 at the latest turn: for coming back to a page. */
const readerAt = new Map<string, number>();

/**
 * Full screen: every turn with its tool calls, questions inline, slash commands. Close it and the work goes on. Turns
 * between agents (and the engine's notices) fold into a line each; `chatter="show"` shows them as they are. `cards`:
 * how the cards in replies show: "open" (default), "folded" to their title row until opened, or "compact".
 *
 * A page that is a conversation adds its own to it in two places: under each turn (`turnFooter`: what that turn
 * changed, say), and in the composer (`complete`: suggestions for a word that starts with one of its characters, "@"
 * for the project's files; useComposer().insert puts text in it from elsewhere on the page).
 */
export function AgentConsole({ agent: explicit, onCollapse, onClose, inline, style, empty, chatter, cards, turnFooter, complete, prepare }: {
  agent?: AgentHandle | string;
  onCollapse?: () => void;
  onClose?: () => void;
  inline?: boolean;
  style?: CSSProperties;
  /** shown before the first turn */
  empty?: ReactNode;
  /** turns between agents: folded into a line each (default), or shown as they are */
  chatter?: "fold" | "show";
  /** cards in replies: open (default), folded to their title row until opened, or compact (open, shorter) */
  cards?: CardsShown;
  /** shown under each turn: it (its messages, what it was asked, whether it is still running), and all of them */
  turnFooter?: (turn: ChatTurn, turns: ChatTurn[]) => ReactNode;
  /** by character: what to suggest for the word it starts ("@": (query) => the files matching it) */
  complete?: Record<string, (query: string) => Completion[]>;
  /**
   * What goes to the agent for what the person wrote, as they send it (a queued message too: it waits as it was then):
   * the text, with what the page adds to it (a line saying which files the person edited since). It is the message:
   * the conversation shows it as sent.
   */
  prepare?: (text: string) => string;
}) {
  useLanguage();
  const agent = useResolvedAgent(explicit);
  const { messages, sendMessage, stop: detach, loaded } = useAgentChat(agent);
  const status = useAgentStatus(agent, { handle: true });
  const host = useHost();
  // While it works: a message is queued on the server, for every page of the agent to see (and withdraw) until it goes
  // once the turn before it is done, this page open or not; or it goes into its turn now (interject: the harness reads
  // it between two steps), when its status says it takes one. What the page adds to it (prepare) is added as it is sent.
  const send = (said: string, files: FileUIPart[], how: "now" | "queue" | "interject" = "now") => {
    atEnd.current = true;
    const text = prepare ? prepare(said) : said;
    const message = text ? { text, files } : { files };
    // An interjection is a run of its own from where the turn takes it in: this view follows that one from here.
    if (how === "interject") void detach().then(() => sendMessage(message, { body: { interject: true } }));
    // Queued: once it starts, every view picks its run up as one started elsewhere; this one goes on following the
    // turn in progress meanwhile. Not queued (the server is not there): the words go back into the composer.
    else if (how === "queue") {
      const user: UIMessage = { id: Math.random().toString(36).slice(2), role: "user", parts: [...files, ...(text ? [{ type: "text" as const, text }] : [])] };
      void host.queue(agent, user).catch((e: Error) => (console.warn(`not queued: ${e.message}`), composers.get(draftKey(agent))?.(said)));
    } else void sendMessage(message);
  };
  // The person's own messages waiting, theirs to withdraw (another agent's or a trigger's may wait there too: not shown).
  const queued = status.queued.filter((q) => q.caller.kind === "user");
  const [stopping, setStopping] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const key = `${agent.node}#${agent.agent}`;
  // Where the reader is: at the latest turn (follow what arrives), or scrolled up to read (stay put). Kept across
  // pages, so coming back from a card's page returns to the card, not to the end.
  const atEnd = useRef(!((readerAt.get(key) ?? -1) >= 0));
  const [copied, setCopied] = useState(false);
  // An image dropped anywhere on the conversation goes to the composer.
  const attach = useRef<Attaching | null>(null);
  const [over, setOver] = useState(false);
  const carries = (e: ReactDragEvent) => e.dataTransfer.types.includes("Files");
  useEffect(() => {
    const log = logRef.current;
    if (log && atEnd.current) log.scrollTop = log.scrollHeight;
  }, [messages, status.questions.length]);
  // Replies grow after they render (cards load their node): keep the reader where they were.
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    let restoring = readerAt.get(key) ?? -1; // until the reader scrolls, or the history has had time to load
    const stopRestoring = () => void (restoring = -1);
    const onScroll = () => {
      if (restoring >= 0) return;
      atEnd.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
      readerAt.set(key, atEnd.current ? -1 : log.scrollTop);
    };
    const grew = new MutationObserver(() => {
      if (restoring >= 0) log.scrollTop = restoring;
      else if (atEnd.current) log.scrollTop = log.scrollHeight;
    });
    const done = setTimeout(stopRestoring, 3000);
    log.addEventListener("scroll", onScroll);
    log.addEventListener("wheel", stopRestoring, { passive: true });
    log.addEventListener("touchstart", stopRestoring, { passive: true });
    grew.observe(log, { childList: true, subtree: true });
    return () => {
      clearTimeout(done);
      log.removeEventListener("scroll", onScroll);
      log.removeEventListener("wheel", stopRestoring);
      log.removeEventListener("touchstart", stopRestoring);
      grew.disconnect();
    };
  }, [key]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (onCollapse ?? onClose)?.();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onCollapse, onClose]);

  return (
    <div
      className={inline ? "pagent-console pagent-console-inline" : "pagent-console"}
      style={style}
      data-pagent-chrome
      data-pagent-console={key}
      onDragOver={(e) => carries(e) && (e.preventDefault(), setOver(true))}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
      onDrop={(e) => {
        if (!carries(e)) return;
        e.preventDefault();
        setOver(false);
        attach.current?.add(imagesIn(e.dataTransfer.files));
      }}
    >
      {over && <div className="pagent-console-drop">{t("console.drop")}</div>}
      <header className="pagent-console-head">
        <span className="pagent-dot" data-busy={status.busy} data-asking={status.questions.length > 0} data-offline={!!status.offline && !status.busy} />
        <strong>{agent.agent}</strong>
        {/* The page says where this is (its title, in the navigation); the head says who and what it is doing. */}
        <span className="pagent-muted" title={activityDetail(status)}>{[status.session.model, contextText(status.session.usage), activityText(status)].filter(Boolean).join(" · ")}</span>
        <span className="pagent-spacer" />
        {/* Its turn in progress, stopped as Esc in its TUI would: one stuck on a call that never returns, or going the wrong way. */}
        {status.busy && (
          <button className="pagent-ghost pagent-stop" title={t("console.stopHint")} disabled={stopping} onClick={() => (setStopping(true), void host.stop(agent).finally(() => setStopping(false)))}>
            <Icon d={STOP_ICON} size={14} />
            {t(stopping ? "console.stopping" : "console.stop")}
          </button>
        )}
        {status.session.resume && (
          <button
            className="pagent-ghost pagent-resume"
            title={t("console.resumeHint", { command: status.session.resume })}
            onClick={() => void navigator.clipboard.writeText(status.session.resume!).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
          >
            <Icon d={TERMINAL_ICON} size={14} />
            {t(copied ? "console.copied" : "console.resume")}
          </button>
        )}
        {onCollapse && <button className="pagent-icon" title={t("console.collapse")} onClick={onCollapse}>⤡</button>}
        {onClose && <button className="pagent-icon" title={t("close")} onClick={onClose}>×</button>}
      </header>
      <div className="pagent-console-log" ref={logRef}>
        {messages.length === 0 && (loaded ? <div className="pagent-console-empty">{empty ?? t("console.empty")}</div> : <div className="pagent-muted">{t("loading")}</div>)}
        <FormStatesOf agent={agent} messages={messages}>
          <Turns messages={messages} me={agent} detailed chatter={chatter} cards={cards} footer={turnFooter} busy={status.busy} />
        </FormStatesOf>
        <Working agent={agent} status={status} />
        {status.questions.map((q) => <QuestionCard key={q.id} question={q} />)}
      </div>
      <div className="pagent-console-input">
        <TerminalNote agent={agent} status={status} />
        {queued.length > 0 && (
          <div className="pagent-queued">
            {queued.map((q) => (
              <div key={q.id} className="pagent-queued-item">
                <span className="pagent-muted">{t("console.queued")}</span>
                <span className="pagent-queued-text">{textOf(q.user) || tn("console.images.one", "console.images.other", q.user.parts.filter((p) => p.type === "file").length)}</span>
                <button className="pagent-icon" aria-label={t("composer.remove")} title={t("console.unqueue")} onClick={() => void host.unqueue(agent, q.id)}>×</button>
              </div>
            ))}
          </div>
        )}
        <Composer
          key={key}
          keep={draftKey(agent)}
          // What it is doing shows at the end of the conversation; here only what sending does meanwhile.
          placeholder={t(!status.busy ? "console.placeholder" : status.interject ? "console.queueOrNow" : "console.queue")}
          commands={status.session.slashCommands}
          complete={complete}
          attach={attach}
          onSend={(text, files) => send(text, files, status.busy ? "queue" : "now")}
          onInterject={status.busy && status.interject ? (text, files) => send(text, files, "interject") : undefined}
        />
      </div>
    </div>
  );
}

/**
 * What is off about the agent's terminal, above the composer: its turns run headless for now (its TUI did not come up:
 * why, and when it is tried again; meanwhile nothing goes into a turn in progress, which is why there is no "say it
 * now"), or its TUI runs settings that changed since it started (it restarts with them before its next message; or now).
 */
function TerminalNote({ agent, status }: { agent: AgentHandle; status: AgentStatus }) {
  const host = useHost();
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const h = status.headless;
  if (h) {
    const min = h.retryAt ? Math.max(1, Math.ceil((h.retryAt - Date.now()) / 60_000)) : null;
    return (
      <div className="pagent-console-note" data-kind="headless">
        {t("console.headless", { why: h.why })} {min ? t("console.headlessRetry", { min }) : t("console.headlessOpen")}
      </div>
    );
  }
  if (!status.terminal?.stale) return null;
  const restart = host.restartTerminal;
  return (
    <div className="pagent-console-note" data-kind="stale">
      <span>{error ?? t(status.terminal.stale === "update" ? "console.updated" : "console.stale")}</span>
      {restart && (
        <button className="pagent-ghost" disabled={restarting || status.busy} onClick={() => (setRestarting(true), setError(null), void restart(agent).catch((e: Error) => setError(e.message)).finally(() => setRestarting(false)))}>
          {t("console.restart")}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- fab

type Mode = "closed" | "bar" | "console";

/** A corner button showing the agent's status. Opens the bar or the console. */
export function AgentFab({ agent: explicit, initial = "closed" }: { agent?: AgentHandle | string; initial?: Mode }) {
  useLanguage();
  const agent = useResolvedAgent(explicit);
  const status = useAgentStatus(agent);
  const [mode, setMode] = useState<Mode>(initial);
  let surface: ReactNode = null;
  if (mode === "bar") surface = <AgentBar agent={agent} onExpand={() => setMode("console")} onClose={() => setMode("closed")} />;
  if (mode === "console") surface = <AgentConsole agent={agent} onCollapse={() => setMode("bar")} onClose={() => setMode("closed")} />;

  return (
    <>
      {surface}
      {mode !== "console" && (
        <button
          className="pagent-fab"
          data-pagent-chrome
          data-busy={status.busy}
          data-asking={status.questions.length > 0}
          title={`${agent.agent}: ${activityText(status)}${activityDetail(status) ? `\n${activityDetail(status)}` : ""}`}
          onClick={() => setMode(mode === "closed" ? "bar" : "closed")}
          onDoubleClick={() => setMode("console")}
        >
          <span className="pagent-dot" data-busy={status.busy} data-asking={status.questions.length > 0} data-offline={!!status.offline && !status.busy} />
          <span className="pagent-fab-label">{status.busy || status.questions.length ? activityText(status) : agent.agent}</span>
          {status.questions.length > 0 && <span className="pagent-badge">{status.questions.length}</span>}
        </button>
      )}
    </>
  );
}
