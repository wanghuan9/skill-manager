import { useEffect, useId, useMemo, useState } from "react";
import { useTranslate } from "@/app/i18n";
import { useFailureReporter } from "@/app/failure-feedback";
import {
  fetchStartupInstalledPlugins,
  fetchMcpWorkspace,
  setPluginEnabled,
  toggleMcpServerApp,
} from "@/features/skills/api/skill-client";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type {
  McpWorkspaceSnapshot,
  PluginHostTool,
  PluginSummary,
} from "@/features/skills/state/skill-store";
import type { OpenToolCard } from "@/features/skills/utils/open-tools";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";

type ToolManageDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  tool: OpenToolCard;
};

type CapabilityTabKey = "skills" | "mcp" | "plugins";

type CapabilityRow = {
  id: string;
  name: string;
  isEnabled: boolean;
};

function sortCapabilityRows(left: CapabilityRow, right: CapabilityRow) {
  return left.name.localeCompare(right.name);
}

function isManagedPluginHost(toolId: string): toolId is PluginHostTool {
  return toolId === "claude-code" || toolId === "codex" || toolId === "cursor";
}

function getPluginInstanceKey(plugin: PluginSummary) {
  const instancePath = plugin.rootPath || plugin.manifestPath || plugin.id;
  return `${plugin.hostTool}::${instancePath}::${plugin.id}`;
}

function getPluginDisplayName(plugin: PluginSummary) {
  return plugin.manifestName?.trim() || plugin.name.trim() || plugin.id;
}

function patchPluginEnabledState(plugin: PluginSummary, enabled: boolean): PluginSummary {
  const enabledState = enabled ? "enabled" : "disabled";
  return {
    ...plugin,
    enabledState,
    scopes: plugin.scopes.map((scope) => ({ ...scope, enabledState })),
  };
}

function patchPluginListToggle(
  plugins: PluginSummary[],
  pluginKey: string,
  enabled: boolean,
) {
  return plugins.map((plugin) => (
    getPluginInstanceKey(plugin) === pluginKey ? patchPluginEnabledState(plugin, enabled) : plugin
  ));
}

function patchMcpWorkspaceToggle(
  workspace: McpWorkspaceSnapshot,
  serverId: string,
  appId: string,
  enabled: boolean,
): McpWorkspaceSnapshot {
  return {
    ...workspace,
    servers: workspace.servers.map((server) => {
      if (server.id !== serverId) {
        return server;
      }

      const nextApps = server.apps.map((app) => (
        app.appId === appId ? { ...app, isEnabled: enabled } : app
      ));
      return {
        ...server,
        enabledAppCount: nextApps.filter((app) => app.isEnabled).length,
        apps: nextApps,
      };
    }),
  };
}

function patchMcpWorkspaceBulkToggle(
  workspace: McpWorkspaceSnapshot,
  rows: CapabilityRow[],
  appId: string,
  enabled: boolean,
): McpWorkspaceSnapshot {
  return rows.reduce(
    (current, row) => patchMcpWorkspaceToggle(current, row.id, appId, enabled),
    workspace,
  );
}

