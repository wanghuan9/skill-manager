import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchInstalledPlugins,
  fetchPluginComponentPreview,
  openExternalLink,
  setPluginEnabled,
} from "@/features/skills/api/skill-client";
import {
  SkillFileContentSurface,
  SkillFileViewModeToggle,
  type SkillFileViewMode,
} from "@/features/skills/components/SkillFileDialog";
import {
  ToolListRow,
  useSingleExpandedRow,
} from "@/features/skills/components/ToolListRows";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";
import type {
  PluginAssetType,
  PluginComponentPreview,
  PluginComponentSummary,
  PluginHostTool,
  PluginSummary,
} from "@/features/skills/state/skill-store";

type PluginFilter = "all" | "enabled" | "disabled" | "error";
type PluginFilterOption = {
  value: PluginFilter;
  label: string;
};
type ComponentSection = {
  key: PluginAssetType;
  title: string;
  summaryLabel: string;
};
type PreviewState = {
  plugin: PluginSummary;
  component: PluginComponentSummary;
  preview: PluginComponentPreview | null;
  isLoading: boolean;
  errorMessage: string;
};

const pluginHostTabs: { key: PluginHostTool; label: string }[] = [
  { key: "claude-code", label: "Claude Code" },
  { key: "codex", label: "Codex" },
  { key: "cursor", label: "Cursor" },
];
const componentSections: ComponentSection[] = [
  { key: "mcp", title: "MCPs", summaryLabel: "mcp" },
  { key: "skill", title: "Skills", summaryLabel: "skill" },
  { key: "subagent", title: "Subagents", summaryLabel: "agents" },
  { key: "command", title: "Commands", summaryLabel: "command" },
  { key: "rule", title: "Rules", summaryLabel: "rule" },
  { key: "hook", title: "Hooks", summaryLabel: "hook" },
];
const primaryComponentSummaryTypes: PluginAssetType[] = [
  "subagent",
  "skill",
  "mcp",
  "rule",
  "hook",
  "command",
];
const maxVisibleComponentsPerSection = 5;
const pluginEnabledOrder: Record<PluginSummary["enabledState"], number> = {
  enabled: 0,
  disabled: 1,
  unknown: 2,
};
const pluginFilterOptions: PluginFilterOption[] = [
  { value: "all", label: "全部" },
  { value: "enabled", label: "已启用" },
  { value: "disabled", label: "未启用" },
  { value: "error", label: "异常" },
];

