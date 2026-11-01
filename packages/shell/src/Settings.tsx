// Settings: the person's (SPEC 13.15), the same in every pagent app of theirs on this machine, so they are the shell's,
// not a page's. A gear at the bottom of the rail (in the top bar when the app has no rail) opens them in a dialog: the
// language and the theme the apps are read in, the harness a new agent runs; then the app's own, when its home page
// exports one (`export function Settings()`), in the home page's scope. A change shows at once here and, through the
// server, in every other open tab of every app. And, on this computer, a QR code that opens the page on a phone.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { renderSVG } from "uqr";
import { setLanguage, setTheme, useLanguage, useTheme } from "@pagent/bridge";
import { setSetting, useSettings, type Settings } from "@pagent/bridge/settings";
import { t } from "@pagent/bridge/i18n";
import { NodeFrame } from "./NodeFrame.tsx";

const GEAR =
  "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z";

/** The gear that opens Settings: at the bottom of the rail, or in the top bar of an app without one. */
export function SettingsButton({ onOpen, label }: { onOpen: () => void; label?: boolean }) {
  return (
    <button type="button" className={label ? "pagent-railgear" : "pagent-icon pagent-gear"} title={t("settings.title")} aria-label={t("settings.title")} onClick={onOpen}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={GEAR} />
      </svg>
      {label && <span>{t("settings.title")}</span>}
    </button>
  );
}


/** One of a few: buttons side by side, the picked one pressed. */
function Choice<T extends string | null>({ value, options, onPick, label }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onPick: (value: T) => void; label: string }) {
  return (
    <div className="pagent-choice" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} title={o.title} onClick={() => onPick(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="pagent-settings-row">
      <div className="pagent-settings-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      {children}
    </div>
  );
}

/** On this computer: a QR code a phone's camera opens this page with (the app's address on the LAN or the tailnet, with
 *  its key: the phone keeps it, and a home screen's icon added there opens as it did). Not on the phone itself. */
function Phone() {
  const [urls, setUrls] = useState<string[] | null>(null);
  const [pick, setPick] = useState(0);
  const remote = !!(window as { __PAGENT_KEY__?: string }).__PAGENT_KEY__;
  useEffect(() => {
    if (remote) return;
    fetch("/_pagent/devices")
      .then((r) => r.json())
      .then((d: { urls?: string[] }) => setUrls(d.urls ?? []), () => setUrls([]));
  }, [remote]);
  if (remote || !urls) return null;
  // A tailnet's addresses are 100.64.0.0/10; the rest are the LAN's.
  const tailnet = (u: string) => /^(\d+)\.(\d+)\./.exec(new URL(u).hostname)?.slice(1).map(Number).every((n, i) => (i ? n >= 64 && n < 128 : n === 100)) ?? false;
  // The tailnet's first: it reaches home from anywhere.
  const choices = [...urls.filter(tailnet), ...urls.filter((u) => !tailnet(u))].map((u) => {
    const at = new URL(u);
    at.pathname = location.pathname;
    return { url: at.href, label: tailnet(u) ? t("settings.phone.tailnet") : t("settings.phone.lan") };
  });
  const chosen = choices[Math.min(pick, choices.length - 1)];
  return (
    <section>
      <h3>{t("settings.phone")}</h3>
      {!chosen ? (
        <p className="pagent-settings-where">{t("settings.phone.off")}</p>
      ) : (
        <div className="pagent-settings-phone">
          {/* Dark on light whatever the theme: a camera reads it so. */}
          <div className="pagent-qr" role="img" aria-label={t("settings.phone")} dangerouslySetInnerHTML={{ __html: renderSVG(chosen.url, { border: 2, whiteColor: "#ffffff", blackColor: "#000000" }) }} />
          <div className="pagent-settings-label">
            <small>{t("settings.phone.hint")}</small>
            {choices.length > 1 && (
              <Choice label={t("settings.phone")} value={String(Math.min(pick, choices.length - 1))} onPick={(v) => setPick(Number(v))} options={choices.map((c, i) => ({ value: String(i), label: c.label, title: new URL(c.url).host }))} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** The dialog, open while `open`; onClose: Escape, the ×, a click beside it. appTitle: the app's name (its home page's). */
export function SettingsDialog({ open, onClose, appTitle }: { open: boolean; onClose: () => void; appTitle: string | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const settings = useSettings();
  const lang = useLanguage({ chosen: true });
  const theme = useTheme({ chosen: true });
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) (setFailed(null), d.showModal());
    else if (!open && d.open) d.close();
  }, [open]);
  // A refused change (it never is, from these choices; a server that is gone) says why, and the setting is as it was.
  const change = (p: Promise<void>) => void p.catch((e: Error) => setFailed(e.message));
  return (
    // The browser's modal: Escape closes it (onClose), the page behind is inert. A click on the backdrop (the dialog
    // itself, outside its box) closes it too.
    <dialog ref={dialog} className="pagent-settings" aria-labelledby="pagent-settings-title" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pagent-settings-box">
        <header>
          <h2 id="pagent-settings-title">{t("settings.title")}</h2>
          <button type="button" className="pagent-icon" aria-label={t("close")} title={t("close")} onClick={onClose}>
            ×
          </button>
        </header>
        <p className="pagent-settings-where">{t("settings.where")}</p>
        <section>
          <h3>{t("settings.general")}</h3>
          <Row label={t("settings.lang")}>
            <Choice
              label={t("settings.lang")}
              value={lang?.toLowerCase().startsWith("zh") ? "zh-CN" : lang ? "en" : null}
              onPick={(l) => change(setLanguage(l))}
              options={[
                { value: null, label: t("settings.lang.auto"), title: t("settings.lang.autoHint") },
                { value: "zh-CN", label: "中文" },
                { value: "en", label: "English" },
              ]}
            />
          </Row>
          <Row label={t("settings.theme")}>
            <Choice
              label={t("settings.theme")}
              value={theme}
              onPick={(v) => change(setTheme(v))}
              options={[
                { value: null, label: t("settings.theme.system") },
                { value: "light", label: t("settings.theme.light") },
                { value: "dark", label: t("settings.theme.dark") },
              ]}
            />
          </Row>
        </section>
        <section>
          <h3>{t("settings.agents")}</h3>
          <Row label={t("settings.harness")} hint={t("settings.harnessHint")}>
            <Choice
              label={t("settings.harness")}
              value={settings.harness}
              onPick={(h) => change(setSetting("harness", h))}
              options={(settings.harnesses ?? [{ id: settings.harness, title: settings.harness }]).map((h) => ({ value: h.id, label: h.title }))}
            />
          </Row>
        </section>
        {open && <Phone />}
        {/* The app's own, if its home page has some: rendered only while the dialog is open. */}
        {open && (
          <NodeFrame path="/" part="Settings">
            <h3>{appTitle ?? t("settings.app")}</h3>
          </NodeFrame>
        )}
        {failed && (
          <p className="pagent-settings-failed" role="alert">
            {failed}
          </p>
        )}
      </div>
    </dialog>
  );
}
