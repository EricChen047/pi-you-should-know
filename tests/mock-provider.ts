// Hermetic Pi-runtime fixture: no HTTP client, sockets or credentials.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const model = {
  id: "mock-model", name: "Mock model", provider: "observer-test", api: "observer-test-api",
  baseUrl: "", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096,
};
const sideModel = { ...model, id: "side-model", name: "Side model" };

function stream(chosenModel, context, options) {
  const result = createAssistantMessageEventStream();
  const system = context.messages.filter((message) => message.role === "system").map((message) => message.content).join(" ");
  const isObserver = system.includes("quiet independent observer");
  const text = isObserver
    ? JSON.stringify({ finding: { title: "模拟测试失败", detail: `上线前应确认测试失败的原因。模型 ${chosenModel.id}，思考 ${options?.reasoning ?? "none"}。`, evidence: "2 tests failed" } })
    : "检查结果：2 tests failed";
  const message = {
    role: "assistant", api: chosenModel.api, provider: chosenModel.provider, model: chosenModel.id,
    content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  queueMicrotask(() => {
    result.push({ type: "start", partial: message });
    result.push({ type: "text_start", contentIndex: 0, partial: message });
    result.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    result.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    result.push({ type: "done", reason: "stop", message });
    result.end();
  });
  return result;
}

export default function (pi) {
  pi.registerProvider({
    id: model.provider, name: "Observer test",
    auth: { apiKey: { name: "Fake", async resolve() { return { auth: { apiKey: "fake" }, source: "env" }; } } },
    getModels() { return [model, sideModel]; },
    stream, streamSimple: stream,
  });
}
