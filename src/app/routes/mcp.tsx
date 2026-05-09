import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
import { getMonogramLabel } from "@/features/skills/utils/monogram";

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
  const [deleteConfirmingServerId, setDeleteConfirmingServerId] = useState("");
  const [deletingServerId, setDeletingServerId] = useState("");
  const deleteActionRef = useRef<HTMLButtonElement | null>(null);

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

  async function handleImport() {
    if (isImporting) {
      return;
    }

    setDeleteConfirmingServerId("");
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

    setDeleteConfirmingServerId("");
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
      setWorkspace(snapshot);
      notify({ tone: "success", message: `已删除 ${server.name}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除 MCP 失败";
      notify({ tone: "error", message });
    } finally {
      setDeletingServerId("");
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
          const visibleApps = server.apps.filter((app) => installedAppIdSet.has(app.appId));
          const serverDescription = formatMcpDescription(server);
          const isDeleteConfirming = deleteConfirmingServerId === server.id;
          const isDeleting = deletingServerId === server.id;
          const deleteConfirmTooltipLabel = isDeleting ? "正在删除" : "再次点击删除";

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
                          <span className="status-badge tone-neutral">{server.serverType}</span>
                          <span className="status-badge tone-info">已启用 {server.enabledAppCount}</span>
                        </div>
                        <code title={server.commandLabel}>{server.commandLabel || server.id}</code>
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