function RefreshIcon({ isSpinning = false }: { isSpinning?: boolean }) {
  return (
    <svg className={isSpinning ? "skills-toolbar-button__svg is-spinning" : "skills-toolbar-button__svg"} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M16.2 9.1a6.2 6.2 0 0 0-10.7-3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.7 3.9v3.7h3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.8 10.9a6.2 6.2 0 0 0 10.7 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.3 16.1v-3.7h-3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 5.5h12l-4.7 5.1v3.9l-2.6 1v-4.9L4 5.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function PluginPowerIcon({ isSpinning = false }: { isSpinning?: boolean }) {
  return (
    <svg
      className={isSpinning ? "plugins-page__power-icon is-spinning" : "plugins-page__power-icon"}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M10 3.5v6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M6.35 6.85a5.25 5.25 0 1 0 7.3 0"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function getHostLabel(hostTool: PluginHostTool) {
  return pluginHostTabs.find((tab) => tab.key === hostTool)?.label ?? hostTool;
}

function getPluginInstanceKey(plugin: PluginSummary) {
  const instancePath = plugin.rootPath || plugin.manifestPath || plugin.id;
  return `${plugin.hostTool}::${instancePath}::${plugin.id}`;
}

function PluginHostLogo({ hostTool, label }: { hostTool: PluginHostTool; label: string }) {
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoUrl = getToolLogoUrl(hostTool);
  const fallbackLabel = label.slice(0, 1).toUpperCase();

  if (!logoUrl || logoLoadFailed) {
    return (
      <span className="plugins-page__host-tab-logo" aria-hidden="true">
        {fallbackLabel}
      </span>
    );
  }

  return (
    <span className="plugins-page__host-tab-logo" aria-hidden="true">
      <img
        src={logoUrl}
        alt=""
        loading="lazy"
        onError={() => setLogoLoadFailed(true)}
      />
    </span>
  );
}

function comparePlugins(left: PluginSummary, right: PluginSummary) {
  return (
    pluginEnabledOrder[left.enabledState] -
      pluginEnabledOrder[right.enabledState] ||
    left.name.localeCompare(right.name, "zh-CN", {
      sensitivity: "base",
      numeric: true,
    }) ||
    left.rootPath.localeCompare(right.rootPath, "zh-CN", {
      sensitivity: "base",
      numeric: true,
    })
  );
}

function getPluginEnabledBadge(plugin: PluginSummary) {
  if (plugin.enabledState === "enabled") {
    return "已启用";
  }
  if (plugin.enabledState === "disabled") {
    return "未启用";
  }
  return "状态未知";
}

function canTogglePlugin(plugin: PluginSummary) {
  return plugin.hostTool === "codex" || plugin.hostTool === "claude-code";
}

function getPluginToggleActionLabel(plugin: PluginSummary, isPending: boolean) {
  if (!canTogglePlugin(plugin)) {
    return `${plugin.name} 暂不支持在 SkillDock 内切换`;
  }
  if (isPending) {
    return plugin.enabledState === "enabled" ? `正在关闭 ${plugin.name} 插件` : `正在开启 ${plugin.name} 插件`;
  }

  return plugin.enabledState === "enabled" ? `关闭 ${plugin.name} 插件` : `开启 ${plugin.name} 插件`;
}

function getPluginToggleButtonClassName(plugin: PluginSummary) {
  const stateClassName =
    plugin.enabledState === "enabled"
      ? "is-enabled"
      : plugin.enabledState === "disabled"
        ? "is-disabled"
        : "is-unknown";

  return `skill-card__icon-button plugins-page__toggle-icon-button ${stateClassName}`;
}

function getPluginSourceLabel(plugin: PluginSummary) {
  if (plugin.sourceLabel.trim()) {
    return plugin.sourceLabel.trim();
  }
  if (plugin.sourceUrl.trim()) {
    return plugin.sourceUrl.trim();
  }
  if (plugin.sourceType === "git") {
    return "Git 仓库";
  }
  if (plugin.sourceType === "marketplace") {
    return "Marketplace";
  }
  return "本地目录";
}

function getPluginSourceTypeLabel(plugin: PluginSummary) {
  return plugin.sourceType === "local" ? "本地" : "Git 仓库";
}

function getPluginSourceValue(plugin: PluginSummary) {
  const sourceUrl = plugin.sourceUrl.trim();
  if (sourceUrl) {
    return sourceUrl;
  }

  if (plugin.sourceType === "local") {
    return plugin.rootPath;
  }

  return getPluginSourceLabel(plugin);
}

function getPluginDescription(plugin: PluginSummary) {
  return plugin.description.trim() || "暂无简介";
}

function getPluginSubtitle(plugin: PluginSummary) {
  return getPluginDescription(plugin);
}

function getComponentDescription(component: PluginComponentSummary) {
  const description = component.description.trim();
  if (description) {
    return description;
  }
  if (component.assetType === "skill") {
    return "Skill 组件";
  }
  if (component.assetType === "subagent") {
    return "Subagent 组件";
  }
  if (component.assetType === "mcp") {
    return "MCP 配置";
  }
  if (component.assetType === "rule") {
    return "Rule 组件";
  }
  if (component.assetType === "hook") {
    return "Hook 组件";
  }
  return "Command 组件";
}

function getComponentIcon(component: PluginComponentSummary) {
  if (component.assetType === "mcp") {
    return "⌁";
  }
  if (component.assetType === "skill") {
    return "▱";
  }
  if (component.assetType === "subagent") {
    return "⌘";
  }
  if (component.assetType === "rule") {
    return "▤";
  }
  if (component.assetType === "hook") {
    return "↳";
  }
  return "›";
}

function getComponentsByType(
  plugin: PluginSummary,
  assetType: PluginAssetType,
) {
  return plugin.components.filter((component) => component.assetType === assetType);
}

function getComponentSection(assetType: PluginAssetType) {
  return componentSections.find((section) => section.key === assetType);
}

function getPluginComponentSummaryLabels(plugin: PluginSummary) {
  const summaryLabels = primaryComponentSummaryTypes
    .map((assetType) => {
      const count = getComponentsByType(plugin, assetType).length;
      const section = getComponentSection(assetType);
      if (count === 0 || !section) {
        return "";
      }

      return `${count} ${section.summaryLabel}`;
    })
    .filter(Boolean);

  if (summaryLabels.length > 0) {
    return summaryLabels;
  }

  return plugin.components.length > 0 ? [`${plugin.components.length} components`] : [];
}

function getPluginPreviewPath(
  preview: PluginComponentPreview | null,
  component: PluginComponentSummary,
) {
  const previewPath = preview?.path.trim();
  if (previewPath) {
    return previewPath;
  }

  if (component.assetType === "skill") {
    return `${component.id.replace(/\/+$/, "")}/SKILL.md`;
  }

  return component.id;
}

function getPluginPreviewItemLabel(path: string, fallbackLabel: string) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return fallbackLabel;
  }

  const fileName = segments.at(-1) ?? "";
  if (
    fileName === "SKILL.md"
    || fileName === "README.md"
    || fileName === "README.mdx"
  ) {
    return segments.at(-2) ?? fallbackLabel;
  }

  return fileName;
}

function isHttpUrl(value: string) {
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

export function PluginsRoute() {
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [actionErrorMessage, setActionErrorMessage] = useState("");
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [previewViewMode, setPreviewViewMode] = useState<SkillFileViewMode>("preview");
  const [isPreviewDirty, setIsPreviewDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [activeHost, setActiveHost] = useState<PluginHostTool>("claude-code");
  const [pendingPluginIds, setPendingPluginIds] = useState<Set<string>>(
    () => new Set(),
  );
  const pendingPluginIdsRef = useRef(new Set<string>());
  const [toolbarContainer, setToolbarContainer] = useState<HTMLElement | null>(
    null,
  );
  const { expandedId, handleExpandedChange } = useSingleExpandedRow();

  async function loadPlugins(options?: { silent?: boolean }) {
    const isSilent = options?.silent ?? false;
    if (isSilent) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const nextPlugins = await fetchInstalledPlugins();
      setPlugins(nextPlugins);
      setErrorMessage("");
    } catch (error) {
      console.warn("Failed to load installed plugins", error);
      setErrorMessage("扫描本地插件失败，请稍后重试。");
    } finally {
      if (isSilent) {
        setIsRefreshing(false);
      } else {
        setIsLoading(false);
      }
    }
  }

  useEffect(() => {
    let shouldIgnore = false;

    void (async () => {
      try {
        const nextPlugins = await fetchInstalledPlugins();
        if (!shouldIgnore) {
          setPlugins(nextPlugins);
          setErrorMessage("");
        }
      } catch (error) {
        console.warn("Failed to load installed plugins", error);
        if (!shouldIgnore) {
          setErrorMessage("扫描本地插件失败，请稍后重试。");
        }
      } finally {
        if (!shouldIgnore) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      shouldIgnore = true;
    };
  }, []);

  useEffect(() => {
    setToolbarContainer(document.getElementById("plugins-header-toolbar-slot"));
  }, []);

  useEffect(() => {
    if (!actionErrorMessage) {
      return;
    }

    const timerId = window.setTimeout(() => setActionErrorMessage(""), 4500);
    return () => window.clearTimeout(timerId);
  }, [actionErrorMessage]);

  useEffect(() => {
    if (plugins.length === 0) {
      return;
    }

    const hasActiveHostPlugins = plugins.some(
      (plugin) => plugin.hostTool === activeHost,
    );
    if (hasActiveHostPlugins) {
      return;
    }

    const firstHostWithPlugins = pluginHostTabs.find((tab) =>
      plugins.some((plugin) => plugin.hostTool === tab.key),
    );
    if (firstHostWithPlugins) {
      setActiveHost(firstHostWithPlugins.key);
    }
  }, [activeHost, plugins]);

  const normalizedQuery = query.trim().toLowerCase();
  const hostPlugins = plugins
    .filter((plugin) => plugin.hostTool === activeHost)
    .sort(comparePlugins);
  const filterCounts: Record<PluginFilter, number> = {
    all: hostPlugins.length,
    enabled: hostPlugins.filter((plugin) => plugin.enabledState === "enabled").length,
    disabled: hostPlugins.filter((plugin) => plugin.enabledState === "disabled").length,
    error: hostPlugins.filter(
      (plugin) => plugin.installState === "broken" || plugin.status === "scan-error",
    ).length,
  };
  const filteredPlugins = hostPlugins.filter((plugin) => {
    if (filter === "enabled" && plugin.enabledState !== "enabled") {
      return false;
    }
    if (filter === "disabled" && plugin.enabledState !== "disabled") {
      return false;
    }
    if (
      filter === "error" &&
      plugin.installState !== "broken" &&
      plugin.status !== "scan-error"
    ) {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    const searchContent = [
      plugin.name,
      plugin.hostTool,
      plugin.sourceType,
      plugin.rootPath,
      plugin.manifestPath,
      plugin.installState,
      plugin.enabledState,
      plugin.sourceLabel,
      plugin.description,
      plugin.sourceUrl,
      plugin.sourceRef,
      plugin.sourceRevision,
      ...plugin.components.map((component) => component.name),
      ...plugin.components.map((component) => component.description),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchContent.includes(normalizedQuery);
  });

  const toolbar = (
    <section
      className="plugins-page__toolbar-primary skills-header-bar__tools"
      aria-label="插件工具栏"
    >
      <label className="search-field search-field--header skill-search-field">
        <span className="sr-only">搜索插件</span>
        <input
          type="search"
          placeholder="搜索插件名称、宿主工具、组件..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="plugins-page__toolbar-actions">
        <label className="skill-status-filter">
          <span className="sr-only">筛选插件状态</span>
          <span className="skill-status-filter__icon" aria-hidden="true">
            <FilterIcon />
          </span>
          <select
            aria-label="筛选插件状态"
            value={filter}
            onChange={(event) => setFilter(event.target.value as PluginFilter)}
          >
            {pluginFilterOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {`${option.label} (${filterCounts[option.value]})`}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--refresh${isRefreshing ? " is-loading" : ""}`}
          type="button"
          onClick={() => void loadPlugins({ silent: true })}
          disabled={isRefreshing}
        >
          <span aria-hidden="true" className="skills-toolbar-button__icon">
            <RefreshIcon isSpinning={isRefreshing} />
          </span>
          <span>{isRefreshing ? "扫描中..." : "重新扫描"}</span>
        </button>
      </div>
    </section>
  );

  async function openComponentPreview(
    plugin: PluginSummary,
    component: PluginComponentSummary,
  ) {
    setPreviewViewMode("preview");
    setIsPreviewDirty(false);
    setPreviewState({
      plugin,
      component,
      preview: null,
      isLoading: true,
      errorMessage: "",
    });

    try {
      const preview = await fetchPluginComponentPreview({
        pluginRoot: plugin.rootPath,
        componentId: component.id,
        assetType: component.assetType,
      });
      setPreviewState({
        plugin,
        component,
        preview,
        isLoading: false,
        errorMessage: "",
      });
    } catch (error) {
      console.warn("Failed to load plugin component preview", error);
      setPreviewState({
        plugin,
        component,
        preview: null,
        isLoading: false,
        errorMessage: "读取组件预览失败。",
      });
    }
  }

  function updatePreviewContent(content: string) {
    setIsPreviewDirty(true);
    setPreviewState((current) => {
      if (!current?.preview) {
        return current;
      }

      return {
        ...current,
        preview: {
          ...current.preview,
          content,
        },
      };
    });
  }

  async function handlePluginEnabledChange(plugin: PluginSummary) {
    const pluginKey = getPluginInstanceKey(plugin);
    if (!canTogglePlugin(plugin) || pendingPluginIdsRef.current.has(pluginKey)) {
      return;
    }

    const enabled = plugin.enabledState !== "enabled";
    pendingPluginIdsRef.current.add(pluginKey);
    setPendingPluginIds((current) => new Set(current).add(pluginKey));
    try {
      const updatedPlugin = await setPluginEnabled({
        pluginId: plugin.id,
        hostTool: plugin.hostTool,
        rootPath: plugin.rootPath,
        enabled,
      });
      setPlugins((current) =>
        current.map((candidate) =>
          candidate.id === updatedPlugin.id
          && candidate.hostTool === updatedPlugin.hostTool
          && candidate.rootPath === updatedPlugin.rootPath
            ? updatedPlugin
            : candidate,
        ),
      );
      setErrorMessage("");
      setActionErrorMessage("");
      void loadPlugins({ silent: true });
    } catch (error) {
      console.warn("Failed to update plugin enabled state", error);
      setActionErrorMessage(enabled ? "开启插件失败，请检查宿主配置。" : "关闭插件失败，请检查宿主配置。");
    } finally {
      pendingPluginIdsRef.current.delete(pluginKey);
      setPendingPluginIds((current) => {
        const next = new Set(current);
        next.delete(pluginKey);
        return next;
      });
    }
  }

  function renderPluginDetails(plugin: PluginSummary) {
    const sourceValue = getPluginSourceValue(plugin);

    return (
      <div className="plugins-page__detail-panel">
        <section className="plugins-page__metadata-panel">
          <div className="plugins-page__metadata-header">
            <h3>基本信息</h3>
          </div>
          <dl className="detail-grid detail-grid--single">
            <div>
              <dt>简介</dt>
              <dd>{getPluginDescription(plugin)}</dd>
            </div>
          </dl>
          <dl className="detail-grid detail-grid--source plugins-page__source-grid">
            <div>
              <dt>来源类型</dt>
              <dd>{getPluginSourceTypeLabel(plugin)}</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd className="detail-grid__source-value" title={sourceValue}>
                {isHttpUrl(sourceValue) ? (
                  <a
                    className="detail-grid__source-link"
                    href={sourceValue}
                    onClick={(event) => {
                      event.preventDefault();
                      void openExternalLink(sourceValue);
                    }}
                  >
                    {sourceValue}
                  </a>
                ) : (
                  <span>{sourceValue}</span>
                )}
                <span
                  className={`detail-git-badge${
                    plugin.isGitRepo || plugin.sourceType !== "local"
                      ? " is-linked"
                      : " is-unlinked"
                  }`}
                >
                  git
                </span>
              </dd>
            </div>
          </dl>
          <dl className="tool-list-row__detail-grid plugins-page__metadata-grid">
            {plugin.sourceRef ? (
              <div>
                <dt>分支</dt>
                <dd>{plugin.sourceRef}</dd>
              </div>
            ) : null}
            {plugin.sourceRevision ? (
              <div>
                <dt>Revision</dt>
                <dd>{plugin.sourceRevision}</dd>
              </div>
            ) : null}
            <div>
              <dt>目录</dt>
              <dd title={plugin.rootPath}>{plugin.rootPath}</dd>
            </div>
            {plugin.relatedHostTools && plugin.relatedHostTools.length > 0 ? (
              <div>
                <dt>也安装在</dt>
                <dd>
                  {plugin.relatedHostTools
                    .map((hostTool) => getHostLabel(hostTool))
                    .join(" · ")}
                </dd>
              </div>
            ) : null}
          </dl>
        </section>
        <div className="plugins-page__component-sections">
          {componentSections.map((section) => {
            const components = getComponentsByType(plugin, section.key);

            if (components.length === 0) {
              return null;
            }

            const visibleComponents = components.slice(0, maxVisibleComponentsPerSection);
            const hiddenCount = components.length - visibleComponents.length;

            return (
              <section
                key={section.key}
                className="plugins-page__component-section"
              >
                <div className="plugins-page__component-section-header">
                  <h3>{section.title}</h3>
                  <span>{components.length}</span>
                </div>
                <div className="plugins-page__component-list">
                  {visibleComponents.map((component) => (
                    <button
                      key={component.id}
                      className="plugins-page__component-row"
                      type="button"
                      onClick={() => void openComponentPreview(plugin, component)}
                    >
                      <span
                        className="plugins-page__component-icon"
                        aria-hidden="true"
                      >
                        {getComponentIcon(component)}
                      </span>
                      <span className="plugins-page__component-copy">
                        <strong>{component.name}</strong>
                        <span>{getComponentDescription(component)}</span>
                      </span>
                      <span className="plugins-page__component-path">
                        {component.packageItemId || component.id}
                      </span>
                    </button>
                  ))}
                </div>
                {hiddenCount > 0 ? (
                  <p className="plugins-page__component-more">
                    View {hiddenCount} More
                  </p>
                ) : null}
              </section>
            );
          })}
          {plugin.components.length === 0 ? (
            <p className="plugins-page__component-empty">暂无可展示组件</p>
          ) : null}
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="plugins-page">
        {toolbarContainer ? createPortal(toolbar, toolbarContainer) : toolbar}
        <p>正在加载插件...</p>
      </div>
    );
  }

  const selectedPreviewPath = previewState
    ? getPluginPreviewPath(previewState.preview, previewState.component)
    : "";
  const selectedPreviewLabel = previewState
    ? getPluginPreviewItemLabel(selectedPreviewPath, previewState.component.name)
    : "";

  return (
    <div className="skills-page plugins-page">
      {toolbarContainer ? createPortal(toolbar, toolbarContainer) : toolbar}
      <div className="plugins-page__host-tabs-row">
        <div
          className="plugins-page__host-tabs"
          role="tablist"
          aria-label="插件宿主"
        >
          {pluginHostTabs.map((tab) => {
            const selected = tab.key === activeHost;
            const count = plugins.filter(
              (plugin) => plugin.hostTool === tab.key,
            ).length;

            return (
              <button
                key={tab.key}
                className={`plugins-page__host-tab${selected ? " is-selected" : ""}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={`${tab.label} ${count}`}
                title={tab.label}
                onClick={() => setActiveHost(tab.key)}
              >
                <PluginHostLogo hostTool={tab.key} label={tab.label} />
                <span className="plugins-page__host-tab-count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>
      {actionErrorMessage ? (
        <div className="plugins-page__inline-error" role="status">
          {actionErrorMessage}
        </div>
      ) : null}
      <div className="card-list">
        {errorMessage ? (
          <div className="panel-card empty-state">
            <p>{errorMessage}</p>
          </div>
        ) : null}
        {filteredPlugins.length === 0 ? (
          <div className="panel-card empty-state">
            <h3>
              {hostPlugins.length === 0
                ? `还没有检测到 ${getHostLabel(activeHost)} 插件。`
                : "当前筛选条件下没有匹配的插件。"}
            </h3>
            <p>
              {hostPlugins.length === 0
                ? `当前仅展示 ${getHostLabel(activeHost)} 的插件安装实例。`
                : "试试切换宿主、调整状态筛选，或重新扫描本地插件目录。"}
            </p>
          </div>
        ) : (
          filteredPlugins.map((plugin) => {
            const pluginKey = getPluginInstanceKey(plugin);
            const isPending = pendingPluginIds.has(pluginKey);
            const componentSummaryBadges = getPluginComponentSummaryLabels(plugin).map((label) => ({
              label,
              tone: "info" as const,
            }));

            return (
              <ToolListRow
                key={pluginKey}
                name={plugin.name}
                subtitle={getPluginSubtitle(plugin)}
                badges={[
                  {
                    label: getPluginEnabledBadge(plugin),
                    tone:
                      plugin.enabledState === "enabled" ? "positive" : "neutral",
                  },
                  ...componentSummaryBadges,
                ]}
                expanded={expandedId === pluginKey}
                onExpandedChange={(expanded) =>
                  handleExpandedChange(pluginKey, expanded)
                }
                details={renderPluginDetails(plugin)}
                actions={[
                  {
                    key: "toggle-enabled",
                    label: getPluginToggleActionLabel(
                      plugin,
                      isPending,
                    ),
                    ariaLabel: getPluginToggleActionLabel(
                      plugin,
                      isPending,
                    ),
                    className: getPluginToggleButtonClassName(plugin),
                    icon: (
                      <PluginPowerIcon
                        isSpinning={isPending}
                      />
                    ),
                    tooltip: getPluginToggleActionLabel(
                      plugin,
                      isPending,
                    ),
                    onClick: () => void handlePluginEnabledChange(plugin),
                    disabled:
                      isPending || !canTogglePlugin(plugin),
                  },
                ]}
              />
            );
          })
        )}
      </div>
      {previewState ? (
        <div
          className="dialog-backdrop plugins-page__preview-backdrop"
          role="presentation"
          onClick={() => setPreviewState(null)}
        >
          <section
            className="skill-file-dialog plugins-page__preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-component-preview-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="skill-file-dialog__header">
              <div className="skill-file-dialog__title">
                <h3 id="plugin-component-preview-title">
                  {previewState.component.name}
                </h3>
                <p>
                  {previewState.plugin.name} ·{" "}
                  {selectedPreviewPath}
                </p>
              </div>
              <div className="skill-file-dialog__toolbar">
                <div className="skill-file-dialog__actions">
                  <SkillFileViewModeToggle
                    viewMode={previewViewMode}
                    groupLabel="组件预览视图模式"
                    previewLabel="预览"
                    editLabel="编辑"
                    onViewModeChange={setPreviewViewMode}
                  />
                  <button
                    className="secondary-button secondary-button--compact"
                    type="button"
                    disabled={!previewState?.preview || previewViewMode !== "edit"}
                  >
                    <span aria-hidden="true">⌘</span>
                    <span>保存</span>
                  </button>
                </div>
                <button
                  className="skill-file-dialog__close"
                  type="button"
                  onClick={() => setPreviewState(null)}
                  aria-label="关闭组件预览"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="skill-file-dialog__body plugins-page__preview-body">
              <aside className="skill-file-dialog__sidebar">
                <div
                  className="skill-file-dialog__tree-item skill-file-dialog__tree-item--directory is-root"
                  style={{ paddingLeft: "16px" }}
                >
                  <span aria-hidden="true">⌄</span>
                  <span>{previewState.plugin.name}</span>
                </div>
                <button
                  className="skill-file-dialog__tree-item skill-file-dialog__tree-item--file is-selected"
                  style={{ paddingLeft: "30px" }}
                  type="button"
                >
                  <span aria-hidden="true">📄</span>
                  <span>{selectedPreviewLabel}</span>
                </button>
              </aside>
              <section className="skill-file-dialog__editor">
                <SkillFileContentSurface
                  selectedPath={selectedPreviewPath}
                  content={previewState.preview?.content ?? ""}
                  viewMode={previewViewMode}
                  fileEntries={
                    previewState.preview
                      ? [
                          {
                            path: selectedPreviewPath,
                            name: selectedPreviewLabel,
                            entryType: "file",
                            depth: 0,
                          },
                        ]
                      : []
                  }
                  isLoading={previewState.isLoading}
                  isSaving={false}
                  hasDirtyChanges={isPreviewDirty}
                  noEditableFileLabel="暂无可预览文件"
                  unsavedLabel="已修改"
                  emptyLabel="暂无可预览内容"
                  emptyMarkdownLabel="当前 Markdown 没有可预览内容。"
                  onContentChange={updatePreviewContent}
                  onSelectFile={() => undefined}
                />
                {previewState.isLoading ? (
                  <p className="dialog-note">正在加载预览...</p>
                ) : null}
                {previewState.errorMessage ? (
                  <p className="dialog-error">{previewState.errorMessage}</p>
                ) : null}
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
