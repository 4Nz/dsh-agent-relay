import { test } from "node:test";
import assert from "node:assert/strict";
import { createDoubaoProvider } from "../../lib/providers/doubao/index.js";
import { DoubaoTransportError } from "../../lib/providers/doubao/transport.js";

test("豆包 Provider 使用快速模型、关闭深度思考且不传工具", async () => {
  let request;
  const provider = createDoubaoProvider({
    transport: {
      chat: async (input) => {
        request = input;
        return { output: "搜索结果", external_ref: "doubao-1" };
      },
    },
  });
  const result = await provider.execute({ run_id: "run", task_id: "task", prompt: "搜索今天的新闻" });
  assert.deepEqual(request, {
    prompt: "搜索今天的新闻",
    model_item_key: "0",
    thinking: false,
    tools: [],
  });
  assert.deepEqual(result, { status: "completed", output: "搜索结果", external_ref: "doubao-1" });
  assert.equal(provider.capabilities().quota, false);
});

test("豆包 Provider 传输失败时保留失败状态", async () => {
  const provider = createDoubaoProvider({
    transport: { chat: async () => { throw new DoubaoTransportError("failed", "登录态不可用"); } },
  });
  assert.deepEqual(
    await provider.execute({ run_id: "run", task_id: "task", prompt: "搜索" }),
    { status: "failed", error: "登录态不可用" },
  );
});

test("豆包 Provider 隐去任意异常内容并保留结果未知", async () => {
  for (const error of [new Error("cookie=secret"), { cookie: "secret" }, new DoubaoTransportError("unknown", "结果未知")]) {
    const provider = createDoubaoProvider({ transport: { chat: async () => { throw error; } } });
    const result = await provider.execute({ run_id: "run", task_id: "task", prompt: "搜索" });
    assert.equal(result.status, "unknown");
    assert.doesNotMatch(JSON.stringify(result), /secret|cookie/);
  }
});
