import { createElement } from "react";
import { AgentRelayPanel } from "./ui/panel.js";

export const inject = ["slots"];

const PANEL_ID = "agent-relay";

// 侧边栏图标：一个最小可点条目。
function AgentRelayIcon(_props: { size: number }): unknown {
  return createElement(
    "span",
    {
      "data-dsh-plugin": "dsh-agent-relay",
      "data-dsh-part": "sidebar-icon",
      style: { display: "inline-flex", alignItems: "center" },
    },
    "🔗",
  );
}

// 前端 Cordis 入口。ctx 用最小结构类型，避免依赖 slots 的类型包。
interface RelayClientContext {
  slots: {
    inject(name: string, callback: () => () => void): () => void;
    register(options: unknown, component: unknown): () => void;
  };
}

export function apply(ctx: RelayClientContext): void {
  ctx.slots.inject("main", () =>
    ctx.slots.inject("sidebar.panellist", () => {
      const stopMain = ctx.slots.register(
        {
          name: "main",
          key: PANEL_ID,
          inject: () => ({}),
        },
        AgentRelayPanel,
      );
      try {
        const stopIcon = ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 50,
            label: () => "Agent Relay",
          },
          AgentRelayIcon,
        );
        return () => {
          stopIcon();
          stopMain();
        };
      } catch (error) {
        stopMain();
        throw error;
      }
    }),
  );
}
