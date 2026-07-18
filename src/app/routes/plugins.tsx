import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslate } from "@/app/i18n";
import { ToolbarGoInstallButton } from "@/app/components/ToolbarGoInstallButton";
import { useNotifications } from "@/app/notifications";
import { formatSkillLastEditor } from "@/features/skills/utils/skill-editor";
import { formatSkillUpdatedAt } from "@/features/skills/utils/skill-time";
import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";
import {
  deletePlugin,
  fetchInstalledPlugins,
  fetchStartupInstalledPlugins,
  fetchPluginComponentPreview,
  openExternalLink,
  openPluginInEditor,
  openPathInFinder,
  refreshLocalPluginState,
  refreshPluginStates,
  savePluginComponentPreview,
  setPluginEnabled,
  shouldUseFixtureData,
  subscribePluginLibraryChanges,
  updatePlugin,
} from "@/features/skills/api/skill-client";
import {
  buildInitialCollapsedDirectories,
  collectAncestorDirectoryPaths,
  entryIndent,
  hasCollapsedAncestor,
  parentDirectoryPath,
  SkillFileContentSurface,
  SkillFileViewModeToggle,
  type SkillFileViewMode,
} from "@/features/skills/components/SkillFileDialog";
import {
  ToolListRow,
  useSingleExpandedRow,
} from "@/features/skills/components/ToolListRows";
import { buildOpenToolOptions } from "@/features/skills/utils/open-tools";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";
import {
  normalizePluginAggregateIdentity,
  normalizePluginSourceIdentity,
} from "@/features/skills/utils/plugin-identity";
import { getMonogramLabel } from "@/features/skills/utils/monogram";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import {
  cachePlugins,
  getCachedPlugins,
  subscribePluginsChange,
} from "@/features/skills/utils/plugin-cache";
import type {
  PluginAssetType,
  PluginComponentPreview,
  PluginComponentSummary,
  PluginHostTool,
  PluginSummary,
} from "@/features/skills/state/skill-store";

type PluginFilter = "all" | "enabled" | "disabled";
type PluginTabKey = "all" | PluginHostTool;
type PluginFilterOption = {
  value: PluginFilter;
  label: string;
};
type ComponentSection = {
  key: PluginAssetType;
  title: string;
  summaryLabel: string;
};
type ExpandedComponentSections = Record<
  string,
  Partial<Record<PluginAssetType, boolean>>
>;
type PreviewState = {
  plugin: PluginSummary;
  component: PluginComponentSummary;
  preview: PluginComponentPreview | null;
  isLoading: boolean;
  errorMessage: string;
};
type PluginScanSession = {
  isScanning: boolean;
  plugins: PluginSummary[] | null;
};
type PluginScanSessionListener = (session: PluginScanSession) => void;
type PluginHostCoverageEntry = {
  hostTool: PluginHostTool;
  enabledState: PluginSummary["enabledState"];
  hasError: boolean;
};
const pluginTabs: { key: PluginTabKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "claude-code", label: "Claude Code" },
  { key: "codex", label: "Codex" },
  { key: "cursor", label: "Cursor" },
];
const componentSections: ComponentSection[] = [
  { key: "skill", title: "Skills", summaryLabel: "skill" },
  { key: "mcp", title: "MCP", summaryLabel: "mcp" },
  { key: "subagent", title: "Subagents", summaryLabel: "agents" },
  { key: "command", title: "Commands", summaryLabel: "command" },
  { key: "rule", title: "Rules", summaryLabel: "rule" },
  { key: "hook", title: "Hooks", summaryLabel: "hook" },
];
const primaryComponentSummaryTypes: PluginAssetType[] = [
  "skill",
  "mcp",
  "subagent",
  "command",
  "rule",
  "hook",
];
const FALLBACK_OPEN_TOOL_ID = "finder";
const maxVisibleComponentsPerSection = 5;
const maxVisibleHostCoverageEntries = 5;
const PLUGIN_LIBRARY_CHANGE_DEBOUNCE_MS = 500;
const AUTO_PLUGIN_STATE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_PLUGIN_STATE_REFRESH_COOLDOWN_MS = 60 * 1000;
const STARTUP_PLUGIN_SYNC_COOLDOWN_MS = 1_500;
const PLUGIN_LOCAL_ALIGN_COOLDOWN_MS = 2_000;
const PLUGIN_HEAVY_REFRESH_AFTER_STARTUP_SYNC_DELAY_MS = 800;
const pluginEnabledOrder: Record<PluginSummary["enabledState"], number> = {
  enabled: 0,
  disabled: 1,
  unknown: 2,
};
let pluginScanSession: PluginScanSession = {
  isScanning: false,
  plugins: null,
};
let activePluginScanPromise: Promise<PluginSummary[]> | null = null;
const pluginScanSessionListeners = new Set<PluginScanSessionListener>();
const FIRST_EMPTY_PLUGINS_AUTO_SCAN_KEY = "skilldock.plugins.firstEmptyAutoScanCompleted";

function getPluginScanSessionSnapshot() {
  return { ...pluginScanSession };
}

function hasCompletedFirstEmptyPluginsAutoScan() {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function"
  ) {
    return false;
  }

  return window.localStorage.getItem(FIRST_EMPTY_PLUGINS_AUTO_SCAN_KEY) === "true";
}

function markFirstEmptyPluginsAutoScanCompleted() {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.setItem !== "function"
  ) {
    return;
  }

  window.localStorage.setItem(FIRST_EMPTY_PLUGINS_AUTO_SCAN_KEY, "true");
}

function setPluginScanSession(nextSession: PluginScanSession) {
  pluginScanSession = nextSession;
  for (const listener of pluginScanSessionListeners) {
    listener(getPluginScanSessionSnapshot());
  }
}

function subscribePluginScanSessionChange(listener: PluginScanSessionListener) {
  pluginScanSessionListeners.add(listener);
  listener(getPluginScanSessionSnapshot());

  return () => {
    pluginScanSessionListeners.delete(listener);
  };
}

function startPluginScanImport() {
  if (activePluginScanPromise) {
    return activePluginScanPromise;
  }

  setPluginScanSession({
    isScanning: true,
    plugins: null,
  });
  activePluginScanPromise = fetchInstalledPlugins()
    .then((plugins) => {
      if (!shouldUseFixtureData()) {
        cachePlugins(plugins);
      }
      setPluginScanSession({
        isScanning: false,
        plugins,
      });
      return plugins;
    })
    .catch((error) => {
      setPluginScanSession({
        isScanning: false,
        plugins: null,
      });
      throw error;
    })
    .finally(() => {
      activePluginScanPromise = null;
    });
  return activePluginScanPromise;
}

function startPluginStateRefreshImport() {
  if (activePluginScanPromise) {
    return activePluginScanPromise;
  }

  setPluginScanSession({
    isScanning: true,
    plugins: null,
  });
  activePluginScanPromise = fetchInstalledPlugins()
    .then((plugins) => {
      if (!shouldUseFixtureData()) {
        cachePlugins(plugins);
      }
      setPluginScanSession({
        isScanning: false,
        plugins,
      });
      return plugins;
    })
    .catch((error) => {
      setPluginScanSession({
        isScanning: false,
        plugins: null,
      });
      throw error;
    })
    .finally(() => {
      activePluginScanPromise = null;
    });
  return activePluginScanPromise;
}

export function resetPluginScanSessionForTests() {
  activePluginScanPromise = null;
  pluginScanSession = {
    isScanning: false,
    plugins: null,
  };
  pluginScanSessionListeners.clear();
}

function getRuntimeCachedPlugins() {
  return shouldUseFixtureData() ? null : getCachedPlugins();
}

