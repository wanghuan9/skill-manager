import { useMemo, useState } from "react";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import {
  buildOpenToolOptions,
  buildSupportedAiToolCards,
  sortToolCards,
  TOOL_SURFACE_LABELS,
} from "@/features/skills/utils/open-tools";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";

export function SettingsRoute() {
  const {
    appSettings,
    defaultOpenToolId,
    gitAccount,
    setMcpInstallActivation,
    setDefaultOpenToolId,
    setSkillInstallActivation,
    toolConfigs,
  } = useSkillWorkspace();
  const openToolOptions = useMemo(() => buildOpenToolOptions(toolConfigs), [toolConfigs]);
  const supportedToolCards = useMemo(
    () => sortToolCards(buildSupportedAiToolCards(toolConfigs), defaultOpenToolId),
    [defaultOpenToolId, toolConfigs],
  );
  const selectedDefaultToolId = openToolOptions.some((tool) => tool.id === defaultOpenToolId)
    ? defaultOpenToolId
    : openToolOptions[0]?.id ?? "";
  const [isToolStatusExpanded, setIsToolStatusExpanded] = useState(false);
  const toolStatusPanelClassName = `panel-card placeholder-panel settings-panel settings-panel--tool-status${
    isToolStatusExpanded ? "" : " is-clickable"
  }`;
  const generalSettingsItems = [
    {
      label: "配置文件存储路径",
      description: "应用设置会写入这个文件，便于你在本地查看或备份默认配置。",
      value: (
        <div className="settings-form-item__value settings-form-item__value--path">
          {appSettings.storagePath || "暂未检测到存储路径"}
        </div>
      ),
      readonly: true,
    },
    {
      label: "默认编辑器",
      description: "当你点击“打开目录”或需要在本地查看/对比改动时会使用该编辑器。",
      value: (
        <div className="settings-form-item__control">
          <select
            aria-label="默认编辑器"
            value={selectedDefaultToolId}
            onChange={(event) => setDefaultOpenToolId(event.target.value)}
            disabled={openToolOptions.length === 0}
          >
            {openToolOptions.length === 0 ? <option value="">未检测到可用编辑器</option> : null}
            {openToolOptions.map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.name}
              </option>
            ))}
          </select>
        </div>
      ),
    },
  ];
  const installBehaviorItems = [
    {
      label: "新增 Skill 默认启用",
      description: "控制从市场安装 skill 后，默认是立即应用到所有已安装工具，还是先保持未启用。",
      value: (
        <div className="settings-form-item__control">
          <select
            aria-label="新增 Skill 默认启用"
            value={appSettings.skillInstallActivation}
            onChange={(event) =>
              void setSkillInstallActivation(
                event.target.value as typeof appSettings.skillInstallActivation,
              )
            }
          >
            <option value="apply-all-tools">应用到所有工具</option>
            <option value="disable-all-tools">默认不启用</option>
          </select>
        </div>
      ),
    },
    {
      label: "新增 MCP 默认启用",
      description: "控制从市场安装 MCP 后，默认是同步到所有已支持应用，还是先仅保存不启用。",
      value: (
        <div className="settings-form-item__control">
          <select
            aria-label="新增 MCP 默认启用"
            value={appSettings.mcpInstallActivation}
            onChange={(event) =>
              void setMcpInstallActivation(event.target.value as typeof appSettings.mcpInstallActivation)
            }
          >
            <option value="apply-all-tools">应用到所有工具</option>
            <option value="disable-all-tools">默认不启用</option>
          </select>
        </div>
      ),
    },
  ];

  return (
    <div className="placeholder-grid settings-page">
      <section className="panel-card placeholder-panel settings-panel settings-panel--module">
        <div className="panel-header settings-panel__header">
          <span className="settings-panel__eyebrow">通用设置</span>
          <h2>应用偏好</h2>
          <p>把基础配置单独收拢，常用入口和本地文件信息会更容易找到。</p>
        </div>
        <div className="settings-form-list">
          {generalSettingsItems.map((item) => (
            <div
              key={item.label}
              className={`settings-form-item${item.readonly ? " settings-form-item--readonly" : ""}`}
            >
              <div className="settings-form-item__copy">
                <span className="settings-form-item__title">{item.label}</span>
                <p>{item.description}</p>
              </div>
              {item.value}
            </div>
          ))}
        </div>
      </section>

      <section className="panel-card placeholder-panel settings-panel settings-panel--module">
        <div className="panel-header settings-panel__header">
          <span className="settings-panel__eyebrow">安装行为</span>
          <h2>新增内容默认策略</h2>
          <p>把 Skill 和 MCP 的默认启用逻辑放在同一组，方便统一调整安装后的行为。</p>
        </div>
        <div className="settings-form-list">
          {installBehaviorItems.map((item) => (
            <div key={item.label} className="settings-form-item">
              <div className="settings-form-item__copy">
                <span className="settings-form-item__title">{item.label}</span>
                <p>{item.description}</p>
              </div>
              {item.value}
            </div>
          ))}
        </div>
      </section>

      <section
        className={toolStatusPanelClassName}
        onClick={() => {
          if (!isToolStatusExpanded) {
            setIsToolStatusExpanded(true);
          }
        }}
      >
        <button
          className="settings-section-toggle"
          type="button"
          onClick={() => setIsToolStatusExpanded((current) => !current)}
          aria-expanded={isToolStatusExpanded}
          aria-label="工具状态"
        >
          <span className="settings-section-toggle__copy">
            <span className="settings-section-toggle__title">工具状态</span>
            <span className="settings-section-hint">展示当前支持的软件列表以及各软件的安装状态。</span>
          </span>
          <span className="settings-section-toggle__chevron" aria-hidden="true">
            {isToolStatusExpanded ? "⌄" : "›"}
          </span>
        </button>
        {isToolStatusExpanded ? (
          <div className="settings-tool-grid">
            {supportedToolCards.map((tool) => {
              const logoUrl = getToolLogoUrl(tool.id);

              return (
                <article
                  key={tool.id}
                  className={`settings-tool-card${tool.isInstalled ? " is-installed" : ""}`}
                >
                  <span className="settings-tool-card__status-row">
                    <span
                      className={`settings-tool-card__status-badge${tool.isInstalled ? " is-installed" : ""}`}
                    >
                      {tool.statusLabel}
                    </span>
                  </span>
                  <span className="settings-tool-card__content-row">
                    <span className="settings-tool-card__logo" aria-hidden="true">
                      {logoUrl ? <img src={logoUrl} alt="" /> : <span>{tool.name.slice(0, 1)}</span>}
                    </span>
                    <span className="settings-tool-card__copy">
                      <span className="settings-tool-card__title">{tool.name}</span>
                      <span className="settings-tool-card__surface">
                        {tool.surfaceTypes.map((surface) => TOOL_SURFACE_LABELS[surface]).join(" / ")}
                      </span>
                    </span>
                  </span>
                </article>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className="panel-card placeholder-panel settings-panel settings-panel--git-account">
        <div className="panel-header settings-panel__header">
          <span className="settings-panel__eyebrow">仓库身份</span>
          <h2>Git 账号</h2>
          <p>这里保留仓库身份信息，后续再补更完整的仓库联动能力。</p>
        </div>
        <div className="settings-row settings-row--account">
          <span className="settings-row__title">{gitAccount?.provider ?? "未连接"}</span>
          <span>{gitAccount?.accountName ?? "请连接代码仓库账号"}</span>
          <span className="status-badge tone-info">{gitAccount?.statusLabel ?? "待连接"}</span>
        </div>
      </section>
    </div>
  );
}
