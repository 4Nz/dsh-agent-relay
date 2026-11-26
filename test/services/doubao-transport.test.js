import { test } from "node:test";
import assert from "node:assert/strict";
import { createDoubaoHttpTransport, DoubaoTransportError, probeDoubaoAccount } from "../../lib/providers/doubao/transport.js";

const input = { prompt: "问题正文", model_item_key: "0", thinking: false, tools: [] };
const cookie = "sessionid=fake-private-session; msToken=fake-private-token";
const block = (text, id = "answer", parent_id = "", block_type = 10000) => ({ block_id: id, block_type, parent_id, content: { text_block: { text } } });
const event = (name, value = {}, id) => `${id ? `id: ${id}\n` : ""}event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
const notify = (text, id = "answer") => event("STREAM_MSG_NOTIFY", { content: { content_block: [block(text, id)] } });
const end = event("SSE_REPLY_END");
const ack = event("SSE_ACK", { ack_client_meta: { conversation_id: "conversation-1" }, query_list: [{ question_id: "question-1" }] });
function response(body) { return new Response(body, { headers: { "content-type": "text/event-stream" } }); }
function fixture(fetchImpl, options = {}) {
  const renewals = [];
  const transport = createDoubaoHttpTransport({
    credentials: { read: () => ({ cookie, generation: "generation-1" }), renew: (...args) => renewals.push(args) },
    fetch: fetchImpl,
    ...options,
  });
  return { transport, renewals };
}
async function rejected(transport, status) {
  await assert.rejects(transport.chat(input), (error) => {
    assert.ok(error instanceof DoubaoTransportError);
    assert.equal(error.status, status);
    assert.doesNotMatch(String(error), /fake-private|sessionid=|msToken=|问题正文/);
    return true;
  });
}

test("独立豆包 HTTP 请求固定普通对话和可信地址，并按凭证代次续期", async () => {
  let calls = 0;
  const { transport, renewals } = fixture(async (url, options) => {
    calls++;
    const target = new URL(url);
    assert.equal(target.origin, "https://www.doubao.com");
    assert.equal(target.pathname, "/chat/completion");
    assert.equal(target.searchParams.get("msToken"), "fake-private-token");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.cookie, cookie);
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.equal(body.messages[0].content_block[0].content.text_block.text, input.prompt);
    assert.equal(body.option.agent_mode, 2);
    assert.equal(body.ext.agent_mode, "2");
    assert.equal(body.option.need_deep_think, 0);
    assert.equal(body.ext.use_deep_think, "0");
    assert.equal(body.option.model_config.model_item_key, "0");
    assert.equal(body.option.aggregate_params.model_item_key, "0");
    assert.equal(body.option.aggregate_params.mode_id, "1");
    assert.deepEqual(body.option.general_task_param, { server_do_compare: true });
    assert.equal(body.tools, undefined);
    assert.equal(body.ext.input_skill, undefined);
    return response(ack + notify("你好") + end);
  });
  assert.deepEqual(await transport.chat(input), { output: "你好", external_ref: "conversation-1" });
  assert.equal(calls, 1);
  assert.equal(renewals.length, 1);
  assert.equal(renewals[0][1], cookie);
  assert.equal(renewals[0][2], "generation-1");
});

test("SSE 支持逐字节 UTF8 和 CRLF，通知首字加增量正文", async () => {
  const wire = new TextEncoder().encode((notify("你") + event("STREAM_CHUNK", { patch_op: [{ patch_value: { id: "answer", text: "好，世界🌏" } }] }) + end).replaceAll("\n", "\r\n"));
  let offset = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (offset === wire.length) controller.close();
    else controller.enqueue(wire.slice(offset, ++offset));
  } });
  const { transport } = fixture(async () => response(stream));
  assert.equal((await transport.chat(input)).output, "你好，世界🌏");
});

test("通知与累计 chunk 去重，重复 event id 不重复追加", async () => {
  const delta = event("STREAM_CHUNK", { id: "answer", text: "你好" }, "2");
  const { transport } = fixture(async () => response(notify("你") + delta + delta + end));
  assert.equal((await transport.chat(input)).output, "你好");
});

test("显式 append 与 CHUNK_DELTA 从已合并正文继续追加重复字符", async () => {
  for (const delta of [
    event("STREAM_CHUNK", { patch_op: [{ op: "append", path: "/content_block/0/content/text_block/text", value: "哈" }] }, "append-1"),
    event("CHUNK_DELTA", { id: "answer", text: "哈" }, "delta-1"),
  ]) {
    const { transport } = fixture(async () => response(notify("哈") + delta + delta + end));
    assert.equal((await transport.chat(input)).output, "哈哈");
  }
});

test("相同文字的独立增量仍然保留，末尾完整通知不会重复", async () => {
  const { transport } = fixture(async () => response(notify("")
    + event("CHUNK_DELTA", { id: "answer", text: "哈" }, "1")
    + event("CHUNK_DELTA", { id: "answer", text: "哈" }, "2")
    + notify("哈哈") + end));
  assert.equal((await transport.chat(input)).output, "哈哈");
});

test("忽略问题回显、任意资料 text 和思考父子块", async () => {
  const { transport } = fixture(async (_url, options) => {
    const request = JSON.parse(options.body);
    return response(ack
      + event("FULL_MSG_NOTIFY", { message: { content_block: [block(input.prompt, "question")] } })
      + event("STREAM_MSG_NOTIFY", { message: { message_id: "question-1" }, content: { content_block: [block(input.prompt, "echo")] } })
      + event("STREAM_CHUNK", { content_block: request.messages[0].content_block })
      + event("STREAM_MSG_NOTIFY", { content: { content_block: [block("推理秘密", "thinking-child", "thinking"), block("思考中", "thinking", "", 10040)] } })
      + event("CHUNK_DELTA", { id: "thinking-child", text: "更多秘密" })
      + event("STREAM_CHUNK", { metadata: { text: "检索正文" } })
      + notify("正式答案") + end);
  });
  assert.equal((await transport.chat(input)).output, "正式答案");
});

test("解析完整块和文本路径 append/replace patch，替换后仍可追加", async () => {
  const { transport } = fixture(async () => response(
    event("STREAM_CHUNK", { patch_op: [{ patch_path: "/content_block", patch_value: [block("初稿")] }] })
    + event("STREAM_CHUNK", { patch_op: [{ op: "replace", path: "/content_block/0/content/text_block/text", value: "终稿" }] })
    + event("STREAM_CHUNK", { patch_op: [{ patch_type: "append", patch_path: ["content_block", "0", "content", "text_block", "text"], patch_value: "。" }] }) + end));
  assert.equal((await transport.chat(input)).output, "终稿。");
});

test("明确业务拒绝为 failed，错误正文不泄露", async () => {
  const { transport } = fixture(async () => response(event("STREAM_ERROR", { error_code: 710022004, error_msg: cookie })));
  await rejected(transport, "failed");
});

test("任务运行时失败占位正文返回 failed，过滤各层 expose_reason 原文", async () => {
  for (const location of ["content", "message", "ext"]) {
    const ext = { expose_reason: `agent_err_real_answer: ${cookie}` };
    const payload = location === "ext" ? { ext } : { [location]: { ext } };
    const { transport } = fixture(async () => response(notify("出了点问题，请稍后重试。") + event("STREAM_MSG_NOTIFY", payload) + end));
    await rejected(transport, "failed");
  }
});

test("断流、空答案、非 SSE、畸形 JSON 和未知文本 patch 均不能误报完成", async () => {
  for (const body of [notify("半个答案"), end, cookie, "event: CHUNK_DELTA\ndata: {\n\n", event("STREAM_CHUNK", { patch_op: [{ op: "replace", path: "/content_block/99/content/text_block/text", value: "不可信" }] }) + end]) {
    const { transport } = fixture(async () => response(body));
    await rejected(transport, "unknown");
  }
});

test("未知增量块和未知父块不能被静默丢弃后误报完整答案", async () => {
  for (const wire of [
    notify("答案开头") + event("CHUNK_DELTA", { id: "unknown-block", text: "不该丢失的后半段" }) + end,
    notify("答案开头") + event("STREAM_CHUNK", { content_block: [block("不确定归属", "child", "unknown-parent")] }) + end,
  ]) {
    const { transport } = fixture(async () => response(wire));
    await rejected(transport, "unknown");
  }
});

test("读取异常和非法 UTF8 不泄露底层错误或返回部分结果", async () => {
  const broken = new ReadableStream({ pull(controller) { controller.error(new Error(cookie)); } });
  for (const body of [broken, new Uint8Array([0xff, 0xff])]) {
    const { transport } = fixture(async () => response(body));
    await rejected(transport, "unknown");
  }
});

test("请求或流超时即 unknown，替身忽略 signal 也按时结束且无重试", async () => {
  for (const streaming of [false, true]) {
    let calls = 0;
    let aborted = false;
    let cancelled = false;
    const { transport } = fixture(async (_url, options) => {
      calls++;
      options.signal.addEventListener("abort", () => { aborted = true; });
      if (!streaming) return new Promise(() => {});
      return response(new ReadableStream({ cancel() { cancelled = true; } }));
    }, { timeoutMs: 15 });
    await rejected(transport, "unknown");
    assert.equal(calls, 1);
    assert.equal(aborted, true);
    if (streaming) assert.equal(cancelled, true);
  }
});

test("网络异常、5xx 和重定向不会泄露凭证或自动重试", async () => {
  for (const fetchResult of [() => { throw new Error(cookie); }, () => new Response(cookie, { status: 503 }), () => new Response(null, { status: 302, headers: { location: "https://attacker.invalid/" } })]) {
    let calls = 0;
    const { transport, renewals } = fixture(async (_url, options) => {
      calls++;
      assert.equal(options.redirect, "error");
      return fetchResult();
    });
    await rejected(transport, "unknown");
    assert.equal(calls, 1);
    assert.equal(renewals.length, 0);
  }
});

test("4xx 明确拒绝；没有凭证或不支持模型不会发送", async () => {
  const { transport } = fixture(async () => new Response(cookie, { status: 401 }));
  await rejected(transport, "failed");
  let calls = 0;
  const empty = fixture(async () => { calls++; throw new Error(); }, { credentials: { read: () => null, renew() {} } });
  await rejected(empty.transport, "failed");
  await assert.rejects(empty.transport.chat({ ...input, model_item_key: "9" }), (error) => error.status === "failed");
  assert.equal(calls, 0);
});

test("流大小有上限，越界后主动取消", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(600_000))); }, cancel() { cancelled = true; } });
  const { transport } = fixture(async () => response(stream));
  await rejected(transport, "unknown");
  assert.equal(cancelled, true);
});

test("多个合法小帧也受总字节上限约束", async () => {
  const wire = notify("a") + event("CHUNK_DELTA", { id: "answer", text: "a".repeat(100_000) }).repeat(43) + end;
  const { transport } = fixture(async () => response(wire));
  await rejected(transport, "unknown");
});

test("账号探测验证业务语义，不以 HTTP200 判断登录成功", async () => {
  for (const [body, expected] of [[{ data: { name: "测试账户" } }, "valid"], [{ data: { name: "测试账户" }, code: 7 }, "expired"], [{ code: 0, data: { name: "测试账户", error_code: 7 } }, "expired"], [{ message: "error", data: {} }, "expired"], [{ data: {} }, "expired"], [{}, "unavailable"], ["坏响应", "unavailable"]]) {
    let calls = 0;
    const result = await probeDoubaoAccount(cookie, async (url, options) => {
      calls++;
      assert.equal(new URL(url).pathname, "/passport/account/info/v2/");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      return Response.json(body);
    });
    assert.equal(result, expected);
    assert.equal(calls, 1);
  }
});

test("账号探测拒绝重定向、限长、网络异常且不抛出凭据", async () => {
  for (const implementation of [async () => { throw new Error(cookie); }, async () => new Response(null, { status: 302 }), async () => new Response("x".repeat(70_000))]) {
    assert.equal(await probeDoubaoAccount(cookie, implementation), "unavailable");
  }
  assert.equal(await probeDoubaoAccount(cookie, async () => new Response(null, { status: 401 })), "expired");
});
