import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNotifications } from "@/app/notifications";
import {
  deleteMcpServer,
  fetchMcpWorkspace,
  importMcpServersFromApps,
  saveMcpServer,
  toggleMcpServerApp,
} from "@/features/skills/api/skill-client";
import type {
  McpAppStatus,
  McpServerRecord,
  McpServerSummary,
  McpTargetApp,
  McpWorkspaceSnapshot,
} from "@/features/skills/state/skill-store";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";

type McpFormState = {
  id: string;
  name: string;
  serverJson: string;
  enabledAppIds: string[];
};

const EMPTY_FORM_STATE: McpFormState = {
  id: "",
  name: "",
  serverJson: "{\n  \"type\": \"stdio\",\n  \"command\": \"npx\",\n  \"args\": []\n}",
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

function sourceLabelForMcpSource(sourceUrl: string) {
  if (sourceUrl.includes("github.com")) {
    return "GitHub";
  }
  if (sourceUrl.includes("gitlab.com")) {
    return "GitLab";
  }
  if (sourceUrl.includes("gitee.com")) {
    return "Gitee";
  }
  return "仓库";
}

function McpServerTypeIcon({ serverType }: { serverType: string }) {
  if (serverType === "stdio") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M4.25 5.25h11.5v9.5H4.25v-9.5Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="m6.75 8 2 2-2 2M10.25 12h3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M7.25 10a2.75 2.75 0 1 1-1.1-2.2l1.45 1.1M12.75 10a2.75 2.75 0 1 0 1.1-2.2l-1.45 1.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 10h5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
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
  const [updatingKey, setUpdatingKey] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [toolbarContainer, setToolbarContainer] = useState<HTMLElement | null>(null);
  const [expandedServerIds, setExpandedServerIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let active = true;

    async function loadWorkspace() {
      try {
        const snapshot = await fetchMcpWorkspace();
        if (active) {
          setWorkspace(snapshot);
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

  async function handleImport() {
    if (isImporting) {
      return;
    }

    setIsImporting(true);
    try {
      const count = await importMcpServersFromApps();
      const snapshot = await fetchMcpWorkspace();
      setWorkspace(snapshot);
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

  async function handleToggle(server: McpServerSummary, appId: string, enabled: boolean) {
    const key = `${server.id}:${appId}`;
    if (updatingKey) {
      return;
    }

    setUpdatingKey(key);
    try {
      const snapshot = await toggleMcpServerApp({
        serverId: server.id,
        appId,
        enabled,
      });
      setWorkspace(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新 MCP 启用状态失败";
      notify({ tone: "error", message });
    } finally {
      setUpdatingKey("");
    }
  }

  async function handleDelete(server: McpServerSummary) {
    if (!window.confirm(`删除 MCP：${server.name}？`)) {
      return;
    }

    try {
      const snapshot = await deleteMcpServer(server.id);
      setWorkspace(snapshot);
      notify({ tone: "success", message: `已删除 ${server.name}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除 MCP 失败";
      notify({ tone: "error", message });
    }
  }

  async function handleSave(formState: McpFormState) {
    const serverRecord: McpServerRecord = {
      id: formState.id.trim(),
      name: formState.name.trim() || formState.id.trim(),
      server: parseServerJson(formState.serverJson),
      description: editingServer?.description ?? "",
      sourceUrl: editingServer?.sourceUrl ?? "",
      enabledAppIds: formState.enabledAppIds,
      updatedAt: "",
    };
    const snapshot = await saveMcpServer(serverRecord);
    setWorkspace(snapshot);
    setIsCreating(false);
    setEditingServer(null);
    notify({ tone: "success", message: `已保存 ${serverRecord.name}` });
  }

  function toggleServerExpanded(serverId: string) {
    setExpandedServerIds((current) => ({
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
  const formInitialState = editingServer ? buildFormState(editingServer) : EMPTY_FORM_STATE;
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
        className="secondary-button secondary-button--compact skills-toolbar-button"
        type="button"
        onClick={() => void handleImport()}
        disabled={isImporting}
      >
        {isImporting ? "导入中..." : "扫描导入"}
      </button>
      <button
        className="primary-button primary-button--compact skills-toolbar-button"
        type="button"
        onClick={() => setIsCreating(true)}
      >
        新增 MCP
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
          const visibleApps = server.apps.filter((app) => installedAppIdSet.has(app.appId));
          const serverDescription = formatMcpDescription(server);

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
                      <div className={`link-badge ${server.serverType === "stdio" ? "link-badge--local" : "link-badge--market"}`} aria-hidden="true">
                        <McpServerTypeIcon serverType={server.serverType} />
                      </div>
                      <div className="mcp-server-card__title-stack">
                        <div className="mcp-server-card__title-row">
                          <strong>{server.name}</strong>
                          <span className="status-badge tone-neutral">{server.serverType}</span>
                          <span className="status-badge tone-info">已启用 {server.enabledAppCount}</span>
                        </div>
                        <code title={server.commandLabel}>{server.commandLabel || server.id}</code>
                      </div>
                    </div>
                  </div>
                </button>
                <div className="mcp-server-card__actions">
                  <button
                    className="secondary-button secondary-button--compact"
                    type="button"
                    onClick={() => setEditingServer(server)}
                  >
                    编辑
                  </button>
                  <button
                    className="secondary-button secondary-button--compact danger-button"
                    type="button"
                    onClick={() => void handleDelete(server)}
                  >
                    删除
                  </button>
                  <span className="mcp-server-card__chevron" aria-hidden="true">
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
                    {server.sourceUrl ? (
                      <dl className="detail-grid detail-grid--source">
                        <div>
                          <dt>来源类型</dt>
                          <dd>{sourceLabelForMcpSource(server.sourceUrl)}</dd>
                        </div>
                        <div>
                          <dt>来源</dt>
                          <dd className="detail-grid__source-value">
                            <span>{server.sourceUrl}</span>
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
                        const isUpdating = updatingKey === `${server.id}:${app.appId}`;
                        const appTitle = app.configPath || "暂未识别 MCP 配置路径";

                        return (
                          <button
                            key={app.appId}
                            className={`tool-pill mcp-app-toggle${app.isEnabled ? " is-enabled" : ""}`}
                            type="button"
                            onClick={() => void handleToggle(server, app.appId, !app.isEnabled)}
                            disabled={Boolean(updatingKey)}
                            aria-pressed={app.isEnabled}
                            title={appTitle}
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
          onClose={() => {
            setIsCreating(false);
            setEditingServer(null);
          }}
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
    if (!formState.id.trim()) {
      setErrorMessage("MCP ID 不能为空");
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
            <span>MCP ID</span>
            <input
              value={formState.id}
              disabled={isEditing}
              onChange={(event) => setFormState((current) => ({ ...current, id: event.target.value }))}
            />
          </label>
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