export function ToolManageDialog({ isOpen, onClose, tool }: ToolManageDialogProps) {
  const { t } = useTranslate();
  const dialogTitleId = useId();
  const { installedSkills, setToolSkillStatuses, toggleSkillTool } = useSkillWorkspace();
  const reportFailure = useFailureReporter();
  const [activeTab, setActiveTab] = useState<CapabilityTabKey>("skills");
  const [query, setQuery] = useState("");
  const [showEnabledOnly, setShowEnabledOnly] = useState(false);
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const [mcpWorkspace, setMcpWorkspace] = useState<McpWorkspaceSnapshot | null>(null);
  const [isMcpLoading, setIsMcpLoading] = useState(false);
  const [mcpErrorMessage, setMcpErrorMessage] = useState("");
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
  const [isPluginLoading, setIsPluginLoading] = useState(false);
  const [pluginErrorMessage, setPluginErrorMessage] = useState("");
  const [pendingPluginIds, setPendingPluginIds] = useState<Set<string>>(new Set());
  const supportsMcp = tool.supportsMcp;
  const hasManagedMcpConfig = tool.supportsMcp && tool.mcpConfigPathRecognized;
  const supportsPlugins = isManagedPluginHost(tool.id);
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveTab("skills");
    setQuery("");
    setShowEnabledOnly(false);
    setIsUpdatingAll(false);
    setMcpErrorMessage("");
    setPluginErrorMessage("");
    setPendingPluginIds(new Set());
  }, [isOpen, tool.id]);

  useEffect(() => {
    if (!isOpen || !hasManagedMcpConfig) {
      setMcpWorkspace(null);
      setIsMcpLoading(false);
      return;
    }

    let isCancelled = false;
    setIsMcpLoading(true);
    setMcpErrorMessage("");

    void fetchMcpWorkspace()
      .then((workspace) => {
        if (!isCancelled) {
          setMcpWorkspace(workspace);
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          const message = error instanceof Error ? error.message : t("tools.dialog.loadMcpFailed");
          setMcpErrorMessage(message);
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsMcpLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [hasManagedMcpConfig, isOpen, tool.id]);

  useEffect(() => {
    if (!isOpen || !supportsPlugins) {
      setPlugins(null);
      setIsPluginLoading(false);
      return;
    }

    let isCancelled = false;
    setIsPluginLoading(true);
    setPluginErrorMessage("");

    void fetchStartupInstalledPlugins()
      .then((installedPlugins) => {
        if (!isCancelled) {
          setPlugins(installedPlugins.filter((plugin) => (
            plugin.hostTool === tool.id && plugin.enabledState !== "unknown"
          )));
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          const message = error instanceof Error ? error.message : t("tools.dialog.loadPluginsFailed");
          setPluginErrorMessage(message);
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsPluginLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [isOpen, supportsPlugins, t, tool.id]);

  const skillRows = useMemo(() => {
    return installedSkills
      .map((skill) => {
        const matchedTool = skill.tools.find((item) => item.name === tool.name);
        const isEnabled = matchedTool ? isToolEnabledStatus(matchedTool.statusLabel) : false;

        return {
          id: skill.name,
          name: skill.name,
          isEnabled,
        };
      })
      .filter((item) => item.name.toLowerCase().includes(normalizedQuery))
      .filter((item) => (showEnabledOnly ? item.isEnabled : true))
      .sort(sortCapabilityRows);
  }, [installedSkills, normalizedQuery, showEnabledOnly, tool.name]);

  const enabledSkillCount = useMemo(
    () => installedSkills.filter((skill) => {
      const matchedTool = skill.tools.find((item) => item.name === tool.name);
      return matchedTool ? isToolEnabledStatus(matchedTool.statusLabel) : false;
    }).length,
    [installedSkills, tool.name],
  );
  const knownSkillToolNames = useMemo(
    () => Array.from(new Set(installedSkills.flatMap((skill) => skill.tools.map((item) => item.name)))),
    [installedSkills],
  );

  const mcpRows = useMemo(() => {
    if (!hasManagedMcpConfig || !mcpWorkspace) {
      return [];
    }

    return mcpWorkspace.servers
      .map((server) => {
        const matchedApp = server.apps.find((app) => app.appId === tool.id);
        return {
          id: server.id,
          name: server.name,
          isEnabled: matchedApp?.isEnabled ?? false,
        };
      })
      .filter((item) => item.name.toLowerCase().includes(normalizedQuery))
      .filter((item) => (showEnabledOnly ? item.isEnabled : true))
      .sort(sortCapabilityRows);
  }, [hasManagedMcpConfig, mcpWorkspace, normalizedQuery, showEnabledOnly, tool.id]);

  const enabledMcpCount = useMemo(() => {
    if (!hasManagedMcpConfig || !mcpWorkspace) {
      return 0;
    }

    return mcpWorkspace.servers.filter((server) =>
      server.apps.some((app) => app.appId === tool.id && app.isEnabled)
    ).length;
  }, [mcpWorkspace, hasManagedMcpConfig, tool.id]);

  const pluginRows = useMemo(() => {
    if (!supportsPlugins || !plugins) {
      return [];
    }

    return plugins
      .map((plugin) => ({
        id: getPluginInstanceKey(plugin),
        name: getPluginDisplayName(plugin),
        isEnabled: plugin.enabledState === "enabled",
      }))
      .filter((item) => item.name.toLowerCase().includes(normalizedQuery))
      .filter((item) => (showEnabledOnly ? item.isEnabled : true))
      .sort(sortCapabilityRows);
  }, [normalizedQuery, plugins, showEnabledOnly, supportsPlugins]);

  const enabledPluginCount = useMemo(
    () => plugins?.filter((plugin) => plugin.enabledState === "enabled").length ?? 0,
    [plugins],
  );

  const activeRows = activeTab === "skills" ? skillRows : activeTab === "mcp" ? mcpRows : pluginRows;
  const disabledVisibleCount = activeRows.filter((item) => !item.isEnabled).length;
  const enabledVisibleCount = activeRows.filter((item) => item.isEnabled).length;
  const capabilitySummaryLabel = supportsMcp
    ? hasManagedMcpConfig
      ? t("tools.dialog.summary", {
          enabledSkills: enabledSkillCount,
          totalSkills: installedSkills.length,
          enabledMcp: enabledMcpCount,
          totalMcp: mcpWorkspace?.servers.length ?? 0,
        })
      : t("tools.dialog.summaryUnmodeled", {
          enabledSkills: enabledSkillCount,
          totalSkills: installedSkills.length,
        })
    : t("tools.dialog.summaryUnsupported", {
        enabledSkills: enabledSkillCount,
        totalSkills: installedSkills.length,
      });
  const summaryLabel = supportsPlugins
    ? `${capabilitySummaryLabel} · ${t("tools.dialog.pluginSummary", {
        enabledPlugins: enabledPluginCount,
        totalPlugins: plugins?.length ?? 0,
      })}`
    : capabilitySummaryLabel;

  async function handleToggleSkill(skillName: string) {
    try {
      await toggleSkillTool({
        skillName,
        toolName: tool.name,
        toolNames: knownSkillToolNames,
      });
    } catch (error) {
        reportFailure(error, {
          operation: "toggle_tool_manage_skill",
        fallbackMessage: t("tools.dialog.error.toggleSkill"),
          context: { toolId: tool.id, toolName: tool.name, skillName },
        });
    }
  }

  async function handleToggleMcp(serverId: string, enabled: boolean) {
    const previousWorkspace = mcpWorkspace;
    setMcpWorkspace((current) => (
      current ? patchMcpWorkspaceToggle(current, serverId, tool.id, enabled) : current
    ));
    try {
      const nextWorkspace = await toggleMcpServerApp({
        serverId,
        appId: tool.id,
        enabled,
      });
      setMcpWorkspace(nextWorkspace);
    } catch (error) {
      setMcpWorkspace(previousWorkspace);
      reportFailure(error, {
        operation: "toggle_tool_manage_mcp",
        fallbackMessage: t("tools.dialog.error.toggleMcp"),
        context: { toolId: tool.id, toolName: tool.name, serverId, enabled },
      });
    }
  }

  async function handleTogglePlugin(pluginKey: string, enabled: boolean) {
    const targetPlugin = plugins?.find((plugin) => getPluginInstanceKey(plugin) === pluginKey);
    if (!supportsPlugins || !targetPlugin || pendingPluginIds.has(pluginKey)) {
      return;
    }

    setPendingPluginIds((current) => new Set(current).add(pluginKey));
    setPlugins((current) => (
      current ? patchPluginListToggle(current, pluginKey, enabled) : current
    ));
    try {
      const updatedPlugin = await setPluginEnabled({
        pluginId: targetPlugin.id,
        hostTool: targetPlugin.hostTool,
        rootPath: targetPlugin.rootPath,
        enabled,
      });
      setPlugins((current) => current?.map((plugin) => (
        getPluginInstanceKey(plugin) === pluginKey ? updatedPlugin : plugin
      )) ?? current);
    } catch (error) {
      setPlugins((current) => current?.map((plugin) => (
        getPluginInstanceKey(plugin) === pluginKey ? targetPlugin : plugin
      )) ?? current);
      reportFailure(error, {
        operation: "toggle_tool_manage_plugin",
        fallbackMessage: t("tools.dialog.error.togglePlugin"),
        context: { toolId: tool.id, toolName: tool.name, pluginId: targetPlugin.id, enabled },
      });
    } finally {
      setPendingPluginIds((current) => {
        const next = new Set(current);
        next.delete(pluginKey);
        return next;
      });
    }
  }

  async function handleToggleAllPlugins(enabled: boolean) {
    if (!supportsPlugins || !plugins) {
      return;
    }

    const targetPluginKeys = new Set(
      pluginRows.filter((item) => item.isEnabled !== enabled).map((item) => item.id),
    );
    const targetPlugins = plugins.filter((plugin) => targetPluginKeys.has(getPluginInstanceKey(plugin)));
    if (targetPlugins.length === 0) {
      return;
    }

    setIsUpdatingAll(true);
    try {
      const updatedPlugins = await Promise.all(targetPlugins.map((plugin) => setPluginEnabled({
        pluginId: plugin.id,
        hostTool: plugin.hostTool,
        rootPath: plugin.rootPath,
        enabled,
      })));
      const updatedByKey = new Map(updatedPlugins.map((plugin) => [getPluginInstanceKey(plugin), plugin]));
      setPlugins((current) => current?.map((plugin) => (
        updatedByKey.get(getPluginInstanceKey(plugin)) ?? plugin
      )) ?? current);
    } catch (error) {
      reportFailure(error, {
        operation: enabled ? "enable_all_tool_manage_plugins" : "disable_all_tool_manage_plugins",
        fallbackMessage: enabled
          ? t("tools.dialog.error.enablePlugins")
          : t("tools.dialog.error.disablePlugins"),
        context: { toolId: tool.id, toolName: tool.name, pluginIds: targetPlugins.map((plugin) => plugin.id) },
      });
    } finally {
      setIsUpdatingAll(false);
    }
  }

  async function handleToggleAllOn() {
    if (activeTab === "skills") {
      const disabledSkillNames = skillRows
        .filter((item) => !item.isEnabled)
        .map((item) => item.name);
      if (disabledSkillNames.length === 0) {
        return;
      }

      try {
        await setToolSkillStatuses({
          toolName: tool.name,
          skillNames: disabledSkillNames,
          enabled: true,
          toolNames: knownSkillToolNames,
        });
      } catch (error) {
        reportFailure(error, {
          operation: "enable_all_tool_manage_skills",
          fallbackMessage: t("tools.dialog.error.enableSkills"),
          context: { toolId: tool.id, toolName: tool.name, skillNames: disabledSkillNames },
        });
      }
      return;
    }

    if (activeTab === "plugins") {
      await handleToggleAllPlugins(true);
      return;
    }

    if (!supportsMcp || !mcpWorkspace) {
      return;
    }

    const disabledRows = mcpRows.filter((item) => !item.isEnabled);
    if (disabledRows.length === 0) {
      return;
    }

    const previousWorkspace = mcpWorkspace;
    setIsUpdatingAll(true);
    setMcpWorkspace((current) => (
      current ? patchMcpWorkspaceBulkToggle(current, disabledRows, tool.id, true) : current
    ));
    try {
      for (const row of disabledRows) {
        await toggleMcpServerApp({
          serverId: row.id,
          appId: tool.id,
          enabled: true,
        });
      }
    } catch (error) {
      setMcpWorkspace(previousWorkspace);
      reportFailure(error, {
        operation: "enable_all_tool_manage_mcp",
        fallbackMessage: t("tools.dialog.error.enableMcp"),
        context: { toolId: tool.id, toolName: tool.name, serverIds: disabledRows.map((row) => row.id) },
      });
    } finally {
      setIsUpdatingAll(false);
    }
  }

  async function handleToggleAllOff() {
    if (activeTab === "skills") {
      const enabledSkillNames = skillRows
        .filter((item) => item.isEnabled)
        .map((item) => item.name);
      if (enabledSkillNames.length === 0) {
        return;
      }

      try {
        await setToolSkillStatuses({
          toolName: tool.name,
          skillNames: enabledSkillNames,
          enabled: false,
          toolNames: knownSkillToolNames,
        });
      } catch (error) {
        reportFailure(error, {
          operation: "disable_all_tool_manage_skills",
          fallbackMessage: t("tools.dialog.error.disableSkills"),
          context: { toolId: tool.id, toolName: tool.name, skillNames: enabledSkillNames },
        });
      }
      return;
    }

    if (activeTab === "plugins") {
      await handleToggleAllPlugins(false);
      return;
    }

    if (!supportsMcp || !mcpWorkspace) {
      return;
    }

    const enabledRows = mcpRows.filter((item) => item.isEnabled);
    if (enabledRows.length === 0) {
      return;
    }

    const previousWorkspace = mcpWorkspace;
    setIsUpdatingAll(true);
    setMcpWorkspace((current) => (
      current ? patchMcpWorkspaceBulkToggle(current, enabledRows, tool.id, false) : current
    ));
    try {
      for (const row of enabledRows) {
        await toggleMcpServerApp({
          serverId: row.id,
          appId: tool.id,
          enabled: false,
        });
      }
    } catch (error) {
      setMcpWorkspace(previousWorkspace);
      reportFailure(error, {
        operation: "disable_all_tool_manage_mcp",
        fallbackMessage: t("tools.dialog.error.disableMcp"),
        context: { toolId: tool.id, toolName: tool.name, serverIds: enabledRows.map((row) => row.id) },
      });
    } finally {
      setIsUpdatingAll(false);
    }
  }

  if (!isOpen) {
    return null;
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="tool-manage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tool-manage-dialog__header">
          <div className="tool-manage-dialog__title">
            <h3 id={dialogTitleId}>{t("tools.dialog.title", { name: tool.name })}</h3>
            <p>{summaryLabel}</p>
          </div>
          <button
            className="tool-manage-dialog__close"
            type="button"
            onClick={onClose}
            aria-label={t("tools.dialog.close")}
          >
            ×
          </button>
        </div>

        <div className="tool-manage-dialog__tabs" role="tablist" aria-label={t("tools.dialog.tabs")}>
          <button
            className={`tool-manage-dialog__tab${activeTab === "skills" ? " is-selected" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "skills"}
            onClick={() => setActiveTab("skills")}
          >
            Skills
          </button>
          <button
            className={`tool-manage-dialog__tab${activeTab === "mcp" ? " is-selected" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "mcp"}
            onClick={() => setActiveTab("mcp")}
            disabled={!supportsMcp}
          >
            MCP
          </button>
          {supportsPlugins ? (
            <button
              className={`tool-manage-dialog__tab${activeTab === "plugins" ? " is-selected" : ""}`}
              type="button"
              role="tab"
              aria-selected={activeTab === "plugins"}
              onClick={() => setActiveTab("plugins")}
            >
              Plugins
            </button>
          ) : null}
        </div>

        <div className="tool-manage-dialog__toolbar">
          <input
            className="tool-manage-dialog__search"
            type="search"
            placeholder={
              activeTab === "skills"
                ? t("tools.dialog.searchSkills")
                : activeTab === "mcp"
                  ? t("tools.dialog.searchMcp")
                  : t("tools.dialog.searchPlugins")
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="tool-manage-dialog__toggle">
            <button
              className={`switch-button${showEnabledOnly ? " is-enabled" : ""}`}
              type="button"
              onClick={() => setShowEnabledOnly((current) => !current)}
              aria-pressed={showEnabledOnly}
              aria-label={t("tools.dialog.enabledOnly")}
            >
              <span className="switch-button__thumb" />
            </button>
            <span>{t("tools.dialog.enabledOnly")}</span>
          </label>
          <div className="tool-manage-dialog__bulk-actions">
            <button
              className="secondary-button secondary-button--compact"
              type="button"
              onClick={() => void handleToggleAllOn()}
              disabled={
                isUpdatingAll
                || pendingPluginIds.size > 0
                || disabledVisibleCount === 0
                || (activeTab === "mcp" && isMcpLoading)
                || (activeTab === "plugins" && isPluginLoading)
              }
            >
              {t("tools.dialog.enableAll")}
            </button>
            <button
              className="secondary-button secondary-button--compact"
              type="button"
              onClick={() => void handleToggleAllOff()}
              disabled={
                isUpdatingAll
                || pendingPluginIds.size > 0
                || enabledVisibleCount === 0
                || (activeTab === "mcp" && isMcpLoading)
                || (activeTab === "plugins" && isPluginLoading)
              }
            >
              {t("tools.dialog.disableAll")}
            </button>
          </div>
        </div>

        <div className="tool-manage-dialog__list">
          {activeTab === "plugins" && tool.id === "cursor" ? (
            <div className="tool-manage-dialog__hint">{t("tools.dialog.cursorPluginReloadHint")}</div>
          ) : null}
          {activeTab === "mcp" && !supportsMcp ? (
            <div className="tool-manage-dialog__empty">{t("tools.dialog.noMcpSupport", { name: tool.name })}</div>
          ) : null}
          {activeTab === "mcp" && supportsMcp && !hasManagedMcpConfig ? (
            <div className="tool-manage-dialog__empty">{t("tools.dialog.noMcpPath", { name: tool.name })}</div>
          ) : null}
          {activeTab === "mcp" && hasManagedMcpConfig && isMcpLoading ? (
            <div className="tool-manage-dialog__empty">{t("tools.dialog.loadingMcp")}</div>
          ) : null}
          {activeTab === "mcp" && hasManagedMcpConfig && !isMcpLoading && mcpErrorMessage ? (
            <div className="tool-manage-dialog__empty">{mcpErrorMessage}</div>
          ) : null}
          {activeTab === "plugins" && isPluginLoading ? (
            <div className="tool-manage-dialog__empty">{t("tools.dialog.loadingPlugins")}</div>
          ) : null}
          {activeTab === "plugins" && !isPluginLoading && pluginErrorMessage ? (
            <div className="tool-manage-dialog__empty">{pluginErrorMessage}</div>
          ) : null}
          {(activeTab === "skills"
            || (activeTab === "mcp" && hasManagedMcpConfig && !isMcpLoading && !mcpErrorMessage)
            || (activeTab === "plugins" && !isPluginLoading && !pluginErrorMessage))
            ? activeRows.map((item) => (
              <div
                key={item.id}
                className={`tool-manage-dialog__item${item.isEnabled ? " is-enabled" : ""}`}
              >
                <span className="tool-manage-dialog__item-name" title={item.name}>
                  {item.name}
                </span>
                <button
                  className={`switch-button${item.isEnabled ? " is-enabled" : ""}`}
                  type="button"
                  onClick={() => {
                    if (activeTab === "skills") {
                      void handleToggleSkill(item.name);
                      return;
                    }

                    if (activeTab === "plugins") {
                      void handleTogglePlugin(item.id, !item.isEnabled);
                      return;
                    }

                    void handleToggleMcp(item.id, !item.isEnabled);
                  }}
                  aria-pressed={item.isEnabled}
                  aria-label={item.isEnabled ? t("tools.dialog.item.disable", { name: item.name }) : t("tools.dialog.item.enable", { name: item.name })}
                  disabled={isUpdatingAll || pendingPluginIds.has(item.id)}
                >
                  <span className="switch-button__thumb" />
                </button>
              </div>
            ))
            : null}
          {(activeTab === "skills"
            || (activeTab === "mcp" && hasManagedMcpConfig && !isMcpLoading && !mcpErrorMessage)
            || (activeTab === "plugins" && !isPluginLoading && !pluginErrorMessage)) &&
          activeRows.length === 0 ? (
            <div className="tool-manage-dialog__empty">
              {activeTab === "skills"
                ? t("tools.dialog.emptySkills")
                : activeTab === "mcp"
                  ? t("tools.dialog.emptyMcp")
                  : t("tools.dialog.emptyPlugins")}
            </div>
          ) : null}
        </div>

        <div className="tool-manage-dialog__actions">
          <button
            className="primary-button primary-button--compact"
            type="button"
            onClick={onClose}
          >
            {t("tools.dialog.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
