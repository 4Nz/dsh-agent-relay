import { randomUUID } from "node:crypto";
import type { DoubaoTransport, DoubaoTransportResponse } from "./index.js";

export interface DoubaoCredentialPort {
  read(): { cookie: string; generation?: string } | null;
  renew(headers: Headers, expectedCookie: string, expectedGeneration?: string): void;
}

/** 不携带上游正文、请求 URL 或底层异常，避免错误输出泄露登录态。 */
export class DoubaoTransportError extends Error {
  constructor(readonly status: "failed" | "unknown", message: string) {
    super(message);
    this.name = "DoubaoTransportError";
  }
}

const unknownResult = () => new DoubaoTransportError("unknown", "豆包发送结果未知，请勿自动重发");
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FRAME = 512 * 1024;
const CLIENT_PARAMS = {
  aid: "582478", real_aid: "582478", version_code: "20800", pc_version: "2.31.4",
  device_id: "2697515174213273", tea_uuid: "2697515174213273", web_id: "7677868049198630415",
  fp: "verify_2697515174213273", chromium_version: "147.0.7727.149", runtime_version: "3.39.0",
  channel: "win", language: "zh", region: "CN", sys_region: "CN", tz_name: "Asia/Shanghai",
  pkg_type: "release_version", client_platform: "pc_client", device_platform: "web",
  doubao_device_platform: "desktop", web_platform: "desktop", samantha_web: "1", "use-olympus-account": "1",
};

function endpoint(path: "/chat/completion" | "/passport/account/info/v2/", cookie: string): string {
  const params = new URLSearchParams({ ...CLIENT_PARAMS, web_tab_id: randomUUID() });
  const token = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("msToken="));
  if (token) params.set("msToken", token.slice("msToken=".length));
  return `https://www.doubao.com${path}?${params}`;
}

function headers(cookie: string): Record<string, string> {
  return {
    cookie, "content-type": "application/json", accept: "text/event-stream, application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.31.4",
    Referer: "chrome://doubao-chat/", "accept-language": "zh-CN,zh;q=0.9",
    "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8"',
    "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin",
    "agw-js-conv": "str", "last-event-id": "undefined",
    "x-flow-trace": `${randomUUID().replaceAll("-", "")}-${randomUUID().replaceAll("-", "")}-01`,
  };
}

