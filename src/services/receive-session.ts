import { mkdir } from 'node:fs/promises';

export const RELAY_GROUP_TITLE = 'Agent 通知';
export interface ReceiveSessionHost {
  workspaceRegistry: { create(path: string, title?: string): Promise<{ id: string }> };
  sessionController: { create(request: { workspaceId: string }): Promise<{ sessionId: string }> };
}

// cwd 只确定会话目录；宿主要求显式 workspaceId 才会登记侧栏分组成员。
export async function createRelayReceiveSession(host: ReceiveSessionHost, relayDir: string): Promise<string> {
  await mkdir(relayDir, { recursive: true, mode: 0o700 });
  const workspace = await host.workspaceRegistry.create(relayDir, RELAY_GROUP_TITLE);
  const { sessionId } = await host.sessionController.create({ workspaceId: workspace.id });
  return sessionId;
}
