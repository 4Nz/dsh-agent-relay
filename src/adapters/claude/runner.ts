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
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
            }, timeoutMs);
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
        if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
      });
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
      });
      child.once("error", (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
      if (input !== undefined) child.stdin!.end(input);
    });
}