function requestBody(prompt: string) {
  const questionId = randomUUID();
  const blockId = randomUUID();
  const ordinary = { server_do_compare: true };
  return {
    questionId, blockId,
    body: {
      messages: [{ local_message_id: questionId, message_status: 0, content_block: [{
        block_type: 10000, block_id: blockId, parent_id: "", meta_info: [], append_fields: [],
        content: { text_block: { text: prompt, icon_url: "", icon_url_dark: "", summary: "" }, pc_event_block: "" },
      }] }],
      option: {
        create_time_ms: Date.now(), agent_mode: 2, need_deep_think: 0,
        is_audio: false, answer_with_suggest: false, tts_switch: false,
        unique_key: randomUUID(), start_seq: 0, need_create_conversation: true,
        conversation_init_option: { need_ack_conversation: true },
        conversation_init_ext: { model_item_key: "0", reasoning_effort: "3", mode_id: "1" },
        sse_recv_event_options: { support_chunk_delta: true }, support_lazy_fetch_stream: true,
        general_task_param: ordinary, connector_info_list: [],
        model_config: { model_item_key: "0", model_extra_params: {}, reasoning_effort: 3 },
        aggregate_params: {
          mention_skill_list: "[]", mention_plugin_list: "[]", mention_ext: "[{}]",
          conversation_mode: "", mode_id: "1", model_item_key: "0", agent_mode: "2", reasoning_effort: "3", provider_id: "",
        },
      },
      client_meta: { local_conversation_id: `local_${randomUUID()}`, conversation_id: "", bot_id: "7338286299411103781", last_section_id: "", last_message_index: null },
      user_context: [],
      ext: { agent_mode: "2", use_deep_think: "0", general_task_param: JSON.stringify(ordinary), is_finish: "1", conversation_init_option: JSON.stringify({ need_ack_conversation: true }), commerce_credit_config_enable: "0" },
    },
  };
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function isUser(value: RecordValue): boolean {
  const role = value.role ?? record(value.sender)?.role;
  return role === "user" || role === "human";
}
function trustedResponse(response: Response): boolean {
  return !response.redirected && (!response.url || new URL(response.url).origin === "https://www.doubao.com");
}

interface Block { id: string; parent: string; type: number; notify: string; chunks: string; replacement?: string }

/** 仅遍历协议中的答案容器；不递归搜集任意 text，避免问题、搜索资料和推理泄露。 */
function replyCollector(questionId: string, questionBlock: string) {
  const questions = new Set([questionId, questionBlock]);
  const blocks = new Map<string, Block>();
  const positions = new Map<string, string>();
  let active: string | undefined;
  let conversationId: string | null = null;
  let anonymous = 0;
  function append(block: Block, part: string, explicitDelta = false) {
    // 显式增量不能用前缀猜测去重，否则「哈」后追加「哈」会丢字。
    if (explicitDelta) block.replacement = merged(block) + part;
    else if (block.replacement !== undefined) block.replacement += part;
    else block.chunks += part;
  }
  function merged(block: Block): string {
    return block.replacement ?? (block.chunks.startsWith(block.notify) ? block.chunks : block.notify + block.chunks);
  }

  function visit(value: unknown, mode: "notify" | "chunk" | "delta", path = "", depth = 0): void {
    if (depth > 32) throw unknownResult();
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, mode, `${path}/${index}`, depth + 1));
      return;
    }
    const item = record(value);
    if (!item || isUser(item) || questions.has(String(item.message_id ?? item.local_message_id ?? ""))) return;
    if (typeof item.block_type === "number") {
      const id = text(item.block_id) ?? `anonymous-${anonymous++}`;
      if (questions.has(id)) return;
      const block = blocks.get(id) ?? { id, parent: "", type: item.block_type, notify: "", chunks: "" };
      block.parent = text(item.parent_id) ?? block.parent;
      block.type = item.block_type;
      blocks.set(id, block);
      positions.set(path, id);
      active = id;
      const part = text(record(record(item.content)?.text_block)?.text);
      if (part !== undefined) {
        if (mode === "notify") {
          if ((block.chunks || block.replacement !== undefined) && part.startsWith(merged(block))) block.replacement = part;
          block.notify = part;
        } else append(block, part, mode === "delta");
      }
      // 容器的子块也登记，以便最终按父子归属过滤思考内容。
      visit(record(item.content)?.content_block, mode, `${path}/content/content_block`, depth + 1);
      return;
    }
    if (Array.isArray(item.patch_op)) {
      for (const raw of item.patch_op) {
        const op = record(raw);
        if (!op) continue;
        const rawPath = op.patch_path ?? op.path;
        const patchPath = Array.isArray(rawPath) ? `/${rawPath.join("/")}` : text(rawPath)?.replaceAll(".", "/");
        const patchValue = op.patch_value ?? op.value;
        if (typeof patchValue === "string" && patchPath?.endsWith("/text_block/text")) {
          const prefix = patchPath.slice(0, -"/content/text_block/text".length);
          const id = positions.get(prefix) ?? positions.get(`/${prefix}`);
          const block = id ? blocks.get(id) : undefined;
          if (!block) throw unknownResult();
          if (op.op === "replace" || op.patch_type === "replace" || op.operation === "replace") block.replacement = patchValue;
          else if (op.op === "append" || op.patch_type === "append" || op.operation === "append") append(block, patchValue, true);
          else throw unknownResult();
        } else visit(patchValue, mode, patchPath ?? path, depth + 1);
      }
    }
    const part = text(item.text);
    if (part !== undefined && !item.content_block && !item.message) {
      const id = text(item.id) ?? text(item.block_id) ?? active;
      const block = id ? blocks.get(id) : undefined;
      if (!block && part) throw unknownResult();
      if (block) append(block, part, mode === "delta");
      return;
    }
    for (const key of ["content", "content_block", "message", "delta", "data"]) {
      if (item[key] !== undefined) visit(item[key], mode, `${path}/${key}`, depth + 1);
    }
  }
  function answerBlock(block: Block): boolean {
    if (block.type !== 10000) return false;
    const visited = new Set<string>([block.id]);
    let parent = block.parent;
    while (parent) {
      if (visited.has(parent)) throw unknownResult();
      visited.add(parent);
      const owner = blocks.get(parent);
      if (!owner) throw unknownResult();
      if (owner.type === 10040) return false;
      parent = owner.parent;
    }
    return true;
  }
  return {
    consume(event: string, payload: RecordValue) {
      if (event === "SSE_ACK") {
        conversationId = text(record(payload.ack_client_meta)?.conversation_id) ?? conversationId;
        if (Array.isArray(payload.query_list)) for (const query of payload.query_list) {
          const id = text(record(query)?.question_id);
          if (id) questions.add(id);
        }
      } else if (event === "STREAM_MSG_NOTIFY") {
        if (!isUser(payload) && !isUser(record(payload.message) ?? {}) && !questions.has(String(record(payload.message)?.message_id ?? ""))) {
          visit(payload.content ?? payload.message, "notify");
        }
      } else if (event === "STREAM_CHUNK" || event === "CHUNK_DELTA") visit(payload, event === "CHUNK_DELTA" ? "delta" : "chunk");
      // FULL_MSG_NOTIFY 是问题回显，不作为答案来源。
    },
    result(): DoubaoTransportResponse {
      const output = [...blocks.values()].filter(answerBlock).map(merged).join("").trim();
      if (!output) throw unknownResult();
      return { output, external_ref: conversationId };
    },
  };
}

