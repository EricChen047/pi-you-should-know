import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Unit tests run outside Pi's loader; resolve the same TUI package Pi supplies.
const installRoot = process.env.PI_TEST_INSTALL_ROOT || join(homedir(), ".pi", "agent", "install");
const version = readFileSync(join(installRoot, "current-version"), "utf8").trim();
const tuiUrl = pathToFileURL(join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === "@earendil-works/pi-tui" ? { url: tuiUrl, shortCircuit: true } : nextResolve(specifier, context);
} });
const { default: extension } = await import("../index.ts");
const { createDetailsView, createNoteWidget } = await import("../ui.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");
import { CHECK_INTERVAL, MAX_CHECKS, MAX_TRANSCRIPT_CHARS, STATE_TYPE, emptyState, findingKey, parseFinding, restoreState, transcriptForObserver } from "../core.ts";
import { settingsPath, supportsThinking } from "../settings.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testRoot = mkdtempSync(join(process.env.YSK_TEST_TMPDIR || tmpdir(), "pi-ysk-unit-"));
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(testRoot, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const tool = (text) => ({ role: "toolResult", toolName: "bash", content: [{ type: "text", text }], timestamp: 2 });
const response = (finding = null) => ({
  role: "assistant", content: [{ type: "text", text: JSON.stringify({ finding }) }], stopReason: "stop",
  usage: { input: 21, output: 12, cacheRead: 3, cacheWrite: 4, cost: { total: 0.002 } },
});
const example = { title: "测试没有通过", detail: "部署前需要留意这个失败。", evidence: "2 tests failed" };

function harness(initial = [], agentDir = mkdtempSync(join(testRoot, "agent-"))) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  let branch = [...initial];
  const calls = [];
  const widgets = [];
  const notifications = [];
  let selected;
  let customResult = "close";
  let confirmed = true;
  let editorText = "";
  const tui = { mode: "fullscreen", terminal: { rows: 40 }, requestRender() {} };
  const theme = { fg(_color, text) { return text; } };
  let messages = [user("请实现这个功能"), tool("2 tests failed")];
  const mainModel = { provider: "mock", id: "model", maxTokens: 4096, reasoning: true };
  const sideModel = { provider: "alt", id: "Team/X", maxTokens: 4096, reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };
  const models = [mainModel, sideModel];
  const pi = {
    on(name, fn) { handlers.set(name, fn); },
    registerCommand(name, definition) { commands.set(name, definition.handler); },
    registerShortcut(name, definition) { shortcuts.set(name, definition.handler); },
    appendEntry(customType, data) { branch.push({ type: "custom", customType, data: structuredClone(data) }); },
  };
  const ctx = {
    mode: "tui", hasUI: true,
    model: mainModel,
    modelRegistry: {
      find(provider, id) { return models.find((model) => model.provider === provider && model.id === id); },
      getAvailable() { return models; },
      hasConfiguredAuth(model) { return !model.unauthenticated; },
      streamSimple(model, input, options) {
        let resolve;
        const completed = new Promise((r) => { resolve = r; });
        calls.push({ model, input, options, resolve });
        return {
          async *[Symbol.asyncIterator]() {
            const result = await completed;
            yield { type: "text_delta", delta: result.content[0].text };
          },
          result() { return completed; },
        };
      },
    },
    sessionManager: {
      getBranch: () => branch,
      buildSessionProjection: () => ({ messages }),
    },
    ui: {
      setWidget(key, content) {
        const component = typeof content === "function" ? content(tui, theme) : undefined;
        widgets.push({ key, component, lines: component ? component.render(80) : content });
      },
      notify(message, type) { notifications.push({ message, type }); },
      async select() { return selected; },
      async custom() { return customResult; },
      async confirm() { return confirmed; },
      getEditorText() { return editorText; },
      setEditorText(text) { editorText = text; },
    },
  };
  extension(pi);
  const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
  const command = async (args = "") => commands.get("ysk")(args, ctx);
  const shortcut = async (name = "ctrl+alt+y") => shortcuts.get(name)(ctx);
  const lastState = () => branch.filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE).at(-1)?.data;
  return { ctx, calls, widgets, notifications, emit, command, shortcut, lastState, agentDir, mainModel, sideModel,
    setBranch(value) { branch = value; }, setMessages(value) { messages = value; },
    select(value) { selected = value; }, custom(value) { customResult = value; }, confirm(value) { confirmed = value; }, editor: () => editorText };
}

