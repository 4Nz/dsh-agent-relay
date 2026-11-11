import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { openRelayStore } from './storage/index.js'

type RelayStore = ReturnType<typeof openRelayStore>

export function registerTools(ctx: Context, store: RelayStore): void {
  ctx.tools.register(defineTool({
    name: 'relay_ping',
    description:
      '检查 DSH Agent Relay 插件与 SQLite 存储是否就绪，返回一次订阅列表探活的采样条数（非总数）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const { items } = store.subscriptions.list({ limit: 1 })
      return { ok: true, storage: 'ready', sampleCount: items.length }
    },
  }))
}