/** 即使替身 fetch/流不遵守 AbortSignal，也确保调用在期限内结束。 */
async function withinDeadline<T>(ms: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(unknownResult()); }, ms);
  });
  try { return await Promise.race([operation(controller.signal), timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}

async function consume(response: Response, signal: AbortSignal, questionId: string, questionBlock: string): Promise<DoubaoTransportResponse> {
  const reader = response.body?.getReader();
  if (!reader) throw unknownResult();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const collector = replyCollector(questionId, questionBlock);
  const events = new Set<string>();
  let buffer = "";
  let size = 0;
  let ended = false;
  function frame(raw: string): void {
    let event = "";
    let id = "";
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("id:")) id = line.slice(3).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length && event !== "SSE_REPLY_END") return;
    if (id && events.has(`${event}:${id}`)) return;
    if (id) events.add(`${event}:${id}`);
    const payload = data.length ? record(JSON.parse(data.join("\n"))) : {};
    if (!payload) throw unknownResult();
    for (const ext of [payload.ext, record(payload.content)?.ext, record(payload.message)?.ext]) {
      if (text(record(ext)?.expose_reason)?.includes("agent_err_real_answer")) {
        throw new DoubaoTransportError("failed", "豆包任务运行时不可用，请在豆包客户端切回普通对话");
      }
    }
    if (event === "STREAM_ERROR" || (payload.error_code !== undefined && Number(payload.error_code) !== 0) || (payload.code !== undefined && Number(payload.code) !== 0)) {
      throw new DoubaoTransportError("failed", "豆包拒绝了本次请求，请检查登录态或账号限制");
    }
    if (event === "SSE_REPLY_END") ended = true;
    else collector.consume(event, payload);
  }
  try {
    while (!ended) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw unknownResult();
      buffer += decoder.decode(value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        if (separator.index > MAX_FRAME) throw unknownResult();
        frame(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
        if (ended) break;
      }
      if (buffer.length > MAX_FRAME) throw unknownResult();
    }
    if (!ended || signal.aborted) throw unknownResult();
    return collector.result();
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export function createDoubaoHttpTransport({ credentials, fetch: fetchImpl = globalThis.fetch, timeoutMs = 120_000 }: {
  credentials: DoubaoCredentialPort;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): DoubaoTransport {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error("豆包请求超时配置无效");
  return {
    async chat(input) {
      if (input.model_item_key !== "0" || input.thinking !== false || input.tools.length !== 0 || !input.prompt.trim()) {
        throw new DoubaoTransportError("failed", "豆包仅支持快速模型的普通文本对话");
      }
      let snapshot: ReturnType<DoubaoCredentialPort["read"]>;
      try { snapshot = credentials.read(); }
      catch { throw new DoubaoTransportError("failed", "豆包登录凭证读取失败，请重新登录"); }
      if (!snapshot?.cookie || /[\r\n]/.test(snapshot.cookie)) throw new DoubaoTransportError("failed", "请先登录豆包");
      const credential = snapshot;
      const request = requestBody(input.prompt);
      try {
        return await withinDeadline(timeoutMs, async (signal) => {
          const response = await fetchImpl(endpoint("/chat/completion", credential.cookie), {
            method: "POST", headers: headers(credential.cookie), body: JSON.stringify(request.body), signal, redirect: "error",
          });
          if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw unknownResult(); }
          if (!response.ok || !trustedResponse(response)) {
            void response.body?.cancel().catch(() => {});
            if (response.status >= 400 && response.status < 500) throw new DoubaoTransportError("failed", "豆包拒绝了本次请求，请检查登录态或账号限制");
            throw unknownResult();
          }
          try { credentials.renew(response.headers, credential.cookie, credential.generation); }
          catch { /* 续期存储失败不改变已经发送的请求，下一次请求重新读取登录态。 */ }
          return consume(response, signal, request.questionId, request.blockId);
        });
      } catch (error) {
        if (error instanceof DoubaoTransportError) throw error;
        throw unknownResult();
      }
    },
  };
}

/** 无推理费用的账号探测；HTTP 200 本身不代表已登录。 */
export async function probeDoubaoAccount(cookie: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<"valid" | "expired" | "unavailable"> {
  if (!cookie || /[\r\n]/.test(cookie)) return "expired";
  try {
    return await withinDeadline(10_000, async (signal) => {
      const response = await fetchImpl(endpoint("/passport/account/info/v2/", cookie), { method: "GET", headers: headers(cookie), signal, redirect: "error" });
      if (response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => {}); return "expired"; }
      if (!response.ok || !trustedResponse(response) || signal.aborted) { void response.body?.cancel().catch(() => {}); return "unavailable"; }
      const reader = response.body?.getReader();
      if (!reader) return "unavailable";
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let body = "";
        let size = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 64 * 1024) return "unavailable";
          body += decoder.decode(next.value, { stream: true });
        }
        body += decoder.decode();
        const payload = record(JSON.parse(body));
        const data = record(payload?.data);
        if (!payload || !data || signal.aborted) return "unavailable";
        if (payload.message === "error" || [payload.error_code, payload.code, data.error_code].some((code) => code !== undefined && Number(code) !== 0)) return "expired";
        return typeof data.name === "string" && data.name.trim() ? "valid" : "expired";
      } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
    });
  } catch { return "unavailable"; }
}
