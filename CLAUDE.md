# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

项目说明、协作约定和第一版边界统一维护在 `AGENTS.md`，此处直接引用，避免两份文档漂移：

@AGENTS.md

## 补充说明

- 当前没有构建、lint 或测试命令。引入代码后，把实际命令补充到 `AGENTS.md`，不要在这里另写一份。
- Worktree 布局：Claude 任务放在仓库内 `.worktrees/<任务名>`（如 `.worktrees/claude-session-relay`），Codex 的 worktree 在 `~/.codex/worktrees/` 下。`git worktree list` 可查看全部。
- 任务顺序以 `docs/tasks.md` 末尾的「依赖与顺序」和里程碑 M1～M4 为准：T0 确认 DSH 接入点后才能做 T1 存储，T2 服务层是 T3 工具、T4 接口、T5 Adapter 的共同依赖。
