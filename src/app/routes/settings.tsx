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
    defaultOpenToolId,
    gitAccount,
    setDefaultOpenToolId,
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

  return (
    <div className="placeholder-grid settings-page">
      <section className="panel-card placeholder-panel settings-panel settings-panel--default-tool">
        <div className="settings-form-list">
          <div className="settings-form-item">
            <div className="settings-form-item__copy">
              <strong>默认编辑器</strong>
              <p>当你点击“打开目录”或需要在本地查看/对比改动时会使用该编辑器。</p>
            </div>
            <div className="settings-form-item__control">
              <select
                aria-label="默认编辑器"
                value={selectedDefaultToolId}
                onChange={(event) => setDefaultOpenToolId(event.target.value)}
                disabled={openToolOptions.length === 0}
              >
                {openToolOptions.length === 0 ? (
                  <option value="">未检测到可用编辑器</option>
                ) : null}
                {openToolOptions.map((tool) => (
                  <option key={tool.id} value={tool.id}>
                    {tool.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
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
                  <span className="settings-tool-card__logo" aria-hidden="true">
                    {logoUrl ? <img src={logoUrl} alt="" /> : <span>{tool.name.slice(0, 1)}</span>}
                  </span>
                  <span className="settings-tool-card__copy">
                    <strong>{tool.name}</strong>
                    <span className={`settings-tool-card__status${tool.isInstalled ? " is-installed" : ""}`}>
                      {tool.statusLabel}
                    </span>
                    <span className="settings-tool-card__surface">
                      {tool.surfaceTypes.map((surface) => TOOL_SURFACE_LABELS[surface]).join(" / ")}
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
          <h2>Git 账号</h2>
          <p>这里保留仓库身份信息，后续再补更完整的仓库联动能力。</p>
        </div>
        <div className="settings-row settings-row--account">
          <strong>{gitAccount?.provider ?? "未连接"}</strong>
          <span>{gitAccount?.accountName ?? "请连接代码仓库账号"}</span>
          <span className="status-badge tone-info">{gitAccount?.statusLabel ?? "待连接"}</span>
        </div>
      </section>
    </div>
  );
}
