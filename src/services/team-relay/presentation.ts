const agentNames: Record<string, string> = { doubao: "豆包", codex: "Codex", claude: "Claude" };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export const teamTaskOutput = {
  schema: { type: "object", additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }],
  presentationMeta(_args: unknown, value: unknown) {
    const run = record(value);
    const tasks: unknown[] = Array.isArray(run?.tasks) ? run.tasks : [];
    return {
      self: run?.self === true,
      tasks: tasks.flatMap(item => {
        const task = record(item);
        return typeof task?.target_id === "string" && typeof task.status === "string"
          ? [{ target: task.target_id, status: task.status }]
          : [];
      }),
    };
  },
};

export function presentTeamTask(result: { isError?: boolean; meta?: unknown }, action: "dispatch" | "status") {
  if (result.isError) {
    return { card: "generic" as const, title: action === "dispatch" ? "TeamRelay 派发失败" : "TeamRelay 状态查询失败" };
  }
  const meta = record(result.meta);
  if (!Array.isArray(meta?.tasks)) return;
  const tasks: unknown[] = meta.tasks;
  const labels = tasks.flatMap(item => {
    const task = record(item);
    if (typeof task?.target !== "string") return [];
    const name = Object.hasOwn(agentNames, task.target) ? agentNames[task.target] : task.target;
    switch (task.status) {
      case "succeeded": return [`${name}已返回结果`];
      case "failed": return [`${name}执行失败`];
      case "unknown": return [`${name}结果待确认`];
      case "cancelled": return [`${name}任务已取消`];
      case "queued": return [`${name}任务已排队`];
      default: return [action === "dispatch" ? `已派发给${name}` : `等待${name}返回结果`];
    }
  });
  if (meta.self) labels.push("由 DSH 执行");
  if (!labels.length) return;
  return { card: "generic" as const, title: labels.join(" · "), content: [] };
}
