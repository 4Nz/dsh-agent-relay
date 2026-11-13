import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startChannelServer, CHANNEL_NAME } from "../../lib/channel/server.js";

const SID = "11111111-2222-3333-4444-555555555555";

function fixture(t, { token = "secret", responses = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-channel-server-"));
  const file = join(dir, "channel-token");
  if (token !== null) writeFileSync(file, `${token}\n`);
  const input = new PassThrough();
  const output = new PassThrough();
  const sent = [];
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      sent.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
  });
  const requests = [];
  const polls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body, auth: init.headers.authorization });
    if (url.endsWith("/poll")) {
      // 每次轮询返回队列中的下一组，队列空时挂起直到中止
      const next = polls.shift();
      if (next) return Response.json({ messages: next });
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    if (url.endsWith("/ack")) return responses.ack ?? Response.json({ ok: true, message: "已确认" });
    return new Response("not found", { status: 404 });
  };
  const logs = [];
  const server = startChannelServer({
    input,
    output,
    env: { AGENT_RELAY_CHANNEL_TOKEN_FILE: file, CLAUDE_CODE_SESSION_ID: SID, AGENT_RELAY_CLAUDE_PID: "4242", DSH_AGENT_RELAY_PORT: "5555" },
    fetchImpl,
    log: (x) => logs.push(x),
    version: "9.9.9",
  });
  t.after(() => {
    server.stop();
    input.end();
    rmSync(dir, { recursive: true, force: true });
  });
  const rpc = (message) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const wait = async (fn, ms = 1000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = fn();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("等待超时");
  };
  return { rpc, sent, requests, polls, logs, wait };
}

test("握手声明 channel 能力并拒绝 server/discover", async (t) => {
  const { rpc, sent, wait } = fixture(t);
  rpc({ id: "d", method: "server/discover", params: {} });
  rpc({ id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  rpc({ id: 1, method: "tools/list" });
  await wait(() => sent.length >= 3);
  assert.equal(sent[0].error.code, -32601);
  const init = sent.find((m) => m.id === 0).result;
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.deepEqual(init.capabilities.experimental, { "claude/channel": {} });
  assert.equal(init.serverInfo.name, CHANNEL_NAME);
  assert.match(init.instructions, /ack/);
  assert.deepEqual(sent.find((m) => m.id === 1).result.tools.map((x) => x.name), ["ack"]);
});

test("initialized 后长轮询 Relay 并推送 channel 事件", async (t) => {
  const { rpc, sent, requests, polls, wait } = fixture(t);
  polls.push([{ msg_id: "m1", content: "改为 v2" }]);
  rpc({ id: 0, method: "initialize", params: {} });
  rpc({ method: "notifications/initialized" });
  const pushed = await wait(() => sent.find((m) => m.method === "notifications/claude/channel"));
  assert.deepEqual(pushed.params, { content: "改为 v2", meta: { msg_id: "m1" } });
  const poll = requests.find((r) => r.url.endsWith("/poll"));
  assert.equal(poll.url, "http://127.0.0.1:5555/api/agent-relay/claude-channel/poll");
  assert.deepEqual(poll.body, { pid: 4242, session_id: SID, version: "9.9.9" });
  assert.equal(poll.auth, "Bearer secret");
});

test("ack 工具转发到 Relay，参数无效或 Relay 报错时返回 isError", async (t) => {
  const { rpc, sent, requests, wait } = fixture(t, { responses: {} });
  rpc({ id: 5, method: "tools/call", params: { name: "ack", arguments: { msg_id: "m1", summary: "完成" } } });
  const ok = await wait(() => sent.find((m) => m.id === 5));
  assert.equal(ok.result.content[0].text, "已确认");
  assert.deepEqual(requests.find((r) => r.url.endsWith("/ack")).body, { msg_id: "m1", summary: "完成" });
  rpc({ id: 6, method: "tools/call", params: { name: "ack", arguments: {} } });
  assert.equal((await wait(() => sent.find((m) => m.id === 6))).result.isError, true);
});

test("Relay 返回错误时 ack 返回 isError", async (t) => {
  const { rpc, sent, wait } = fixture(t, { responses: { ack: new Response("凭证无效", { status: 401 }) } });
  rpc({ id: 7, method: "tools/call", params: { name: "ack", arguments: { msg_id: "m1" } } });
  const result = (await wait(() => sent.find((m) => m.id === 7))).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /401/);
});

test("缺少凭证时不崩溃，记录一次原因并退避", async (t) => {
  const { rpc, logs, requests, wait } = fixture(t, { token: null });
  rpc({ id: 0, method: "initialize", params: {} });
  rpc({ method: "notifications/initialized" });
  await wait(() => logs.length);
  assert.match(logs[0], /channel 凭证/);
  assert.equal(requests.length, 0);
});
