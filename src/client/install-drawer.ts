import { createElement as h } from "react";
import { Drawer, fieldSelect } from "./drawer.js";
import { SETUP_ITEM, SETUP_LABEL, SETUP_OVERALL } from "./format.js";

export interface InstallDrawerContext {
  busy: boolean;
  installAgent: string;
  notifyCatalog: any[];
  optionalSkills: string[];
  installBusy: boolean;
  enableAgySandbox: boolean;
  onToggleSandbox: (enabled: boolean) => void;
  setupReport: any;
  probe: any;
  installError: string;
  setupMessage: string;
  onClose: () => void;
  onChangeAgent: (agent: string) => void;
  onToggleOptionalSkill: (name: string, checked: boolean) => void;
  onRunSetup: (endpoint: "setup_check" | "setup_install" | "setup_uninstall") => void;
  onStartProbe: () => void;
}

export function renderInstallDrawer(ctx: InstallDrawerContext) {
  const {
    busy,
    installAgent,
    notifyCatalog,
    optionalSkills,
    installBusy,
    enableAgySandbox,
    onToggleSandbox,
    setupReport,
    probe,
    installError,
    setupMessage,
    onClose,
    onChangeAgent,
    onToggleOptionalSkill,
    onRunSetup,
    onStartProbe,
  } = ctx;

  return h(
    Drawer,
    { title: "前置安装接入", onClose },
    fieldSelect(
      "Agent",
      installAgent,
      onChangeAgent,
      [
        ["claude", "Claude"],
        ["codex", "Codex"],
        ["agy", "Antigravity"],
      ],
    ),
    h(
      "fieldset",
      { disabled: installBusy },
      h("legend", null, "可选接力 Skill"),
      ...notifyCatalog.map(({ name, label, available, reason }) =>
        h(
          "label",
          { key: name, style: { display: "block" } },
          h("input", {
            type: "checkbox",
            disabled: !available,
            checked: optionalSkills.includes(name),
            onChange: (e: any) => onToggleOptionalSkill(name, e.target.checked),
          }),
          " ",
          `${name}：${label}${available ? "" : `（${reason}）`}`,
        ),
      ),
    ),
    setupReport?.agy_sandbox && h("div", null,
      h("label", { style: { display: "block" } },
        h("input", { type: "checkbox", checked: setupReport.agy_sandbox.status === "ok" || enableAgySandbox,
          disabled: installBusy || setupReport.agy_sandbox.status !== "missing",
          onChange: (e: any) => onToggleSandbox(e.target.checked) }), " 允许 agy CLI 在沙箱内自动执行终端命令"),
      h("p", { className: "muted small" }, "建议在需要主动创建 agy 后台会话时启用。此设置影响当前用户的所有 agy CLI 会话。"),
      setupReport.agy_sandbox.status !== "missing" && h("p", null, setupReport.agy_sandbox.message)),
    !setupReport && !installError && h("p", { className: "muted" }, "正在检查安装状态…"),
    setupReport &&
      h(
        "div",
        { className: "notice small" },
        h(
          "p",
          null,
          `${SETUP_OVERALL[setupReport.overall] ?? setupReport.overall}${setupReport.version ? ` · ${installAgent === "claude" ? "Claude Code" : installAgent === "agy" ? "Antigravity" : "Codex"} ${setupReport.version}` : ""}`,
        ),
      ),
    h("details", { key: installAgent, className: "setup-details" },
      h("summary", null, h("span", { className: "collapsed" }, "展开安装详情"), h("span", { className: "expanded" }, "收起安装详情")),
      h(
        "p",
        { className: "muted" },
        installAgent === "claude"
          ? "为 Claude 一次配好接入：通知 Skill 与 create-agent-notify（创建和安装 Agent 接力 Skill）默认必装；另含 channel（把消息送进开在终端里的会话）。已正常的项不会改动，修改前自动备份。"
          : installAgent === "agy"
            ? "为 Antigravity 一次配好接入（兼容 macOS 与 Windows）：通知 Skill 与 create-agent-notify 默认必装，写入 ~/.gemini/config/skills；同时写入桌面桥接 Sidecar 配置。已正常的项不会改动，修改前自动备份。"
            : "为 Codex 一次配好接入：通知 Skill 与 create-agent-notify（创建和安装 Agent 接力 Skill）默认必装。订阅可选择已有桌面或 CLI 会话，不需要 channel。已正常的项不会改动，修改前自动备份。",
      ),
      h(
        "p",
        { className: "muted small" },
        "安装到上方选中的 Agent，共用 dsh-notify 的本机凭证。DSH 插件需保持运行；消息直接投递，不经 DSH 模型处理。取消勾选不会卸载已有 Skill。",
      ),
      setupReport?.agy_sandbox && h("p", null, `${setupReport.agy_sandbox.message}。勾选后将更新 ${setupReport.agy_sandbox.path}，设置 enableTerminalSandbox=true 和 toolPermission=proceed-in-sandbox。`),
      setupReport && h(
          "ul",
          null,
          ...setupReport.items.map((item: any) =>
            h(
              "li",
              {
                key: item.key,
                className:
                  item.status === "ok"
                    ? ""
                    : item.status === "conflict" || item.status === "unavailable"
                      ? "error"
                      : "warn",
              },
              `${SETUP_ITEM[item.key] ?? notifyCatalog.find((entry) => entry.name === item.key)?.label ?? item.key}：${SETUP_LABEL[item.status] ?? item.status} · ${item.message}`,
              item.backup ? h("span", { className: "muted" }, `（备份：${item.backup}）`) : null,
            ),
          ),
        ),
        setupReport?.sessions &&
          h(
            "p",
            { className: "muted" },
            installAgent === "agy"
              ? `在线桌面桥接 Sidecar：${setupReport.sessions.online} 个`
              : `已启用 channel 的会话：${setupReport.sessions.online} 个`,
          ),
        setupReport?.next_steps?.length > 0 &&
          h(
            "div",
            null,
            h("p", null, "下一步："),
            h(
              "ol",
              null,
              ...setupReport.next_steps.map((step: string, i: number) =>
                h("li", { key: i }, step),
              ),
            ),
          ),
      ),
    installAgent === "claude" &&
      probe &&
      h(
        "div",
        { className: "notice small" },
        probe.status === "waiting"
          ? h(
              "div",
              null,
              h("p", null, "连通测试进行中，请按以下步骤操作："),
              h(
                "ol",
                null,
                ...probe.instructions.map((step: string, i: number) =>
                  h("li", { key: i }, step),
                ),
              ),
            )
          : h("p", { className: probe.status === "acked" ? "" : "error" }, probe.message),
      ),
    setupMessage && h("p", { role: "status", className: "good" }, setupMessage),
    installError && h("p", { role: "alert", className: "error" }, installError),
    h(
      "footer",
      { className: "setup-actions" },
      h("button", { disabled: installBusy, onClick: () => onRunSetup("setup_check") }, "检查安装状态"),
      installAgent === "claude" &&
        h(
          "button",
          {
            disabled: installBusy || probe?.status === "waiting" || setupReport?.overall === "unavailable",
            onClick: onStartProbe,
          },
          probe?.status === "waiting" ? "等待新会话…" : "连通测试",
        ),
      installAgent === "claude" &&
        h(
          "button",
          {
            disabled: installBusy,
            onClick: () => {
              if (
                window.confirm(
                  "将删除 channel 配置（MCP 登记、规则、claude 函数、channel 凭证），通知 Skill 保留。继续？",
                )
              )
                onRunSetup("setup_uninstall");
            },
          },
          "卸载 channel",
        ),
      h(
        "button",
        {
          className: "primary",
          disabled: busy || installBusy || setupReport?.overall === "unavailable",
          onClick: () => onRunSetup("setup_install"),
        },
        installBusy
          ? "正在处理…"
          : setupReport?.overall === "ok"
            ? "重新检查并修复"
            : "安装 / 修复",
      ),
    ),
  );
}
