import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export interface RunOptions {
  cwd?: string;
  // 写入 stdin 的内容；不传时 stdin 为空，避免 CLI 等待输入。
  input?: string;
  // 超时后终止进程。不传则一直等待进程退出。
  timeoutMs?: number;
}
export type ClaudeRunner = (
  args: string[],
  options?: RunOptions,
) => Promise<RunResult>;

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const KILL_GRACE_MS = 1000;
const SETTLE_GRACE_MS = 1000;

// 不经过 shell，参数原样作为 argv 传入。
export function createRunner(bin = "claude"): ClaudeRunner {
  return (args, { cwd, input, timeoutMs } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        timedOut = false;
      let settled = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const clearTimers = () => {
        for (const t of timers) clearTimeout(t);
        timers.length = 0;
      };
      // 只结算一次：close 与强制收尾竞争时以先到为准。
      const settle = (result: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve(result);
      };
      if (timeoutMs !== undefined) {
        // 先 TERM，1 秒宽限后 KILL 自己启动的 child；KILL 后最多再等 1 秒收尾。
        timers.push(
          setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            timers.push(
              setTimeout(() => {
                child.kill("SIGKILL");
                timers.push(
                  setTimeout(() => {
                    // 不依赖继承管道关闭：关闭自己持有的 stdio 后强制结算。
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    child.stdin?.destroy();
                    settle({ code: null, stdout, stderr, timedOut: true });
                  }, SETTLE_GRACE_MS),
                );
              }, KILL_GRACE_MS),
            );
          }, timeoutMs),
        );
      }
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
        if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
      });
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(error);
      });
      child.once("close", (code) => {
        settle({ code, stdout, stderr, timedOut });
      });
      if (input !== undefined) child.stdin!.end(input);
    });
}