test("Chinese dedup keys stay distinct and normalize punctuation", () => {
  assert.notEqual(findingKey("测试没有通过"), findingKey("部署失败"));
  assert.equal(findingKey("测试，没有通过！"), findingKey("测试没有通过"));
});

test("observer input is bounded, preserves the latest user request and excludes system, images and thinking", () => {
  const messages = [
    { role: "system", content: "PRIVATE_SYSTEM" },
    user("我的目标是上线"),
    { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_THOUGHT" }, { type: "text", text: "checking" }] },
    ...Array.from({ length: 12 }, (_, i) => tool(`${i}:` + "a".repeat(12000))),
    { role: "user", content: [{ type: "image", data: "PRIVATE_IMAGE" }, { type: "text", text: "最新的用户请求" }] },
    ...Array.from({ length: 8 }, (_, i) => tool(`${i}:` + "b".repeat(12000))),
  ];
  const out = transcriptForObserver(messages);
  assert.ok(out.length <= MAX_TRANSCRIPT_CHARS);
  assert.match(out, /最新的用户请求/);
  assert.doesNotMatch(out, /PRIVATE_SYSTEM|PRIVATE_THOUGHT|PRIVATE_IMAGE/);
  assert.match(out, /tool result bash/);
});

test("findings require a literal source quote and strip terminal controls", () => {
  const transcript = "[tool result]\n2 tests failed";
  const good = parseFinding(JSON.stringify({ finding: { ...example, title: "\u001b[31m测试没有通过\u001b[0m" } }), transcript, "id");
  assert.equal(good.title, "测试没有通过");
  assert.equal(parseFinding(JSON.stringify({ finding: { ...example, evidence: "invented" } }), transcript, "id"), null);
  assert.equal(parseFinding("not json", transcript, "id"), null);
  assert.equal(parseFinding('{"finding":null}', transcript, "id"), null);
});

test("default off, turn threshold, no tools and bounded requests", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  for (let i = 0; i < 10; i++) await h.emit("turn_end", { outcome: "completed", context: { contextMessages: [user("test")] } });
  assert.equal(h.calls.length, 0);
  await h.command("on");
  for (let i = 0; i < CHECK_INTERVAL - 1; i++) await h.emit("turn_end", { outcome: "completed", context: { contextMessages: [user("test"), tool("2 tests failed")] } });
  assert.equal(h.calls.length, 0);
  await h.emit("turn_end", { outcome: "completed", context: { contextMessages: [user("test"), tool("2 tests failed")] } });
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.input.tools, undefined);
  assert.equal(call.options.reasoning, "low");
  assert.equal(call.options.maxTokens, 900);
  assert.equal(call.options.maxRetries, 0);
  assert.equal(call.options.disableContinuation, true);
  assert.equal(h.lastState().attempts, 1);
  call.resolve(response(example));
  await tick(); await tick();
  assert.equal(h.lastState().finding.title, example.title);
  assert.equal(h.lastState().tokens.input, 21);
  assert.equal(h.lastState().tokens.cost, 0.002);
  assert.ok(h.widgets.some((w) => w.lines?.[0].includes(example.title)));
  await h.emit("turn_end", { outcome: "completed", context: { contextMessages: [user("test")] } });
  assert.equal(h.calls.length, 1, "pending findings should not cause more checks");
});

test("off aborts an in-flight request and rejects a late finding", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.command("on"); await h.command("check");
  assert.equal(h.calls.length, 1);
  await h.command("off");
  assert.equal(h.calls[0].options.signal.aborted, true);
  h.calls[0].resolve(response(example));
  await tick(); await tick();
  assert.equal(h.lastState().enabled, false);
  assert.equal(h.lastState().finding, null);
  assert.ok(!h.widgets.some((w) => w.lines?.[0].includes(example.title)));
});

