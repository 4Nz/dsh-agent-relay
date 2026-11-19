import { mkdir } from 'node:fs/promises';
import type { Agent } from '../storage/types.js';

export const RELAY_GROUP_TITLE = 'Agent 通知';
// 接收会话必须显式固定标准预设，不能继承用户在预设选择器里选的默认预设（如 claude）。
// Claude（dsh-claude）只在存在直接人工输入（source.kind === "user"）时执行，
// 而 Relay 的通知以 source.kind === "agent-relay" 注入，会被它判为无人工输入而失败。
export const RELAY_SESSION_PRESET = 'standard';

export interface ReceiveSessionContext {
  agent: Agent;
  externalSessionId: string;
  externalSessionTitle?: string | null;
  type: 'poll' | 'push';
}

export interface ReceiveSessionHost {
  workspaceRegistry: { create(path: string, title?: string): Promise<{ id: string }> };
  sessionController: {
    create(request: { workspaceId: string; agentPreset?: string }): Promise<{ sessionId: string }>;
    rename(request: { sessionId: string; title: string }): Promise<unknown>;
  };
}

const AGENT_LABELS: Record<Agent, string> = { claude: 'Claude', codex: 'Codex', workbuddy: 'WorkBuddy' };

// 接收会话默认命名：<Agent名>-<外部会话标题或ID>-<通知|订阅>，便于在 DSH 会话列表里区分。
export function receiveSessionTitle(context: ReceiveSessionContext): string {
  const sessionLabel = context.externalSessionTitle?.trim() || context.externalSessionId;
  const kind = context.type === 'push' ? '通知' : '订阅';
  return `${AGENT_LABELS[context.agent]}-${sessionLabel}-${kind}`;
}

// cwd 只确定会话目录；宿主要求显式 workspaceId 才会登记侧栏分组成员。
export async function createRelayReceiveSession(
  host: ReceiveSessionHost,
  relayDir: string,
  context?: ReceiveSessionContext,
): Promise<string> {
  await mkdir(relayDir, { recursive: true, mode: 0o700 });
  const workspace = await host.workspaceRegistry.create(relayDir, RELAY_GROUP_TITLE);
  const { sessionId } = await host.sessionController.create({
    workspaceId: workspace.id,
    agentPreset: RELAY_SESSION_PRESET,
  });
  if (context) {
    try {
      await host.sessionController.rename({
        sessionId,
        title: receiveSessionTitle(context),
      });
    } catch {
      // 命名失败不阻塞会话创建与后续通知投递；标题仍可后续手动命名。
    }
  }
  return sessionId;
}
