import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  ctx.logger.info('[agent-relay] server plugin loaded')
}
