import { useEffect, useMemo, useState } from "react";
import { SearchFieldIcon } from "@/app/components/SearchFieldIcon";
import { AppSelect } from "@/app/components/AppSelect";
import { useNotifications } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import {
  distributeMcpToProject,
  distributeSkillToProject,
  importProjectMcp,
  importProjectSkill,
  openPathInFinder,
  previewProjectMcpSync,
  previewProjectSkillSync,
  removeManagedProject,
  syncProjectMcp,
  syncProjectSkill,
  unlinkProjectResource,
} from "@/features/skills/api/skill-client";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type {
  ProjectDetail,
  ProjectMcpDiffSnapshot,
  ProjectMcpInstance,
  ProjectSkillDiffSnapshot,
  ProjectSkillInstance,
  ProjectSyncDirection,
  ProjectSyncStatus,
  ProjectWorkspaceSnapshot,
} from "@/features/skills/state/skill-store";

export type ProjectResourceTab = "skills" | "mcp";
export type ProjectViewMode = "list" | "grid";
export type ProjectStatusFilter = "all" | ProjectSyncStatus;
type DistributionDialog = { type: "skill" | "mcp" } | null;
type SkillDiffState = {
  type: "skill";
  resource: ProjectSkillInstance;
  direction: ProjectSyncDirection;
  snapshot: ProjectSkillDiffSnapshot;
};
type McpDiffState = {
  type: "mcp";
  resource: ProjectMcpInstance;
  direction: ProjectSyncDirection;
  snapshot: ProjectMcpDiffSnapshot;
};
type ProjectDiffState = SkillDiffState | McpDiffState;

const projectToolOptions = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cursor", name: "Cursor" },
];
const mcpToolOptions = projectToolOptions.filter((tool) => tool.id !== "codex");

const statusLabels: Record<ProjectSyncStatus, { zh: string; en: string }> = {
  "project-only": { zh: "仅项目", en: "Project only" },
  "project-missing": { zh: "项目已缺失", en: "Missing in project" },
  "managed-missing": { zh: "托管已缺失", en: "Missing in library" },
  "in-sync": { zh: "已同步", en: "In sync" },
  "project-changed": { zh: "项目有修改", en: "Project changed" },
  "managed-changed": { zh: "托管有更新", en: "Library changed" },
  diverged: { zh: "两侧均有修改", en: "Diverged" },
  unavailable: { zh: "不可同步", en: "Unavailable" },
};

function canUpdateProject(status: ProjectSyncStatus) {
  return ["project-missing", "managed-changed", "diverged"].includes(status);
}

function canUpdateManaged(status: ProjectSyncStatus) {
  return ["managed-missing", "project-changed", "diverged"].includes(status);
}

function ProjectListIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="2.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 7h8M6 10h8M6 13h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ProjectGridIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 4.25h4.5v4.5H4v-4.5ZM11.5 4.25H16v4.5h-4.5v-4.5ZM4 11.25h4.5v4.5H4v-4.5ZM11.5 11.25H16v4.5h-4.5v-4.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function ProjectRefreshIcon({ isSpinning }: { isSpinning: boolean }) {
  return (
    <svg className={isSpinning ? "skills-toolbar-button__svg is-spinning" : "skills-toolbar-button__svg"} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M16.2 9.1a6.2 6.2 0 0 0-10.7-3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.7 3.9v3.7h3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.8 10.9a6.2 6.2 0 0 0 10.7 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.3 16.1v-3.7h-3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type ProjectWorkspaceToolbarProps = {
  activeTab: ProjectResourceTab;
  query: string;
  statusFilter: ProjectStatusFilter;
  statusCounts?: Record<ProjectStatusFilter, number>;
  viewMode: ProjectViewMode;
  isRefreshing: boolean;
  onActiveTabChange: (value: ProjectResourceTab) => void;
  onQueryChange: (value: string) => void;
  onStatusFilterChange: (value: ProjectStatusFilter) => void;
  onViewModeChange: (value: ProjectViewMode) => void;
  onRefresh: () => void;
  onAddResource: () => void;
};

export function ProjectWorkspaceToolbar(props: ProjectWorkspaceToolbarProps) {
  const { language } = useSkillWorkspace();
  const copy = (zh: string, en: string) => language === "en" ? en : zh;
  const statusOptions: Array<{ value: ProjectStatusFilter; label: string }> = [
    { value: "all", label: copy("全部状态", "All statuses") },
    { value: "project-only", label: copy("仅项目", "Project only") },
    { value: "in-sync", label: copy("已同步", "In sync") },
    { value: "project-changed", label: copy("项目有修改", "Project changed") },
    { value: "managed-changed", label: copy("托管有更新", "Library changed") },
    { value: "diverged", label: copy("两侧均有修改", "Diverged") },
  ];

  return (
    <div className="skills-header-bar__tools project-workspace-toolbar">
      <label className="search-field search-field--header skill-search-field">
        <span className="sr-only">{copy("搜索项目资源", "Search project resources")}</span>
        <SearchFieldIcon />
        <input
          type="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={props.activeTab === "skills"
            ? copy("搜索项目中的 Skills…", "Search project Skills…")
            : copy("搜索项目中的 MCP…", "Search project MCP…")}
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
      </label>
      <div className="project-workspace-toolbar__tabs" role="tablist" aria-label={copy("项目资源", "Project resources")}>
        <button type="button" role="tab" aria-selected={props.activeTab === "skills"} className={props.activeTab === "skills" ? "is-active" : ""} onClick={() => props.onActiveTabChange("skills")}>Skills</button>
        <button type="button" role="tab" aria-selected={props.activeTab === "mcp"} className={props.activeTab === "mcp" ? "is-active" : ""} onClick={() => props.onActiveTabChange("mcp")}>MCP</button>
      </div>
      <div className="skills-view-toggle" role="group" aria-label={copy("视图", "View")}>
        <button className={`skills-view-toggle__button${props.viewMode === "list" ? " is-active" : ""}`} type="button" aria-pressed={props.viewMode === "list"} aria-label={copy("列表视图", "List view")} onClick={() => props.onViewModeChange("list")}><ProjectListIcon /></button>
        <button className={`skills-view-toggle__button${props.viewMode === "grid" ? " is-active" : ""}`} type="button" aria-pressed={props.viewMode === "grid"} aria-label={copy("卡片视图", "Grid view")} onClick={() => props.onViewModeChange("grid")}><ProjectGridIcon /></button>
      </div>
      {props.activeTab === "skills" ? (
        <AppSelect
          value={props.statusFilter}
          options={statusOptions.map((option) => ({
            value: option.value,
            label: `${option.label} (${props.statusCounts?.[option.value] ?? 0})`,
          }))}
          onChange={props.onStatusFilterChange}
          ariaLabel={copy("同步状态筛选", "Sync status filter")}
          className="skill-status-filter__select project-workspace-toolbar__filter"
          menuClassName="skill-status-filter__popover"
          minMenuWidth={112}
        />
      ) : null}
      <button className={`secondary-button secondary-button--compact skills-toolbar-button${props.isRefreshing ? " is-loading" : ""}`} type="button" disabled={props.isRefreshing} onClick={props.onRefresh}>
        <span aria-hidden="true" className="skills-toolbar-button__icon"><ProjectRefreshIcon isSpinning={props.isRefreshing} /></span>
        <span>{copy("刷新", "Refresh")}</span>
      </button>
      <button className="primary-button primary-button--compact project-workspace-toolbar__add" type="button" onClick={props.onAddResource}>
        ＋ {props.activeTab === "skills" ? copy("添加 Skill", "Add Skill") : copy("添加 MCP", "Add MCP")}
      </button>
    </div>
  );
}

type ProjectsRouteProps = {
  workspace: ProjectWorkspaceSnapshot | null;
  activeProjectId: string;
  query: string;
  statusFilter: ProjectStatusFilter;
  viewMode: ProjectViewMode;
  activeTab: ProjectResourceTab;
  addResourceRequest: number;
  onWorkspaceChange: (snapshot: ProjectWorkspaceSnapshot) => void;
};

