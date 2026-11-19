import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseWorkBuddyTranscript, textOf } from "./transcript.js";

export interface WorkBuddyBinding {
  conversationId: string;
  workerSessionId: string;
  projectKey: string;
  // 工作会话换绑后必须变化；不能用相同工作区或标题代替绑定版本。
  generation: string;
}
export interface WorkBuddyDeliveryProbe {
  confirm(text: string): Promise<{ external_ref: string } | null>;
}
export interface WorkBuddyDeliveryVerifier {
  capture(conversationId: string): Promise<WorkBuddyDeliveryProbe>;
}

const MAX_BYTES = 32 * 1024 * 1024;
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const segment = (value: string) => !!value && value !== "." && value !== ".." && !/[\\/:\x00]/.test(value);

// 实验工具：绑定解析器由测试环境注入；生产尚无已验证的权威映射 API。
export function createWorkBuddyDeliveryVerifier(options: {
  projectsDir: string;
  resolveBinding: (conversationId: string) => Promise<WorkBuddyBinding | null>;
}): WorkBuddyDeliveryVerifier {
  async function binding(id: string) {
    const value = await options.resolveBinding(id);
    if (!value || value.conversationId !== id || !value.generation ||
        !segment(value.workerSessionId) || !segment(value.projectKey))
      throw new Error("无法确认 WorkBuddy 对话与工作会话绑定");
    return { ...value };
  }
  const key = (value: WorkBuddyBinding) => JSON.stringify([
    value.conversationId, value.workerSessionId, value.projectKey, value.generation,
  ]);
  async function read(value: WorkBuddyBinding) {
    const root = await realpath(options.projectsDir);
    const file = await realpath(join(root, value.projectKey, `${value.workerSessionId}.jsonl`));
    const rel = relative(root, file);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
      throw new Error("工作会话文件超出指定目录");
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("工作会话文件不可用于回读");
      const data = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
        if (!bytesRead) throw new Error("工作会话读取期间被截短");
        offset += bytesRead;
      }
      return { data, identity: `${file}:${stat.dev}:${stat.ino}` };
    } finally { await handle.close(); }
  }
  return {
    async capture(conversationId) {
      const initial = await binding(conversationId);
      const before = await read(initial);
      if (before.data.length && before.data.at(-1) !== 10)
        throw new Error("工作会话尾行尚未写完，未建立发送基线");
      if (key(initial) !== key(await binding(conversationId)))
        throw new Error("建立基线时工作会话绑定已变化");
      const digest = hash(before.data);
      return {
        async confirm(text) {
          const current = await binding(conversationId);
          if (key(current) !== key(initial)) return null;
          const after = await read(current);
          if (after.identity !== before.identity || after.data.length < before.data.length ||
              hash(after.data.subarray(0, before.data.length)) !== digest ||
              key(current) !== key(await binding(conversationId))) return null;
          const appended = parseWorkBuddyTranscript(after.data.subarray(before.data.length).toString("utf8"));
          const matches = appended.entries.filter(entry => entry.role === "user" &&
            (textOf(entry.record.message) ?? textOf(entry.record.content)) === text);
          // 同文出现多次无法唯一归因，保留未知。
          if (matches.length !== 1) return null;
          return { external_ref: `${current.workerSessionId}:${matches[0].uuid}` };
        },
      };
    },
  };
}
