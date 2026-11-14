/** Session-local, opt-in observer. No tools, external services or global history. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CHECK_INTERVAL, CHECK_TIMEOUT_MS, MAX_CHECKS, MAX_RESPONSE_CHARS, OBSERVER_INSTRUCTIONS, STATE_TYPE,
  emptyState, findingKey, isExplicitSilence, parseFinding, restoreState, safeLine, transcriptForObserver,
  type ObserverState,
} from "./core.ts";
import {
  defaultSettings, isThinking, readSettings, saveSettingsPatch, settingsPath, splitModel, supportsThinking, THINKING_LEVELS,
  type ObserverSettings,
} from "./settings.ts";
import { createDetailsView, createNoteWidget, type NoteAction } from "./ui.ts";

const WIDGET = "session-heads-up";
const HELP = "/ysk on | off | status | check | reset | model | thinking";
const FOLLOW_MODEL = "Follow current model";

export default function headsUpExtension(pi: ExtensionAPI) {
  let state: ObserverState = emptyState();
  let settings: ObserverSettings | undefined;
  let settingsError: string | undefined;
  let turnsSinceCheck = 0;
  let generation = 0;
  let stopped = false;
  let detailsOpen = false;
  let pending: { controller: AbortController; generation: number } | undefined;

  function persist() {
    // Pi custom entries are session-local, branch-aware and excluded from model context.
    pi.appendEntry(STATE_TYPE, structuredClone(state));
  }

  function restore(ctx: ExtensionContext) {
    state = emptyState();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) state = restoreState(entry.data);
    }
    turnsSinceCheck = 0;
    if (state.lastResult === "Checking") state.lastResult = "Previous check interrupted; usage may be incomplete";
    try {
      const defaults = readSettings();
      // Legacy enabled branches had consented to the main model and low thinking.
      settings = state.settings ?? (state.enabled ? defaultSettings() : defaults);
      settingsError = undefined;
    } catch {
      settings = undefined;
      settingsError = "Observer settings are unreadable or invalid";
    }
  }

  function observerModel(ctx: ExtensionContext) {
    if (!settings) return undefined;
    if (!settings.model) return ctx.model;
    const target = splitModel(settings.model);
    return target ? ctx.modelRegistry.find(target.provider, target.id) : undefined;
  }

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!state.enabled || !state.finding) {
      ctx.ui.setWidget(WIDGET, undefined);
      return;
    }
    const finding = state.finding;
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET, (tui, theme) => createNoteWidget(finding, tui, theme, (action) => {
        void performAction(ctx, finding.id, action).catch(() => {
          if (!stopped) ctx.ui.notify("Could not open the reminder.", "error");
        });
      }));
    } else {
      // RPC clients receive text; they can open the same actions via /ysk.
      ctx.ui.setWidget(WIDGET, [`✦ Heads up: ${finding.title}`, "Use /ysk to review"]);
    }
  }

  function cancelPending() {
    generation++;
    const previous = pending;
    pending = undefined;
    if (previous && state.lastResult === "Checking") state.lastResult = "Cancellation requested; usage may be incomplete";
    previous?.controller.abort();
  }

  function usageStatus(ctx: ExtensionContext): string {
    const selected = observerModel(ctx);
    const label = selected ? `${safeLine(selected.provider, 80)}/${safeLine(selected.id, 150)}`
      : settings?.model ? `${safeLine(settings.model, 230)} (unavailable)` : "none";
    const model = settings && !settings.model ? `${label} (following main model)` : label;
    const t = state.tokens;
    const supported = settings && selected ? supportsThinking(selected, settings.thinking) : true;
    const thinking = selected && !selected.reasoning ? " (model does not support thinking)" : supported ? " (requested)" : " (unsupported by model)";
    const virtual = selected?.api === "pi-virtual" ? " (virtual model may route to another provider)" : "";
    const config = settings ? `model ${model}${virtual}; thinking ${settings.thinking}${thinking}` : `${settingsError}: ${settingsPath()}`;
    return `Observer ${state.enabled ? "on" : "off"}; ${config}; checks ${state.attempts}/${MAX_CHECKS}, completed ${state.completed}; input ${t.input}, output ${t.output}, cache read ${t.cacheRead}, cache write ${t.cacheWrite}; estimated $${t.cost.toFixed(4)}. Observer usage is separate from Pi session totals.`;
  }

  function rememberCurrentFinding() {
    if (!state.finding) return;
    const key = findingKey(state.finding.title);
    if (key && !state.seen.includes(key)) state.seen.push(key);
    state.seen = state.seen.slice(-50);
    state.finding = null;
  }

  async function showDetails(ctx: ExtensionContext, findingId: string) {
    const finding = state.finding;
    if (!finding || finding.id !== findingId || detailsOpen || stopped) return;
    detailsOpen = true;
    const selectionGeneration = generation;
    // Opening the details is itself an acknowledgement: remove the heads-up widget
    // while the user reviews it, and do not show the same finding again.
    rememberCurrentFinding();
    persist();
    render(ctx);
    try {
      const result = ctx.mode === "tui"
        ? await ctx.ui.custom<"discuss" | "close">(
          (tui, theme, keys, done) => createDetailsView(finding, tui, theme, keys, done),
          { blocked: { kind: "question", message: "Review reminder details" } },
        )
        : await ctx.ui.select(`${finding.title}\n\n${finding.detail}\n\nEvidence: ${finding.evidence}`, ["Discuss with agent", "Close"]);
      if ((result === "discuss" || result === "Discuss with agent") && !stopped && generation === selectionGeneration) {
        const existing = ctx.ui.getEditorText();
        const text = `Reminder from the side agent — please review:\n${finding.title}\n${finding.detail}\nEvidence: ${finding.evidence}`;
        ctx.ui.setEditorText(existing ? `${existing}\n\n${text}` : text);
        rememberCurrentFinding();
        persist();
        render(ctx);
      }
    } finally {
      detailsOpen = false;
    }
  }

  async function performAction(ctx: ExtensionContext, findingId: string, action: NoteAction) {
    if (stopped || !state.enabled || state.finding?.id !== findingId) return;
    if (action === "details") { await showDetails(ctx, findingId); return; }
    rememberCurrentFinding();
    persist();
    render(ctx);
    ctx.ui.notify(action === "got-it" ? "Marked as known." : "Reminder dismissed.", "info");
  }

  async function showActions(ctx: ExtensionContext) {
    const finding = state.finding;
    if (!finding || !state.enabled) {
      ctx.ui.notify(`${usageStatus(ctx)} ${HELP}`, "info");
      return;
    }
    const selectionGeneration = generation;
    const selection = await ctx.ui.select(
      `Heads up: ${finding.title}\n\nUse ↑/↓ to choose, Enter to confirm, or Esc to cancel.`,
      ["Got it", "View details", "Dismiss", "Cancel"],
    );
    const action = selection === "Got it" ? "got-it" : selection === "View details" ? "details" : selection === "Dismiss" ? "dismiss" : undefined;
    if (action && !stopped && generation === selectionGeneration) await performAction(ctx, finding.id, action);
  }

  function canCheck(ctx: ExtensionContext, manual: boolean): boolean {
    const model = observerModel(ctx);
    let reason: string | undefined;
    if (!state.enabled) reason = "Enable the observer with /ysk on first.";
    else if (!settings) reason = `${settingsError}: ${settingsPath()}`;
    else if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) reason = "Observer model unavailable or unauthenticated; choose one with /ysk model.";
    else if (!supportsThinking(model, settings.thinking)) reason = `Observer model does not support ${settings.thinking}; choose a level with /ysk thinking.`;
    else if (pending) reason = "A check is already in progress.";
    else if (state.finding) reason = "Review the current reminder first.";
    else if (state.attempts >= MAX_CHECKS) reason = "Check limit reached for this branch; use /ysk reset to reset it.";
    if (reason && ctx.hasUI) {
      if (manual) ctx.ui.notify(reason, "warning");
      else if (state.enabled && (!settings || !model || !ctx.modelRegistry.hasConfiguredAuth(model) || !supportsThinking(model, settings.thinking)) && state.lastResult !== reason) {
        state.lastResult = reason;
        persist();
        ctx.ui.notify(reason, "warning");
      }
    }
    return !reason && ctx.hasUI;
  }

  /** Start in the background; never await this from a turn boundary. */
  function startCheck(ctx: ExtensionContext, messages: readonly unknown[], manual: boolean) {
    if (!canCheck(ctx, manual) || !settings) return;
    const model = observerModel(ctx);
    if (!model) return;
    const thinking = settings.thinking;
    const transcript = transcriptForObserver(messages);
    if (!transcript) {
      if (manual) ctx.ui.notify("There is no conversation text to check.", "info");
      return;
    }

    const controller = new AbortController();
    const token = ++generation;
    pending = { controller, generation: token };
    turnsSinceCheck = 0;
    state.attempts++;
    state.lastResult = "Checking";
    persist(); // Count attempts before sending, including requests that fail or are cancelled.

    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    timer.unref?.();

    const run = async () => {
      let tooLong = false;
      try {
        const stream = ctx.modelRegistry.streamSimple(model, {
          systemPrompt: OBSERVER_INSTRUCTIONS,
          messages: [{ role: "user", content: [{ type: "text", text: transcript }], timestamp: Date.now() }],
          // No tools are declared to the observer.
        }, {
          signal: controller.signal,
          // Do not ask non-reasoning models to think. "off" is not a selectable level.
          reasoning: model.reasoning ? thinking : undefined,
          maxTokens: Math.min(900, model.maxTokens || 900),
          timeoutMs: CHECK_TIMEOUT_MS,
          maxRetries: 0,
          cacheRetention: "none",
          disableContinuation: true,
        });

        const aborted = new Promise<never>((_resolve, reject) => {
          if (controller.signal.aborted) reject(new Error("aborted"));
          else controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        const consume = async () => {
          let outputChars = 0;
          for await (const event of stream) {
            if (event.type === "text_delta") {
              outputChars += event.delta.length;
              if (outputChars > MAX_RESPONSE_CHARS) {
                tooLong = true;
                controller.abort();
                break;
              }
            }
          }
          return stream.result();
        };
        const response = await Promise.race([consume(), aborted]);
        if (stopped || generation !== token || !state.enabled || controller.signal.aborted) return;

        state.completed++;
        const usage = response.usage;
        if (usage) {
          const amount = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0;
          state.tokens.input += amount(usage.input);
          state.tokens.output += amount(usage.output);
          state.tokens.cacheRead += amount(usage.cacheRead);
          state.tokens.cacheWrite += amount(usage.cacheWrite);
          state.tokens.cost += amount(usage.cost?.total);
        }
        if (response.stopReason !== "stop") {
          state.lastResult = "Model did not finish the check";
          persist();
          if (manual && ctx.hasUI) ctx.ui.notify("Observer check did not finish; see /ysk status.", "warning");
          return;
        }
        const output = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        const finding = output.length <= MAX_RESPONSE_CHARS ? parseFinding(output, transcript, randomUUID()) : null;
        if (finding && !state.seen.includes(findingKey(finding.title))) {
          state.finding = finding;
          state.lastResult = "Reminder found";
          persist();
          render(ctx);
          if (ctx.mode === "rpc") ctx.ui.notify(`Heads up: ${finding.title} (use /ysk to review)`, "info");
        } else {
          const invalid = !finding && !isExplicitSilence(output);
          state.lastResult = invalid ? "Invalid model output or evidence not found" : "No new reminders";
          persist();
          if (manual && ctx.hasUI) ctx.ui.notify(`Observer check: ${state.lastResult}.`, invalid ? "warning" : "info");
        }
      } catch {
        if (stopped || generation !== token || !state.enabled) return;
        state.lastResult = tooLong ? "Output exceeded the limit" : controller.signal.aborted ? "Check timed out or was cancelled" : "Model request failed";
        persist();
        if (manual && ctx.hasUI) ctx.ui.notify(`Observer: ${state.lastResult}.`, "warning");
      } finally {
        clearTimeout(timer);
        if (pending?.generation === token) pending = undefined;
      }
    };
    void run();
  }

  pi.on("session_start", (event, ctx) => {
    stopped = false;
    restore(ctx);
    // A fork/new session is a new consent and history boundary, even if it inherited entries.
    if (event.reason === "new" || event.reason === "fork") {
      state = emptyState();
      try { settings = readSettings(); settingsError = undefined; }
      catch { settings = undefined; settingsError = "Observer settings are unreadable or invalid"; }
      persist();
    }
    render(ctx);
  });
  pi.on("session_before_tree", () => { cancelPending(); });
  pi.on("session_tree", (_event, ctx) => { cancelPending(); restore(ctx); render(ctx); });
  pi.on("session_before_fork", () => { cancelPending(); });
  pi.on("session_before_compact", () => { cancelPending(); });
  pi.on("session_compact", (_event, ctx) => { cancelPending(); render(ctx); });
  pi.on("model_select", () => { cancelPending(); });
  pi.on("input", (event) => {
    // A fresh human request can change the task before the old observation arrives.
    if (event.source !== "extension") cancelPending();
    return { action: "continue" };
  });
  pi.on("agent_settled", (event) => { if (event.aborted) cancelPending(); });
  pi.on("session_shutdown", (_event, ctx) => {
    stopped = true;
    cancelPending();
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
  });
  pi.on("turn_end", (event, ctx) => {
    if (!state.enabled || !ctx.hasUI || event.outcome !== "completed") return;
    turnsSinceCheck++;
    if (turnsSinceCheck >= CHECK_INTERVAL) startCheck(ctx, event.context.contextMessages, false);
  });

  pi.registerShortcut("ctrl+alt+y", {
    description: "Review the observer reminder",
    handler: async (ctx) => { if (ctx.mode === "tui") await showActions(ctx); },
  });

  pi.registerCommand("ysk", {
    description: "Heads-up observer: on, off, status, check, model, thinking",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const [verb = "", ...words] = args.trim().split(/\s+/);
      const action = verb.toLowerCase();
      const value = words.join(" ");
      if (action === "on") {
        const selected = observerModel(ctx);
        if (!settings || !selected || !ctx.modelRegistry.hasConfiguredAuth(selected) || !supportsThinking(selected, settings.thinking)) {
          ctx.ui.notify(`Cannot enable observer: ${usageStatus(ctx)} Check /ysk model and /ysk thinking.`, "warning");
          return;
        }
        if (!state.enabled) {
          state.enabled = true;
          state.settings = { ...settings };
          turnsSinceCheck = 0;
          persist();
        }
        render(ctx);
        ctx.ui.notify(`Observer enabled: excerpts of conversation and tool results, possibly sensitive, will be sent to the model below; up to ${MAX_CHECKS} checks. ${usageStatus(ctx)}`, "info");
        return;
      }
      if (action === "model") {
        if (!settings) {
          ctx.ui.notify(`${settingsError}: ${settingsPath()}. Fix the file first.`, "warning");
          return;
        }
        const selectionGeneration = generation;
        let choice = value;
        if (!choice) {
          const available = [...new Set(ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`))].sort();
          const picked = await ctx.ui.select("Choose the observer model (does not change the main agent)", [FOLLOW_MODEL, ...available]);
          if (!picked || stopped || generation !== selectionGeneration || !settings) return;
          choice = picked === FOLLOW_MODEL ? "current" : picked;
        }
        const modelSpec = choice.toLowerCase() === "current" ? null : choice;
        const target = modelSpec ? splitModel(modelSpec) : undefined;
        const selected = modelSpec ? (target ? ctx.modelRegistry.find(target.provider, target.id) : undefined) : ctx.model;
        if (modelSpec && (!selected || !ctx.modelRegistry.hasConfiguredAuth(selected))) {
          ctx.ui.notify("Model not found or unauthenticated; select one with /ysk model or provide provider/model.", "warning");
          return;
        }
        const previous = observerModel(ctx);
        if (state.enabled && selected && (previous?.provider !== selected.provider || selected.api === "pi-virtual")) {
          const destination = selected.api === "pi-virtual"
            ? "This virtual model may route conversation excerpts to another provider"
            : `Conversation excerpts will be sent to ${safeLine(selected.provider, 80)}`;
          const ok = await ctx.ui.confirm("Change observer provider", `${destination}. Continue?`);
          if (!ok || stopped || generation !== selectionGeneration || !settings) return;
        }
        try { saveSettingsPatch({ model: modelSpec }); }
        catch { ctx.ui.notify(`Could not save observer settings; check ${settingsPath()}.`, "error"); return; }
        cancelPending();
        settings = { ...settings, model: modelSpec };
        state.settings = { ...settings };
        persist();
        const warning = selected && !supportsThinking(selected, settings.thinking) ? "Choose a supported level with /ysk thinking." : "";
        ctx.ui.notify(`Observer model updated; the main agent is unchanged. ${usageStatus(ctx)} ${warning}`, warning ? "warning" : "info");
        return;
      }
      if (action === "thinking") {
        if (!settings) {
          ctx.ui.notify(`${settingsError}: ${settingsPath()}. Fix the file first.`, "warning");
          return;
        }
        const selectionGeneration = generation;
        const selected = observerModel(ctx);
        const levels = selected ? THINKING_LEVELS.filter((level) => supportsThinking(selected, level)) : [...THINKING_LEVELS];
        if (!levels.length) {
          ctx.ui.notify("The observer model has no supported thinking levels.", "warning");
          return;
        }
        const picked = value || await ctx.ui.select("Choose observer thinking level (does not change the main agent)", levels);
        if (!picked || stopped || generation !== selectionGeneration || !settings) return;
        const level = picked.toLowerCase();
        if (!isThinking(level) || !levels.includes(level)) {
          ctx.ui.notify(`Supported thinking levels: ${levels.join(", ")}`, "warning");
          return;
        }
        try { saveSettingsPatch({ thinking: level }); }
        catch { ctx.ui.notify(`Could not save observer settings; check ${settingsPath()}.`, "error"); return; }
        cancelPending();
        settings = { ...settings, thinking: level };
        state.settings = { ...settings };
        persist();
        ctx.ui.notify(`Observer thinking set to ${level}; actual behavior depends on the model.`, "info");
        return;
      }
      if (action === "off") {
        cancelPending();
        state.enabled = false;
        rememberCurrentFinding();
        state.lastResult = "Disabled";
        persist();
        render(ctx);
        ctx.ui.notify("Observer disabled; cancellation requested for any in-flight check.", "info");
        return;
      }
      if (action === "status") {
        ctx.ui.notify(`${usageStatus(ctx)} Last result: ${state.lastResult}.`, "info");
        return;
      }
      if (action === "check") {
        startCheck(ctx, ctx.sessionManager.buildSessionProjection().messages, true);
        return;
      }
      if (action === "reset") {
        if (pending) {
          ctx.ui.notify("Wait for the current check or cancel it with /ysk off.", "warning");
          return;
        }
        state.attempts = 0;
        state.completed = 0;
        state.lastResult = "Check limit reset; cumulative usage preserved";
        persist();
        ctx.ui.notify("Check limit reset; cumulative usage preserved.", "info");
        return;
      }
      if (action) {
        ctx.ui.notify(`Usage: ${HELP}`, "warning");
        return;
      }
      await showActions(ctx);
    },
  });
}