export function ProjectsRoute(props: ProjectsRouteProps) {
  const { language } = useSkillWorkspace();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const copy = (zh: string, en: string) => language === "en" ? en : zh;
  const { activeProjectId, activeTab, workspace } = props;
  const [activeToolId, setActiveToolId] = useState("all");
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [distributionDialog, setDistributionDialog] = useState<DistributionDialog>(null);
  const [distributionToolId, setDistributionToolId] = useState("claude-code");
  const [distributionResourceId, setDistributionResourceId] = useState("");
  const [distributionName, setDistributionName] = useState("");
  const [diffState, setDiffState] = useState<ProjectDiffState | null>(null);

  const activeProject = workspace?.projects.find((project) => project.id === activeProjectId) ?? null;

  const availableToolIds = useMemo(() => {
    if (!activeProject) return [];
    const resources = activeTab === "skills" ? activeProject.skills : activeProject.mcpServers;
    return [...new Set(resources.map((resource) => resource.toolId))];
  }, [activeProject, activeTab]);

  useEffect(() => {
    if (activeToolId !== "all" && !availableToolIds.includes(activeToolId)) {
      setActiveToolId("all");
    }
  }, [activeToolId, availableToolIds]);

  async function runAction(
    operation: string,
    action: () => Promise<ProjectWorkspaceSnapshot>,
    successMessage: string,
  ) {
    setIsBusy(true);
    setErrorMessage("");
    try {
      const snapshot = await action();
      props.onWorkspaceChange(snapshot);
      notify({ message: successMessage, tone: "success" });
    } catch (error) {
      const fallbackMessage = copy("操作失败，请稍后重试", "Operation failed. Please try again.");
      reportFailure(error, {
        operation,
        fallbackMessage,
      });
      setErrorMessage(error instanceof Error ? error.message : fallbackMessage);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRemoveProject(project: ProjectDetail) {
    if (!window.confirm(copy(
      `只移除 ${project.name} 的管理记录，不删除项目文件。确定继续吗？`,
      `Remove ${project.name} from SkillDock without deleting project files?`,
    ))) return;
    await runAction(
      "remove_managed_project",
      () => removeManagedProject(project.id),
      copy("项目管理记录已移除", "Project removed"),
    );
  }

  function openDistributionDialog(type: "skill" | "mcp") {
    const firstResource = type === "skill"
      ? workspace?.managedSkills[0]
      : workspace?.managedMcpServers[0];
    setDistributionDialog({ type });
    setDistributionToolId("claude-code");
    setDistributionResourceId(type === "skill"
      ? workspace?.managedSkills[0]?.localPath ?? ""
      : workspace?.managedMcpServers[0]?.id ?? "");
    setDistributionName(firstResource?.name ?? "");
  }

  useEffect(() => {
    if (props.addResourceRequest > 0) {
      openDistributionDialog(activeTab === "skills" ? "skill" : "mcp");
    }
  }, [props.addResourceRequest]);

  async function handleDistribute() {
    if (!activeProject || !distributionDialog || !distributionResourceId || !distributionName.trim()) {
      return;
    }
    if (distributionDialog.type === "skill") {
      await runAction(
        "distribute_skill_to_project",
        () => distributeSkillToProject({
          projectId: activeProject.id,
          toolId: distributionToolId,
          managedSkillPath: distributionResourceId,
          targetName: distributionName.trim(),
        }),
        copy("Skill 已下发到项目", "Skill distributed to project"),
      );
    } else {
      await runAction(
        "distribute_mcp_to_project",
        () => distributeMcpToProject({
          projectId: activeProject.id,
          toolId: distributionToolId,
          managedMcpId: distributionResourceId,
          serverName: distributionName.trim(),
        }),
        copy("MCP 已下发到项目", "MCP distributed to project"),
      );
    }
    setDistributionDialog(null);
  }

  async function handlePreviewSkill(
    skill: ProjectSkillInstance,
    direction: ProjectSyncDirection,
  ) {
    if (!activeProject) return;
    setIsBusy(true);
    setErrorMessage("");
    try {
      const snapshot = await previewProjectSkillSync({
        projectId: activeProject.id,
        toolId: skill.toolId,
        projectRelativePath: skill.relativePath,
        direction,
      });
      setDiffState({ type: "skill", resource: skill, direction, snapshot });
    } catch (error) {
      const fallbackMessage = copy("读取 Skill 差异失败", "Failed to load Skill diff");
      reportFailure(error, {
        operation: "preview_project_skill_sync",
        fallbackMessage,
      });
      setErrorMessage(error instanceof Error ? error.message : fallbackMessage);
    } finally {
      setIsBusy(false);
    }
  }

  async function handlePreviewMcp(
    server: ProjectMcpInstance,
    direction: ProjectSyncDirection,
  ) {
    if (!activeProject) return;
    setIsBusy(true);
    setErrorMessage("");
    try {
      const snapshot = await previewProjectMcpSync({
        projectId: activeProject.id,
        toolId: server.toolId,
        serverName: server.serverName,
        direction,
      });
      setDiffState({ type: "mcp", resource: server, direction, snapshot });
    } catch (error) {
      const fallbackMessage = copy("读取 MCP 差异失败", "Failed to load MCP diff");
      reportFailure(error, {
        operation: "preview_project_mcp_sync",
        fallbackMessage,
      });
      setErrorMessage(error instanceof Error ? error.message : fallbackMessage);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleConfirmSync() {
    if (!activeProject || !diffState) return;
    const common = {
      projectId: activeProject.id,
      toolId: diffState.resource.toolId,
      direction: diffState.direction,
      sourceHash: diffState.snapshot.sourceHash,
      targetHash: diffState.snapshot.targetHash,
    };
    const action = diffState.type === "skill"
      ? () => syncProjectSkill({
          ...common,
          projectRelativePath: diffState.resource.relativePath,
        })
      : () => syncProjectMcp({
          ...common,
          serverName: diffState.resource.serverName,
        });
    await runAction(
      diffState.type === "skill" ? "sync_project_skill" : "sync_project_mcp",
      action,
      copy("同步完成", "Sync completed"),
    );
    setDiffState(null);
  }

  const normalizedQuery = props.query.trim().toLocaleLowerCase();
  const filteredSkills = activeProject?.skills.filter((skill) => (
    (activeToolId === "all" || skill.toolId === activeToolId)
    && (props.statusFilter === "all" || skill.syncStatus === props.statusFilter)
    && (!normalizedQuery || [skill.name, skill.description, skill.toolName, skill.relativePath]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
  )) ?? [];
  const filteredMcpServers = activeProject?.mcpServers.filter((server) => (
    (activeToolId === "all" || server.toolId === activeToolId)
    && (!normalizedQuery || [server.serverName, server.toolName, server.configRelativePath]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
  )) ?? [];

  if (!workspace) {
    return <div className="panel-card empty-state"><p>{copy("正在扫描项目…", "Scanning projects…")}</p></div>;
  }

  return (
    <div className="projects-page skills-page">
      {errorMessage ? <div className="dialog-error projects-page__error">{errorMessage}</div> : null}
      {activeProject ? (
        <section className="projects-page__detail">
          <div className="projects-page__context-bar">
            <div className="projects-page__tool-filters" aria-label={copy("工具筛选", "Tool filter")}>
              <button className={activeToolId === "all" ? "is-active" : ""} type="button" onClick={() => setActiveToolId("all")}>{copy("全部工具", "All tools")}</button>
              {availableToolIds.map((toolId) => (
                <button className={activeToolId === toolId ? "is-active" : ""} type="button" key={toolId} onClick={() => setActiveToolId(toolId)}>
                  {projectToolOptions.find((tool) => tool.id === toolId)?.name ?? toolId}
                </button>
              ))}
            </div>
            <div className="projects-page__header-actions">
              <button className="ghost-button" type="button" onClick={() => void openPathInFinder({ path: activeProject.canonicalRootPath })}>
                {copy("打开目录", "Open folder")}
              </button>
              <button className="ghost-button is-warning" type="button" onClick={() => void handleRemoveProject(activeProject)}>
                {copy("移除管理", "Remove")}
              </button>
            </div>
          </div>
          {activeProject.errors.map((error) => <div className="dialog-error" key={error}>{error}</div>)}
          {activeTab === "skills" ? (
            <div className={`card-list project-resource-list${props.viewMode === "grid" ? " skill-card-grid" : ""}`}>
                  {filteredSkills.map((skill) => (
                    <ProjectSkillRow
                      key={`${skill.toolId}:${skill.relativePath}`}
                      skill={skill}
                      language={language}
                      layout={props.viewMode}
                      disabled={isBusy}
                      onImport={() => void runAction(
                        "import_project_skill",
                        () => importProjectSkill({ projectId: activeProject.id, toolId: skill.toolId, projectRelativePath: skill.relativePath }),
                        copy("项目 Skill 已上传到托管", "Project Skill imported"),
                      )}
                      onUpdateProject={() => void handlePreviewSkill(skill, "managed-to-project")}
                      onUpdateManaged={() => void handlePreviewSkill(skill, "project-to-managed")}
                      onUnlink={() => void runAction(
                        "unlink_project_skill",
                        () => unlinkProjectResource({ projectId: activeProject.id, resourceType: "skill", toolId: skill.toolId, resourceKey: skill.relativePath }),
                        copy("Skill 关联已解除", "Skill unlinked"),
                      )}
                    />
                  ))}
                  {filteredSkills.length === 0 ? <ResourceEmpty label={copy("未识别到项目 Skill", "No project Skills found")} /> : null}
            </div>
          ) : (
            <div className={`card-list project-resource-list${props.viewMode === "grid" ? " skill-card-grid" : ""}`}>
                  {filteredMcpServers.map((server) => (
                    <ProjectMcpRow
                      key={`${server.toolId}:${server.serverName}`}
                      server={server}
                      language={language}
                      layout={props.viewMode}
                      disabled={isBusy}
                      onImport={() => void runAction(
                        "import_project_mcp",
                        () => importProjectMcp({ projectId: activeProject.id, toolId: server.toolId, serverName: server.serverName }),
                        copy("项目 MCP 已上传到托管", "Project MCP imported"),
                      )}
                      onUpdateProject={() => void handlePreviewMcp(server, "managed-to-project")}
                      onUpdateManaged={() => void handlePreviewMcp(server, "project-to-managed")}
                      onUnlink={() => void runAction(
                        "unlink_project_mcp",
                        () => unlinkProjectResource({ projectId: activeProject.id, resourceType: "mcp", toolId: server.toolId, resourceKey: server.serverName }),
                        copy("MCP 关联已解除", "MCP unlinked"),
                      )}
                    />
                  ))}
                  {filteredMcpServers.length === 0 ? <ResourceEmpty label={copy("未识别到项目 MCP", "No project MCP servers found")} /> : null}
            </div>
          )}
        </section>
      ) : (
        <div className="panel-card empty-state projects-page__empty">
          <h3>{copy("项目不可用", "Project unavailable")}</h3>
          <p>{copy("请从左侧项目工作区重新选择项目。", "Choose a project again from the project workspace.")}</p>
        </div>
      )}

      {distributionDialog && activeProject ? (
        <DistributionModal
          type={distributionDialog.type}
          language={language}
          workspace={workspace}
          project={activeProject}
          toolId={distributionToolId}
          resourceId={distributionResourceId}
          targetName={distributionName}
          disabled={isBusy}
          onToolChange={setDistributionToolId}
          onResourceChange={(value, name) => {
            setDistributionResourceId(value);
            setDistributionName(name);
          }}
          onTargetNameChange={setDistributionName}
          onClose={() => setDistributionDialog(null)}
          onConfirm={() => void handleDistribute()}
        />
      ) : null}
      {diffState ? (
        <ProjectDiffModal
          state={diffState}
          language={language}
          disabled={isBusy}
          onClose={() => setDiffState(null)}
          onConfirm={() => void handleConfirmSync()}
        />
      ) : null}
    </div>
  );
}

function ProjectSkillRow(props: {
  skill: ProjectSkillInstance;
  language: "zh-CN" | "en";
  layout: ProjectViewMode;
  disabled: boolean;
  onImport: () => void;
  onUpdateProject: () => void;
  onUpdateManaged: () => void;
  onUnlink: () => void;
}) {
  const { skill, language } = props;
  const copy = (zh: string, en: string) => language === "en" ? en : zh;
  const isLinked = Boolean(skill.managedSkillPath);
  const canReverse = skill.projectCapability === "bidirectional";
  const unavailable = skill.entryKind === "symlink" || skill.syncStatus === "unavailable";
  return (
    <article className={`skill-card project-resource-card skill-card--${props.layout}`}>
      <div className="skill-card__header">
        <div className="skill-card__identity">
          <span className="link-badge project-resource-card__monogram" aria-hidden="true">
            {skill.name.slice(0, 1).toLocaleUpperCase()}
          </span>
          <div className="skill-card__summary-main">
            <div className="skill-card__title-row">
              <h3>{skill.name}</h3>
              {skill.projectCapability === "export-only" ? <span className="projects-page__owner">Agent CLI · {copy("仅下发", "Export only")}</span> : null}
            </div>
            <p className="skill-card__summary-description">{skill.description || skill.relativePath}</p>
            <div className="project-resource-card__meta">
              <span>{skill.toolName}</span>
              <span>{skill.relativePath}</span>
            </div>
          </div>
        </div>
        <div className="skill-card__list-actions project-resource-card__actions">
          <span className={`projects-page__status is-${skill.syncStatus}`}>{statusLabels[skill.syncStatus][language === "en" ? "en" : "zh"]}</span>
          {!isLinked ? <button className="secondary-button secondary-button--compact" type="button" disabled={props.disabled || unavailable} onClick={props.onImport}>{copy("上传托管", "Import")}</button> : null}
          {isLinked && canUpdateProject(skill.syncStatus) ? <button className="secondary-button secondary-button--compact is-primary" type="button" disabled={props.disabled} onClick={props.onUpdateProject}>{copy("更新项目", "Update project")}</button> : null}
          {isLinked && canReverse && canUpdateManaged(skill.syncStatus) ? <button className="secondary-button secondary-button--compact" type="button" disabled={props.disabled || unavailable} onClick={props.onUpdateManaged}>{copy("同步回托管", "Sync to library")}</button> : null}
          {isLinked ? <button className="ghost-button" type="button" disabled={props.disabled} onClick={props.onUnlink}>{copy("解除关联", "Unlink")}</button> : null}
        </div>
      </div>
      {skill.error ? <div className="projects-page__resource-warning">{skill.error}</div> : null}
    </article>
  );
}

function ProjectMcpRow(props: {
  server: ProjectMcpInstance;
  language: "zh-CN" | "en";
  layout: ProjectViewMode;
  disabled: boolean;
  onImport: () => void;
  onUpdateProject: () => void;
  onUpdateManaged: () => void;
  onUnlink: () => void;
}) {
  const { server, language } = props;
  const copy = (zh: string, en: string) => language === "en" ? en : zh;
  const isLinked = Boolean(server.managedMcpId);
  const hasSecretRisk = server.secretRisk === "literal-secret-suspected";
  return (
    <article className={`skill-card project-resource-card skill-card--${props.layout}`}>
      <div className="skill-card__header">
        <div className="skill-card__identity">
          <span className="link-badge project-resource-card__monogram" aria-hidden="true">M</span>
          <div className="skill-card__summary-main">
            <div className="skill-card__title-row">
              <h3>{server.serverName}</h3>
              {hasSecretRisk ? <span className="projects-page__secret">{copy("疑似明文密钥", "Possible plaintext secret")}</span> : null}
            </div>
            <p className="skill-card__summary-description">{server.toolName}</p>
            <div className="project-resource-card__meta"><span>{server.configRelativePath}</span></div>
          </div>
        </div>
        <div className="skill-card__list-actions project-resource-card__actions">
          <span className={`projects-page__status is-${server.syncStatus}`}>{statusLabels[server.syncStatus][language === "en" ? "en" : "zh"]}</span>
          {!isLinked ? <button className="secondary-button secondary-button--compact" type="button" disabled={props.disabled || hasSecretRisk} onClick={props.onImport}>{copy("上传托管", "Import")}</button> : null}
          {isLinked && canUpdateProject(server.syncStatus) ? <button className="secondary-button secondary-button--compact is-primary" type="button" disabled={props.disabled || hasSecretRisk} onClick={props.onUpdateProject}>{copy("更新项目", "Update project")}</button> : null}
          {isLinked && canUpdateManaged(server.syncStatus) ? <button className="secondary-button secondary-button--compact" type="button" disabled={props.disabled || hasSecretRisk} onClick={props.onUpdateManaged}>{copy("同步回托管", "Sync to library")}</button> : null}
          {isLinked ? <button className="ghost-button" type="button" disabled={props.disabled} onClick={props.onUnlink}>{copy("解除关联", "Unlink")}</button> : null}
        </div>
      </div>
      {server.error ? <div className="projects-page__resource-warning">{server.error}</div> : null}
    </article>
  );
}

function ResourceEmpty({ label }: { label: string }) {
  return <div className="projects-page__resource-empty">{label}</div>;
}

function DistributionModal(props: {
  type: "skill" | "mcp";
  language: "zh-CN" | "en";
  workspace: ProjectWorkspaceSnapshot;
  project: ProjectDetail;
  toolId: string;
  resourceId: string;
  targetName: string;
  disabled: boolean;
  onToolChange: (value: string) => void;
  onResourceChange: (value: string, name: string) => void;
  onTargetNameChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const copy = (zh: string, en: string) => props.language === "en" ? en : zh;
  const resources = props.type === "skill" ? props.workspace.managedSkills : props.workspace.managedMcpServers;
  const tools = props.type === "skill" ? projectToolOptions : mcpToolOptions;
  const normalizedTargetName = props.targetName.trim().toLocaleLowerCase();
  const targetAlreadyExists = props.type === "skill"
    ? props.project.skills.some((skill) => (
        skill.toolId === props.toolId
        && skill.name.toLocaleLowerCase() === normalizedTargetName
      ))
    : props.project.mcpServers.some((server) => (
        server.toolId === props.toolId
        && server.serverName.toLocaleLowerCase() === normalizedTargetName
      ));
  return (
    <div className="dialog-backdrop" role="presentation" onClick={props.onClose}>
      <div className="projects-page__dialog" role="dialog" aria-modal="true" aria-label={props.type === "skill" ? copy("下发 Skill", "Distribute Skill") : copy("下发 MCP", "Distribute MCP")} onClick={(event) => event.stopPropagation()}>
        <header><h3>{props.type === "skill" ? copy("下发托管 Skill", "Distribute managed Skill") : copy("下发托管 MCP", "Distribute managed MCP")}</h3></header>
        <div className="projects-page__dialog-body">
          <label>
            <span>{copy("托管资源", "Managed resource")}</span>
            <select value={props.resourceId} onChange={(event) => {
              const resource = resources.find((item) => ("localPath" in item ? item.localPath : item.id) === event.target.value);
              props.onResourceChange(event.target.value, resource?.name ?? "");
            }}>
              {resources.map((resource) => {
                const value = "localPath" in resource ? resource.localPath : resource.id;
                return <option value={value} key={value}>{resource.name}{"managementOwner" in resource && resource.managementOwner === "agent-skills-cli" ? " · Agent CLI" : ""}</option>;
              })}
            </select>
          </label>
          <label>
            <span>{copy("目标工具", "Target tool")}</span>
            <select value={props.toolId} onChange={(event) => props.onToolChange(event.target.value)}>
              {tools.map((tool) => <option value={tool.id} key={tool.id}>{tool.name}</option>)}
            </select>
          </label>
          <label>
            <span>{props.type === "skill" ? copy("目标目录名", "Target directory name") : copy("Server 名称", "Server name")}</span>
            <input value={props.targetName} onChange={(event) => props.onTargetNameChange(event.target.value)} />
          </label>
          {resources.length === 0 ? <div className="dialog-error">{copy("当前没有可下发的托管资源", "No managed resources available")}</div> : null}
          {targetAlreadyExists ? <div className="dialog-error">{copy("目标工具中已存在同名资源，请修改名称或选择其他工具。", "A resource with this name already exists in the target tool.")}</div> : null}
        </div>
        <footer>
          <button className="secondary-button" type="button" onClick={props.onClose}>{copy("取消", "Cancel")}</button>
          <button className="primary-button" type="button" onClick={props.onConfirm} disabled={props.disabled || !props.resourceId || !props.targetName.trim() || targetAlreadyExists}>{copy("下发到项目", "Distribute")}</button>
        </footer>
      </div>
    </div>
  );
}

function ProjectDiffModal(props: {
  state: ProjectDiffState;
  language: "zh-CN" | "en";
  disabled: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const copy = (zh: string, en: string) => props.language === "en" ? en : zh;
  const toProject = props.state.direction === "managed-to-project";
  const title = toProject ? copy("托管 → 项目", "Library → Project") : copy("项目 → 托管", "Project → Library");
  return (
    <div className="dialog-backdrop" role="presentation" onClick={props.onClose}>
      <div className="projects-page__dialog projects-page__diff-dialog" role="dialog" aria-modal="true" aria-label={copy("同步差异预览", "Sync diff preview")} onClick={(event) => event.stopPropagation()}>
        <header>
          <div><h3>{copy("差异预览", "Diff preview")}</h3><p>{title}</p></div>
        </header>
        <div className="projects-page__dialog-body projects-page__diff-body">
          {props.state.type === "skill" ? (
            props.state.snapshot.files.length > 0
              ? props.state.snapshot.files.map((file) => (
                  <article className="projects-page__diff-entry" key={file.path}>
                    <div><span className={`projects-page__diff-status is-${file.status}`}>{file.status}</span><strong>{file.path}</strong>{file.isBinary ? <small>{copy("二进制文件", "Binary")}</small> : null}</div>
                    {!file.isBinary ? <div className="projects-page__diff-columns"><pre>{file.originalContent ?? ""}</pre><pre>{file.currentContent ?? ""}</pre></div> : null}
                  </article>
                ))
              : <ResourceEmpty label={copy("两侧内容一致", "No differences")} />
          ) : (
            <>
              {props.state.snapshot.warnings.map((warning) => <div className="dialog-error" key={warning}>{warning}</div>)}
              {props.state.snapshot.fields.length > 0
                ? props.state.snapshot.fields.map((field) => (
                    <article className="projects-page__mcp-field" key={field.path}>
                      <div><span className={`projects-page__diff-status is-${field.status}`}>{field.status}</span><strong>{field.path}</strong>{field.sensitive ? <small>{copy("已脱敏", "Redacted")}</small> : null}</div>
                      <code>{JSON.stringify(field.before)} → {JSON.stringify(field.after)}</code>
                    </article>
                  ))
                : <ResourceEmpty label={copy("两侧配置一致", "No differences")} />}
            </>
          )}
        </div>
        <footer>
          <button className="secondary-button" type="button" onClick={props.onClose}>{copy("取消", "Cancel")}</button>
          <button className="primary-button" type="button" onClick={props.onConfirm} disabled={props.disabled || (props.state.type === "mcp" && props.state.snapshot.warnings.length > 0)}>{copy("确认同步", "Confirm sync")}</button>
        </footer>
      </div>
    </div>
  );
}
