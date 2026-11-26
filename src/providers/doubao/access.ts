import type { DoubaoCredentialStore } from "./credentials.js";

export type DoubaoAccessState = "signed_out" | "logging_in" | "saved" | "connected" | "expired" | "unavailable";
export interface DoubaoAccessStatus { state: DoubaoAccessState; message: string }
export interface DoubaoLogin { capture(signal: AbortSignal): Promise<string> }

const messages: Record<DoubaoAccessState, string> = {
  signed_out: "尚未登录豆包",
  logging_in: "请在打开的专用浏览器窗口中完成豆包登录（五分钟内）",
  saved: "已保存豆包登录凭证，尚未验证连接",
  connected: "豆包连接正常",
  expired: "豆包登录已失效，请重新登录",
  unavailable: "豆包连接暂不可用，请重试",
};

export function createDoubaoAccess({ store, login, probe }: {
  store: DoubaoCredentialStore;
  login: DoubaoLogin;
  probe?: (cookie: string) => Promise<"valid" | "expired" | "unavailable">;
}) {
  let generation = 0;
  let controller: AbortController | undefined;
  let disposed = false;
  function localState(): DoubaoAccessState {
    try { return store.read() ? "saved" : "signed_out"; }
    catch { return "unavailable"; }
  }
  let state: DoubaoAccessState = localState();
  let message = messages[state];
  function status(): DoubaoAccessStatus { return { state, message }; }
  function set(next: DoubaoAccessState, detail = messages[next]): DoubaoAccessStatus {
    state = next;
    message = detail;
    return status();
  }
  function invalidate(): void { generation++; controller?.abort(); controller = undefined; }
  return {
    status,
    start(): DoubaoAccessStatus {
      if (disposed || controller) return status();
      invalidate();
      const run = generation;
      const current = new AbortController();
      controller = current;
      set("logging_in");
      void Promise.resolve().then(() => {
        if (current.signal.aborted) throw new Error();
        return login.capture(current.signal);
      }).then((cookie) => {
        if (disposed || generation !== run || current.signal.aborted) return;
        store.save(cookie);
        controller = undefined;
        set("saved");
      }).catch(() => {
        if (disposed || generation !== run) return;
        controller = undefined;
        set("unavailable", "豆包登录未完成，请确认浏览器可用后重试");
      });
      return status();
    },
    async check(): Promise<DoubaoAccessStatus> {
      if (disposed || controller) return status();
      const run = ++generation;
      try {
        const snapshot = store.read();
        if (!snapshot) return set("signed_out");
        if (!probe) return set("saved");
        const result = await probe(snapshot.cookie);
        if (disposed || generation !== run) return status();
        const latest = store.read();
        if (!latest || latest.generation !== snapshot.generation) return status();
        return set(result === "valid" ? "connected" : result);
      } catch {
        if (disposed || generation !== run) return status();
        return set("unavailable");
      }
    },
    cancel(): DoubaoAccessStatus {
      invalidate();
      return set(localState());
    },
    logout(): DoubaoAccessStatus {
      invalidate();
      try { store.clear(); return set("signed_out"); }
      catch { return set("unavailable", "豆包登录凭证清理失败，请重试退出"); }
    },
    dispose(): void { disposed = true; invalidate(); },
  };
}