test("tree navigation invalidates in-flight results and restores the selected branch", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.command("on");
  const enabledBranch = structuredClone([h.lastState()]);
  await h.command("check");
  const old = h.calls[0];
  await h.emit("session_before_tree");
  h.setBranch(enabledBranch.map((data) => ({ type: "custom", customType: STATE_TYPE, data })));
  await h.emit("session_tree");
  assert.ok(old.options.signal.aborted);
  old.resolve(response(example));
  await tick(); await tick();
  assert.equal(h.lastState().finding, null);
  assert.equal(h.lastState().attempts, 0);
});

test("a fresh user prompt cancels a stale observation", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.command("on"); await h.command("check");
  await h.emit("input", { source: "interactive", text: "换一个任务" });
  assert.ok(h.calls[0].options.signal.aborted);
  h.calls[0].resolve(response(example));
  await tick(); await tick();
  assert.equal(h.lastState().finding, null);
});

test("feedback is branch-local, honors Chinese titles, and editor handoff never submits", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.command("on"); await h.command("check");
  h.calls[0].resolve(response(example));
  await tick(); await tick();
  h.select("View details");
  h.custom("discuss");
  await h.command();
  assert.match(h.editor(), /测试没有通过/);
  assert.equal(h.lastState().finding, null);
  assert.deepEqual(h.lastState().seen, [findingKey(example.title)]);
  await h.command("check");
  h.calls[1].resolve(response({ ...example, title: "部署失败" }));
  await tick(); await tick();
  assert.equal(h.lastState().finding.title, "部署失败");
  const fresh = harness();
  await fresh.emit("session_start", { reason: "startup" });
  await fresh.command("on");
  assert.deepEqual(fresh.lastState().seen, []);
});

test("caps checks, reset preserves usage, and forks do not inherit consent", async () => {
  const s = emptyState();
  s.enabled = true;
  s.attempts = MAX_CHECKS;
  s.tokens.input = 123;
  const h = harness([{ type: "custom", customType: STATE_TYPE, data: s }]);
  await h.emit("session_start", { reason: "resume" });
  await h.command("check");
  assert.equal(h.calls.length, 0);
  await h.command("reset");
  assert.equal(h.lastState().attempts, 0);
  assert.equal(h.lastState().tokens.input, 123);
  await h.emit("session_start", { reason: "fork" });
  assert.equal(h.lastState().enabled, false);
  assert.equal(h.lastState().tokens.input, 0);
  assert.deepEqual(h.lastState().seen, []);
});

test("invalid or ungrounded responses are reported, not shown as findings", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.command("on"); await h.command("check");
  h.calls[0].resolve(response({ ...example, evidence: "not actually in the session" }));
  await tick(); await tick();
  assert.equal(h.lastState().finding, null);
  assert.match(h.lastState().lastResult, /evidence not found/i);
  assert.ok(h.notifications.some((item) => item.type === "warning"));
});

test("model changes and session shutdown cancel in-flight work", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.command("on"); await h.command("check");
  await h.emit("model_select");
  assert.ok(h.calls[0].options.signal.aborted);
  h.calls[0].resolve(response(example));
  await tick(); await tick();
  await h.command("check");
  assert.equal(h.calls.length, 2);
  await h.emit("session_shutdown");
  assert.ok(h.calls[1].options.signal.aborted);
  h.calls[1].resolve(response(example));
  await tick(); await tick();
  assert.equal(h.lastState().finding, null);
});

test("independent model and thinking persist and reach the observer only", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.command("model alt/Team/X");
  await h.command("thinking high");
  assert.equal(h.ctx.model, h.mainModel, "main agent model must not change");
  assert.deepEqual(JSON.parse(readFileSync(settingsPath(), "utf8")), { version: 1, model: "alt/Team/X", thinking: "high" });
  await h.command("on"); await h.command("check");
  assert.equal(h.calls[0].model, h.sideModel);
  assert.equal(h.calls[0].options.reasoning, "high");
  h.calls[0].resolve(response());
  await tick(); await tick();
  const next = harness([], h.agentDir);
  await next.emit("session_start", { reason: "startup" });
  await next.command("status");
  assert.match(next.notifications.at(-1).message, /alt\/Team\/X/);
  assert.match(next.notifications.at(-1).message, /thinking high/);
});

