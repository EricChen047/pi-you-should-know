import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const pi = process.env.PI_TEST_BIN || `${process.env.HOME}/.pi/agent/bin/pi`;

test("real Pi RPC: opt in, mock model observation, widget and branch-local state", { timeout: 25000 }, async () => {
  const temp = mkdtempSync(join(process.env.YSK_TEST_TMPDIR || tmpdir(), "pi-observer-runtime-"));
  const extensions = join(temp, "agent", "extensions");
  mkdirSync(extensions, { recursive: true });
  cpSync(join(dir, ".."), join(extensions, "you-should-know"), { recursive: true });
  // Load the tested extension by normal global discovery, not by an explicit -e.
  const child = spawn(pi, ["--mode", "rpc", "--offline", "--no-session", "--no-approve", "--no-mcp", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "observer-test", "--model", "mock-model", "-e", join(dir, "mock-provider.ts")], {
    cwd: temp,
    env: { PATH: process.env.PATH, HOME: temp, TMPDIR: temp, PI_CODING_AGENT_DIR: join(temp, "agent"), PI_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let buffer = "";
  const records = [];
  child.stderr.on("data", (data) => { stderr += data; });
  child.stdout.on("data", (data) => {
    buffer += data.toString();
    let pos;
    while ((pos = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, pos);
      buffer = buffer.slice(pos + 1);
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch { records.push({ type: "invalid", line }); }
    }
  });
  const wait = async (predicate, from = 0) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const found = records.slice(from).find(predicate);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`Pi exited ${child.exitCode}: ${stderr}\n${JSON.stringify(records)}`);
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Timed out: ${stderr}\n${JSON.stringify(records)}`);
  };
  let serial = 0;
  const send = (item) => child.stdin.write(`${JSON.stringify(item)}\n`);
  const command = async (item) => {
    const id = `test-${++serial}`;
    const from = records.length;
    send({ ...item, id });
    const result = await wait((record) => record.type === "response" && record.id === id, from);
    assert.equal(result.success, true, JSON.stringify(result));
    return { from, result };
  };
  try {
    const list = await command({ type: "get_commands" });
    assert.ok(list.result.data.commands.some((item) => item.name === "ysk"));

    let mark = records.length;
    await command({ type: "prompt", message: "/ysk status" });
    await wait((record) => record.method === "notify" && record.message.includes("Observer off"), mark);

    mark = records.length;
    const modelDialog = command({ type: "prompt", message: "/ysk model" });
    const modelSelection = await wait((record) => record.method === "select" && record.title.includes("Choose the observer model"), mark);
    assert.ok(modelSelection.options.includes("observer-test/side-model"));
    send({ type: "extension_ui_response", id: modelSelection.id, value: "observer-test/side-model" });
    await modelDialog;

    mark = records.length;
    const thinkingDialog = command({ type: "prompt", message: "/ysk thinking" });
    const thinkingSelection = await wait((record) => record.method === "select" && record.title.includes("Choose observer thinking"), mark);
    assert.ok(thinkingSelection.options.includes("high"));
    assert.ok(!thinkingSelection.options.includes("off"));
    send({ type: "extension_ui_response", id: thinkingSelection.id, value: "high" });
    await thinkingDialog;

    const mainState = await command({ type: "get_state" });
    assert.equal(mainState.result.data.model.id, "mock-model", "changing observer model must not change the main agent");
    mark = records.length;
    await command({ type: "prompt", message: "/ysk on" });
    await wait((record) => record.method === "notify" && record.message.includes("Observer enabled"), mark);

    // Six real Pi turns trigger the background observer at the boundary, not just /ysk check.
    for (let i = 0; i < 6; i++) {
      mark = records.length;
      await command({ type: "prompt", message: `请检查测试结果 ${i + 1}` });
      await wait((record) => record.type === "agent_settled", mark);
    }
    const widget = await wait((record) => record.method === "setWidget" && record.widgetLines?.some((line) => line.includes("模拟测试失败")), mark);
    assert.match(widget.widgetLines[0], /模拟测试失败/);

    mark = records.length;
    const view = command({ type: "prompt", message: "/ysk" });
    const selection = await wait((record) => record.method === "select" && record.title.includes("模拟测试失败"), mark);
    assert.ok(selection.options.includes("View details"));
    send({ type: "extension_ui_response", id: selection.id, value: "View details" });
    const details = await wait((record) => record.method === "select" && record.title.includes("模型 side-model，思考 high"), mark);
    assert.match(details.title, /Evidence:/);
    send({ type: "extension_ui_response", id: details.id, value: "Close" });
    await view;

    mark = records.length;
    const dismiss = command({ type: "prompt", message: "/ysk" });
    const actions = await wait((record) => record.method === "select" && record.title.includes("模拟测试失败"), mark);
    send({ type: "extension_ui_response", id: actions.id, value: "Got it" });
    await dismiss;
    await wait((record) => record.method === "setWidget" && !record.widgetLines, mark);

    mark = records.length;
    await command({ type: "prompt", message: "/ysk status" });
    await wait((record) => record.method === "notify" && record.message.includes("checks 1/12") && record.message.includes("input 20"), mark);

    await command({ type: "prompt", message: "/reload" });
    mark = records.length;
    await command({ type: "prompt", message: "/ysk status" });
    await wait((record) => record.method === "notify" && record.message.includes("Observer on") && record.message.includes("checks 1/12"), mark);

    await command({ type: "new_session" });
    mark = records.length;
    await command({ type: "prompt", message: "/ysk status" });
    await wait((record) => record.method === "notify" && record.message.includes("Observer off") && record.message.includes("side-model") && record.message.includes("thinking high"), mark);
    await command({ type: "prompt", message: "/ysk model current" });
    mark = records.length;
    await command({ type: "prompt", message: "/ysk status" });
    await wait((record) => record.method === "notify" && record.message.includes("mock-model") && record.message.includes("following main model"), mark);
    assert.equal(records.some((record) => record.type === "invalid"), false);
  } finally {
    child.stdin.end();
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill("SIGTERM");
    rmSync(temp, { recursive: true, force: true });
  }
});
