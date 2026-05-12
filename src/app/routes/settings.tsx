import { useMemo, useState } from "react";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import {
  buildOpenToolOptions,
  buildSupportedAiToolCards,
  sortToolCards,
  TOOL_SURFACE_LABELS,
} from "@/features/skills/utils/open-tools";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";

function FolderOpenIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M2.75 5.25A1.5 1.5 0 0 1 4.25 3.75h3.1l1.2 1.35h4.95A1.5 1.5 0 0 1 15 6.6v1.15"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <path
        d="M3.15 7.75h11.7l-.7 4.7a1.5 1.5 0 0 1-1.48 1.28H4.98a1.5 1.5 0 0 1-1.48-1.28l-.35-2.35"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getDirectoryPath(filePath: string) {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) {
    return "";
  }

  const lastSeparatorIndex = normalizedPath.lastIndexOf("/");
  if (lastSeparatorIndex <= 0) {
    return normalizedPath;
  }

  return normalizedPath.slice(0, lastSeparatorIndex);
}

export function SettingsRoute() {
  const {
    appSettings,
    defaultOpenToolId,
    openPathInFinder,
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
  const [isOpeningStoragePath, setIsOpeningStoragePath] = useState(false);
  const toolStatusPanelClassName = `panel-card placeholder-panel settings-panel settings-panel--tool-status${
    isToolStatusExpanded ? "" : " is-clickable"
  }`;
  const storageDirectoryPath = getDirectoryPath(appSettings.storagePath);

  async function handleOpenStoragePath() {
    if (!storageDirectoryPath || isOpeningStoragePath) {
      return;
    }

    setIsOpeningStoragePath(true);
    try {
      await openPathInFinder(storageDirectoryPath);
    } finally {
      setIsOpeningStoragePath(false);
    }
  }

  const generalSettingsItems = [
    {
      label: "配置文件存储目录",
      description: "应用设置会写入这个目录，便于你在本地查看或备份默认配置。",
      value: (
        <div className="settings-form-item__path-group">
          <div className="settings-form-item__value settings-form-item__value--path">
            {storageDirectoryPath || "暂未检测到存储目录"}
          </div>
          <button
            className="secondary-button secondary-button--compact settings-open-button"
            type="button"
            onClick={() => void handleOpenStoragePath()}
            disabled={!storageDirectoryPath || isOpeningStoragePath}
          >
            <FolderOpenIcon />
            打开
          </button>
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
      description: "开启后会在安装 skill 时默认应用到所有已安装工具；关闭后先保持未启用。",
      value: (
        <div className="settings-toggle-control">
          <span className="settings-toggle-control__state">
            {appSettings.skillInstallActivation === "apply-all-tools" ? "已开启" : "已关闭"}
          </span>
          <button
            className={`switch-button${appSettings.skillInstallActivation === "apply-all-tools" ? " is-enabled" : ""}`}
            type="button"
            onClick={() =>
              void setSkillInstallActivation(
                appSettings.skillInstallActivation === "apply-all-tools"
                  ? "disable-all-tools"
                  : "apply-all-tools",
              )
            }
            aria-pressed={appSettings.skillInstallActivation === "apply-all-tools"}
            aria-label="新增 Skill 默认启用"
          >
            <span className="switch-button__thumb" />
          </button>
        </div>
      ),
    },
    {
      label: "新增 MCP 默认启用",
      description: "开启后会在安装 MCP 时默认同步到所有已支持应用；关闭后先仅保存不启用。",
      value: (
        <div className="settings-toggle-control">
          <span className="settings-toggle-control__state">
            {appSettings.mcpInstallActivation === "apply-all-tools" ? "已开启" : "已关闭"}
          </span>
          <button
            className={`switch-button${appSettings.mcpInstallActivation === "apply-all-tools" ? " is-enabled" : ""}`}
            type="button"
            onClick={() =>
              void setMcpInstallActivation(
                appSettings.mcpInstallActivation === "apply-all-tools"
                  ? "disable-all-tools"
                  : "apply-all-tools",
              )
            }
            aria-pressed={appSettings.mcpInstallActivation === "apply-all-tools"}
            aria-label="新增 MCP 默认启用"
          >
            <span className="switch-button__thumb" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="placeholder-grid settings-page">
      <section className="settings-group">
        <div className="settings-group__heading">
          <span className="settings-group__bar" aria-hidden="true" />
          <h2 className="settings-group__title">应用偏好</h2>
        </div>
        <div className="panel-card placeholder-panel settings-panel settings-panel--module">
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
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group__heading">
          <span className="settings-group__bar" aria-hidden="true" />
          <h2 className="settings-group__title">安装行为</h2>
        </div>
        <div className="panel-card placeholder-panel settings-panel settings-panel--module">
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
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group__heading">
          <span className="settings-group__bar" aria-hidden="true" />
          <h2 className="settings-group__title">工具状态</h2>
        </div>
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
      </section>

      <section className="settings-group">
        <div className="settings-group__heading">
          <span className="settings-group__bar" aria-hidden="true" />
          <h2 className="settings-group__title">GitHub 账号</h2>
        </div>
        <div className="panel-card placeholder-panel settings-panel settings-panel--git-account">
          <div className="settings-row settings-row--account">
            <span className="settings-row__title">GitHub</span>
            <span>账号信息占位</span>
            <span className="status-badge tone-info">暂不展示</span>
          </div>
        </div>
      </section>
    </div>
  );
}
