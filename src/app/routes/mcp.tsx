import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNotifications } from "@/app/notifications";
import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";
import {
  deleteMcpServer,
  fetchMcpWorkspace,
  importMcpServersFromApps,
  openExternalLink,
  refreshMcpServerTools,
  saveMcpServer,
  shouldUseFixtureData,
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
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";
import { getMonogramLabel } from "@/features/skills/utils/monogram";
import { formatSkillSourceLabel } from "@/features/skills/utils/skill-source";
import { formatSkillSourceLabel } from "@/features/skills/utils/skill-source";

type McpFormState = {
  id: string;
  name: string;
  serverJson: string;
  enabledAppIds: string[];
};

const EMPTY_FORM_STATE: McpFormState = {
  id: "",
  name: "",
  serverJson: "{\n  \"command\": \"npx\",\n  \"args\": []\n}",
  enabledAppIds: [],
};

function buildFormState(server: McpServerSummary): McpFormState {
  return {
    id: server.id,
    name: server.name,
    serverJson: server.serverJson,
    enabledAppIds: server.apps.filter((app) => app.isEnabled).map((app) => app.appId),
  };
}

function parseServerJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP 配置必须是 JSON 对象");
  }

  return parsed as Record<string, unknown>;
}

function normalizeServerJsonForSave(value: string): Record<string, unknown> {
  const server = parseServerJson(value);
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

function targetAppLabel(app: McpTargetApp) {
  return `${app.name}${app.statusLabel === "已安装" ? "" : "（未安装）"}`;
}

function isMcpAppSupported(app: McpTargetApp | McpAppStatus) {
  return app.configPath.trim().length > 0;
}

function isMcpAppReady(app: McpTargetApp | McpAppStatus) {
  return isMcpAppSupported(app) && app.statusLabel === "已安装";
}

function formatMcpDescription(server: McpServerSummary) {
  const explicitDescription = server.description.trim();
  if (explicitDescription) {
    return explicitDescription;
  }

  const commandLabel = server.commandLabel || server.name;
  if (server.serverType === "stdio") {
    return `通过本地命令 ${commandLabel} 启动的 MCP 服务。`;
  }
  if (server.serverType === "sse") {
    return `连接到 ${commandLabel} 的远程 SSE MCP 服务。`;
  }
  if (server.serverType === "http" || server.serverType === "streamable-http") {
    return `连接到 ${commandLabel} 的远程 HTTP MCP 服务。`;
  }

  return `用于向已安装工具同步 ${server.name} MCP 配置。`;
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

function McpServerMonogram({ server }: { server: McpServerSummary }) {
  const statusClassName = server.enabledAppCount > 0 ? "is-active" : "is-inactive";
  return (
    <div className="link-badge link-badge--mcp-monogram" aria-hidden="true">
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

export function McpRoute() {
  const { notify } = useNotifications();
  const [workspace, setWorkspace] = useState<McpWorkspaceSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [editingServer, setEditingServer] = useState<McpServerSummary | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [pendingAppKey, setPendingAppKey] = useState("");
  const [pendingToolKey, setPendingToolKey] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [toolbarContainer, setToolbarContainer] = useState<HTMLElement | null>(null);
  const [expandedServerIds, setExpandedServerIds] = useState<Record<string, boolean>>({});
  const [collapsedToolSectionIds, setCollapsedToolSectionIds] = useState<Record<string, boolean>>({});
  const [deleteConfirmingServerId, setDeleteConfirmingServerId] = useState("");
  const [deletingServerId, setDeletingServerId] = useState("");
  const deleteActionRef = useRef<HTMLButtonElement | null>(null);
  const toolsRefreshRef = useRef<Set<string>>(new Set());

  function commitWorkspace(snapshot: McpWorkspaceSnapshot | null) {
    startTransition(() => {
      setWorkspace(snapshot);
    });
  }

  useEffect(() => {
    let active = true;

    async function loadWorkspace() {
      try {
        const snapshot = await fetchMcpWorkspace();
        if (active) {
          commitWorkspace(snapshot);
        }
      } catch (error) {
        if (active) {
          const message = error instanceof Error ? error.message : "读取 MCP 配置失败";
          setErrorMessage(message);
        }
      }
    }

    void loadWorkspace();
    return () => {
      active = false;
    };
  }, []);

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
      const searchableText = `${server.id} ${server.name} ${server.commandLabel}`.toLowerCase();
      return searchableText.includes(normalizedQuery);
    });
  }, [deferredQuery, workspace?.servers]);

  useEffect(() => {
    if (shouldUseFixtureData()) {
      return;
    }
    const serverIds = (workspace?.servers ?? [])
      .filter((item) => item.tools.length === 0 && !item.toolsDiscoveredAt && !toolsRefreshRef.current.has(item.id))
      .map((item) => item.id);
    if (serverIds.length === 0) {
      return;
    }
    serverIds.forEach((serverId) => toolsRefreshRef.current.add(serverId));

    let active = true;
    async function refreshTools() {
      for (const serverId of serverIds) {
        try {
          const snapshot = await refreshMcpServerTools(serverId);
          if (!active) {
            return;
          }
          commitWorkspace(snapshot);
        } catch (error) {
          console.warn(`Failed to refresh MCP tools for ${serverId}`, error);
        }
      }
    }

    void refreshTools();
    return () => {
      active = false;
    };
  }, [workspace?.servers]);

  async function handleImport() {
    if (isImporting) {
      return;
    }

    setDeleteConfirmingServerId("");
    setIsImporting(true);
    try {
      const count = await importMcpServersFromApps();
      const snapshot = await fetchMcpWorkspace();
      commitWorkspace(snapshot);
      notify({
        tone: "success",
        message: count > 0 ? `已导入 ${count} 项 MCP 启用状态` : "没有发现新的 MCP 配置",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "导入 MCP 配置失败";
      notify({ tone: "error", message });
    } finally {
      setIsImporting(false);
    }
  }

  async function handleRefreshWorkspace() {
    if (isRefreshing) {
      return;
    }

    setDeleteConfirmingServerId("");
    setIsRefreshing(true);
    await waitForNextPaint();
    try {
      const snapshot = await fetchMcpWorkspace();
      commitWorkspace(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "刷新 MCP 配置失败";
      notify({ tone: "error", message });
    } finally {
      setIsRefreshing(false);
    }
  }

  async function handleToggle(server: McpServerSummary, appId: string, enabled: boolean) {
    const key = `${server.id}:${appId}`;
    if (pendingAppKey || pendingToolKey) {
      return;
    }

    setDeleteConfirmingServerId("");
    setPendingAppKey(key);
    try {
      const snapshot = await toggleMcpServerApp({
        serverId: server.id,
        appId,
        enabled,
      });
      commitWorkspace(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新 MCP 启用状态失败";
      notify({ tone: "error", message });
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
      const message = error instanceof Error ? error.message : "更新 MCP tool 启用状态失败";
      notify({ tone: "error", message });
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
      commitWorkspace(snapshot);
    } catch (error) {
      commitWorkspace(previousWorkspace);
      const message = error instanceof Error ? error.message : "批量更新 MCP tools 启用状态失败";
      notify({ tone: "error", message });
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
      notify({ tone: "success", message: `已删除 ${server.name}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除 MCP 失败";
      notify({ tone: "error", message });
    } finally {
      setDeletingServerId("");
    }
  }

  async function handleSave(formState: McpFormState) {
    const name = formState.name.trim();
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
      updatedAt: "",
    };
    const snapshot = await saveMcpServer(serverRecord);
    commitWorkspace(snapshot);
    setIsCreating(false);
    setEditingServer(null);
    setDeleteConfirmingServerId("");
    notify({ tone: "success", message: `已保存 ${serverRecord.name}` });
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
    setExpandedServerIds((current) => ({
      ...current,
      [serverId]: !(current[serverId] ?? false),
    }));
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
  const toolbar = (
    <section className="mcp-toolbar skills-header-bar__tools" aria-label="MCP 工具栏">
      <label className="search-field search-field--header mcp-toolbar__search">
        <span className="sr-only">搜索 MCP</span>
        <input
          type="search"
          placeholder="搜索 MCP 名称、命令或地址..."
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
        <span>刷新</span>
      </button>
      <button
        className="secondary-button secondary-button--compact skills-toolbar-button"
        type="button"
        onClick={() => void handleImport()}
        disabled={isImporting}
      >
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          <ImportIcon isSpinning={isImporting} />
        </span>
        <span>{isImporting ? "导入中..." : "扫描导入"}</span>
      </button>
      <button
        className="secondary-button secondary-button--compact skills-toolbar-button"
        type="button"
        onClick={handleCreate}
      >
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          <AddIcon />
        </span>
        <span>新增 MCP</span>
      </button>
    </section>
  );

  return (
    <div className="mcp-route">
      {toolbarContainer ? createPortal(toolbar, toolbarContainer) : toolbar}

      {errorMessage ? <div className="dialog-error">{errorMessage}</div> : null}

      <section className="mcp-server-list card-list">
        {filteredServers.map((server) => {
          const isExpanded = expandedServerIds[server.id] ?? false;
          const isToolSectionCollapsed = collapsedToolSectionIds[server.id] ?? false;
          const visibleApps = server.apps.filter((app) => installedAppIdSet.has(app.appId));
          const enabledVisibleAppCount = visibleApps.filter((app) => app.isEnabled).length;
          const enabledToolCount = server.tools.filter((tool) => tool.isEnabled).length;
          const totalToolCount = server.tools.length;
          const disabledToolCount = totalToolCount - enabledToolCount;
          const toolSummaryLabel = totalToolCount > 0
            ? enabledToolCount === totalToolCount
              ? `${enabledToolCount} tools`
              : `${enabledToolCount}/${totalToolCount} tools`
            : "未获取 tools";
          const enabledAppSummaryLabel = enabledVisibleAppCount > 0
            ? `已启用 ${enabledVisibleAppCount}`
            : "未启用";
          const serverDescription = formatMcpDescription(server);
          const isDeleteConfirming = deleteConfirmingServerId === server.id;
          const isDeleting = deletingServerId === server.id;
          const deleteConfirmTooltipLabel = isDeleting ? "正在删除" : "再次点击删除";
          const sourceTypeLabel = formatSkillSourceLabel("自定义仓库", {
            sourceUrl: server.sourceUrl,
          });
          const sourceTypeLabel = formatSkillSourceLabel("自定义仓库", {
            sourceUrl: server.sourceUrl,
          });

          return (
            <article key={server.id} className={`mcp-server-card${isExpanded ? " is-expanded" : ""}`}>
              <div className="mcp-server-card__header">
                <button
                  className="mcp-server-card__summary-button"
                  type="button"
                  onClick={() => toggleServerExpanded(server.id)}
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? "收起" : "展开"} ${server.name}`}
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
                          <span className="status-badge tone-info">
                            {enabledAppSummaryLabel}
                          </span>
                        </div>
                        <div
                          className="mcp-server-card__subtitle"
                          data-tooltip={server.commandLabel || server.id}
                        >
                          {server.commandLabel || server.id}
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
                <div className="skill-card__list-actions mcp-server-card__actions">
                  <button
                    className="skill-card__icon-button"
                    type="button"
                    onClick={() => handleEdit(server)}
                    aria-label={`编辑 ${server.name}`}
                    data-tooltip="编辑 MCP"
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
                      aria-label={`${isDeleting ? "正在删除" : "确认删除"} ${server.name}`}
                      data-tooltip={deleteConfirmTooltipLabel}
                      disabled={isDeleting}
                    >
                      {isDeleting ? "删除中" : "确认"}
                    </button>
                  ) : (
                    <button
                      className="skill-card__icon-button skill-card__icon-button--delete"
                      type="button"
                      onClick={() => void handleDelete(server)}
                      aria-label={`删除 ${server.name}`}
                      data-tooltip="删除 MCP"
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
                      <h4>基本信息</h4>
                    </div>
                    <dl className="detail-grid detail-grid--single">
                      <div>
                        <dt>简介</dt>
                        <dd>{serverDescription}</dd>
                      </div>
                    </dl>
                    <dl className="detail-grid detail-grid--single">
                      <div>
                        <dt>完整命令</dt>
                        <dd
                          className="detail-grid__single-line detail-grid__single-line--tooltip"
                          data-tooltip={server.commandLabel || server.id}
                        >
                          {server.commandLabel || server.id}
                        </dd>
                      </div>
                    </dl>
                    {server.sourceUrl ? (
                      <dl className="detail-grid detail-grid--source">
                        <div>
                          <dt>来源类型</dt>
                          <dd>{sourceTypeLabel}</dd>
                        </div>
                        <div>
                          <dt>来源</dt>
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
                      </dl>
                    ) : null}
                  </section>
                  <section>
                    <div className="skill-card__section-header">
                      <h4>启用到工具</h4>
                    </div>
                    <div className="mcp-server-card__apps">
                      {visibleApps.map((app) => {
                        const isUpdating = pendingAppKey === `${server.id}:${app.appId}`;
                        const appTooltipLabel = app.isEnabled ? "已启用，点击关闭" : "未启用，点击启用";

                        return (
                          <button
                            key={app.appId}
                            className={`tool-pill mcp-app-toggle${app.isEnabled ? " is-enabled" : ""}`}
                            type="button"
                            onClick={() => void handleToggle(server, app.appId, !app.isEnabled)}
                            disabled={isUpdating}
                            aria-pressed={app.isEnabled}
                            data-tooltip={appTooltipLabel}
                          >
                            <span className="tool-pill__logo">
                              <McpToolLogo appId={app.appId} appName={app.appName} />
                            </span>
                            <span className="tool-pill__name">{isUpdating ? "处理中" : app.appName}</span>
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
                            <span className="mcp-server-card__tool-count">{enabledToolCount}/{totalToolCount} 已启用</span>
                          ) : null}
                          {totalToolCount > 0 ? (
                            <button
                              className="mcp-server-card__tool-collapse-button"
                              type="button"
                              onClick={() => toggleToolSectionCollapsed(server.id)}
                              aria-expanded={!isToolSectionCollapsed}
                              aria-controls={`mcp-tools-${server.id}`}
                              aria-label={`${isToolSectionCollapsed ? "展开" : "收起"} ${server.name} Tools`}
                              data-tooltip={isToolSectionCollapsed ? "展开 Tools" : "收起 Tools"}
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
                              全部开启
                            </button>
                            <button
                              className="secondary-button secondary-button--compact"
                              type="button"
                              onClick={() => void handleToggleAllTools(server, false)}
                              disabled={Boolean(pendingToolKey) || enabledToolCount === 0}
                            >
                              全部关闭
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
                              data-tooltip={tool.isEnabled ? "点击关闭" : "点击开启"}
                            >
                              {tool.name}
                            </button>
                          );
                        })}
                      </div>
                    ) : server.tools.length > 0 ? null : (
                      <p className="mcp-server-card__tool-empty">暂未获取到该 MCP 的 tools。</p>
                    )}
                  </section>
                </div>
              ) : null}
            </article>
          );
        })}
        {workspace && filteredServers.length === 0 ? (
          <div className="panel-card empty-state">
            <h3>暂无匹配的 MCP</h3>
            <p>调整搜索词，或扫描导入已有工具配置后再查看。</p>
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
      setErrorMessage("名称不能为空");
      return;
    }

    try {
      parseServerJson(formState.serverJson);
    } catch (error) {
      const message = error instanceof Error ? error.message : "JSON 格式无效";
      setErrorMessage(message);
      return;
    }

    setIsSaving(true);
    try {
      await onSave(formState);
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存 MCP 失败";
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
        aria-label={isEditing ? "编辑 MCP" : "新增 MCP"}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mcp-edit-dialog__header">
          <h3>{isEditing ? "编辑 MCP" : "新增 MCP"}</h3>
          <button
            className="tool-manage-dialog__close"
            type="button"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <div className="mcp-edit-dialog__body">
          <label className="mcp-form-field">
            <span>名称</span>
            <input
              value={formState.name}
              onChange={(event) => setFormState((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <div className="mcp-form-field">
            <span>启用软件</span>
            <div className="mcp-form-apps">
              {apps.map((app) => {
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
                    <span>{isMcpAppSupported(app) ? targetAppLabel(app) : `${app.name}（暂未支持）`}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <label className="mcp-form-field">
            <span>JSON 配置</span>
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
            取消
          </button>
          <button
            className="primary-button primary-button--compact"
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSaving}
          >
            {isSaving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
