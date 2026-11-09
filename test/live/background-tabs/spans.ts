// The pure parts of the live hidden-tab check (visibility.ts): the page's event log, the visible spans
// in it, and the failure rules. No Chrome, no I/O, so that test/hidden-tab.test.ts runs them in
// `npm test`.

/** One event that a probe page reported (navigator.sendBeacon): its time (Date.now()), its tab, what. */
export type PageEvent = { t: number; tab: string; ev: string; vis: string; focus: boolean; documentId?: number };

/** A span in which the page reported "visible": from its visibilitychange to "visible" to the next one to "hidden" (`to` null: still visible). */
export type Span = { from: number; to: number | null };

/**
 * The visible spans of one tab's page that overlap the window from `from` to `to`: each starts at a
 * visibilitychange to "visible" (or at `from`, when the page was visible already) and ends at the next
 * visibilitychange to "hidden". The log is in time order.
 */
export function visibleSpans(log: readonly PageEvent[], tab: string, from: number, to: number): Span[] {
  const changes = log.filter((e) => e.tab === tab && (e.ev === "visibilitychange" || e.ev === "load"));
  const spans: Span[] = [];
  let since: number | null = null;
  for (const e of changes) {
    if (e.vis === "visible" && since === null) since = e.t;
    else if (e.vis === "hidden" && since !== null) { spans.push({ from: since, to: e.t }); since = null; }
  }
  if (since !== null) spans.push({ from: since, to: null });
  return spans.filter((s) => s.from <= to && (s.to === null || s.to >= from));
}

/** The total visible time of the spans inside the window (a span still open counts until `to`). */
export function visibleMs(spans: readonly Span[], from: number, to: number): number {
  return spans.reduce((sum, s) => sum + Math.max(0, Math.min(s.to ?? to, to) - Math.max(s.from, from)), 0);
}

/** Time origins identify documents: only the pre-command document's hide before a new visible load is an unload. */
export function navigationVisibility(events: readonly PageEvent[], tab: string, previousDocument: number | undefined): { hides: number; startsVisible: boolean } {
  const changes = events.filter((e) => e.tab === tab && (e.ev === "visibilitychange" || e.ev === "load"));
  if (previousDocument === undefined) return { hides: 0, startsVisible: false };
  const loads = changes.filter((e) => e.ev === "load");
  const newVisibleLoad = (e: PageEvent | undefined) => e?.ev === "load" && e.vis === "visible"
    && e.documentId !== undefined && e.documentId !== previousDocument;
  return {
    hides: changes.filter((e, i) => e.ev === "visibilitychange" && e.vis === "hidden"
      && e.documentId === previousDocument && newVisibleLoad(changes[i + 1])).length,
    startsVisible: loads.length > 0 && loads.every(newVisibleLoad),
  };
}

/**
 * One command of the check. `front` names the tab in front, `ok` and `detail` its own result,
 * `visibleMs` the page's visible time while the command ran, `framesAfter` the animation frames that
 * the page drew in the second after it (a hidden page draws none).
 */
export type Measured = {
  command: string; tab: string; front: string; ms: number; ok: boolean; detail?: string;
  visibleMs: number; visibilityChanges: number; focusEvents: string[]; framesAfter: number;
  navigationHides?: number;
  navigationStartsVisible?: boolean;
};

/**
 * Why the run failed, or nothing. Every command must work. With `hiddenDrive` (agent-browser's option of
 * that name) also: a command on a hidden tab leaves the page hidden (no visible time and no
 * visibilitychange), except `record`, whose span is reported; and a hidden page draws no frame after a
 * command. In the default mode the page is visible while a command is attached: the spans are reported.
 * With `windowDrive`, every page stays visible and draws frames after every command, regardless of
 * which window is in front. Only goto's old-document hide before a new visible load is allowed.
 */
export function failures(run: readonly Measured[], hiddenDrive: boolean, windowDrive = false): string[] {
  const out: string[] = [];
  for (const m of run) {
    const where = `${m.command} on tab ${m.tab} (front: ${m.front})`;
    if (!m.ok) out.push(`${where}: ${m.detail ?? "failed"}`);
    if (windowDrive) {
      const unloads = m.command === "goto" ? m.navigationHides ?? 0 : 0;
      if (m.command === "goto" && !m.navigationStartsVisible)
        out.push(`${where}: the navigation did not load a new visible document`);
      if (m.visibleMs <= 0 || m.visibilityChanges !== unloads)
        out.push(`${where}: the window page must stay visible (${m.visibleMs} ms visible, ${m.visibilityChanges} visibilitychange events)`);
      if (m.framesAfter === 0) out.push(`${where}: the window page drew no frame in the second after the command`);
      continue;
    }
    if (!hiddenDrive || m.front === m.tab) continue;
    if (!m.command.startsWith("record") && (m.visibleMs > 0 || m.visibilityChanges > 0))
      out.push(`${where}: the hidden page reported "visible" for ${m.visibleMs} ms (${m.visibilityChanges} visibilitychange events)`);
    if (m.framesAfter > 0) out.push(`${where}: the hidden page drew ${m.framesAfter} frames in the second after the command`);
  }
  return out;
}