test("cannot select off; unsupported levels are blocked; non-reasoning models send no reasoning", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.command("thinking off");
  assert.match(h.notifications.at(-1).message, /Supported thinking levels/);
  await h.command("thinking xhigh");
  assert.match(h.notifications.at(-1).message, /Supported thinking levels/);
  h.mainModel.reasoning = false;
  await h.command("on"); await h.command("check");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.reasoning, undefined);
  h.calls[0].resolve(response());
  await tick(); await tick();
  assert.equal(supportsThinking({ reasoning: true, thinkingLevelMap: { xhigh: null } }, "xhigh"), false);
  assert.equal(supportsThinking({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }, "xhigh"), true);
});

test("model changes validate credentials, require cross-provider approval, and cancel stale work", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.command("model missing/not-there");
  assert.match(h.notifications.at(-1).message, /not found/);
  h.sideModel.unauthenticated = true;
  await h.command("model alt/Team/X");
  assert.match(h.notifications.at(-1).message, /unauthenticated/);
  h.sideModel.unauthenticated = false;
  await h.command("on"); await h.command("check");
  h.confirm(false);
  await h.command("model alt/Team/X");
  assert.equal(h.calls[0].options.signal.aborted, false);
  h.confirm(true);
  await h.command("model alt/Team/X");
  assert.equal(h.calls[0].options.signal.aborted, true);
  h.calls[0].resolve(response(example));
  await tick(); await tick();
  assert.equal(h.lastState().finding, null);
  await h.command("check");
  assert.equal(h.calls[1].model, h.sideModel);
  h.calls[1].resolve(response());
  await tick(); await tick();
});

test("branch snapshots do not silently follow another session's global change", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.command("on");
  await h.command("thinking high");
  const branch = [{ type: "custom", customType: STATE_TYPE, data: h.lastState() }];
  const other = harness([], h.agentDir);
  await other.emit("session_start", { reason: "startup" });
  await other.command("model alt/Team/X");
  const resumed = harness(branch, h.agentDir);
  await resumed.emit("session_start", { reason: "resume" });
  await resumed.command("check");
  assert.equal(resumed.calls[0].model, resumed.mainModel);
  assert.equal(resumed.calls[0].options.reasoning, "high");
  resumed.calls[0].resolve(response());
  await tick(); await tick();
});

test("changing thinking aborts an old request; unsupported model combinations do not send", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.command("on"); await h.command("check");
  await h.command("thinking high");
  assert.ok(h.calls[0].options.signal.aborted);
  h.calls[0].resolve(response(example));
  await tick(); await tick();
  h.sideModel.thinkingLevelMap.high = null;
  await h.command("model alt/Team/X");
  assert.match(h.notifications.at(-1).message, /unsupported/);
  await h.command("check");
  assert.equal(h.calls.length, 1);
  assert.match(h.notifications.at(-1).message, /does not support/);
  await h.command("thinking low"); await h.command("check");
  assert.equal(h.calls[1].model, h.sideModel);
  assert.equal(h.calls[1].options.reasoning, "low");
  h.calls[1].resolve(response());
  await tick(); await tick();
});

test("invalid saved branch settings disable observation instead of switching providers", () => {
  const broken = { ...emptyState(), enabled: true, settings: { model: "alt/Team/X", thinking: "off" } };
  const restored = restoreState(broken);
  assert.equal(restored.enabled, false);
  assert.match(restored.lastResult, /disabled/);
});

test("unreadable settings fail closed without overwriting or falling back", async () => {
  const h = harness();
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), "{bad json");
  await h.emit("session_start", { reason: "startup" });
  await h.command("on"); await h.command("check"); await h.command("model current");
  assert.equal(h.calls.length, 0);
  assert.equal(readFileSync(settingsPath(), "utf8"), "{bad json");
  assert.match(h.notifications.at(-1).message, /Fix the file first/);
});

test("restore rejects damaged state and never enables without explicit true", () => {
  assert.equal(restoreState({ version: 1, enabled: "yes", tokens: { input: -5 }, finding: {} }).enabled, false);
  assert.equal(restoreState({ version: 1, attempts: Infinity }).attempts, 0);
  assert.equal(restoreState({ version: 1, attempts: 999 }).attempts, MAX_CHECKS);
});

