import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Finding } from "./core.ts";

export type NoteAction = "got-it" | "details" | "dismiss";
type DetailAction = "discuss" | "close";
type Button<T extends string> = { label: string; action: T };
type Hit<T extends string> = { y: number; from: number; to: number; action: T };

/** Layout stays cell-aligned when buttons wrap or the terminal is resized. */
function buttonRows<T extends string>(width: number, startY: number, buttons: readonly Button<T>[], theme: Theme) {
  const lines: string[] = [];
  const hits: Hit<T>[] = [];
  const indent = width > 2 ? "  " : "";
  let plain = indent;
  let styled = indent;
  const flush = () => {
    if (plain !== indent) lines.push(styled);
    plain = indent;
    styled = indent;
  };
  for (const button of buttons) {
    const label = truncateToWidth(button.label, Math.max(0, width - visibleWidth(indent)), "");
    if (!label) continue;
    let gap = plain === indent ? "" : "  ";
    if (visibleWidth(plain + gap + label) > width) { flush(); gap = ""; }
    const from = visibleWidth(plain + gap);
    plain += gap + label;
    styled += gap + theme.fg("accent", label);
    hits.push({ y: startY + lines.length, from, to: from + visibleWidth(label), action: button.action });
  }
  flush();
  return { lines, hits };
}

function hitAction<T extends string>(event: TuiMouseEvent, hits: readonly Hit<T>[]): T | undefined {
  if (event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl) return;
  return hits.find((hit) => hit.y === event.y && event.x >= hit.from && event.x < hit.to)?.action;
}

/** Passive widget: clicks do not take keyboard focus away from the editor. */
export function createNoteWidget(finding: Finding, tui: TUI, theme: Theme, onAction: (action: NoteAction) => void): Component {
  let hits: Hit<NoteAction>[] = [];
  let lastWidth = 0;
  const buttons: Button<NoteAction>[] = [
    { label: "[ Got it ]", action: "got-it" },
    { label: "[ View details ]", action: "details" },
    { label: "[ Dismiss ]", action: "dismiss" },
  ];
  const render = (width: number): string[] => {
    lastWidth = width;
    hits = [];
    if (width <= 0) return [];
    const heading = truncateToWidth(`✦ Heads up: ${finding.title}`, width);
    const lines = [theme.fg("warning", heading)];
    if (tui.mode === "fullscreen") {
      const layout = buttonRows(width, lines.length, buttons, theme);
      lines.push(...layout.lines);
      hits = layout.hits;
    }
    lines.push(theme.fg("dim", truncateToWidth("  Ctrl+Alt+Y to review", width)));
    return lines;
  };
  return {
    render,
    invalidate() { lastWidth = 0; hits = []; },
    handleMouse(event): TuiMouseEventResult | undefined {
      if (event.width !== lastWidth) render(event.width);
      const action = hitAction(event, hits);
      if (!action) return;
      onAction(action);
      return { handled: true };
    },
  };
}

/** Full details remain scrollable rather than overflowing the editor or viewport. */
export function createDetailsView(
  finding: Finding, tui: TUI, theme: Theme, keys: KeybindingsManager, done: (action: DetailAction) => void,
): Component {
  let top = 0;
  let maxTop = 0;
  let pageSize = 1;
  let lastWidth = 0;
  let hits: Hit<DetailAction>[] = [];
  const buttons: Button<DetailAction>[] = [
    { label: "[ Discuss with agent ]", action: "discuss" },
    { label: "[ Close ]", action: "close" },
  ];
  const render = (width: number): string[] => {
    lastWidth = width;
    hits = [];
    if (width <= 0) return [];
    const maxHeight = Math.max(4, Math.min(18, tui.terminal.rows - 2));
    const foot = buttonRows(width, 0, buttons, theme);
    pageSize = Math.max(1, maxHeight - foot.lines.length - 3);
    const body = wrapTextWithAnsi(`${finding.title}\n\n${finding.detail}\n\nEvidence: ${finding.evidence}`, Math.max(1, width - 2));
    maxTop = Math.max(0, body.length - pageSize);
    top = Math.max(0, Math.min(top, maxTop));
    const lines = [theme.fg("accent", truncateToWidth("  Heads-up details", width))];
    lines.push(...body.slice(top, top + pageSize).map((line) => truncateToWidth(`  ${line}`, width)));
    if (maxTop > 0) {
      const indicator = `  ${top + 1}-${Math.min(top + pageSize, body.length)}/${body.length} · ↑↓ or wheel`;
      lines.push(theme.fg("dim", truncateToWidth(indicator, width)));
    }
    lines.push(theme.fg("dim", truncateToWidth("  D: discuss · Esc: close", width)));
    const footer = buttonRows(width, lines.length, buttons, theme);
    lines.push(...footer.lines);
    hits = footer.hits;
    return lines;
  };
  const scroll = (amount: number) => {
    const next = Math.max(0, Math.min(maxTop, top + amount));
    if (next !== top) { top = next; tui.requestRender(); }
  };
  return {
    capturesViewportInput: true,
    render,
    invalidate() { lastWidth = 0; hits = []; },
    handleInput(data) {
      if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm")) done("close");
      else if (keys.matches(data, "tui.select.up")) scroll(-1);
      else if (keys.matches(data, "tui.select.down")) scroll(1);
      else if (keys.matches(data, "tui.select.pageUp")) scroll(-pageSize);
      else if (keys.matches(data, "tui.select.pageDown")) scroll(pageSize);
      else if (data === "d" || data === "D") done("discuss");
    },
    handleMouse(event) {
      if (event.type === "wheel" && event.wheelDelta) { scroll(event.wheelDelta); return { handled: true }; }
      if (event.width !== lastWidth) render(event.width);
      const action = hitAction(event, hits);
      if (!action) return;
      done(action);
      return { handled: true };
    },
  };
}