function RefreshIcon({
  isSpinning = false,
  variant = "toolbar",
}: {
  isSpinning?: boolean;
  variant?: "toolbar" | "card";
}) {
  const className = variant === "card"
    ? (isSpinning ? "skill-card__refresh-icon is-spinning" : "skill-card__refresh-icon")
    : (isSpinning ? "skills-toolbar-button__svg is-spinning" : "skills-toolbar-button__svg");
  const inlineAnimationStyle = isSpinning
    ? {
        animation: "spin 0.8s linear infinite",
        transformBox: "fill-box" as const,
        transformOrigin: "center",
      }
    : undefined;

  return (
    <svg
      className={className}
      style={inlineAnimationStyle}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      {variant === "card" ? (
        <>
          <path
            d="M15.2 6.6A6.25 6.25 0 1 0 16 10"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M15.3 4.2v2.8h-2.8"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <path d="M16.2 9.1a6.2 6.2 0 0 0-10.7-3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3.7 3.9v3.7h3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3.8 10.9a6.2 6.2 0 0 0 10.7 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M16.3 16.1v-3.7h-3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

function ImportIcon({ isSpinning = false }: { isSpinning?: boolean }) {
  return (
    <svg className={isSpinning ? "skills-toolbar-button__svg is-spinning" : "skills-toolbar-button__svg"} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M4.25 10.25A5.75 5.75 0 0 1 14.1 6.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.75 9.75A5.75 5.75 0 0 1 5.9 13.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.9 3.75v2.8h-2.8M6.1 16.25v-2.8h2.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

function DeleteIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M4.75 5.75h10.5M7.25 5.75V4.5c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1v1.25m-6.25 0 .45 8.25c.03.61.54 1.08 1.15 1.08h3.8c.61 0 1.12-.47 1.15-1.08l.45-8.25M8.5 8.75v4.25m3 0V8.75"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OpenFolderIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3.75 6.5A1.75 1.75 0 0 1 5.5 4.75h3l1.25 1.5h4.75a1.75 1.75 0 0 1 1.75 1.75v5.5a1.75 1.75 0 0 1-1.75 1.75h-9A1.75 1.75 0 0 1 3.75 13.5v-7Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="m8.25 11.75 3.5-3.5M9.25 8.25h2.5v2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3.5 6.6c0-.97.78-1.75 1.75-1.75h3.18c.52 0 1.01.23 1.34.63l.67.8h4.31c.97 0 1.75.78 1.75 1.75v5.37c0 .97-.78 1.75-1.75 1.75h-9.5c-.97 0-1.75-.78-1.75-1.75V6.6Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <path
        d="M3.75 8.1h12.5"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PluginListIcon({ name }: { name: string }) {
  return (
    <span className="plugins-page__plugin-icon" aria-hidden="true">
      <span className="plugins-page__plugin-type-mark">
        <svg viewBox="0 0 12 12" fill="none">
          <path
            d="M4.25 1.5v3m3.5-3v3M3.25 4.5h5.5v2.25a2.75 2.75 0 0 1-5.5 0V4.5ZM6 9.5v1"
            stroke="currentColor"
            strokeWidth="1.15"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="plugins-page__plugin-icon-label">
        {getMonogramLabel(name)}
      </span>
    </span>
  );
}

function getHostLabel(hostTool: PluginHostTool) {
  return pluginTabs.find((tab) => tab.key === hostTool)?.label ?? hostTool;
}

function getPluginInstanceKey(plugin: PluginSummary) {
  const instancePath = plugin.rootPath || plugin.manifestPath || plugin.id;
  return `${plugin.hostTool}::${instancePath}::${plugin.id}`;
}

function getPluginDisplayName(plugin: PluginSummary) {
  const aliasedDisplayName = getAliasedPluginDisplayName(plugin);
  if (aliasedDisplayName) {
    return aliasedDisplayName;
  }
  const manifestName = plugin.manifestName?.trim() ?? "";
  if (manifestName) {
    return manifestName;
  }
  return plugin.name.trim() || plugin.id;
}

function normalizePluginAlias(value: string) {
  const normalizedValue = normalizePluginAggregateIdentity(value);
  if (normalizedValue === "launchdarkly-mcp") {
    return "launchdarkly";
  }
  return normalizedValue;
}

function getAliasedPluginDisplayName(plugin: PluginSummary) {
  const manifestName = plugin.manifestName?.trim() ?? "";
  const pluginName = plugin.name.trim();
  const displayCandidates = [manifestName, pluginName];

  for (const candidate of displayCandidates) {
    if (normalizePluginAlias(candidate) === "launchdarkly") {
      return "launchdarkly";
    }
  }

  return "";
}

function getPluginCanonicalName(plugin: PluginSummary) {
  const manifestName = normalizePluginAlias(plugin.manifestName || "");
  if (manifestName) {
    return manifestName;
  }
  const prefix = `${plugin.hostTool}:`;
  if (plugin.id.startsWith(prefix)) {
    return normalizePluginAlias(plugin.id.slice(prefix.length));
  }
  return normalizePluginAlias(plugin.id);
}

function buildPluginAggregateKey(plugin: PluginSummary) {
  const canonicalName = getPluginCanonicalName(plugin);
  const sourceIdentity = normalizePluginSourceIdentity(plugin.sourceUrl);
  const packageIdentity = normalizePluginAggregateIdentity(plugin.packageId);
  const repoIdentity = normalizePluginAggregateIdentity(plugin.repoRootPath);
  const sourceLabelIdentity = normalizePluginAggregateIdentity(plugin.sourceLabel);

  if (sourceIdentity && canonicalName) {
    return `source:${sourceIdentity}:name:${canonicalName}`;
  }
  if (packageIdentity && canonicalName) {
    return `package:${packageIdentity}:name:${canonicalName}`;
  }
  if (repoIdentity && canonicalName) {
    return `repo:${repoIdentity}:name:${canonicalName}`;
  }
  if (sourceLabelIdentity && canonicalName) {
    return `label:${sourceLabelIdentity}:name:${canonicalName}`;
  }
  if (canonicalName) {
    return `name:${canonicalName}`;
  }

  return `fallback:${normalizePluginAggregateIdentity(plugin.name)}:${plugin.hostTool}`;
}

function buildPluginPackageMap(plugins: PluginSummary[]) {
  const packageMap = new Map<string, PluginSummary[]>();

  for (const plugin of plugins) {
    const packageKey = buildPluginAggregateKey(plugin);
    const installedGroup = packageMap.get(packageKey) ?? [];
    installedGroup.push(plugin);
    packageMap.set(packageKey, installedGroup);
  }

  return packageMap;
}

function getPluginComponentIdentityKey(component: PluginComponentSummary) {
  if (component.assetType === "mcp") {
    return `${component.assetType}:${component.id}`;
  }

  return `${component.assetType}:${component.packageItemId || component.id}`;
}

function buildAllTabPlugins(plugins: PluginSummary[]): PluginSummary[] {
  const packageMap = buildPluginPackageMap(plugins);

  return [...packageMap.values()].map((installedGroup) => {
    const sortedGroup = [...installedGroup].sort(comparePlugins);
    const primaryPlugin = sortedGroup[0];
    if (!primaryPlugin) {
      throw new Error("plugin package group should not be empty");
    }

    const relatedHostTools = sortedGroup
      .map((plugin) => plugin.hostTool)
      .filter((hostTool, index, hostTools) => hostTools.indexOf(hostTool) === index);
    const hasEnabledInstallation = sortedGroup.some((plugin) => plugin.enabledState === "enabled");
    const hasDisabledInstallation = sortedGroup.some((plugin) => plugin.enabledState === "disabled");
    const hasUnknownInstallation = sortedGroup.some((plugin) => plugin.enabledState === "unknown");
    const hasBrokenInstallation = sortedGroup.some(
      (plugin) => plugin.installState === "broken" || plugin.status === "scan-error",
    );
    const updateAvailable = sortedGroup.some((plugin) => plugin.updateAvailable);

    let enabledState: PluginSummary["enabledState"] = "unknown";
    if (hasEnabledInstallation) {
      enabledState = "enabled";
    } else if (hasDisabledInstallation) {
      enabledState = "disabled";
    } else if (hasUnknownInstallation) {
      enabledState = "unknown";
    }

    let installState: PluginSummary["installState"] = primaryPlugin.installState;
    if (hasBrokenInstallation) {
      installState = "broken";
    } else if (sortedGroup.every((plugin) => plugin.installState === "detected")) {
      installState = "detected";
    }

    const mergedComponents = sortedGroup.flatMap((plugin) => plugin.components);
    const uniqueComponents = mergedComponents.filter((component, index) => {
      const componentKey = getPluginComponentIdentityKey(component);
      return mergedComponents.findIndex((candidate) => (
        getPluginComponentIdentityKey(candidate) === componentKey
      )) === index;
    });
    const mergedScopes = sortedGroup.flatMap((plugin) => plugin.scopes);
    const uniqueScopes = mergedScopes.filter((scope, index) => {
      const scopeKey = `${scope.scopeId}:${scope.location}`;
      return mergedScopes.findIndex((candidate) => (
        `${candidate.scopeId}:${candidate.location}` === scopeKey
      )) === index;
    });
    const installSource = sortedGroup.some((plugin) => plugin.installSource === "skilldock")
      ? "skilldock"
      : primaryPlugin.installSource;
    const collabStatus: PluginSummary["collabStatus"] = sortedGroup.some((plugin) => plugin.collabStatus === "pending-push")
      ? "pending-push"
      : sortedGroup.some((plugin) => plugin.collabStatus === "update-available")
        ? "update-available"
        : sortedGroup.some((plugin) => plugin.collabStatus === "diverged")
          ? "diverged"
          : "clean";
    const statusText = updateAvailable
      ? "Shared plugin package has updates available."
      : hasBrokenInstallation
        ? "Some host installations are in an error state."
        : primaryPlugin.statusText;

    return {
      ...primaryPlugin,
      relatedHostTools,
      components: uniqueComponents,
      scopes: uniqueScopes,
      enabledState,
      installState,
      installSource,
      collabStatus,
      updateAvailable,
      statusText,
    };
  });
}

function listPluginActionTargets(
  plugin: PluginSummary,
  allPlugins: PluginSummary[],
  includeAllHosts: boolean,
) {
  if (!includeAllHosts) {
    return allPlugins.filter((candidate) => (
      candidate.hostTool === plugin.hostTool
      && getPluginInstanceKey(candidate) === getPluginInstanceKey(plugin)
    ));
  }

  const aggregateKey = buildPluginAggregateKey(plugin);
  return allPlugins.filter((candidate) => (
    buildPluginAggregateKey(candidate) === aggregateKey
  ));
}

function getPluginUpdateOperationKey(plugin: PluginSummary) {
  const normalizedRoot = normalizePluginAggregateIdentity(
    plugin.updateStrategy === "git"
      ? plugin.repoRootPath || plugin.rootPath
      : plugin.rootPath,
  );
  if (normalizedRoot) {
    return `${plugin.updateStrategy}:${normalizedRoot}`;
  }
  return `${plugin.updateStrategy}:${getPluginInstanceKey(plugin)}`;
}

function listUniquePluginUpdateTargets(plugins: PluginSummary[]) {
  const updateTargetMap = new Map<string, PluginSummary>();

  for (const plugin of plugins) {
    const operationKey = getPluginUpdateOperationKey(plugin);
    if (!updateTargetMap.has(operationKey)) {
      updateTargetMap.set(operationKey, plugin);
    }
  }

  return [...updateTargetMap.values()];
}

function isPluginActionPending(
  plugin: PluginSummary,
  allPlugins: PluginSummary[],
  pendingPluginIds: Set<string>,
  includeAllHosts: boolean,
) {
  const targetPlugins = listPluginActionTargets(plugin, allPlugins, includeAllHosts);
  return targetPlugins.some((candidate) => pendingPluginIds.has(getPluginInstanceKey(candidate)));
}

function getPluginActionErrorMessage(error: unknown, fallbackMessage: string) {
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallbackMessage;
}

function PluginHostLogo({ hostTool, label }: { hostTool: PluginHostTool; label: string }) {
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoUrl = getToolLogoUrl(hostTool);
  const fallbackLabel = label.slice(0, 1).toUpperCase();

  if (!logoUrl || logoLoadFailed) {
    return (
      <span className="skills-source-tab__logo" aria-hidden="true">
        {fallbackLabel}
      </span>
    );
  }

  return (
    <span className="skills-source-tab__logo" aria-hidden="true">
      <img
        src={logoUrl}
        alt=""
        loading="lazy"
        onError={() => setLogoLoadFailed(true)}
      />
    </span>
  );
}

function PluginHostCoverageIcon({
  hostTool,
  label,
}: {
  hostTool: PluginHostTool;
  label: string;
}) {
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoUrl = getToolLogoUrl(hostTool);
  const fallbackLabel = label.slice(0, 1).toUpperCase();

  return (
    <span className="plugins-page__host-coverage-icon" aria-hidden="true">
      {logoUrl && !logoLoadFailed ? (
        <img
          src={logoUrl}
          alt=""
          loading="lazy"
          onError={() => setLogoLoadFailed(true)}
        />
      ) : (
        <span>{fallbackLabel}</span>
      )}
    </span>
  );
}

function comparePlugins(left: PluginSummary, right: PluginSummary) {
  return (
    pluginEnabledOrder[left.enabledState] -
      pluginEnabledOrder[right.enabledState] ||
    getPluginDisplayName(left).localeCompare(getPluginDisplayName(right), "zh-CN", {
      sensitivity: "base",
      numeric: true,
    }) ||
    left.rootPath.localeCompare(right.rootPath, "zh-CN", {
      sensitivity: "base",
      numeric: true,
    })
  );
}

function getPluginEnabledBadge(
  plugin: PluginSummary,
  t: ReturnType<typeof useTranslate>["t"],
) {
  if (plugin.enabledState === "enabled") {
    return t("plugins.status.enabled");
  }
  if (plugin.enabledState === "disabled") {
    return t("plugins.status.disabled");
  }
  return t("plugins.status.unknown");
}

function getPluginHostCoverageEntries(plugins: PluginSummary[]) {
  return [...plugins]
    .sort((left, right) => pluginTabs
      .filter((tab) => tab.key !== "all")
      .findIndex((tab) => tab.key === left.hostTool)
      - pluginTabs
        .filter((tab) => tab.key !== "all")
        .findIndex((tab) => tab.key === right.hostTool))
    .map((plugin) => ({
      hostTool: plugin.hostTool,
      enabledState: plugin.enabledState,
      hasError: plugin.installState === "broken" || plugin.status === "scan-error",
    }))
    .filter((entry, index, entries) => entries.findIndex((candidate) => (
      candidate.hostTool === entry.hostTool
    )) === index);
}

function getPluginHostCoverageEntriesForSummary(
  plugin: PluginSummary,
  allPlugins: PluginSummary[],
  includeRelatedHostTools = false,
) {
  const relatedPlugins = allPlugins.filter((candidate) => (
    buildPluginAggregateKey(candidate) === buildPluginAggregateKey(plugin)
    && getPluginInstanceKey(candidate) !== getPluginInstanceKey(plugin)
  ));
  const entries = getPluginHostCoverageEntries([plugin, ...relatedPlugins]);
  const coveredHostTools = new Set(entries.map((entry) => entry.hostTool));

  if (includeRelatedHostTools) {
    for (const hostTool of plugin.relatedHostTools ?? []) {
      if (!coveredHostTools.has(hostTool)) {
        entries.push({
          hostTool,
          enabledState: "unknown",
          hasError: false,
        });
      }
    }
  }

  return entries.sort((left, right) => pluginTabs
    .filter((tab) => tab.key !== "all")
    .findIndex((tab) => tab.key === left.hostTool)
    - pluginTabs
      .filter((tab) => tab.key !== "all")
      .findIndex((tab) => tab.key === right.hostTool));
}

function renderPluginHostCoverageList(
  hostCoverageEntries: PluginHostCoverageEntry[],
  t: ReturnType<typeof useTranslate>["t"],
) {
  if (hostCoverageEntries.length === 0) {
    return null;
  }

  return (
    <span className="plugins-page__enabled-badge-hosts" aria-label={t("plugins.installedHosts")}>
      {hostCoverageEntries.map((entry) => (
        <span
          key={entry.hostTool}
          className={`plugins-page__host-coverage-item is-${entry.enabledState}${entry.hasError ? " has-error" : ""}`}
          data-tooltip={getPluginHostCoverageTooltip(entry, t)}
        >
          <PluginHostCoverageIcon
            hostTool={entry.hostTool}
            label={getHostLabel(entry.hostTool)}
          />
        </span>
      ))}
    </span>
  );
}

function getPluginHostCoverageTooltip(
  entry: PluginHostCoverageEntry,
  t: ReturnType<typeof useTranslate>["t"],
) {
  const hostLabel = getHostLabel(entry.hostTool);
  if (entry.hasError) {
    return t("plugins.hostCoverage.error", { host: hostLabel });
  }
  if (entry.enabledState === "enabled") {
    return t("plugins.hostCoverage.enabled", { host: hostLabel });
  }
  if (entry.enabledState === "disabled") {
    return t("plugins.hostCoverage.disabled", { host: hostLabel });
  }

  return t("plugins.hostCoverage.unknown", { host: hostLabel });
}

function renderPluginEnabledBadge(
  plugin: PluginSummary,
  t: ReturnType<typeof useTranslate>["t"],
) {
  return getPluginEnabledBadge(plugin, t);
}

function renderPluginHostCoverageBadge(
  plugin: PluginSummary,
  hostCoverageEntries: PluginHostCoverageEntry[],
  t: ReturnType<typeof useTranslate>["t"],
) {
  if (hostCoverageEntries.length === 0) {
    return null;
  }

  const visibleEntries = hostCoverageEntries.slice(0, maxVisibleHostCoverageEntries);
  const hiddenCount = Math.max(hostCoverageEntries.length - visibleEntries.length, 0);

  return (
    <span className="plugins-page__enabled-badge-hosts" aria-label={t("plugins.installedHostsFor", { name: getPluginDisplayName(plugin) })}>
      {renderPluginHostCoverageList(visibleEntries, t)}
      {hiddenCount > 0 ? (
        <span className="plugins-page__host-coverage-more">{`+${hiddenCount}`}</span>
      ) : null}
    </span>
  );
}

function getPluginCollabBadge(
  plugin: PluginSummary,
  t: ReturnType<typeof useTranslate>["t"],
) {
  if (plugin.collabStatus === "update-available") {
    return { label: t("plugins.collab.updateAvailable"), tone: "positive" as const };
  }
  if (plugin.collabStatus === "pending-push") {
    return { label: t("plugins.collab.pendingPush"), tone: "info" as const };
  }
  if (plugin.collabStatus === "diverged") {
    return { label: t("plugins.collab.diverged"), tone: "warning" as const };
  }

  return null;
}

function canTogglePlugin(plugin: PluginSummary) {
  return (
    plugin.enabledState !== "unknown"
    && (plugin.hostTool === "codex" || plugin.hostTool === "claude-code")
  );
}

function getPluginToggleActionLabel(
  plugin: PluginSummary,
  isPending: boolean,
  t: ReturnType<typeof useTranslate>["t"],
) {
  const pluginName = getPluginDisplayName(plugin);
  if (!canTogglePlugin(plugin)) {
    return t("plugins.action.toggle.unsupported", { name: pluginName });
  }
  if (isPending) {
    return plugin.enabledState === "enabled"
      ? t("plugins.action.toggle.disabling", { name: pluginName })
      : t("plugins.action.toggle.enabling", { name: pluginName });
  }

  return plugin.enabledState === "enabled"
    ? t("plugins.action.toggle.disable", { name: pluginName })
    : t("plugins.action.toggle.enable", { name: pluginName });
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

function getPluginDeleteActionLabel(
  plugin: PluginSummary,
  isConfirming: boolean,
  isDeleting: boolean,
  t: ReturnType<typeof useTranslate>["t"],
) {
  const pluginName = getPluginDisplayName(plugin);
  if (isDeleting) {
    return t("plugins.action.delete.deleting", { name: pluginName });
  }
  if (isConfirming) {
    return t("plugins.action.delete.confirmAria", { name: pluginName });
  }

  return t("plugins.action.delete.default", { name: pluginName });
}

function getPluginOpenActionAriaLabel(
  plugin: PluginSummary,
  t: ReturnType<typeof useTranslate>["t"],
) {
  return t("plugins.action.openFolder", { name: getPluginDisplayName(plugin) });
}

function getPluginOpenInFinderActionAriaLabel(
  plugin: PluginSummary,
  t: ReturnType<typeof useTranslate>["t"],
) {
  return t("plugins.action.openFolderInFinder", { name: getPluginDisplayName(plugin) });
}

function getPluginUpdateActionLabel(
  plugin: PluginSummary,
  isPending: boolean,
  t: ReturnType<typeof useTranslate>["t"],
) {
  const pluginName = getPluginDisplayName(plugin);
  return isPending
    ? t("plugins.action.update.updating", { name: pluginName })
    : t("plugins.action.update.default", { name: pluginName });
}

function getPluginSourceLabel(plugin: PluginSummary) {
  if (plugin.sourceUrl.trim()) {
    return plugin.sourceUrl.trim();
  }
  if (plugin.sourceLabel.trim()) {
    return plugin.sourceLabel.trim();
  }
  if (plugin.sourceType === "git") {
    return "Git Repository";
  }
  if (plugin.sourceType === "marketplace") {
    return "Marketplace";
  }
  return "Local Directory";
}

function getPluginSourceTypeLabel(
  plugin: PluginSummary,
  t: ReturnType<typeof useTranslate>["t"],
) {
  if (plugin.sourceType === "marketplace") {
    return "Marketplace";
  }
  const sourceValue = plugin.sourceUrl.trim() || plugin.sourceLabel.trim();
  if (sourceValue && isGitSourceValue(sourceValue)) {
    return t("plugins.sourceType.git");
  }
  if (plugin.sourceType === "local") {
    return t("plugins.sourceType.local");
  }
  return t("plugins.sourceType.git");
}

function getPluginInstallSourceLabel(
  plugin: PluginSummary,
  t: ReturnType<typeof useTranslate>["t"],
) {
  return plugin.installSource === "skilldock"
    ? t("plugins.installSource.skilldock")
    : t("plugins.installSource.host");
}

function getPluginOpenRootPath(
  plugin: PluginSummary,
  activeHost: PluginTabKey,
  allPlugins: PluginSummary[],
) {
  const displayRootPath = plugin.displayRootPath?.trim();
  if (plugin.hostTool === "codex" && plugin.installSource === "skilldock" && displayRootPath) {
    return displayRootPath;
  }

  if (activeHost === "all") {
    const aggregatePlugins = allPlugins.filter((candidate) => (
      buildPluginAggregateKey(candidate) === buildPluginAggregateKey(plugin)
    ));
    const hostCoverageCount = getPluginHostCoverageEntries(aggregatePlugins).length;
    if (hostCoverageCount > 1) {
      const skilldockRoot = aggregatePlugins.find((candidate) => (
        candidate.installSource === "skilldock"
        && candidate.repoRootPath.includes("/.skilldock/")
        && candidate.repoRootPath.trim()
      ))?.repoRootPath?.trim();
      return skilldockRoot || plugin.repoRootPath.trim() || plugin.rootPath.trim();
    }
    if (plugin.hostTool === "cursor") {
      return plugin.displayRootPath?.trim() || plugin.rootPath.trim();
    }
    return plugin.rootPath.trim() || plugin.repoRootPath.trim();
  }

  if (plugin.hostTool === "cursor" && activeHost === "cursor") {
    return plugin.displayRootPath?.trim() || plugin.rootPath;
  }

  return plugin.rootPath.trim() || plugin.repoRootPath.trim();
}

function getPluginDirectoryPath(
  plugin: PluginSummary,
  activeHost: PluginTabKey,
  allPlugins: PluginSummary[],
) {
  const displayRootPath = plugin.displayRootPath?.trim();
  if (plugin.hostTool === "codex" && plugin.installSource === "skilldock" && displayRootPath) {
    return displayRootPath;
  }

  if (plugin.installSource === "skilldock" && plugin.repoRootPath.includes("/.skilldock/")) {
    return plugin.repoRootPath.trim();
  }

  return getPluginOpenRootPath(plugin, activeHost, allPlugins);
}

function getPluginDisplayDirectoryPath(
  plugin: PluginSummary,
  activeHost: PluginTabKey,
  allPlugins: PluginSummary[],
) {
  const displayRootPath = plugin.displayRootPath?.trim();
  if (displayRootPath) {
    return displayRootPath;
  }

  const rootPath = plugin.rootPath.trim();
  if (rootPath && !rootPath.includes("/.skilldock/")) {
    return rootPath;
  }

  return getPluginOpenRootPath(plugin, activeHost, allPlugins);
}

function shouldShowPluginGitBadge(plugin: PluginSummary, sourceValue: string) {
  return plugin.sourceType !== "marketplace" && isGitSourceValue(sourceValue);
}

function tryParsePluginSourceUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function buildPluginRepositorySourceUrl(plugin: PluginSummary) {
  const sourceUrl = plugin.sourceUrl.trim();
  if (!sourceUrl) {
    return "";
  }

  const parsed = tryParsePluginSourceUrl(sourceUrl);
  if (!parsed) {
    return sourceUrl;
  }

  const branch = plugin.sourceRef.trim() || plugin.currentBranch.trim();
  const relativePath = plugin.pluginRelativePath.trim().replace(/^\/+|\/+$/g, "");
  if (!branch || !relativePath) {
    return sourceUrl;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const treeIndex = segments.findIndex((segment, index) => {
    return segment === "tree" || segment === "blob" || (segment === "-" && segments[index + 1] === "tree");
  });
  if (treeIndex >= 0) {
    parsed.pathname = `/${segments.slice(0, treeIndex).join("/")}`;
    parsed.search = "";
    parsed.hash = "";
  }

  if (parsed.hostname.includes("gitlab")) {
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/-/tree/${branch}/${relativePath}`;
  } else {
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/tree/${branch}/${relativePath}`;
  }
  return parsed.toString();
}

function getPluginSourceValue(plugin: PluginSummary) {
  const gitRepositorySourceUrl = buildPluginRepositorySourceUrl(plugin);
  if (gitRepositorySourceUrl) {
    return gitRepositorySourceUrl;
  }

  const sourceUrl = plugin.sourceUrl.trim();
  if (sourceUrl) {
    return sourceUrl;
  }

  if (plugin.sourceType === "local") {
    return plugin.rootPath;
  }

  return getPluginSourceLabel(plugin);
}

function getPluginDescription(
  plugin: PluginSummary,
  t: ReturnType<typeof useTranslate>["t"],
) {
  return plugin.description.trim() || t("plugins.description.empty");
}

function getPluginSubtitle(
  plugin: PluginSummary,
  t: ReturnType<typeof useTranslate>["t"],
) {
  return getPluginDescription(plugin, t);
}

function getPluginRemoteUpdatedAt(plugin: PluginSummary, t: ReturnType<typeof useTranslate>["t"]) {
  return formatSkillUpdatedAt(plugin.remoteUpdatedAt)
    || formatSkillUpdatedAt(plugin.updatedAt)
    || t("skill.card.notFetched");
}

function getPluginLocalUpdatedAt(plugin: PluginSummary, t: ReturnType<typeof useTranslate>["t"]) {
  return formatSkillUpdatedAt(plugin.localUpdatedAt)
    || formatSkillUpdatedAt(plugin.updatedAt)
    || t("skill.card.notFetched");
}

function getPluginLastEditor(plugin: PluginSummary, t: ReturnType<typeof useTranslate>["t"]) {
  return formatSkillLastEditor(plugin.lastEditor) || t("skill.card.notFetched");
}

function shouldShowPluginRemoteUpdateInfo(plugin: PluginSummary) {
  return plugin.sourceType === "git" || plugin.isGitRepo;
}

function getComponentDescription(
  component: PluginComponentSummary,
  t: ReturnType<typeof useTranslate>["t"],
) {
  const description = component.description.trim();
  if (description) {
    return description;
  }
  if (component.assetType === "skill") {
    return t("plugins.componentType.skill");
  }
  if (component.assetType === "subagent") {
    return t("plugins.componentType.subagent");
  }
  if (component.assetType === "mcp") {
    return t("plugins.componentType.mcp");
  }
  if (component.assetType === "rule") {
    return t("plugins.componentType.rule");
  }
  if (component.assetType === "hook") {
    return t("plugins.componentType.hook");
  }
  return t("plugins.componentType.command");
}

function ComponentIcon({ assetType }: { assetType: PluginAssetType }) {
  if (assetType === "skill") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 4.5 14 10l5.5 2-5.5 2L12 19.5l-2-5.5L4.5 12 10 10 12 4.5Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (assetType === "mcp") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M2.4 11.3 11.45 2.26a3.2 3.2 0 0 1 4.53 4.53l-6.84 6.83"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.6"
        />
        <path
          d="m9.24 13.53 6.74-6.74a3.2 3.2 0 0 1 4.52 0l.05.05a3.2 3.2 0 0 1 0 4.52l-8.19 8.19a1.07 1.07 0 0 0 0 1.51l1.68 1.68"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.6"
        />
        <path
          d="m13.71 4.53-6.69 6.69a3.2 3.2 0 0 0 4.53 4.53l6.69-6.7"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.6"
        />
      </svg>
    );
  }

  if (assetType === "subagent") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 5.25a3 3 0 1 1 0 6a3 3 0 0 1 0-6ZM5.5 18.5a6.5 6.5 0 0 1 13 0"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        />
        <path
          d="M5.25 8.75h2.1m9.3 0h2.1M12 2.75v2.1"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
      </svg>
    );
  }

  if (assetType === "rule") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M7 4.5h8.25L18 7.25V19.5H7V4.5Z"
          fill="none"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="1.7"
        />
        <path
          d="M9.5 10.25h5M9.5 13.25h5M9.5 16.25h3.25"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.7"
        />
      </svg>
    );
  }

  if (assetType === "hook") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M8.25 5.5a3.25 3.25 0 0 1 6.5 0v7.25a4.75 4.75 0 1 1-9.5 0v-.5"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
        <path
          d="M14.75 9.25h3.5"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="m8.25 8.25 3.5 3.75-3.5 3.75M13.5 15.75h3.75"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </svg>
  );
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

function isHttpUrl(value: string) {
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function isGitSourceValue(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return false;
  }

  if (normalizedValue.startsWith("git@") || normalizedValue.startsWith("ssh://")) {
    return true;
  }

  if (normalizedValue.endsWith(".git")) {
    return true;
  }

  try {
    const parsedUrl = new URL(value.trim());
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return false;
    }
    return parsedUrl.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

type PluginsRouteProps = {
  onGoInstall?: () => void;
  onActiveHostChange?: (hostName: string | null) => void;
};

export function PluginsRoute(props: PluginsRouteProps = {}) {
  const { t } = useTranslate();
  const { defaultOpenToolId, language, toolConfigs } = useSkillWorkspace();
  const { notify } = useNotifications();
  const [plugins, setPlugins] = useState<PluginSummary[]>(() => getRuntimeCachedPlugins() ?? []);
  const [isLoading, setIsLoading] = useState(() => getRuntimeCachedPlugins() === null);
  const [isRefreshing, setIsRefreshing] = useState(() => getPluginScanSessionSnapshot().isScanning);
  const [isReloading, setIsReloading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [actionErrorMessage, setActionErrorMessage] = useState("");
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [previewViewMode, setPreviewViewMode] = useState<SkillFileViewMode>("preview");
  const [previewCollapsedDirectories, setPreviewCollapsedDirectories] = useState<Record<string, boolean>>({});
  const [isPreviewDirty, setIsPreviewDirty] = useState(false);
  const [isPreviewSaving, setIsPreviewSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [activeHost, setActiveHost] = useState<PluginTabKey>("all");
  const [pendingPluginToggleIds, setPendingPluginToggleIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingPluginUpdateIds, setPendingPluginUpdateIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingPluginIds, setDeletingPluginIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deleteConfirmingPluginId, setDeleteConfirmingPluginId] = useState("");
  const [updateConfirmingPlugin, setUpdateConfirmingPlugin] = useState<PluginSummary | null>(null);
  const [expandedComponentSections, setExpandedComponentSections] =
    useState<ExpandedComponentSections>({});
  const pendingPluginToggleIdsRef = useRef(new Set<string>());
  const pendingPluginUpdateIdsRef = useRef(new Set<string>());
  const localAlignInFlightRef = useRef<Promise<PluginSummary[]> | null>(null);
  const pluginRefreshDebounceTimerRef = useRef<number | null>(null);
  const pluginLocalRefreshInFlightRef = useRef(new Map<string, Promise<void>>());
  const pluginStateRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const deferredHeavyRefreshTimerRef = useRef<number | null>(null);
  const lastPluginAutoRefreshAtRef = useRef(0);
  const startupPluginSyncInFlightRef = useRef<Promise<void> | null>(null);
  const lastStartupPluginSyncAtRef = useRef(0);
  const lastPluginLocalAlignAtRef = useRef(0);
  const pluginsRef = useRef(plugins);
  const [toolbarContainer, setToolbarContainer] = useState<HTMLElement | null>(
    null,
  );
  const [sourceHeaderContainer, setSourceHeaderContainer] = useState<HTMLElement | null>(null);
  const { expandedId, handleExpandedChange } = useSingleExpandedRow();
  const localizedPluginTabs: { key: PluginTabKey; label: string }[] = [
    { key: "all", label: t("plugins.tabs.all") },
    { key: "claude-code", label: "Claude Code" },
    { key: "codex", label: "Codex" },
    { key: "cursor", label: "Cursor" },
  ];
  const pluginFilterOptions: PluginFilterOption[] = [
    { value: "all", label: t("plugins.filter.all") },
    { value: "enabled", label: t("plugins.filter.enabled") },
    { value: "disabled", label: t("plugins.filter.disabled") },
  ];

  useEffect(() => {
    pluginsRef.current = plugins;
  }, [plugins]);

  function commitPlugins(nextPlugins: PluginSummary[]) {
    if (!shouldUseFixtureData()) {
      cachePlugins(nextPlugins);
    }
    setPlugins(nextPlugins);
  }

  function mergePluginsByInstance(
    currentPlugins: PluginSummary[],
    updatedPlugins: PluginSummary[],
  ) {
    if (updatedPlugins.length === 0) {
      return currentPlugins;
    }

    const updatedPluginMap = new Map(
      updatedPlugins.map((plugin) => [getPluginInstanceKey(plugin), plugin]),
    );
    return currentPlugins.map((plugin) => (
      updatedPluginMap.get(getPluginInstanceKey(plugin)) ?? plugin
    ));
  }

  async function refreshPluginLocalStateInBackground(
    plugin: PluginSummary,
    isActive: () => boolean,
  ) {
    const refreshKey = getPluginInstanceKey(plugin);
    const existingRefresh = pluginLocalRefreshInFlightRef.current.get(refreshKey);
    if (existingRefresh) {
      await existingRefresh;
      return;
    }

    const refreshPromise = (async () => {
      try {
        const refreshedPlugin = await refreshLocalPluginState({
          hostTool: plugin.hostTool,
          rootPath: plugin.rootPath,
        });
        if (!isActive()) {
          return;
        }
        setPlugins((current) => current.map((candidate) => (
          getPluginInstanceKey(candidate) === refreshKey ? refreshedPlugin : candidate
        )));
      } catch (error) {
        console.warn("Failed to refresh plugin local state", error);
      } finally {
        pluginLocalRefreshInFlightRef.current.delete(refreshKey);
      }
    })();

    pluginLocalRefreshInFlightRef.current.set(refreshKey, refreshPromise);
    await refreshPromise;
  }

  async function refreshPluginStatesInBackground(
    isActive: () => boolean,
    options?: { minimumIntervalMs?: number; pluginsSnapshot?: PluginSummary[] },
  ) {
    const now = Date.now();
    const minimumIntervalMs = options?.minimumIntervalMs ?? 0;
    if (minimumIntervalMs > 0 && now - lastPluginAutoRefreshAtRef.current < minimumIntervalMs) {
      return pluginStateRefreshInFlightRef.current ?? Promise.resolve();
    }

    const existingRefresh = pluginStateRefreshInFlightRef.current;
    if (existingRefresh) {
      return existingRefresh;
    }

    const refreshTargets = (options?.pluginsSnapshot ?? pluginsRef.current).filter((plugin) => (
      plugin.installSource === "skilldock"
      && plugin.updateMode === "auto"
      && (plugin.updateStrategy === "git" || plugin.updateStrategy === "hash")
    ));
    if (refreshTargets.length === 0) {
      return;
    }

    lastPluginAutoRefreshAtRef.current = now;
    const refreshPromise = (async () => {
      try {
        const refreshedPlugins = await refreshPluginStates();
        if (!isActive()) {
          return;
        }
        setPlugins((current) => {
          const nextPlugins = mergePluginsByInstance(current, refreshedPlugins);
          if (!shouldUseFixtureData()) {
            cachePlugins(nextPlugins);
          }
          return nextPlugins;
        });
        setErrorMessage("");
      } catch (error) {
        console.warn("Failed to refresh plugin states in background", error);
      } finally {
        lastPluginAutoRefreshAtRef.current = Date.now();
        pluginStateRefreshInFlightRef.current = null;
      }
    })();

    pluginStateRefreshInFlightRef.current = refreshPromise;
    return refreshPromise;
  }

  async function alignPluginsLocalState() {
    if (localAlignInFlightRef.current) {
      return localAlignInFlightRef.current;
    }
    if (Date.now() - lastPluginLocalAlignAtRef.current < PLUGIN_LOCAL_ALIGN_COOLDOWN_MS) {
      return Promise.resolve(pluginsRef.current);
    }

    const alignPromise = fetchInstalledPlugins()
      .then((nextPlugins) => {
        lastPluginLocalAlignAtRef.current = Date.now();
        return nextPlugins;
      })
      .finally(() => {
        if (localAlignInFlightRef.current === alignPromise) {
          localAlignInFlightRef.current = null;
        }
      });

    localAlignInFlightRef.current = alignPromise;
    return alignPromise;
  }

  async function syncPluginsStartupState(
    isActive: () => boolean,
    options?: { minimumIntervalMs?: number },
  ) {
    const minimumIntervalMs = options?.minimumIntervalMs ?? 0;
    const now = Date.now();
    if (
      minimumIntervalMs > 0
      && now - lastStartupPluginSyncAtRef.current < minimumIntervalMs
    ) {
      return;
    }

    const existingSync = startupPluginSyncInFlightRef.current;
    if (existingSync) {
      return existingSync;
    }

    lastStartupPluginSyncAtRef.current = now;
    const syncPromise = fetchStartupInstalledPlugins()
      .then((nextPlugins) => {
        if (!isActive()) {
          return;
        }
        commitPlugins(nextPlugins);
        setErrorMessage("");
      })
      .catch((error) => {
        console.warn("Failed to align installed plugins from startup scan", error);
      })
      .finally(() => {
        startupPluginSyncInFlightRef.current = null;
      });

    startupPluginSyncInFlightRef.current = syncPromise;
    return syncPromise;
  }

  async function loadPlugins(options?: { silent?: boolean }) {
    const isSilent = options?.silent ?? false;
    if (isSilent) {
      if (getPluginScanSessionSnapshot().isScanning) {
        return activePluginScanPromise ?? Promise.resolve();
      }
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const nextPlugins = isSilent ? await startPluginStateRefreshImport() : await alignPluginsLocalState();
      commitPlugins(nextPlugins);
      setErrorMessage("");
    } catch (error) {
      console.warn("Failed to load installed plugins", error);
      setErrorMessage(t("plugins.error.scan"));
    } finally {
      if (isSilent) {
        setIsRefreshing(false);
      } else {
        setIsLoading(false);
      }
    }
  }

  async function reloadPlugins() {
    if (isReloading) {
      return;
    }

    setIsReloading(true);
    try {
      if (activeHost !== "all") {
        const refreshTargets = pluginsRef.current.filter(
          (plugin) => plugin.hostTool === activeHost,
        );
        const refreshedPlugins = await Promise.all(
          refreshTargets.map((plugin) => refreshLocalPluginState({
            hostTool: plugin.hostTool,
            rootPath: plugin.rootPath,
          })),
        );
        setPlugins((current) => {
          const nextPlugins = mergePluginsByInstance(current, refreshedPlugins);
          if (!shouldUseFixtureData()) {
            cachePlugins(nextPlugins);
          }
          return nextPlugins;
        });
        setErrorMessage("");
        return;
      }

      const nextPlugins = await alignPluginsLocalState();
      commitPlugins(nextPlugins);
      setErrorMessage("");
    } catch (error) {
      console.warn("Failed to refresh installed plugins", error);
      setErrorMessage(t("plugins.error.refresh"));
    } finally {
      setIsReloading(false);
    }
  }

  useEffect(() => {
    let shouldIgnore = false;

    void (async () => {
      const cachedPlugins = getRuntimeCachedPlugins();
      if (cachedPlugins && !shouldIgnore) {
        setPlugins(cachedPlugins);
        setIsLoading(false);
      }

      if (cachedPlugins) {
        const syncedPlugins = await syncPluginsStartupState(() => !shouldIgnore);
        if (!shouldUseFixtureData()) {
          void refreshPluginStatesInBackground(() => !shouldIgnore, {
            pluginsSnapshot: syncedPlugins ?? cachedPlugins,
          });
        }
        return;
      }

      if (getPluginScanSessionSnapshot().isScanning) {
        if (!shouldIgnore) {
          setIsLoading(false);
        }
        return;
      }

      try {
        const nextPlugins = await fetchStartupInstalledPlugins();
        if (!shouldIgnore) {
          commitPlugins(nextPlugins);
          setErrorMessage("");
          if (!shouldUseFixtureData()) {
            void refreshPluginStatesInBackground(() => !shouldIgnore, {
              pluginsSnapshot: nextPlugins,
            });
          }
          if (
            nextPlugins.length === 0 &&
            !getPluginScanSessionSnapshot().isScanning &&
            !hasCompletedFirstEmptyPluginsAutoScan()
          ) {
            markFirstEmptyPluginsAutoScanCompleted();
            void startPluginStateRefreshImport().then((refreshedPlugins) => {
              if (!shouldIgnore) {
                commitPlugins(refreshedPlugins);
                setErrorMessage("");
              }
            }).catch((refreshError) => {
              console.warn("Failed to refresh plugin states", refreshError);
              if (!shouldIgnore) {
                setErrorMessage(t("plugins.error.scan"));
              }
            });
          }
        }
      } catch (error) {
        console.warn("Failed to load installed plugins", error);
        if (!shouldIgnore) {
          setErrorMessage(t("plugins.error.scan"));
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

  useEffect(() => subscribePluginsChange((nextPlugins) => {
    if (nextPlugins && nextPlugins !== pluginsRef.current) {
      setPlugins(nextPlugins);
    }
  }), []);

  useEffect(() => subscribePluginScanSessionChange((session) => {
    setIsRefreshing(session.isScanning);
    if (session.plugins) {
      commitPlugins(session.plugins);
      setErrorMessage("");
    }
  }), []);

  useEffect(() => {
    if (shouldUseFixtureData()) {
      return;
    }

    let active = true;
    const refreshPluginStatesIfNeeded = () => {
      void refreshPluginStatesInBackground(
        () => active,
        { minimumIntervalMs: AUTO_PLUGIN_STATE_REFRESH_COOLDOWN_MS },
      );
    };
    const syncPluginStartupStateIfNeeded = () => {
      void syncPluginsStartupState(
        () => active,
        { minimumIntervalMs: STARTUP_PLUGIN_SYNC_COOLDOWN_MS },
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      syncPluginStartupStateIfNeeded();
      if (deferredHeavyRefreshTimerRef.current !== null) {
        window.clearTimeout(deferredHeavyRefreshTimerRef.current);
      }
      deferredHeavyRefreshTimerRef.current = window.setTimeout(() => {
        deferredHeavyRefreshTimerRef.current = null;
        refreshPluginStatesIfNeeded();
      }, PLUGIN_HEAVY_REFRESH_AFTER_STARTUP_SYNC_DELAY_MS);
    };
    const intervalId = window.setInterval(
      refreshPluginStatesIfNeeded,
      AUTO_PLUGIN_STATE_REFRESH_INTERVAL_MS,
    );
    const handleFocus = () => {
      syncPluginStartupStateIfNeeded();
      if (deferredHeavyRefreshTimerRef.current !== null) {
        window.clearTimeout(deferredHeavyRefreshTimerRef.current);
      }
      deferredHeavyRefreshTimerRef.current = window.setTimeout(() => {
        deferredHeavyRefreshTimerRef.current = null;
        refreshPluginStatesIfNeeded();
      }, PLUGIN_HEAVY_REFRESH_AFTER_STARTUP_SYNC_DELAY_MS);
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      if (deferredHeavyRefreshTimerRef.current !== null) {
        window.clearTimeout(deferredHeavyRefreshTimerRef.current);
        deferredHeavyRefreshTimerRef.current = null;
      }
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (shouldUseFixtureData()) {
      return;
    }

    let active = true;
    let unlisten: (() => void) | null = null;

    void subscribePluginLibraryChanges(({ changedPaths }) => {
      if (!active) {
        return;
      }

      if (pluginRefreshDebounceTimerRef.current !== null) {
        window.clearTimeout(pluginRefreshDebounceTimerRef.current);
      }

      pluginRefreshDebounceTimerRef.current = window.setTimeout(() => {
        pluginRefreshDebounceTimerRef.current = null;
        const changedPluginTargets = pluginsRef.current.filter((plugin) => {
          if (plugin.installSource !== "skilldock") {
            return false;
          }

          const packageRoot = plugin.repoRootPath?.trim() || plugin.rootPath?.trim();
          if (!packageRoot) {
            return false;
          }

          return changedPaths.some((changedPath) => changedPath.startsWith(packageRoot));
        });

        for (const plugin of changedPluginTargets) {
          void refreshPluginLocalStateInBackground(plugin, () => active);
        }
      }, PLUGIN_LIBRARY_CHANGE_DEBOUNCE_MS);
    }).then((cleanup) => {
      if (!active) {
        cleanup();
        return;
      }
      unlisten = cleanup;
    }).catch((error) => {
      console.error("Failed to subscribe to plugin library changes:", error);
    });

    return () => {
      active = false;
      if (unlisten) {
        unlisten();
      }
      if (pluginRefreshDebounceTimerRef.current !== null) {
        window.clearTimeout(pluginRefreshDebounceTimerRef.current);
        pluginRefreshDebounceTimerRef.current = null;
      }
      pluginLocalRefreshInFlightRef.current.clear();
    };
  }, [t]);

  useEffect(() => {
    setToolbarContainer(document.getElementById("plugins-header-toolbar-slot"));
    setSourceHeaderContainer(document.getElementById("plugins-source-header-slot"));
  }, []);

  useEffect(() => {
    props.onActiveHostChange?.(activeHost === "all" ? null : getHostLabel(activeHost));
    return () => props.onActiveHostChange?.(null);
  }, [activeHost, props.onActiveHostChange]);

  useEffect(() => {
    if (!actionErrorMessage) {
      return;
    }

    const timerId = window.setTimeout(() => setActionErrorMessage(""), 4500);
    return () => window.clearTimeout(timerId);
  }, [actionErrorMessage]);

  useEffect(() => {
    if (!previewState) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPreviewState(null);
        return;
      }

      const isSaveShortcut = event.key.toLowerCase() === "s" && (event.metaKey || event.ctrlKey);
      if (isSaveShortcut) {
        event.preventDefault();
        void handlePreviewSave();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [previewState, isPreviewSaving, previewViewMode, isPreviewDirty]);

  useEffect(() => {
    if (!deleteConfirmingPluginId) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDeleteConfirmingPluginId("");
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [deleteConfirmingPluginId]);

  useEffect(() => {
    if (plugins.length === 0) {
      return;
    }

    if (activeHost === "all") {
      return;
    }

    const hasActiveHostPlugins = plugins.some(
      (plugin) => plugin.hostTool === activeHost,
    );
    if (hasActiveHostPlugins) {
      return;
    }

    const firstHostWithPlugins = pluginTabs
      .filter((tab) => tab.key !== "all")
      .find((tab) =>
      plugins.some((plugin) => plugin.hostTool === tab.key),
    );
    if (firstHostWithPlugins) {
      setActiveHost(firstHostWithPlugins.key);
    }
  }, [activeHost, plugins]);

  const normalizedQuery = query.trim().toLowerCase();
  const scopedPlugins = (activeHost === "all"
    ? buildAllTabPlugins(plugins)
    : plugins.filter((plugin) => plugin.hostTool === activeHost))
    .sort(comparePlugins);
  const filterCounts: Record<PluginFilter, number> = {
    all: scopedPlugins.length,
    enabled: scopedPlugins.filter((plugin) => plugin.enabledState === "enabled").length,
    disabled: scopedPlugins.filter((plugin) => plugin.enabledState === "disabled").length,
  };
  const filteredPlugins = scopedPlugins.filter((plugin) => {
    if (filter === "enabled" && plugin.enabledState !== "enabled") {
      return false;
    }
    if (filter === "disabled" && plugin.enabledState !== "disabled") {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    const searchContent = [
      getPluginDisplayName(plugin),
      plugin.name,
      plugin.hostTool,
      plugin.sourceType,
      plugin.rootPath,
      plugin.repoRootPath,
      plugin.pluginRelativePath,
      plugin.manifestPath,
      plugin.installState,
      plugin.enabledState,
      plugin.collabStatus,
      plugin.statusText,
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
      aria-label={t("plugins.toolbar.aria")}
    >
      <label className="search-field search-field--header skill-search-field plugins-page__search">
        <span className="sr-only">{t("plugins.toolbar.searchLabel")}</span>
        <input
          type="search"
          placeholder={t("plugins.toolbar.searchPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="plugins-page__toolbar-actions">
        <label className="skill-status-filter plugins-page__toolbar-filter">
          <span className="sr-only">{t("plugins.toolbar.filterLabel")}</span>
          <span className="skill-status-filter__icon" aria-hidden="true">
            <FilterIcon />
          </span>
          <select
            aria-label={t("plugins.toolbar.filterLabel")}
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
          className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--refresh${isReloading ? " is-loading" : ""}`}
          type="button"
          onClick={() => void reloadPlugins()}
          disabled={isReloading}
        >
          <span aria-hidden="true" className="skills-toolbar-button__icon">
            <RefreshIcon isSpinning={isReloading} />
          </span>
          <span>{t("plugins.toolbar.refresh")}</span>
        </button>
        <button
          className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--refresh${isRefreshing ? " is-loading" : ""}`}
          type="button"
          onClick={() => void loadPlugins({ silent: true })}
          disabled={isRefreshing}
        >
          <span aria-hidden="true" className="skills-toolbar-button__icon">
            <ImportIcon isSpinning={isRefreshing} />
          </span>
          <span>{isRefreshing ? t("plugins.toolbar.scanning") : t("plugins.toolbar.scanImport")}</span>
        </button>
      </div>
      {props.onGoInstall ? <ToolbarGoInstallButton onClick={props.onGoInstall} /> : null}
    </section>
  );
  const sourceHeader = (
    <div className="skills-source-header">
      <div className="skills-source-tabs-row">
        <div className="skills-source-tabs" role="tablist" aria-label={t("plugins.tabs.aria")}>
          {localizedPluginTabs.map((tab) => {
            const selected = tab.key === activeHost;
            const count = tab.key === "all"
              ? buildAllTabPlugins(plugins).length
              : plugins.filter((plugin) => plugin.hostTool === tab.key).length;

            return (
              <button
                key={tab.key}
                className={`skills-source-tab${selected ? " is-selected" : ""}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={`${tab.label} ${count}`}
                title={tab.label}
                onClick={() => setActiveHost(tab.key)}
              >
                {tab.key === "all" ? <span>{t("plugins.tabs.all")}</span> : (
                  <PluginHostLogo hostTool={tab.key} label={tab.label} />
                )}
                <span className="skills-source-tab__count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="skills-source-divider" aria-hidden="true" />
    </div>
  );

  async function openComponentPreview(
    plugin: PluginSummary,
    component: PluginComponentSummary,
  ) {
    setPreviewViewMode("preview");
    setIsPreviewDirty(false);
    setPreviewCollapsedDirectories({});
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
      setPreviewCollapsedDirectories(buildInitialCollapsedDirectories(preview.entries, preview.path));
    } catch (error) {
      console.warn("Failed to load plugin component preview", error);
      setPreviewState({
        plugin,
        component,
        preview: null,
        isLoading: false,
        errorMessage: t("plugins.preview.error.load"),
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

  async function handlePreviewSave() {
    if (
      !previewState?.preview
      || isPreviewSaving
      || previewViewMode !== "edit"
    ) {
      return;
    }

    setIsPreviewSaving(true);
    try {
      const savedPreview = await savePluginComponentPreview({
        pluginRoot: previewState.plugin.rootPath,
        componentId: previewState.preview.path,
        assetType: previewState.component.assetType,
        content: previewState.preview.content,
      });
      setPreviewState((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          preview: savedPreview,
          errorMessage: "",
        };
      });
      setIsPreviewDirty(false);
    } catch (error) {
      console.warn("Failed to save plugin component preview", error);
      setPreviewState((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          errorMessage: t("plugins.preview.error.save"),
        };
      });
    } finally {
      setIsPreviewSaving(false);
    }
  }

  async function handlePluginEnabledChange(plugin: PluginSummary) {
    const pluginKey = getPluginInstanceKey(plugin);
    if (
      !canTogglePlugin(plugin)
      || pendingPluginToggleIdsRef.current.has(pluginKey)
      || deletingPluginIds.has(pluginKey)
    ) {
      return;
    }

    const targetPlugins = listPluginActionTargets(plugin, plugins, activeHost === "all")
      .filter((candidate) => canTogglePlugin(candidate));
    if (targetPlugins.length === 0) {
      return;
    }

    const enabled = plugin.enabledState !== "enabled";
    const targetPluginKeys = targetPlugins.map((candidate) => getPluginInstanceKey(candidate));
    for (const targetPluginKey of targetPluginKeys) {
      pendingPluginToggleIdsRef.current.add(targetPluginKey);
    }
    setPendingPluginToggleIds((current) => {
      const next = new Set(current);
      for (const targetPluginKey of targetPluginKeys) {
        next.add(targetPluginKey);
      }
      return next;
    });
    try {
      const updatedPlugins = await Promise.all(targetPlugins.map((targetPlugin) => setPluginEnabled({
        pluginId: targetPlugin.id,
        hostTool: targetPlugin.hostTool,
        rootPath: targetPlugin.rootPath,
        enabled,
      })));
      setPlugins((current) => {
        const updatedPluginMap = new Map(updatedPlugins.map((updatedPlugin) => [
          getPluginInstanceKey(updatedPlugin),
          updatedPlugin,
        ]));
        const nextPlugins = current.map((candidate) => (
          updatedPluginMap.get(getPluginInstanceKey(candidate)) ?? candidate
        ));
        if (!shouldUseFixtureData()) {
          cachePlugins(nextPlugins);
        }
        return nextPlugins;
      });
      setErrorMessage("");
      setActionErrorMessage("");
    } catch (error) {
      console.warn("Failed to update plugin enabled state", error);
      notify({
        message: enabled ? t("plugins.error.enable") : t("plugins.error.disable"),
        tone: "error",
      });
    } finally {
      for (const targetPluginKey of targetPluginKeys) {
        pendingPluginToggleIdsRef.current.delete(targetPluginKey);
      }
      setPendingPluginToggleIds((current) => {
        const next = new Set(current);
        for (const targetPluginKey of targetPluginKeys) {
          next.delete(targetPluginKey);
        }
        return next;
      });
    }
  }

  function handleTogglePreviewDirectory(path: string) {
    setPreviewCollapsedDirectories((current) => ({
      ...current,
      [path]: !current[path],
    }));
  }

  async function handleSelectPreviewFile(path: string) {
    if (
      !previewState
      || !previewState.preview
      || path === previewState.preview.path
      || isPreviewSaving
    ) {
      return;
    }

    const { plugin, component } = previewState;
    setPreviewState({
      plugin,
      component,
      preview: previewState.preview,
      isLoading: true,
      errorMessage: "",
    });

    try {
      const preview = await fetchPluginComponentPreview({
        pluginRoot: plugin.rootPath,
        componentId: path,
        assetType: component.assetType,
      });
      setPreviewState({
        plugin,
        component,
        preview,
        isLoading: false,
        errorMessage: "",
      });
      setPreviewCollapsedDirectories((current) => {
        const next = { ...current };
        for (const directoryPath of collectAncestorDirectoryPaths(path)) {
          next[directoryPath] = false;
        }
        return next;
      });
      setIsPreviewDirty(false);
    } catch (error) {
      console.warn("Failed to load plugin component preview file", error);
      setPreviewState((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          isLoading: false,
          errorMessage: t("plugins.preview.error.load"),
        };
      });
    }
  }

  async function runPluginUpdate(plugin: PluginSummary) {
    const pluginKey = getPluginInstanceKey(plugin);
    if (
      plugin.collabStatus !== "update-available"
      || pendingPluginUpdateIdsRef.current.has(pluginKey)
      || deletingPluginIds.has(pluginKey)
    ) {
      return;
    }

    pendingPluginUpdateIdsRef.current.add(pluginKey);
    setPendingPluginUpdateIds((current) => new Set(current).add(pluginKey));
    try {
      await waitForNextPaint();
      const updatedPlugin = await updatePlugin({
        pluginId: plugin.id,
        hostTool: plugin.hostTool,
        rootPath: plugin.rootPath,
      });
      setPlugins((current) => {
        const nextPlugins = current.map((candidate) =>
          candidate.id === updatedPlugin.id
          && candidate.hostTool === updatedPlugin.hostTool
          && candidate.rootPath === updatedPlugin.rootPath
            ? updatedPlugin
            : candidate,
        );
        if (!shouldUseFixtureData()) {
          cachePlugins(nextPlugins);
        }
        return nextPlugins;
      });
      setErrorMessage("");
      setActionErrorMessage("");
    } catch (error) {
      console.warn("Failed to update plugin", error);
      const errorMessage = getPluginActionErrorMessage(error, t("plugins.error.update"));
      setActionErrorMessage(errorMessage);
      notify({
        message: errorMessage,
        tone: "error",
      });
    } finally {
      pendingPluginUpdateIdsRef.current.delete(pluginKey);
      setPendingPluginUpdateIds((current) => {
        const next = new Set(current);
        next.delete(pluginKey);
        return next;
      });
    }
  }

  async function handlePluginUpdate(plugin: PluginSummary) {
    const targetPlugins = listPluginActionTargets(plugin, plugins, activeHost === "all");
    const actionablePlugins = targetPlugins.filter((candidate) => (
      candidate.collabStatus === "update-available"
    ));
    if (actionablePlugins.length === 0) {
      return;
    }
    if (
      actionablePlugins.some((candidate) =>
        candidate.updateStrategy === "hash" && candidate.localModified)
    ) {
      setUpdateConfirmingPlugin(plugin);
      return;
    }
    if (activeHost !== "all" || actionablePlugins.length === 1) {
      await runPluginUpdate(actionablePlugins[0] ?? plugin);
      return;
    }

    const targetPluginKeys = actionablePlugins.map((candidate) => getPluginInstanceKey(candidate));
    for (const targetPluginKey of targetPluginKeys) {
      pendingPluginUpdateIdsRef.current.add(targetPluginKey);
    }
    setPendingPluginUpdateIds((current) => {
      const next = new Set(current);
      for (const targetPluginKey of targetPluginKeys) {
        next.add(targetPluginKey);
      }
      return next;
    });
    try {
      await waitForNextPaint();
      const uniqueUpdateTargets = listUniquePluginUpdateTargets(actionablePlugins);
      await Promise.all(uniqueUpdateTargets.map((candidate) => updatePlugin({
        pluginId: candidate.id,
        hostTool: candidate.hostTool,
        rootPath: candidate.rootPath,
      })));
      const updatedPlugins = await Promise.all(actionablePlugins.map(async (candidate) => {
        try {
          return await refreshLocalPluginState({
            hostTool: candidate.hostTool,
            rootPath: candidate.rootPath,
          });
        } catch (refreshError) {
          console.warn("Failed to refresh plugin local state after update", refreshError);
          return candidate;
        }
      }));
      setPlugins((current) => {
        const updatedPluginMap = new Map(
          updatedPlugins.map((updatedPlugin) => [getPluginInstanceKey(updatedPlugin), updatedPlugin]),
        );
        const nextPlugins = current.map((candidate) => (
          updatedPluginMap.get(getPluginInstanceKey(candidate)) ?? candidate
        ));
        if (!shouldUseFixtureData()) {
          cachePlugins(nextPlugins);
        }
        return nextPlugins;
      });
      setErrorMessage("");
      setActionErrorMessage("");
    } catch (error) {
      console.warn("Failed to update plugin", error);
      const errorMessage = getPluginActionErrorMessage(error, t("plugins.error.update"));
      setActionErrorMessage(errorMessage);
      notify({
        message: errorMessage,
        tone: "error",
      });
    } finally {
      for (const targetPluginKey of targetPluginKeys) {
        pendingPluginUpdateIdsRef.current.delete(targetPluginKey);
      }
      setPendingPluginUpdateIds((current) => {
        const next = new Set(current);
        for (const targetPluginKey of targetPluginKeys) {
          next.delete(targetPluginKey);
        }
        return next;
      });
    }
  }

  async function handlePluginOpen(plugin: PluginSummary) {
    const availableTools = buildOpenToolOptions(toolConfigs, language);
    const availableToolIds = new Set(availableTools.map((tool) => tool.id));
    const resolvedOpenToolId = availableToolIds.has(defaultOpenToolId)
      ? defaultOpenToolId
      : availableTools[0]?.id ?? FALLBACK_OPEN_TOOL_ID;

    try {
      await openPluginInEditor({
        rootPath: getPluginOpenRootPath(plugin, activeHost, plugins),
        editorId: resolvedOpenToolId,
      });
      setActionErrorMessage("");
    } catch (error) {
      console.warn("Failed to open plugin folder with default tool", error);
      notify({
        message: t("plugins.error.open"),
        tone: "error",
      });
    }
  }

  async function handlePluginOpenInFinder(plugin: PluginSummary) {
    try {
      await openPathInFinder({ path: getPluginDirectoryPath(plugin, activeHost, plugins) });
      setActionErrorMessage("");
    } catch (error) {
      console.warn("Failed to open plugin folder", error);
      notify({
        message: t("plugins.error.openDirectory"),
        tone: "error",
      });
    }
  }

  async function handlePluginDelete(plugin: PluginSummary) {
    const pluginKey = getPluginInstanceKey(plugin);
    if (deletingPluginIds.has(pluginKey)) {
      return;
    }
    if (deleteConfirmingPluginId !== pluginKey) {
      setDeleteConfirmingPluginId(pluginKey);
      setActionErrorMessage("");
      return;
    }

    const targetPlugins = listPluginActionTargets(plugin, plugins, activeHost === "all");
    const targetPluginKeys = targetPlugins.map((candidate) => getPluginInstanceKey(candidate));
    setDeletingPluginIds((current) => {
      const next = new Set(current);
      for (const targetPluginKey of targetPluginKeys) {
        next.add(targetPluginKey);
      }
      return next;
    });
    try {
      for (const targetPlugin of targetPlugins) {
        await deletePlugin({
          pluginId: targetPlugin.id,
          hostTool: targetPlugin.hostTool,
          rootPath: targetPlugin.rootPath,
        });
      }
      setPlugins((current) => {
        const deletedPluginKeySet = new Set(targetPluginKeys);
        const nextPlugins = current.filter((candidate) => !deletedPluginKeySet.has(getPluginInstanceKey(candidate)));
        if (!shouldUseFixtureData()) {
          cachePlugins(nextPlugins);
        }
        return nextPlugins;
      });
      setPreviewState((current) =>
        current && targetPluginKeys.includes(getPluginInstanceKey(current.plugin)) ? null : current,
      );
      setExpandedComponentSections((current) => {
        const next = { ...current };
        for (const targetPluginKey of targetPluginKeys) {
          delete next[targetPluginKey];
        }
        return next;
      });
      handleExpandedChange(pluginKey, false);
      setActionErrorMessage("");
    } catch (error) {
      console.warn("Failed to delete plugin", error);
      notify({
        message: t("plugins.error.delete"),
        tone: "error",
      });
    } finally {
      setDeleteConfirmingPluginId("");
      setDeletingPluginIds((current) => {
        const next = new Set(current);
        for (const targetPluginKey of targetPluginKeys) {
          next.delete(targetPluginKey);
        }
        return next;
      });
    }
  }

  function toggleComponentSection(plugin: PluginSummary, assetType: PluginAssetType) {
    const pluginKey = getPluginInstanceKey(plugin);

    setExpandedComponentSections((current) => ({
      ...current,
      [pluginKey]: {
        ...current[pluginKey],
        [assetType]: !current[pluginKey]?.[assetType],
      },
    }));
  }

  function renderPluginDetails(plugin: PluginSummary) {
    const sourceValue = getPluginSourceValue(plugin);
    const pluginKey = getPluginInstanceKey(plugin);
    const expandedSections = expandedComponentSections[pluginKey] ?? {};
    const pluginDirectoryPath = getPluginDirectoryPath(plugin, activeHost, plugins);
    const pluginDisplayDirectoryPath = getPluginDisplayDirectoryPath(plugin, activeHost, plugins);
    const isAllTabAggregate = activeHost === "all";
    const showRemoteUpdateInfo = shouldShowPluginRemoteUpdateInfo(plugin);
    const relatedHostCoverageEntries = getPluginHostCoverageEntriesForSummary(
      plugin,
      plugins,
      activeHost === "all",
    );
    const shouldShowPluginMetadataGrid = !isAllTabAggregate;

    return (
      <div className="plugins-page__detail-panel">
        <section className="plugins-page__metadata-panel">
          <div className="plugins-page__metadata-header">
            <h3>{t("plugins.details.basicInfo")}</h3>
          </div>
          <dl className="detail-grid detail-grid--single">
            <div>
              <dt>{t("plugins.details.description")}</dt>
              <dd>{getPluginDescription(plugin, t)}</dd>
            </div>
          </dl>
          <dl className="detail-grid detail-grid--source plugins-page__source-grid">
            <div>
              <dt>{t("plugins.details.installMethod")}</dt>
              <dd>{getPluginInstallSourceLabel(plugin, t)}</dd>
            </div>
            <div>
              <dt>{t("plugins.details.sourceType")}</dt>
              <dd>{getPluginSourceTypeLabel(plugin, t)}</dd>
            </div>
            <div>
              <dt>{t("plugins.details.source")}</dt>
              <dd className="detail-grid__source-value">
                {isHttpUrl(sourceValue) ? (
                  <a
                    className="detail-grid__source-link detail-grid__single-line"
                    href={sourceValue}
                    onClick={(event) => {
                      event.preventDefault();
                      void openExternalLink(sourceValue);
                    }}
                  >
                    {sourceValue}
                  </a>
                ) : (
                  <span className="detail-grid__single-line">
                    {sourceValue}
                  </span>
                )}
                {shouldShowPluginGitBadge(plugin, sourceValue) ? (
                  <span className="detail-git-badge is-linked">git</span>
                ) : null}
              </dd>
            </div>
          </dl>
          {shouldShowPluginMetadataGrid ? (
            <dl className="tool-list-row__detail-grid plugins-page__metadata-grid">
              {!isAllTabAggregate ? (
                <div>
                  <dt>{t("plugins.details.pluginDirectory")}</dt>
                  <dd className="plugins-page__directory-value">
                    <span
                      className="plugins-page__directory-path"
                      title={pluginDisplayDirectoryPath}
                    >
                      {pluginDisplayDirectoryPath}
                    </span>
                    <button
                      type="button"
                      className="skill-card__icon-button plugins-page__directory-open-button"
                      aria-label={getPluginOpenInFinderActionAriaLabel(plugin, t)}
                      data-tooltip={t("plugins.action.openFolderInFinderTooltip")}
                      onClick={() => void handlePluginOpenInFinder(plugin)}
                      disabled={!pluginDirectoryPath}
                    >
                      <FolderIcon />
                    </button>
                  </dd>
                </div>
              ) : null}
              {!isAllTabAggregate && relatedHostCoverageEntries.length > 1 ? (
                <div>
                  <dt>{t("plugins.details.installedHosts")}</dt>
                  <dd>
                    {renderPluginHostCoverageList(relatedHostCoverageEntries, t)}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          <dl className="detail-grid detail-grid--single">
            {showRemoteUpdateInfo ? (
              <>
                <div>
                  <dt>{t("plugins.details.remoteUpdatedAt")}</dt>
                  <dd>{getPluginRemoteUpdatedAt(plugin, t)}</dd>
                </div>
                <div>
                  <dt>{t("plugins.details.lastEditor")}</dt>
                  <dd>{getPluginLastEditor(plugin, t)}</dd>
                </div>
              </>
            ) : null}
            <div>
              <dt>{t("plugins.details.localUpdatedAt")}</dt>
              <dd>{getPluginLocalUpdatedAt(plugin, t)}</dd>
            </div>
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
            const isComponentSectionExpanded = expandedSections[section.key] ?? false;
            const displayedComponents = isComponentSectionExpanded
              ? components
              : visibleComponents;

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
                  {displayedComponents.map((component) => (
                    <button
                      key={component.id}
                      className="plugins-page__component-row"
                      type="button"
                      onClick={() => void openComponentPreview(plugin, component)}
                    >
                      <span
                        className={`plugins-page__component-icon plugins-page__component-icon--${component.assetType}`}
                        aria-hidden="true"
                      >
                        <ComponentIcon assetType={component.assetType} />
                      </span>
                      <span className="plugins-page__component-copy">
                        <strong>{component.name}</strong>
                        <span>{getComponentDescription(component, t)}</span>
                      </span>
                      <span className="plugins-page__component-path">
                        {component.packageItemId || component.id}
                      </span>
                    </button>
                  ))}
                </div>
                {hiddenCount > 0 ? (
                  <button
                    className="plugins-page__component-more"
                    type="button"
                    aria-expanded={isComponentSectionExpanded}
                    onClick={() => toggleComponentSection(plugin, section.key)}
                  >
                    {isComponentSectionExpanded
                      ? t("plugins.components.showLess")
                      : t("plugins.components.viewMore", { count: hiddenCount })}
                  </button>
                ) : null}
              </section>
            );
          })}
          {plugin.components.length === 0 ? (
            <p className="plugins-page__component-empty">{t("plugins.components.empty")}</p>
          ) : null}
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="plugins-page">
        {toolbarContainer ? createPortal(toolbar, toolbarContainer) : toolbar}
        {sourceHeaderContainer ? createPortal(sourceHeader, sourceHeaderContainer) : sourceHeader}
        <p>{t("plugins.loading")}</p>
      </div>
    );
  }

  const selectedPreviewPath = previewState
    ? getPluginPreviewPath(previewState.preview, previewState.component)
    : "";
  const previewEntries = previewState?.preview?.entries ?? [];
  const previewFileEntries = previewEntries.filter((entry) => entry.entryType === "file");
  const visiblePreviewEntries = previewEntries.filter(
    (entry) => entry.depth === 0 || !hasCollapsedAncestor(entry, previewCollapsedDirectories),
  );
  const previewDirectoryChildCounts = new Map<string, number>();
  for (const entry of previewEntries) {
    if (!entry.path) {
      continue;
    }

    const parentPath = parentDirectoryPath(entry.path);
    previewDirectoryChildCounts.set(parentPath, (previewDirectoryChildCounts.get(parentPath) ?? 0) + 1);
  }

  return (
    <div className="skills-page plugins-page">
      {toolbarContainer ? createPortal(toolbar, toolbarContainer) : toolbar}
      {sourceHeaderContainer ? createPortal(sourceHeader, sourceHeaderContainer) : sourceHeader}
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
              {scopedPlugins.length === 0
                ? activeHost === "all"
                  ? t("plugins.empty.none")
                  : t("plugins.empty.hostNone", { host: getHostLabel(activeHost) })
                : t("plugins.empty.filteredTitle")}
            </h3>
            <p>
              {scopedPlugins.length === 0
                ? activeHost === "all"
                  ? t("plugins.empty.allDescription")
                  : t("plugins.empty.hostDescription", { host: getHostLabel(activeHost) })
                : t("plugins.empty.filteredDescription")}
            </p>
          </div>
        ) : (
          filteredPlugins.map((plugin) => {
            const pluginKey = getPluginInstanceKey(plugin);
            const pluginDisplayName = getPluginDisplayName(plugin);
            const isUpdatePending = isPluginActionPending(
              plugin,
              plugins,
              pendingPluginUpdateIds,
              activeHost === "all",
            );
            const isTogglePending = isPluginActionPending(
              plugin,
              plugins,
              pendingPluginToggleIds,
              activeHost === "all",
            );
            const isDeleting = deletingPluginIds.has(pluginKey);
            const isDeleteConfirming = deleteConfirmingPluginId === pluginKey;
            const deleteActionLabel = getPluginDeleteActionLabel(
              plugin,
              isDeleteConfirming,
              isDeleting,
              t,
            );
            const openActionLabel = getPluginOpenActionAriaLabel(plugin, t);
            const updateActionLabel = getPluginUpdateActionLabel(plugin, isUpdatePending, t);
            const collabBadge = getPluginCollabBadge(plugin, t);
            const componentSummaryBadges = getPluginComponentSummaryLabels(plugin).map((label) => ({
              label,
              tone: "info" as const,
            }));
            const hostCoverageEntries = activeHost === "all"
              ? getPluginHostCoverageEntriesForSummary(plugin, plugins)
              : [];
            const hostCoverageBadge = renderPluginHostCoverageBadge(plugin, hostCoverageEntries, t);

            return (
              <ToolListRow
                key={pluginKey}
                rowId={pluginKey}
                name={pluginDisplayName}
                subtitle={getPluginSubtitle(plugin, t)}
                leading={<PluginListIcon name={pluginDisplayName} />}
                badges={[
                  {
                    key: "enabled-state",
                    label: renderPluginEnabledBadge(plugin, t),
                    tone:
                      plugin.enabledState === "enabled" ? "positive" : "neutral",
                  },
                  ...componentSummaryBadges,
                  ...(hostCoverageBadge
                    ? [{ key: "host-coverage", label: hostCoverageBadge, tone: "neutral" as const }]
                    : []),
                ]}
                details={renderPluginDetails(plugin)}
                expanded={expandedId === pluginKey}
                onExpandedChange={(expanded, summaryElement) =>
                  handleExpandedChange(pluginKey, expanded, summaryElement)
                }
                expandLabel={language === "en" ? "Expand" : "展开"}
                collapseLabel={language === "en" ? "Collapse" : "收起"}
                actions={[
                  ...(collabBadge
                    ? [
                        {
                          key: "collab-status",
                          label: collabBadge.label,
                          className: "plugins-page__action-status",
                          content: (
                            <span className={`status-badge tone-${collabBadge.tone}`}>
                              {collabBadge.label}
                            </span>
                          ),
                        },
                      ]
                    : []),
                  ...(plugin.collabStatus === "update-available"
                    ? [
                        {
                          key: "update",
                          label: updateActionLabel,
                          ariaLabel: updateActionLabel,
                          className: "skill-card__icon-button skill-card__icon-button--update",
                          icon: <RefreshIcon isSpinning={isUpdatePending} variant="card" />,
                          tooltip: updateActionLabel,
                          onClick: () => void handlePluginUpdate(plugin),
                          disabled: isUpdatePending || isDeleting,
                        },
                      ]
                    : []),
                  {
                    key: "toggle-enabled",
                    label: getPluginToggleActionLabel(
                      plugin,
                      isTogglePending,
                      t,
                    ),
                    ariaLabel: getPluginToggleActionLabel(
                      plugin,
                      isTogglePending,
                      t,
                    ),
                    className: getPluginToggleButtonClassName(plugin),
                    icon: (
                      <PluginPowerIcon
                        isSpinning={isTogglePending}
                      />
                    ),
                    tooltip: getPluginToggleActionLabel(
                      plugin,
                      isTogglePending,
                      t,
                    ),
                    onClick: () => void handlePluginEnabledChange(plugin),
                    disabled:
                      isTogglePending || isDeleting || !canTogglePlugin(plugin),
                  },
                  {
                    key: "open-folder",
                    label: openActionLabel,
                    ariaLabel: openActionLabel,
                    className: "skill-card__icon-button",
                    icon: <OpenFolderIcon />,
                    tooltip: t("plugins.action.openFolderTooltip"),
                    onClick: () => void handlePluginOpen(plugin),
                    disabled: isDeleting || !plugin.rootPath.trim(),
                  },
                  isDeleteConfirming
                    ? {
                        key: "delete-confirm",
                        label: t("plugins.action.delete.confirm"),
                        ariaLabel: t("plugins.action.delete.confirmAria", { name: pluginDisplayName }),
                        className: "skill-card__delete-confirm-button",
                        tooltip: t("plugins.action.delete.confirmAria", { name: pluginDisplayName }),
                        onClick: () => void handlePluginDelete(plugin),
                        disabled: isDeleting,
                      }
                    : {
                        key: "delete",
                        label: deleteActionLabel,
                        ariaLabel: deleteActionLabel,
                        className: "skill-card__icon-button skill-card__icon-button--delete plugins-page__delete-icon-button",
                        icon: <DeleteIcon />,
                        tooltip: deleteActionLabel,
                        onClick: () => void handlePluginDelete(plugin),
                    disabled: isDeleting || isUpdatePending,
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
                  {getPluginDisplayName(previewState.plugin)} ·{" "}
                  {selectedPreviewPath}
                </p>
              </div>
              <div className="skill-file-dialog__toolbar">
                <div className="skill-file-dialog__actions">
                  <SkillFileViewModeToggle
                    viewMode={previewViewMode}
                    groupLabel={t("plugins.preview.viewMode")}
                    previewLabel={t("plugins.preview.preview")}
                    editLabel={t("plugins.preview.edit")}
                    onViewModeChange={setPreviewViewMode}
                  />
                  <button
                    className="secondary-button secondary-button--compact"
                    type="button"
                    onClick={() => void handlePreviewSave()}
                    disabled={
                      !previewState?.preview
                      || previewViewMode !== "edit"
                      || previewState.isLoading
                      || isPreviewSaving
                    }
                  >
                    <span aria-hidden="true">⌘</span>
                    <span>{isPreviewSaving ? t("plugins.preview.saving") : t("plugins.preview.save")}</span>
                  </button>
                </div>
                <button
                  className="skill-file-dialog__close"
                  type="button"
                  onClick={() => setPreviewState(null)}
                  aria-label={t("plugins.preview.close")}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="skill-file-dialog__body plugins-page__preview-body">
              <aside className="skill-file-dialog__sidebar">
                {visiblePreviewEntries.map((entry) =>
                  entry.entryType === "directory" ? (
                    entry.depth === 0 ? (
                      <div
                        key={`${entry.path}-${entry.entryType}`}
                        className="skill-file-dialog__tree-item skill-file-dialog__tree-item--directory is-root"
                        style={entryIndent(entry)}
                      >
                        <span aria-hidden="true">⌄</span>
                        <span>{entry.name}</span>
                      </div>
                    ) : (
                      <button
                        key={`${entry.path}-${entry.entryType}`}
                        className="skill-file-dialog__tree-item skill-file-dialog__tree-item--directory"
                        style={entryIndent(entry)}
                        type="button"
                        onClick={() => handleTogglePreviewDirectory(entry.path)}
                        aria-expanded={!previewCollapsedDirectories[entry.path]}
                        aria-label={t(previewCollapsedDirectories[entry.path] ? "skill.files.expand" : "skill.files.collapse", { name: entry.name })}
                      >
                        <span aria-hidden="true">
                          {previewDirectoryChildCounts.get(entry.path) ? (previewCollapsedDirectories[entry.path] ? "›" : "⌄") : "•"}
                        </span>
                        <span>{entry.name}</span>
                      </button>
                    )
                  ) : (
                    <button
                      key={entry.path}
                      className={`skill-file-dialog__tree-item skill-file-dialog__tree-item--file${
                        entry.path === selectedPreviewPath ? " is-selected" : ""
                      }`}
                      style={entryIndent(entry)}
                      type="button"
                      onClick={() => void handleSelectPreviewFile(entry.path)}
                    >
                      <span aria-hidden="true">📄</span>
                      <span>{entry.name}</span>
                    </button>
                  ),
                )}
              </aside>
              <section className="skill-file-dialog__editor">
                <SkillFileContentSurface
                  selectedPath={selectedPreviewPath}
                  content={previewState.preview?.content ?? ""}
                  viewMode={previewViewMode}
                  fileEntries={previewFileEntries}
                  isLoading={previewState.isLoading}
                  isSaving={false}
                  hasDirtyChanges={isPreviewDirty}
                  noEditableFileLabel={t("plugins.preview.noEditableFile")}
                  unsavedLabel={t("plugins.preview.unsaved")}
                  emptyLabel={t("plugins.preview.empty")}
                  emptyMarkdownLabel={t("plugins.preview.emptyMarkdown")}
                  onContentChange={updatePreviewContent}
                  onSelectFile={(path) => void handleSelectPreviewFile(path)}
                />
                {previewState.isLoading ? (
                  <p className="dialog-note">{t("plugins.preview.loading")}</p>
                ) : null}
                {previewState.errorMessage ? (
                  <p className="dialog-error">{previewState.errorMessage}</p>
                ) : null}
              </section>
            </div>
          </section>
        </div>
      ) : null}
      {updateConfirmingPlugin ? (
        <div
          className="dialog-backdrop plugins-page__preview-backdrop"
          role="presentation"
          onClick={() => setUpdateConfirmingPlugin(null)}
        >
          <section
            className="skill-file-dialog plugins-page__preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-update-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="skill-file-dialog__header">
              <div className="skill-file-dialog__title">
                <h3 id="plugin-update-confirm-title">更新将覆盖本地修改</h3>
                <p>{getPluginDisplayName(updateConfirmingPlugin)}</p>
              </div>
              <button
                className="skill-file-dialog__close"
                type="button"
                onClick={() => setUpdateConfirmingPlugin(null)}
                aria-label={t("notifications.close")}
              >
                ×
              </button>
            </div>
            <div className="skill-file-dialog__body plugins-page__preview-body">
              <p>这个插件目录存在本地修改。继续更新会用上游版本覆盖当前本地内容。</p>
            </div>
            <div className="skill-file-dialog__footer">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setUpdateConfirmingPlugin(null)}
              >
                取消
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  const plugin = updateConfirmingPlugin;
                  setUpdateConfirmingPlugin(null);
                  if (plugin) {
                    void runPluginUpdate(plugin);
                  }
                }}
              >
                继续更新
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
