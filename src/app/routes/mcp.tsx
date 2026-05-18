import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslate, type TranslationKey } from "@/app/i18n";
import { useNotifications } from "@/app/notifications";
import { BusinessError } from "@/app/errors";
import { useFailureReporter } from "@/app/failure-feedback";
import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";
import {
  deleteMcpServer,
  fetchMcpWorkspace,
  getMcpImportSessionSnapshot,
  importMcpServersFromApps,
  openExternalLink,
  refreshMcpServerTools,
  saveMcpServer,
  shouldUseFixtureData,
  startMcpServersImport,
  subscribeMcpImportSessionChange,
  toggleMcpServerApp,
  toggleMcpServerTool,
} from "@/features/skills/api/skill-client";
import type {
  McpAppStatus,
  McpServerRecord,
  McpServerSummary,
  McpTargetApp,
  McpWorkspaceSnapshot,
} from "@/features/skills/state/skill-store";
import { getToolDisplayRank, getToolLogoUrl } from "@/features/skills/utils/tool-logo";
import { getMonogramLabel } from "@/features/skills/utils/monogram";
import { formatSkillUpdatedAt } from "@/features/skills/utils/skill-time";
import {
  cacheMcpWorkspace,
  getCachedMcpWorkspace,
  subscribeMcpWorkspaceChange,
} from "@/features/skills/utils/mcp-workspace-cache";
import { isToolInstalledStatus } from "@/features/skills/utils/tool-status";

type McpFormState = {
  id: string;
  name: string;
  serverJson: string;
  enabledAppIds: string[];
};

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const MCP_CONFIG_PLACEHOLDER_PATTERN = /<[^>]*(?:YOUR|TOKEN|KEY|SECRET|PASSWORD|API)[^>]*>|^(?:your[_ -]?(?:api[_ -]?)?(?:key|token|secret|password)|replace[_ -]?me|change[_ -]?me|changeme|todo)$/i;
const MCP_MISSING_ENV_PATTERN = /缺少环境变量\s+([A-Z0-9_]+)/i;
const MCP_CONFIG_PARAM_FIELDS = ["env", "headers"];
const MCP_SUMMARY_APP_ICON_LIMIT = 7;

const EMPTY_FORM_STATE: McpFormState = {
  id: "",
  name: "",
  serverJson: "{\n  \"command\": \"npx\",\n  \"args\": []\n}",
  enabledAppIds: [],
};

function shouldAutoRefreshMcpTools(server: Pick<McpServerSummary, "tools" | "toolsDiscoveredAt" | "toolsDiscoveryError">) {
  return !server.toolsDiscoveredAt.trim()
    && !server.toolsDiscoveryError.trim();
}

function shouldRefreshFailedMcpTools(server: Pick<McpServerSummary, "toolsDiscoveryError">) {
  return !!server.toolsDiscoveryError.trim();
}

function shouldRefreshMcpToolsOnManualRefresh(
  server: Pick<McpServerSummary, "tools" | "toolsDiscoveredAt" | "toolsDiscoveryError">,
) {
  return shouldAutoRefreshMcpTools(server) || shouldRefreshFailedMcpTools(server);
}

function buildMcpFeedbackContext(workspace: McpWorkspaceSnapshot | null) {
  return {
    route: "mcp",
    storagePath: workspace?.storagePath ?? "",
    appConfigs: (workspace?.apps ?? []).map((app) => ({
      id: app.id,
      name: app.name,
      configPath: app.configPath,
      statusLabel: app.statusLabel,
    })),
    serverCount: workspace?.servers.length ?? 0,
    servers: (workspace?.servers ?? []).map((server) => ({
      id: server.id,
      name: server.name,
      serverType: server.serverType,
      enabledAppCount: server.enabledAppCount,
      toolsCount: server.tools.length,
      toolsDiscoveryError: server.toolsDiscoveryError,
    })),
  };
}

function buildFormState(server: McpServerSummary): McpFormState {
  return {
    id: server.id,
    name: server.name,
    serverJson: server.serverJson,
    enabledAppIds: server.apps.filter((app) => app.isEnabled).map((app) => app.appId),
  };
}

function parseServerJson(value: string, invalidJsonObjectMessage: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BusinessError(invalidJsonObjectMessage);
  }

  return parsed as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUnconfiguredMcpConfigValue(value: unknown) {
  if (value == null) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim();
  return normalized.length === 0 || MCP_CONFIG_PLACEHOLDER_PATTERN.test(normalized);
}

function collectUnconfiguredMcpParamNames(
  target: unknown,
  paramNames: Set<string>,
) {
  if (!isRecord(target)) {
    return;
  }

  for (const [name, value] of Object.entries(target)) {
    if (isUnconfiguredMcpConfigValue(value)) {
      paramNames.add(name);
    }
  }
}

function getMissingMcpEnvParamName(errorMessage: string) {
  const match = errorMessage.match(MCP_MISSING_ENV_PATTERN);
  return match?.[1] ?? "";
}

function getRequiredMcpConfigParamNames(server: McpServerSummary) {
  const paramNames = new Set<string>();
  try {
    const serverConfig = parseServerJson(server.serverJson, "MCP config must be a JSON object");
    for (const field of MCP_CONFIG_PARAM_FIELDS) {
      collectUnconfiguredMcpParamNames(serverConfig[field], paramNames);
    }
  } catch {
    // JSON errors are surfaced in the edit dialog; the list badge only handles valid saved config.
  }

  const missingEnvParamName = getMissingMcpEnvParamName(server.toolsDiscoveryError);
  if (missingEnvParamName) {
    paramNames.add(missingEnvParamName);
  }

  return Array.from(paramNames).sort();
}

function formatRequiredMcpConfigTooltip(paramNames: string[], t: Translate) {
  if (paramNames.length === 0) {
    return t("mcp.requiredParams");
  }

  return t("mcp.requiredParamsWithNames", { params: paramNames.join(", ") });
}