const mouse = (x, y, width, extra = {}) => ({
  type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: 10,
  shift: false, alt: false, ctrl: false, ...extra,
});

test("widget buttons route real mouse events across wide and narrow layouts", () => {
  const theme = { fg(_color, text) { return text; } };
  for (const width of [18, 32, 40, 80, 110]) {
    const clicked = [];
    const tui = { mode: "fullscreen", terminal: { rows: 40 }, requestRender() {} };
    const widget = createNoteWidget({ id: "n", ...example }, tui, theme, (action) => clicked.push(action));
    const lines = widget.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    for (const [label, action] of [["[ Got it ]", "got-it"], ["[ View details ]", "details"], ["[ Dismiss ]", "dismiss"]]) {
      const y = lines.findIndex((line) => line.includes(label));
      assert.notEqual(y, -1, `${label} missing at width ${width}`);
      const x = lines[y].indexOf(label) + 2;
      assert.equal(widget.handleMouse(mouse(x, y, width, { button: "right" })), undefined);
      assert.equal(widget.handleMouse(mouse(x, y, width, { type: "drag" })), undefined);
      assert.equal(widget.handleMouse(mouse(x, y, width))?.handled, true);
      assert.equal(clicked.at(-1), action);
    }
  }
});

test("details are scrollable, preserve multilingual text, and close by mouse", () => {
  const theme = { fg(_color, text) { return text; } };
  const tui = { terminal: { rows: 10 }, requestRender() {} };
  const keys = { matches(data, binding) { return data === binding; } };
  let result;
  const view = createDetailsView({ id: "n", title: "中文标题", detail: "Details ".repeat(70), evidence: "LAST-EVIDENCE" }, tui, theme, keys, (value) => { result = value; });
  const first = view.render(40);
  assert.ok(first.some((line) => line.includes("中文标题")));
  assert.ok(first.length <= 8 && first.every((line) => visibleWidth(line) <= 40));
  view.handleMouse(mouse(1, 1, 40, { type: "wheel", button: "none", wheelDelta: 1000 }));
  const last = view.render(40);
  assert.ok(last.some((line) => line.includes("LAST-EVIDENCE")));
  const y = last.findIndex((line) => line.includes("[ Close ]"));
  view.handleMouse(mouse(last[y].indexOf("[ Close ]") + 2, y, 40));
  assert.equal(result, "close");
});

test("clicking actions updates the current branch without stealing editor text", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  h.ctx.ui.setEditorText("Draft in progress");
  await h.command("on"); await h.command("check");
  h.calls[0].resolve(response(example));
  await tick(); await tick();
  const widget = h.widgets.at(-1).component;
  const lines = widget.render(80);
  const y = lines.findIndex((line) => line.includes("[ Got it ]"));
  widget.handleMouse(mouse(lines[y].indexOf("[ Got it ]") + 2, y, 80));
  await tick();
  assert.equal(h.lastState().finding, null);
  assert.equal(h.editor(), "Draft in progress");
  assert.match(h.notifications.at(-1).message, /Marked as known/);
});

test("viewing details clears the heads-up, and discussion preserves the user's draft", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.command("on"); await h.command("check");
  h.calls[0].resolve(response(example));
  await tick(); await tick();
  h.ctx.ui.setEditorText("Draft in progress");
  h.select("View details"); h.custom("discuss");
  await h.shortcut();
  assert.match(h.editor(), /^Draft in progress/);
  assert.match(h.editor(), /测试没有通过/);
  assert.equal(h.lastState().finding, null);
  assert.equal(h.widgets.at(-1).lines, undefined);
});

test("legacy UI status becomes English without changing model-generated content", () => {
  const restored = restoreState({ ...emptyState(), lastResult: "检查中", finding: { id: "n", ...example } });
  assert.equal(restored.lastResult, "Status from an earlier version");
  assert.equal(restored.finding.title, example.title);
  const base = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const file of ["index.ts", "core.ts", "settings.ts", "ui.ts", "README.md"]) {
    assert.doesNotMatch(readFileSync(join(base, file), "utf8"), /[\u3400-\u9fff]/u, `${file} contains non-English plugin copy`);
  }
});
