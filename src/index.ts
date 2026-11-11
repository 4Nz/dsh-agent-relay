import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { openRelayStore } from './storage/index.js'
import { registerTools } from './tools.js'

// workspaceRegistry 服务由 dsh-workspace 提供；这里声明最小类型，避免直接依赖该包。
declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: {
      create(path: string, title?: string): Promise<unknown>
    }
  }
}

export const inject = ['tools', 'workspaceRegistry']

const RELAY_GROUP_TITLE = 'Agent Relay'

export function apply(ctx: Context): void {
  const store = openRelayStore({ dataDir: join(resolveDshHome(), 'agent-relay') })
  ctx.effect(() => () => store.close())
  registerTools(ctx, store)
  void ensureRelayWorkspace(ctx)
  ctx.logger.info('[agent-relay] server plugin loaded')
}

// T6.3 通知会话分组的前置：在插件数据目录下建专用目录并注册为 workspace 项目，
// 通知投递新建的会话以该目录为 cwd 时会自动归入「Agent Relay」分组。
async function ensureRelayWorkspace(ctx: Context): Promise<void> {
  const relayDir = join(resolveDshHome(), 'agent-relay', 'conversations')
  try {
    await mkdir(relayDir, { recursive: true, mode: 0o700 })
    await ctx.workspaceRegistry.create(relayDir, RELAY_GROUP_TITLE)
    ctx.logger.info('[agent-relay] workspace group ready')
  } catch (error) {
    ctx.logger.warn('[agent-relay] workspace group init failed:', error)
  }
}