function normalizeServerJsonForSave(value: string): Record<string, unknown> {
  const server = parseServerJson(value, "MCP config must be a JSON object");
  if (typeof server.type === "string" && server.type.trim() === "stdio") {
    const { type: _type, ...serverWithoutDefaultType } = server;
    return serverWithoutDefaultType;
  }

  return server;
}

function normalizeMcpServerId(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "mcp-server";
}

function normalizeMcpServerName(value: string) {
  return value.trim().toLowerCase();
}

function buildUniqueMcpServerId(value: string, servers: McpServerSummary[]) {
  const baseId = normalizeMcpServerId(value);
  const usedIds = new Set(servers.map((server) => server.id));
  if (!usedIds.has(baseId)) {
    return baseId;
  }

  let suffix = 2;
  while (usedIds.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

function targetAppLabel(app: McpTargetApp, t: Translate) {
  return `${app.name}${isToolInstalledStatus(app.statusLabel) ? "" : ` ${t("mcp.app.notInstalled")}`}`;
}

function isMcpAppSupported(app: McpTargetApp | McpAppStatus) {
  return app.configPath.trim().length > 0;
}

function isMcpAppReady(app: McpTargetApp | McpAppStatus) {
  return isMcpAppSupported(app) && isToolInstalledStatus(app.statusLabel);
}

function formatMcpToolCountLabel(enabled: number, total: number, t: Translate) {
  return enabled === total
    ? t("mcp.card.toolsCount", { count: total })
    : t("mcp.card.toolsPartialCount", { enabled, total });
}

function formatMcpDescription(server: McpServerSummary, t: Translate) {
  const explicitDescription = server.description.trim();
  if (explicitDescription) {
    return explicitDescription;
  }

  const commandLabel = server.commandLabel || server.name;
  if (server.serverType === "stdio") {
    return t("mcp.description.stdio", { command: commandLabel });
  }
  if (server.serverType === "sse") {
    return t("mcp.description.sse", { command: commandLabel });
  }
  if (server.serverType === "http" || server.serverType === "streamable-http") {
    return t("mcp.description.http", { command: commandLabel });
  }

  return t("mcp.description.default", { name: server.name });
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function patchWorkspaceToolState(
  current: McpWorkspaceSnapshot | null,
  serverId: string,
  toolNames: string[],
  enabled: boolean,
) {
  if (!current || toolNames.length === 0) {
    return current;
  }

  const targetToolNames = new Set(toolNames);
  return {
    ...current,
    servers: current.servers.map((server) => (
      server.id === serverId
        ? {
            ...server,
            tools: server.tools.map((tool) => (
              targetToolNames.has(tool.name)
                ? { ...tool, isEnabled: enabled }
                : tool
            )),
          }
        : server
    )),
  };
}

function patchWorkspaceAppState(
  current: McpWorkspaceSnapshot | null,
  serverId: string,
  appIds: string[],
  enabled: boolean,
) {
  if (!current || appIds.length === 0) {
    return current;
  }

  const targetAppIds = new Set(appIds);
  return {
    ...current,
    servers: current.servers.map((server) => {
      if (server.id !== serverId) {
        return server;
      }

      const apps = server.apps.map((app) => (
        targetAppIds.has(app.appId) ? { ...app, isEnabled: enabled } : app
      ));
      return {
        ...server,
        enabledAppCount: apps.filter((app) => app.isEnabled).length,
        apps,
      };
    }),
  };
}

function McpServerMonogram({ server }: { server: McpServerSummary }) {
  const statusClassName = server.enabledAppCount > 0 ? "is-active" : "is-inactive";
  return (
    <div className="link-badge link-badge--mcp-monogram" aria-hidden="true">
      <span className="link-badge__type-mark link-badge__type-mark--mcp">
        <svg viewBox="0 0 12 12" fill="none">
          <path
            d="M4.2 4.2 2.8 5.6a2 2 0 0 0 2.8 2.8L7 7"
            stroke="currentColor"
            strokeWidth="1.45"
            strokeLinecap="round"
          />
          <path
            d="M7.8 7.8 9.2 6.4a2 2 0 0 0-2.8-2.8L5 5"
            stroke="currentColor"
            strokeWidth="1.45"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="link-badge__label">{getMonogramLabel(server.name || server.id)}</span>
      <span className={`link-badge__status-dot ${statusClassName}`} />
    </div>
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

function AddIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 4.75v10.5M4.75 10h10.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="m4.75 13.25-.5 2.5 2.5-.5 8.15-8.15a1.75 1.75 0 0 0-2.47-2.47L4.75 13.25Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m11.75 5.25 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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

function CollapseToolsIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className="mcp-server-card__tool-collapse-icon"
      viewBox="0 0 10 14"
      fill="none"
      aria-hidden="true"
    >
      {collapsed ? (
        <>
          <path d="M2 5 5 2l3 3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m2 9 3 3 3-3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <path d="m2 4 3 3 3-3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2 8 5 11l3-3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

type McpToolLogoProps = {
  appId: string;
  appName: string;
};

function compareAppsByDisplayOrder(left: { appId: string; appName: string }, right: { appId: string; appName: string }) {
  const rankDelta = getToolDisplayRank(left.appName) - getToolDisplayRank(right.appName);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  return left.appName.localeCompare(right.appName);
}

function McpToolLogo({ appId, appName }: McpToolLogoProps) {
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoUrl = getToolLogoUrl(appId);
  const fallbackLabel = appName.slice(0, 1).toUpperCase();

  if (!logoUrl || logoLoadFailed) {
    return (
      <span className="mcp-tool-logo" aria-hidden="true">
        {fallbackLabel}
      </span>
    );
  }

  return (
    <span className="mcp-tool-logo" aria-hidden="true">
      <img
        src={logoUrl}
        alt=""
        loading="lazy"
        onError={() => setLogoLoadFailed(true)}
      />
    </span>
  );
}

function McpEnabledAppSummary({ apps }: { apps: McpAppStatus[] }) {
  const { t } = useTranslate();
  const [showEnabledApps, setShowEnabledApps] = useState(false);
  const enabledApps = apps.filter((app) => app.isEnabled).sort(compareAppsByDisplayOrder);
  const visibleApps = enabledApps.slice(0, MCP_SUMMARY_APP_ICON_LIMIT);
  const hiddenAppCount = Math.max(enabledApps.length - visibleApps.length, 0);
  const summaryLabel = enabledApps.length > 0
    ? t("mcp.summary.enabledApps", { apps: enabledApps.map((app) => app.appName).join("、") })
    : t("mcp.summary.disabled");

  function handleEnabledAppsToggle(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (enabledApps.length === 0) {
      return;
    }

    setShowEnabledApps((value) => !value);
  }

  if (enabledApps.length === 0) {
    return (
      <button
        className="status-badge tone-info skill-card__enabled-toggle is-empty"
        type="button"
        aria-label={summaryLabel}
        disabled
      >
        {summaryLabel}
      </button>
    );
  }

  return (
    <>
      <button
        className="status-badge tone-info skill-card__enabled-toggle"
        type="button"
        onClick={handleEnabledAppsToggle}
        aria-expanded={showEnabledApps}
        aria-label={summaryLabel}
      >
        {t("mcp.summary.enabledCount", { count: enabledApps.length })}
      </button>
      {showEnabledApps ? (
        <span className="mcp-enabled-app-summary" aria-label={summaryLabel}>
          {visibleApps.map((app) => (
            <McpToolLogo key={app.appId} appId={app.appId} appName={app.appName} />
          ))}
          {hiddenAppCount > 0 ? (
            <span className="skill-card__tool-tag skill-card__tool-tag--extra">+{hiddenAppCount}</span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

type McpRouteProps = {
  onInstallFromMarketplace?: () => void;
};

export function McpRoute(props: McpRouteProps = {}) {
  const { t } = useTranslate();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const [workspace, setWorkspace] = useState<McpWorkspaceSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [editingServer, setEditingServer] = useState<McpServerSummary | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [pendingAppKey, setPendingAppKey] = useState("");
  const [pendingToolKey, setPendingToolKey] = useState("");
  const [importSession, setImportSession] = useState(getMcpImportSessionSnapshot);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [toolbarContainer, setToolbarContainer] = useState<HTMLElement | null>(null);
  const [expandedServerId, setExpandedServerId] = useState("");
  const [collapsedToolSectionIds, setCollapsedToolSectionIds] = useState<Record<string, boolean>>({});
  const [deleteConfirmingServerId, setDeleteConfirmingServerId] = useState("");
  const [deletingServerId, setDeletingServerId] = useState("");
  const [saveErrorMessage, setSaveErrorMessage] = useState("");
  const deleteActionRef = useRef<HTMLButtonElement | null>(null);
  const isMountedRef = useRef(false);
  const importActionLockedRef = useRef(false);
  const refreshActionLockedRef = useRef(false);
  const probingToolServerIdsRef = useRef(new Set<string>());

  function commitWorkspace(
    snapshot: McpWorkspaceSnapshot | null,
  ) {
    cacheMcpWorkspace(snapshot);
    startTransition(() => {
      setWorkspace(snapshot);
    });
  }

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  async function probeMcpTools(
    snapshot: McpWorkspaceSnapshot | null,
    predicate: (server: McpServerSummary) => boolean,
  ) {
    if (shouldUseFixtureData() || !snapshot) {
      return snapshot;
    }
    let nextSnapshot = snapshot;
    for (const server of snapshot.servers) {
      if (!predicate(server) || probingToolServerIdsRef.current.has(server.id)) {
        continue;
      }
      probingToolServerIdsRef.current.add(server.id);
      try {
        nextSnapshot = await refreshMcpServerTools(server.id);
        if (!isMountedRef.current) {
          cacheMcpWorkspace(nextSnapshot);
          return nextSnapshot;
        }
        commitWorkspace(nextSnapshot);
      } catch (error) {
        console.warn(`Failed to refresh MCP tools for ${server.id}`, error);
        const message = error instanceof Error ? error.message : t("mcp.toolsProbeFailed");
        const failedSnapshot: McpWorkspaceSnapshot = {
          ...(nextSnapshot ?? snapshot),
          servers: (nextSnapshot ?? snapshot)?.servers.map((item) => (
            item.id === server.id
              ? {
                  ...item,
                  tools: [],
                  toolsDiscoveredAt: new Date().toISOString(),
                  toolsDiscoveryError: message,
                }
              : item
          )) ?? [],
        };
        try {
          nextSnapshot = await saveMcpServer({
            id: server.id,
            name: server.name,
            server: normalizeServerJsonForSave(server.serverJson),
            description: server.description,
            sourceUrl: server.sourceUrl,
            enabledAppIds: server.apps.filter((app) => app.isEnabled).map((app) => app.appId),
            tools: [],
            toolsDiscoveredAt: new Date().toISOString(),
            toolsDiscoveryError: message,
            installedAt: server.installedAt,
            updatedAt: new Date().toISOString(),
          });
          if (!isMountedRef.current) {
            cacheMcpWorkspace(nextSnapshot);
            return nextSnapshot;
          }
          commitWorkspace(nextSnapshot);
        } catch (persistError) {
          console.warn(`Failed to persist MCP tools error for ${server.id}`, persistError);
          if (isMountedRef.current) {
            commitWorkspace(failedSnapshot);
          } else {
            cacheMcpWorkspace(failedSnapshot);
          }
          nextSnapshot = failedSnapshot;
        }
      } finally {
        probingToolServerIdsRef.current.delete(server.id);
      }
    }

    return nextSnapshot;
  }

  useEffect(() => {
    let active = true;

    async function loadWorkspace() {
      try {
        const cachedWorkspace = getCachedMcpWorkspace();
        if (active && cachedWorkspace) {
          commitWorkspace(cachedWorkspace);
        }
        const snapshot = await fetchMcpWorkspace();
        if (active) {
          commitWorkspace(snapshot);
          void probeMcpTools(snapshot, shouldAutoRefreshMcpTools);
        }
      } catch (error) {
        if (active) {
          const message = error instanceof Error ? error.message : t("mcp.loadFailed");
          setErrorMessage(message);
        }
      }
    }

    void loadWorkspace();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => subscribeMcpWorkspaceChange((snapshot) => {
    startTransition(() => {
      setWorkspace(snapshot);
    });
  }), []);

  useEffect(() => subscribeMcpImportSessionChange((snapshot) => {
    setImportSession(snapshot);
    if (snapshot.progress) {
      commitWorkspace(snapshot.progress.workspace);
    }
  }), []);

  useEffect(() => {
    setToolbarContainer(document.getElementById("mcp-header-toolbar-slot"));
  }, []);

  useEffect(() => {
    if (!deleteConfirmingServerId) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (deleteActionRef.current?.contains(event.target as Node)) {
        return;
      }
      setDeleteConfirmingServerId("");
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDeleteConfirmingServerId("");
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [deleteConfirmingServerId]);

  const filteredServers = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    const servers = workspace?.servers ?? [];
    if (!normalizedQuery) {
      return servers;
    }

    return servers.filter((server) => {
      const serverDescription = formatMcpDescription(server, t);
      const searchableText = [
        server.id,
        server.name,
        server.commandLabel,
        serverDescription,
        server.sourceUrl,
      ].join(" ").toLowerCase();
      return searchableText.includes(normalizedQuery);
    });
  }, [deferredQuery, workspace?.servers]);

  async function handleImport() {
    if (importSession.isImporting || importActionLockedRef.current) {
      return;
    }
    importActionLockedRef.current = true;

    setDeleteConfirmingServerId("");
    await waitForNextPaint();
    try {
      const count = await startMcpServersImport(importMcpServersFromApps);
      const snapshot = await fetchMcpWorkspace();
      if (isMountedRef.current) {
        commitWorkspace(snapshot);
      } else {
        cacheMcpWorkspace(snapshot);
      }
      await probeMcpTools(snapshot, shouldAutoRefreshMcpTools);
      notify({
        tone: "success",
        message: count > 0 ? t("mcp.import.added", { count }) : t("mcp.import.none"),
      });
    } catch (error) {
      reportFailure(error, {
        operation: "import_mcp_servers_from_apps",
        fallbackMessage: t("mcp.import.failed"),
        context: buildMcpFeedbackContext(workspace),
      });
    } finally {
      importActionLockedRef.current = false;
    }
  }

  async function handleRefreshWorkspace() {
    if (isRefreshing || refreshActionLockedRef.current) {
      return;
    }
    refreshActionLockedRef.current = true;

    setDeleteConfirmingServerId("");
    setIsRefreshing(true);
    await waitForNextPaint();
    try {
      const snapshot = await fetchMcpWorkspace();
      commitWorkspace(snapshot);
      await probeMcpTools(snapshot, shouldRefreshMcpToolsOnManualRefresh);
    } catch (error) {
      reportFailure(error, {
        operation: "refresh_mcp_workspace",
        fallbackMessage: t("mcp.refreshFailed"),
      });
    } finally {
      setIsRefreshing(false);
      refreshActionLockedRef.current = false;
    }
  }

  async function handleToggle(server: McpServerSummary, appId: string, enabled: boolean) {
    const key = `${server.id}:${appId}`;
    if (pendingAppKey || pendingToolKey) {
      return;
    }

    const previousWorkspace = workspace;
    setDeleteConfirmingServerId("");
    setPendingAppKey(key);
    commitWorkspace(patchWorkspaceAppState(previousWorkspace, server.id, [appId], enabled));
    try {
      const snapshot = await toggleMcpServerApp({
        serverId: server.id,
        appId,
        enabled,
      });
      commitWorkspace(snapshot);
    } catch (error) {
      commitWorkspace(previousWorkspace);
      reportFailure(error, {
        operation: "toggle_mcp_server_app",
        fallbackMessage: t("mcp.toggleFailed"),
        context: { serverId: server.id, appId, enabled },
      });
    } finally {
      setPendingAppKey("");
    }
  }

  async function handleToggleAllApps(server: McpServerSummary, apps: McpAppStatus[], enabled: boolean) {
    if (pendingAppKey || pendingToolKey) {
      return;
    }

    const targetApps = apps.filter((app) => app.isEnabled !== enabled);
    if (targetApps.length === 0) {
      return;
    }

    const targetAppIds = targetApps.map((app) => app.appId);
    const previousWorkspace = workspace;
    setDeleteConfirmingServerId("");
    setPendingAppKey(`${server.id}:apps:${enabled ? "enable" : "disable"}`);
    commitWorkspace(patchWorkspaceAppState(previousWorkspace, server.id, targetAppIds, enabled));
    await waitForNextPaint();
    try {
      let snapshot = workspace;
      for (const app of targetApps) {
        snapshot = await toggleMcpServerApp({
          serverId: server.id,
          appId: app.appId,
          enabled,
        });
      }
      commitWorkspace(patchWorkspaceAppState(snapshot, server.id, targetAppIds, enabled));
    } catch (error) {
      commitWorkspace(previousWorkspace);
      reportFailure(error, {
        operation: "toggle_all_mcp_server_apps",
        fallbackMessage: t("mcp.toggleAllAppsFailed"),
        context: { serverId: server.id, appIds: targetAppIds, enabled },
      });
    } finally {
      setPendingAppKey("");
    }
  }

  async function handleToggleTool(server: McpServerSummary, toolName: string, enabled: boolean) {
    const key = `${server.id}:tool:${toolName}`;
    if (pendingToolKey || pendingAppKey) {
      return;
    }

    const previousWorkspace = workspace;
    setDeleteConfirmingServerId("");
    setPendingToolKey(key);
    commitWorkspace(patchWorkspaceToolState(previousWorkspace, server.id, [toolName], enabled));
    try {
      const snapshot = await toggleMcpServerTool({
        serverId: server.id,
        toolName,
        enabled,
      });
      commitWorkspace(snapshot);
    } catch (error) {
      commitWorkspace(previousWorkspace);
      reportFailure(error, {
        operation: "toggle_mcp_server_tool",
        fallbackMessage: t("mcp.toggleToolFailed"),
        context: { serverId: server.id, toolName, enabled },
      });
    } finally {
      setPendingToolKey("");
    }
  }

  async function handleToggleAllTools(server: McpServerSummary, enabled: boolean) {
    if (pendingToolKey || pendingAppKey) {
      return;
    }

    const targetTools = server.tools.filter((tool) => tool.isEnabled !== enabled);
    if (targetTools.length === 0) {
      return;
    }

    const previousWorkspace = workspace;
    setDeleteConfirmingServerId("");
    setPendingToolKey(`${server.id}:tools:all`);
    commitWorkspace(
      patchWorkspaceToolState(
        previousWorkspace,
        server.id,
        targetTools.map((tool) => tool.name),
        enabled,
      ),
    );
    try {
      let snapshot = workspace;
      for (const tool of targetTools) {
        snapshot = await toggleMcpServerTool({
          serverId: server.id,
          toolName: tool.name,
          enabled,
        });
      }
      commitWorkspace(
        patchWorkspaceToolState(
          snapshot,
          server.id,
          targetTools.map((tool) => tool.name),
          enabled,
        ),
      );
    } catch (error) {
      commitWorkspace(previousWorkspace);
      reportFailure(error, {
        operation: "toggle_all_mcp_server_tools",
        fallbackMessage: t("mcp.toggleAllToolsFailed"),
        context: { serverId: server.id, toolNames: targetTools.map((tool) => tool.name), enabled },
      });
    } finally {
      setPendingToolKey("");
    }
  }

  async function handleDelete(server: McpServerSummary) {
    if (deletingServerId) {
      return;
    }

    if (deleteConfirmingServerId !== server.id) {
      setDeleteConfirmingServerId(server.id);
      return;
    }

    setDeleteConfirmingServerId("");
    setDeletingServerId(server.id);
    try {
      const snapshot = await deleteMcpServer(server.id);
      commitWorkspace(snapshot);
      notify({ tone: "success", message: t("mcp.deleteSuccess", { name: server.name }) });
    } catch (error) {
      reportFailure(error, {
        operation: "delete_mcp_server",
        fallbackMessage: t("mcp.deleteFailed"),
        context: { serverId: server.id },
      });
    } finally {
      setDeletingServerId("");
    }
  }

  async function handleSave(formState: McpFormState) {
    const name = normalizeMcpServerName(formState.name);
    const serverId = activeEditingServer?.id ?? buildUniqueMcpServerId(name, workspace?.servers ?? []);
    const serverRecord: McpServerRecord = {
      id: serverId,
      name,
      server: normalizeServerJsonForSave(formState.serverJson),
      description: activeEditingServer?.description ?? "",
      sourceUrl: activeEditingServer?.sourceUrl ?? "",
      enabledAppIds: formState.enabledAppIds,
      tools: activeEditingServer?.tools ?? [],
      toolsDiscoveredAt: activeEditingServer?.toolsDiscoveredAt ?? "",
      toolsDiscoveryError: activeEditingServer?.toolsDiscoveryError ?? "",
      installedAt: activeEditingServer?.installedAt ?? "",
      updatedAt: "",
    };
    try {
      const snapshot = await saveMcpServer(serverRecord);
      commitWorkspace(snapshot);
      setIsCreating(false);
      setEditingServer(null);
      setDeleteConfirmingServerId("");
      notify({ tone: "success", message: t("mcp.saveSuccess", { name: serverRecord.name }) });
    } catch (error) {
      reportFailure(error, {
        operation: "save_mcp_server",
        fallbackMessage: t("mcp.dialog.saveFailed"),
        context: { serverId, name: serverRecord.name },
      });
    }
  }

  function handleEdit(server: McpServerSummary) {
    if (deletingServerId) {
      return;
    }

    setDeleteConfirmingServerId("");
    setEditingServer(server);
  }

  function handleCreate() {
    setDeleteConfirmingServerId("");
    setIsCreating(true);
  }

  function handleCloseDialog() {
    setIsCreating(false);
    setEditingServer(null);
  }

  function toggleServerExpanded(serverId: string) {
    setExpandedServerId((current) => (current === serverId ? "" : serverId));
  }

  function toggleToolSectionCollapsed(serverId: string) {
    setCollapsedToolSectionIds((current) => ({
      ...current,
      [serverId]: !(current[serverId] ?? false),
    }));
  }

  const apps = workspace?.apps ?? [];
  const installedApps = apps.filter(isMcpAppReady);
  const installedAppIdSet = useMemo(
    () => new Set(installedApps.map((app) => app.id)),
    [installedApps],
  );
  const isDialogOpen = isCreating || editingServer !== null;
  const activeEditingServer = editingServer
    ? workspace?.servers.find((server) => server.id === editingServer.id) ?? editingServer
    : null;
  const formInitialState = useMemo(
    () => (activeEditingServer ? buildFormState(activeEditingServer) : EMPTY_FORM_STATE),
    [activeEditingServer],
  );
  const isImporting = importSession.isImporting;
  const importProgress = importSession.progress;
  const importButtonLabel = isImporting
    ? importProgress
      ? t("mcp.toolbar.scannedCount", { count: importProgress.scannedCount })
      : t("mcp.toolbar.scanning")
    : t("mcp.toolbar.scanImport");
  const toolbar = (
    <section className="mcp-toolbar skills-header-bar__tools" aria-label={t("mcp.toolbar.aria")}>
      <label className="search-field search-field--header mcp-toolbar__search">
        <span className="sr-only">{t("mcp.toolbar.search")}</span>
        <input
          type="search"
          placeholder={t("mcp.toolbar.searchPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <button
        className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--refresh${isRefreshing ? " is-loading" : ""}`}
        type="button"
        onClick={() => void handleRefreshWorkspace()}
        disabled={isRefreshing}
      >
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          <RefreshIcon isSpinning={isRefreshing} />
        </span>
        <span>{t("mcp.toolbar.refresh")}</span>
      </button>
      <button
        className="secondary-button secondary-button--compact skills-toolbar-button"
        type="button"
        onClick={() => void handleImport()}
        disabled={isImporting}
        aria-label={isImporting && importProgress
          ? t("mcp.toolbar.importProgress", {
              scanned: importProgress.scannedCount,
              imported: importProgress.importedCount,
            })
          : undefined}
      >
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          <ImportIcon isSpinning={isImporting} />
        </span>
        <span>{importButtonLabel}</span>
      </button>
      <button
        className="secondary-button secondary-button--compact skills-toolbar-button"
        type="button"
        onClick={handleCreate}
      >
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          <AddIcon />
        </span>
        <span>{t("mcp.toolbar.add")}</span>
      </button>
    </section>
  );

  return (
    <div className="mcp-route">
      {toolbarContainer ? createPortal(toolbar, toolbarContainer) : toolbar}

      {errorMessage ? <div className="dialog-error">{errorMessage}</div> : null}

      <section className="mcp-server-list card-list">
        {filteredServers.map((server) => {
          const isExpanded = expandedServerId === server.id;
          const isToolSectionCollapsed = collapsedToolSectionIds[server.id] ?? false;
          const visibleApps = server.apps
            .filter((app) => isMcpAppSupported(app))
            .filter((app) => installedAppIdSet.has(app.appId))
            .sort(compareAppsByDisplayOrder);
          const enabledVisibleAppCount = visibleApps.filter((app) => app.isEnabled).length;
          const disabledVisibleAppCount = visibleApps.length - enabledVisibleAppCount;
          const appBulkAction = pendingAppKey === `${server.id}:apps:enable`
            ? "enable"
            : pendingAppKey === `${server.id}:apps:disable`
              ? "disable"
              : null;
          const enabledToolCount = server.tools.filter((tool) => tool.isEnabled).length;
          const totalToolCount = server.tools.length;
          const disabledToolCount = totalToolCount - enabledToolCount;
          const toolSummaryLabel = totalToolCount > 0
            ? formatMcpToolCountLabel(enabledToolCount, totalToolCount, t)
            : server.toolsDiscoveryError
              ? t("mcp.card.toolsFetchFailed")
              : t("mcp.card.toolsUnknown");
          const serverDescription = formatMcpDescription(server, t);
          const isDeleteConfirming = deleteConfirmingServerId === server.id;
          const isDeleting = deletingServerId === server.id;
          const deleteConfirmTooltipLabel = isDeleting ? t("mcp.card.deleting") : t("mcp.card.deleteConfirmTooltip");
          const requiredConfigParamNames = getRequiredMcpConfigParamNames(server);
          const requiredConfigTooltip = formatRequiredMcpConfigTooltip(requiredConfigParamNames, t);

          return (
            <article key={server.id} className={`mcp-server-card${isExpanded ? " is-expanded" : ""}`}>
              <div className="mcp-server-card__header">
                <div
                  className="mcp-server-card__summary-button"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleServerExpanded(server.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleServerExpanded(server.id);
                    }
                  }}
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? t("mcp.card.collapse") : t("mcp.card.expand")} ${server.name}`}
                >
                  <div className="mcp-server-card__main">
                    <div className="mcp-server-card__identity">
                      <McpServerMonogram server={server} />
                      <div className="mcp-server-card__title-stack">
                        <div className="mcp-server-card__title-row">
                          <strong>{server.name}</strong>
                          <span className="status-badge tone-neutral">
                            {toolSummaryLabel}
                          </span>
                          <McpEnabledAppSummary apps={visibleApps} />
                          {requiredConfigParamNames.length > 0 ? (
                            <span
                              className="status-badge tone-warning"
                              data-tooltip={requiredConfigTooltip}
                            >
                              {t("mcp.card.configRequired")}
                            </span>
                          ) : null}
                        </div>
                        <div className="mcp-server-card__subtitle">
                          {serverDescription}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="skill-card__list-actions mcp-server-card__actions">
                  <button
                    className="skill-card__icon-button"
                    type="button"
                    onClick={() => handleEdit(server)}
                    aria-label={t("mcp.card.edit", { name: server.name })}
                    data-tooltip={t("mcp.card.editTooltip")}
                    disabled={Boolean(deletingServerId)}
                  >
                    <EditIcon />
                  </button>
                  {isDeleteConfirming || isDeleting ? (
                    <button
                      ref={deleteActionRef}
                      className="skill-card__delete-confirm-button"
                      type="button"
                      onClick={() => void handleDelete(server)}
                      aria-label={t("mcp.card.deleteConfirmAria", {
                        state: isDeleting ? t("mcp.card.deleting") : t("mcp.card.deleteConfirm"),
                        name: server.name,
                      })}
                      data-tooltip={deleteConfirmTooltipLabel}
                      disabled={isDeleting}
                    >
                      {isDeleting ? t("mcp.card.deleteLoading") : t("mcp.card.deleteConfirm")}
                    </button>
                  ) : (
                    <button
                      className="skill-card__icon-button skill-card__icon-button--delete"
                      type="button"
                      onClick={() => void handleDelete(server)}
                      aria-label={t("mcp.card.delete", { name: server.name })}
                      data-tooltip={t("mcp.card.deleteTooltip")}
                      disabled={Boolean(deletingServerId)}
                    >
                      <DeleteIcon />
                    </button>
                  )}
                  <span className="skill-card__chevron mcp-server-card__chevron" aria-hidden="true">
                    {isExpanded ? "⌄" : "›"}
                  </span>
                </div>
              </div>
              {isExpanded ? (
                <div className="mcp-server-card__details">
                  <section>
                    <div className="skill-card__section-header">
                      <h4>{t("mcp.card.basicInfo")}</h4>
                    </div>
                    <dl className="detail-grid detail-grid--single">
                      <div>
                        <dt>{t("mcp.card.description")}</dt>
                        <dd>{serverDescription}</dd>
                      </div>
                    </dl>
                    <dl className="detail-grid detail-grid--single">
                      <div>
                        <dt>{t("mcp.card.command")}</dt>
                        <dd className="detail-grid__single-line">
                          {server.commandLabel || server.id}
                        </dd>
                      </div>
                    </dl>
                    {server.sourceUrl || server.installedAt ? (
                      <dl className="detail-grid detail-grid--mcp-meta">
                        {server.installedAt ? (
                          <div>
                            <dt>{t("mcp.card.installedAt")}</dt>
                            <dd
                              className="detail-grid__single-line detail-grid__single-line--tooltip"
                              data-tooltip={formatSkillUpdatedAt(server.installedAt)}
                            >
                              {formatSkillUpdatedAt(server.installedAt)}
                            </dd>
                          </div>
                        ) : null}
                        {server.sourceUrl ? (
                          <div>
                            <dt>{t("mcp.card.source")}</dt>
                            <dd className="detail-grid__source-value">
                              {isHttpUrl(server.sourceUrl) ? (
                                <a
                                  className="detail-grid__source-link detail-grid__single-line"
                                  data-tooltip={server.sourceUrl}
                                  href={server.sourceUrl}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    void openExternalLink(server.sourceUrl);
                                  }}
                                >
                                  {server.sourceUrl}
                                </a>
                              ) : (
                                <span className="detail-grid__single-line" data-tooltip={server.sourceUrl}>
                                  {server.sourceUrl}
                                </span>
                              )}
                              <span className="detail-git-badge is-linked">git</span>
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    ) : null}
                  </section>
                  <section>
                    <div className="skill-card__section-header">
                      <h4>{t("mcp.card.enableApps")}</h4>
                      {visibleApps.length > 0 ? (
                        <div className="tool-sync-panel__actions">
                          <button
                            className="secondary-button secondary-button--compact"
                            type="button"
                            onClick={() => void handleToggleAllApps(server, visibleApps, true)}
                            disabled={Boolean(pendingAppKey) || Boolean(pendingToolKey) || disabledVisibleAppCount === 0}
                            aria-label={t("mcp.card.enableAllApps", { name: server.name })}
                          >
                            {appBulkAction === "enable" ? t("mcp.card.enabling") : t("mcp.card.enableAll")}
                          </button>
                          <button
                            className="secondary-button secondary-button--compact"
                            type="button"
                            onClick={() => void handleToggleAllApps(server, visibleApps, false)}
                            disabled={Boolean(pendingAppKey) || Boolean(pendingToolKey) || enabledVisibleAppCount === 0}
                            aria-label={t("mcp.card.disableAllApps", { name: server.name })}
                          >
                            {appBulkAction === "disable" ? t("mcp.card.disabling") : t("mcp.card.disableAll")}
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <div className="mcp-server-card__apps">
                      {visibleApps.map((app) => {
                        const isUpdating = pendingAppKey === `${server.id}:${app.appId}`;
                        const appTooltipLabel = app.isEnabled ? t("mcp.card.appEnabledTooltip") : t("mcp.card.appDisabledTooltip");

                        return (
                          <button
                            key={app.appId}
                            className={`tool-pill mcp-app-toggle${app.isEnabled ? " is-enabled" : ""}`}
                            type="button"
                            onClick={() => void handleToggle(server, app.appId, !app.isEnabled)}
                            disabled={isUpdating || appBulkAction !== null}
                            aria-pressed={app.isEnabled}
                            data-tooltip={appTooltipLabel}
                          >
                            <span className="tool-pill__logo">
                              <McpToolLogo appId={app.appId} appName={app.appName} />
                            </span>
                            <span className="tool-pill__name">{app.appName}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                  <section>
                    <div className="skill-card__section-header">
                      <div className="mcp-server-card__tool-header-row">
                        <div className="mcp-server-card__tool-header">
                          <h4>Tools</h4>
                          {totalToolCount > 0 ? (
                            <span className="mcp-server-card__tool-count">{formatMcpToolCountLabel(enabledToolCount, totalToolCount, t)}</span>
                          ) : null}
                          {totalToolCount > 0 ? (
                            <button
                              className="mcp-server-card__tool-collapse-button"
                              type="button"
                              onClick={() => toggleToolSectionCollapsed(server.id)}
                              aria-expanded={!isToolSectionCollapsed}
                              aria-controls={`mcp-tools-${server.id}`}
                              aria-label={isToolSectionCollapsed ? t("mcp.card.expandTools", { name: server.name }) : t("mcp.card.collapseTools", { name: server.name })}
                              data-tooltip={isToolSectionCollapsed ? t("mcp.card.expandToolsTooltip") : t("mcp.card.collapseToolsTooltip")}
                            >
                              <CollapseToolsIcon collapsed={isToolSectionCollapsed} />
                            </button>
                          ) : null}
                        </div>
                        {totalToolCount > 0 ? (
                          <div className="mcp-server-card__tool-actions">
                            <button
                              className="secondary-button secondary-button--compact"
                              type="button"
                              onClick={() => void handleToggleAllTools(server, true)}
                              disabled={Boolean(pendingToolKey) || disabledToolCount === 0}
                            >
                              {t("mcp.card.enableAll")}
                            </button>
                            <button
                              className="secondary-button secondary-button--compact"
                              type="button"
                              onClick={() => void handleToggleAllTools(server, false)}
                              disabled={Boolean(pendingToolKey) || enabledToolCount === 0}
                            >
                              {t("mcp.card.disableAll")}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {server.tools.length > 0 && !isToolSectionCollapsed ? (
                      <div
                        id={`mcp-tools-${server.id}`}
                        className="mcp-server-card__tool-list"
                        aria-label={`${server.name} tools`}
                      >
                        {server.tools.map((tool) => {
                          const isUpdating = pendingToolKey === `${server.id}:tool:${tool.name}`;

                          return (
                            <button
                              key={tool.name}
                              className={`mcp-server-card__tool-chip${tool.isEnabled ? " is-enabled" : ""}`}
                              type="button"
                              onClick={() => void handleToggleTool(server, tool.name, !tool.isEnabled)}
                              disabled={isUpdating || pendingToolKey === `${server.id}:tools:all`}
                              aria-pressed={tool.isEnabled}
                              data-tooltip={tool.isEnabled ? t("mcp.card.toolDisableTooltip") : t("mcp.card.toolEnableTooltip")}
                            >
                              {tool.name}
                            </button>
                          );
                        })}
                      </div>
                    ) : server.tools.length > 0 ? null : (
                      <p className="mcp-server-card__tool-empty">
                        {server.toolsDiscoveryError
                          ? t("mcp.card.toolsError", { message: server.toolsDiscoveryError })
                          : t("mcp.card.toolsEmpty")}
                      </p>
                    )}
                  </section>
                </div>
              ) : null}
            </article>
          );
        })}
        {workspace && filteredServers.length === 0 ? (
          <div className="panel-card empty-state">
            {workspace.servers.length === 0 ? (
              <>
                <h3>{t("mcp.empty.title")}</h3>
                <p>{t("mcp.empty.description")}</p>
                <div className="empty-state__actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void handleImport()}
                    disabled={isImporting}
                  >
                    {importButtonLabel}
                  </button>
                  <button className="secondary-button" type="button" onClick={props.onInstallFromMarketplace}>
                    {t("mcp.empty.market")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>{t("mcp.empty.noMatchTitle")}</h3>
                <p>{t("mcp.empty.noMatchDescription")}</p>
              </>
            )}
          </div>
        ) : null}
      </section>

      {isDialogOpen ? (
        <McpEditDialog
          apps={installedApps}
          initialState={formInitialState}
          isEditing={Boolean(editingServer)}
          onClose={handleCloseDialog}
          onSave={handleSave}
        />
      ) : null}
    </div>
  );
}

type McpEditDialogProps = {
  apps: McpTargetApp[];
  initialState: McpFormState;
  isEditing: boolean;
  onClose: () => void;
  onSave: (state: McpFormState) => Promise<void>;
};

function McpEditDialog(props: McpEditDialogProps) {
  const { apps, initialState, isEditing, onClose, onSave } = props;
  const { t } = useTranslate();
  const [formState, setFormState] = useState(initialState);
  const [errorMessage, setErrorMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setFormState(initialState);
    setErrorMessage("");
  }, [initialState]);

  function setEnabledApp(appId: string, enabled: boolean) {
    setFormState((current) => {
      const nextEnabledAppIds = enabled
        ? [...current.enabledAppIds, appId]
        : current.enabledAppIds.filter((item) => item !== appId);
      return {
        ...current,
        enabledAppIds: Array.from(new Set(nextEnabledAppIds)).sort(),
      };
    });
  }

  async function handleSubmit() {
    setErrorMessage("");
    if (!formState.name.trim()) {
      setErrorMessage(t("mcp.dialog.nameRequired"));
      return;
    }

    try {
      parseServerJson(formState.serverJson, t("mcp.error.invalidJsonObject"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("mcp.dialog.invalidJson");
      setErrorMessage(message);
      return;
    }

    setIsSaving(true);
    try {
      await onSave(formState);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("mcp.dialog.saveFailed");
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="mcp-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={isEditing ? t("mcp.dialog.editAria") : t("mcp.dialog.createAria")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mcp-edit-dialog__header">
          <h3>{isEditing ? t("mcp.dialog.editTitle") : t("mcp.dialog.createTitle")}</h3>
          <button
            className="tool-manage-dialog__close"
            type="button"
            onClick={onClose}
            aria-label={t("mcp.dialog.close")}
          >
            ×
          </button>
        </div>
        <div className="mcp-edit-dialog__body">
          <label className="mcp-form-field">
            <span>{t("mcp.dialog.name")}</span>
            <input
              value={formState.name}
              onChange={(event) => setFormState((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <div className="mcp-form-field">
            <span>{t("mcp.dialog.enabledApps")}</span>
            <div className="mcp-form-apps">
              {apps.filter((app) => isMcpAppSupported(app)).map((app) => {
                const checked = formState.enabledAppIds.includes(app.id);
                const disabled = !isMcpAppReady(app);

                return (
                  <label key={app.id} className={`mcp-form-app${checked ? " is-selected" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={(event) => setEnabledApp(app.id, event.target.checked)}
                    />
                    <McpToolLogo appId={app.id} appName={app.name} />
                    <span>{targetAppLabel(app, t)}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <label className="mcp-form-field">
            <span>{t("mcp.dialog.json")}</span>
            <textarea
              className="mcp-json-editor"
              value={formState.serverJson}
              spellCheck={false}
              onChange={(event) => setFormState((current) => ({ ...current, serverJson: event.target.value }))}
            />
          </label>
          {errorMessage ? <div className="dialog-error">{errorMessage}</div> : null}
        </div>
        <div className="mcp-edit-dialog__footer">
          <button
            className="secondary-button secondary-button--compact"
            type="button"
            onClick={onClose}
          >
            {t("mcp.dialog.cancel")}
          </button>
          <button
            className="primary-button primary-button--compact"
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSaving}
          >
            {isSaving ? t("mcp.dialog.saving") : t("mcp.dialog.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
