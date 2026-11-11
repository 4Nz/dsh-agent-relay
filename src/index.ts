import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { openRelayStore } from './storage/index.js'
import { registerTools } from './tools.js'

export const inject = ['tools']

export function apply(ctx: Context): void {
  const store = openRelayStore({ dataDir: join(resolveDshHome(), 'agent-relay') })
  ctx.effect(() => () => store.close())
  registerTools(ctx, store)
  ctx.logger.info('[agent-relay] server plugin loaded')
}
