import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SearchFieldIcon } from "@/app/components/SearchFieldIcon";
import { AppSelect } from "@/app/components/AppSelect";
import { useNotifications } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import {
  distributeMcpToProject,
  distributeSkillsToProject,
  importProjectMcp,
  importProjectSkill,
  openPathInFinder,
  previewProjectMcpSync,
  previewProjectSkillSync,
  removeManagedProject,
  syncProjectMcp,
  syncProjectSkill,
  toggleProjectSkill,
  unlinkProjectResource,
} from "@/features/skills/api/skill-client";
import { PowerToggleIcon } from "@/features/skills/components/PowerToggleIcon";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { resolveToolLogoUrl } from "@/features/skills/utils/tool-logo";
import { getMonogramLabel } from "@/features/skills/utils/monogram";
import type {
  ProjectDetail,
  ProjectMcpDiffSnapshot,
  ProjectMcpInstance,
  ProjectSkillDiffSnapshot,
  ProjectSkillInstance,
  ProjectSkillTarget,
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
export type ProjectSkillGroup = {
  key: string;
  name: string;
  description: string;
  instances: ProjectSkillInstance[];
  hasContentConflict: boolean;
};

const mcpToolOptions = [
  { id: "claude-code", name: "Claude Code" },
  { id: "cursor", name: "Cursor" },
];

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

export function groupProjectSkills(skills: ProjectSkillInstance[]): ProjectSkillGroup[] {
  const groups = new Map<string, ProjectSkillInstance[]>();
  for (const skill of skills) {
    const key = skill.name.trim().toLocaleLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  return [...groups.entries()].map(([key, instances]) => {
    const hashes = new Set(instances.map((instance) => instance.contentHash).filter(Boolean));
    const toolIds = instances.map((instance) => instance.toolId);
    return {
      key,
      name: instances[0]?.name ?? key,
      description: instances.find((instance) => instance.description.trim())?.description ?? "",
      instances,
      hasContentConflict: hashes.size > 1 || new Set(toolIds).size !== toolIds.length,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function groupSyncStatus(group: ProjectSkillGroup): ProjectSyncStatus {
  const priority: ProjectSyncStatus[] = [
    "diverged",
    "unavailable",
    "project-changed",
    "managed-changed",
    "managed-missing",
    "project-missing",
    "project-only",
    "in-sync",
  ];
  if (group.hasContentConflict) return "diverged";
  return priority.find((status) => group.instances.some((instance) => instance.syncStatus === status))
    ?? "in-sync";
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
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [distributionDialog, setDistributionDialog] = useState<DistributionDialog>(null);
  const [distributionToolId, setDistributionToolId] = useState("claude-code");
  const [distributionResourceId, setDistributionResourceId] = useState("");
  const [distributionName, setDistributionName] = useState("");
  const [diffState, setDiffState] = useState<ProjectDiffState | null>(null);

  const activeProject = workspace?.projects.find((project) => project.id === activeProjectId) ?? null;

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
    setDistributionDialog({ type });
    if (type === "mcp") {
      const firstResource = workspace?.managedMcpServers[0];
      setDistributionToolId("claude-code");
      setDistributionResourceId(firstResource?.id ?? "");
      setDistributionName(firstResource?.name ?? "");
    }
  }

  useEffect(() => {
    if (props.addResourceRequest > 0) {
      openDistributionDialog(activeTab === "skills" ? "skill" : "mcp");
    }
  }, [props.addResourceRequest]);

  async function handleDistributeMcp() {
    if (!activeProject || !distributionDialog || !distributionResourceId || !distributionName.trim()) {
      return;
    }
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
    setDistributionDialog(null);
  }

  async function handleDistributeSkills(toolIds: string[], managedSkillPaths: string[], closeDialog = true) {
    if (!activeProject || toolIds.length === 0 || managedSkillPaths.length === 0) {
      return;
    }
    setIsBusy(true);
    setErrorMessage("");
    try {
      const batch = await distributeSkillsToProject({
        projectId: activeProject.id,
        toolIds,
        managedSkillPaths,
      });
      props.onWorkspaceChange(batch.workspace);
      const distributed = batch.results.filter((result) => result.status === "distributed").length;
      const skipped = batch.results.filter((result) => result.status === "skipped").length;
      const conflicts = batch.results.filter((result) => result.status === "conflict").length;
      const failed = batch.results.filter((result) => result.status === "failed").length;
      notify({
        tone: conflicts > 0 || failed > 0 ? "info" : "success",
        message: copy(
          `下发完成：成功 ${distributed}，已存在 ${skipped}，冲突 ${conflicts}，失败 ${failed}`,
          `Distribution complete: ${distributed} added, ${skipped} existing, ${conflicts} conflicts, ${failed} failed`,
        ),
      });
      if (conflicts > 0 || failed > 0) {
        setErrorMessage(copy(
          `部分目标未下发：${conflicts} 个冲突，${failed} 个失败。`,
          `${conflicts} targets conflicted and ${failed} failed.`,
        ));
      }
      if (closeDialog) {
        setDistributionDialog(null);
      }
    } catch (error) {
      const fallbackMessage = copy("批量下发 Skill 失败", "Failed to distribute Skills");
      reportFailure(error, { operation: "distribute_skills_to_project", fallbackMessage });
      setErrorMessage(error instanceof Error ? error.message : fallbackMessage);
    } finally {
      setIsBusy(false);
    }
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

  async function handleToggleSkill(skill: ProjectSkillInstance, enabled: boolean) {
    if (!activeProject) return;
    await runAction(
      "toggle_project_skill",
      () => toggleProjectSkill({
        projectId: activeProject.id,
        toolId: skill.toolId,
        projectRelativePath: skill.relativePath,
        enabled,
      }),
      enabled
        ? copy(`${skill.toolName} 已启用`, `${skill.toolName} enabled`)
        : copy(`${skill.toolName} 已关闭`, `${skill.toolName} disabled`),
    );
  }

  async function handleToggleSkillGroup(group: ProjectSkillGroup, enabled: boolean) {
    if (!activeProject) return;
    const targets = group.instances.filter((instance) => (
      instance.entryKind === "directory" && instance.isEnabled !== enabled
    ));
    if (targets.length === 0) return;
    setIsBusy(true);
    setErrorMessage("");
    let latestSnapshot: ProjectWorkspaceSnapshot | null = null;
    try {
      for (const skill of targets) {
        latestSnapshot = await toggleProjectSkill({
          projectId: activeProject.id,
          toolId: skill.toolId,
          projectRelativePath: skill.relativePath,
          enabled,
        });
      }
      if (latestSnapshot) props.onWorkspaceChange(latestSnapshot);
      notify({
        tone: "success",
        message: enabled
          ? copy(`${group.name} 已启用`, `${group.name} enabled`)
          : copy(`${group.name} 已关闭`, `${group.name} disabled`),
      });
    } catch (error) {
      if (latestSnapshot) props.onWorkspaceChange(latestSnapshot);
      const fallbackMessage = copy("切换项目 Skill 状态失败", "Failed to toggle project Skill");
      reportFailure(error, { operation: "toggle_project_skill_group", fallbackMessage });
      setErrorMessage(error instanceof Error ? error.message : fallbackMessage);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleAddSkillTarget(group: ProjectSkillGroup, target: ProjectSkillTarget) {
    const managedSkillPaths = [...new Set(group.instances
      .map((instance) => instance.managedSkillPath)
      .filter(Boolean))];
    if (group.hasContentConflict || managedSkillPaths.length !== 1) {
      setErrorMessage(copy(
        "请先上传托管或解决多版本冲突，再添加到其他工具。",
        "Upload the Skill or resolve its version conflict before adding another tool.",
      ));
      return;
    }
    await handleDistributeSkills([target.toolId], managedSkillPaths, false);
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
  const groupedSkills = groupProjectSkills(activeProject?.skills ?? []);
  const filteredSkills = groupedSkills.filter((group) => (
    (props.statusFilter === "all" || groupSyncStatus(group) === props.statusFilter)
    && (!normalizedQuery || [group.name, group.description, ...group.instances.flatMap((instance) => [
      instance.toolName,
      instance.relativePath,
    ])].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
  ));
  const filteredMcpServers = activeProject?.mcpServers.filter((server) => (
    !normalizedQuery || [server.serverName, server.toolName, server.configRelativePath]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  )) ?? [];

  if (!workspace) {
    return <div className="panel-card empty-state"><p>{copy("正在扫描项目…", "Scanning projects…")}</p></div>;
  }

  return (
    <div className="projects-page skills-page">
      {errorMessage ? <div className="dialog-error projects-page__error">{errorMessage}</div> : null}
      {activeProject ? (
        <section className="projects-page__detail">
          <div className="projects-page__project-actions">
            <button className="ghost-button" type="button" onClick={() => void openPathInFinder({ path: activeProject.canonicalRootPath })}>
              {copy("打开目录", "Open folder")}
            </button>
            <button className="ghost-button is-warning" type="button" onClick={() => void handleRemoveProject(activeProject)}>
              {copy("移除管理", "Remove")}
            </button>
          </div>
          {activeProject.errors.map((error) => <div className="dialog-error" key={error}>{error}</div>)}
          {activeTab === "skills" ? (
            <div className={`card-list project-resource-list${props.viewMode === "grid" ? " skill-card-grid" : ""}`}>
                  {filteredSkills.map((group) => (
                    <ProjectSkillCard
                      key={group.key}
                      group={group}
                      targets={activeProject.skillTargets}
                      language={language}
                      layout={props.viewMode}
                      disabled={isBusy}
                      onImport={(skill) => void runAction(
                        "import_project_skill",
                        () => importProjectSkill({ projectId: activeProject.id, toolId: skill.toolId, projectRelativePath: skill.relativePath }),
                        copy("项目 Skill 已上传到托管", "Project Skill imported"),
                      )}
                      onToggle={(skill, enabled) => void handleToggleSkill(skill, enabled)}
                      onToggleAll={(enabled) => void handleToggleSkillGroup(group, enabled)}
                      onAddTarget={(target) => void handleAddSkillTarget(group, target)}
                      onUpdateProject={(skill) => void handlePreviewSkill(skill, "managed-to-project")}
                      onUpdateManaged={(skill) => void handlePreviewSkill(skill, "project-to-managed")}
                      onUnlink={(skill) => void runAction(
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

      {distributionDialog?.type === "skill" && activeProject ? (
        <SkillDistributionModal
          language={language}
          workspace={workspace}
          project={activeProject}
          disabled={isBusy}
          onClose={() => setDistributionDialog(null)}
          onConfirm={(toolIds, managedSkillPaths) => void handleDistributeSkills(toolIds, managedSkillPaths)}
        />
      ) : null}
      {distributionDialog?.type === "mcp" && activeProject ? (
        <McpDistributionModal
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
          onConfirm={() => void handleDistributeMcp()}
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

function ProjectSkillMonogram({ name }: { name: string }) {
  return (
    <div className="link-badge link-badge--monogram" aria-hidden="true">
      <span className="link-badge__type-mark link-badge__type-mark--skill">
        <svg viewBox="0 0 12 12" fill="none">
          <path d="M6 1.5 7.1 4.9 10.5 6 7.1 7.1 6 10.5 4.9 7.1 1.5 6 4.9 4.9 6 1.5Z" fill="currentColor" />
        </svg>
      </span>
      <span className="link-badge__label">{getMonogramLabel(name)}</span>
    </div>
  );
}

function ProjectToolIcon({ instance }: { instance: ProjectSkillInstance }) {
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoUrl = resolveToolLogoUrl(instance.toolName);
  return (
    <span
      className={`skill-card__tool-icon${instance.isEnabled ? "" : " is-disabled"}`}
      title={`${instance.toolName} · ${instance.isEnabled ? "已启用" : "已关闭"}`}
      aria-hidden="true"
    >
      {logoUrl && !logoLoadFailed
        ? <img src={logoUrl} alt="" loading="lazy" onError={() => setLogoLoadFailed(true)} />
        : <span>{getMonogramLabel(instance.toolName)}</span>}
    </span>
  );
}

function ProjectTargetIcon({ target }: { target: ProjectSkillTarget }) {
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoUrl = resolveToolLogoUrl(target.toolName);
  return (
    <span className="tool-pill__logo" aria-hidden="true">
      {logoUrl && !logoLoadFailed
        ? <img src={logoUrl} alt="" loading="lazy" onError={() => setLogoLoadFailed(true)} />
        : <span>{getMonogramLabel(target.toolName)}</span>}
    </span>
  );
}

function ProjectSkillCard(props: {
  group: ProjectSkillGroup;
  targets: ProjectSkillTarget[];
  language: "zh-CN" | "en";
  layout: ProjectViewMode;
  disabled: boolean;
  onImport: (skill: ProjectSkillInstance) => void;
  onToggle: (skill: ProjectSkillInstance, enabled: boolean) => void;
  onToggleAll: (enabled: boolean) => void;
  onAddTarget: (target: ProjectSkillTarget) => void;
  onUpdateProject: (skill: ProjectSkillInstance) => void;
  onUpdateManaged: (skill: ProjectSkillInstance) => void;
  onUnlink: (skill: ProjectSkillInstance) => void;
}) {
  const { group, language } = props;
  const copy = (zh: string, en: string) => language === "en" ? en : zh;
  const [expanded, setExpanded] = useState(false);
  const isGridLayout = props.layout === "grid";
  const duplicateToolIds = new Set(group.instances
    .filter((instance, index, instances) => (
      instances.findIndex((candidate) => candidate.toolId === instance.toolId) !== index
    ))
    .map((instance) => instance.toolId));
  const hasDuplicateToolInstances = duplicateToolIds.size > 0;
  const enabledInstances = group.instances.filter((instance) => (
    instance.entryKind === "directory" && instance.isEnabled
  ));
  const toggleableInstances = group.instances.filter((instance) => instance.entryKind === "directory");
  const allEnabled = toggleableInstances.length > 0 && toggleableInstances.every((instance) => instance.isEnabled);
  const partiallyEnabled = enabledInstances.length > 0 && !allEnabled;
  const managedSkillPaths = [...new Set(group.instances
    .map((instance) => instance.managedSkillPath)
    .filter(Boolean))];
  const canAddMissingTarget = !group.hasContentConflict && managedSkillPaths.length === 1;
  const status = groupSyncStatus(group);
  const toggleState = allEnabled ? "is-enabled" : partiallyEnabled ? "is-partial" : "is-disabled";
  const enabledLabel = enabledInstances.length > 0
    ? copy(`已启用 ${enabledInstances.length}`, `Enabled ${enabledInstances.length}`)
    : copy("已关闭", "Disabled");
  const details = (
    <>
      <section>
        <div className="skill-card__section-header"><h4>{copy("基本信息", "Basic information")}</h4></div>
        <dl className="detail-grid detail-grid--single">
          <div><dt>{copy("描述", "Description")}</dt><dd>{group.description || copy("暂无描述", "No description")}</dd></div>
        </dl>
        {group.hasContentConflict ? (
          <div className="projects-page__resource-warning">
            {hasDuplicateToolInstances
              ? copy(
                  "同一工具的启用和关闭目录中同时存在同名 Skill。请先手动处理目录冲突，再执行启停或同步。",
                  "The same Skill exists in both enabled and disabled directories. Resolve the directory conflict before toggling or syncing.",
                )
              : copy(
                  "不同工具中的同名 Skill 内容不一致。请分别预览与托管中心的差异，再明确选择同步方向。",
                  "This Skill has different content across tools. Preview each library diff before choosing a sync direction.",
                )}
          </div>
        ) : null}
      </section>
      <section className="tool-sync-panel project-skill-target-panel">
        <div className="skill-card__section-header">
          <h4>{copy("启用到工具", "Enable in tools")}</h4>
          <div className="tool-sync-panel__actions">
            <button className="secondary-button secondary-button--compact semantic-action semantic-action--enable" type="button" disabled={props.disabled || toggleableInstances.length === 0 || allEnabled || hasDuplicateToolInstances} onClick={() => props.onToggleAll(true)}>
              {copy("全部开启", "Enable all")}
            </button>
            <button className="secondary-button secondary-button--compact semantic-action semantic-action--disable" type="button" disabled={props.disabled || enabledInstances.length === 0 || hasDuplicateToolInstances} onClick={() => props.onToggleAll(false)}>
              {copy("全部关闭", "Disable all")}
            </button>
          </div>
        </div>
        <div className="tool-pill-grid">
          {props.targets.map((target) => {
            const instance = group.instances.find((candidate) => candidate.toolId === target.toolId);
            const enabled = Boolean(instance?.isEnabled);
            const present = Boolean(instance && instance.entryKind === "directory");
            const unavailable = Boolean(instance && (
              instance.entryKind !== "directory" || duplicateToolIds.has(instance.toolId)
            ));
            const disabled = props.disabled || unavailable || (!present && !canAddMissingTarget);
            const stateLabel = present
              ? enabled ? copy("已启用", "Enabled") : copy("已关闭", "Disabled")
              : copy("未下发", "Not added");
            const ariaLabel = present
              ? enabled
                ? copy(`关闭 ${target.toolName}`, `Disable ${target.toolName}`)
                : copy(`启用 ${target.toolName}`, `Enable ${target.toolName}`)
              : copy(`添加到 ${target.toolName}`, `Add to ${target.toolName}`);
            return (
              <button
                className={`tool-pill${enabled ? " is-enabled" : ""}${present && !enabled ? " is-present-disabled" : ""}`}
                type="button"
                key={target.toolId}
                disabled={disabled}
                aria-pressed={enabled}
                aria-label={ariaLabel}
                data-tooltip={stateLabel}
                onClick={() => instance
                  ? props.onToggle(instance, !instance.isEnabled)
                  : props.onAddTarget(target)}
              >
                <ProjectTargetIcon target={target} />
                <span className="tool-pill__name">{target.toolName}</span>
                <span className="project-skill-target-panel__state">{stateLabel}</span>
              </button>
            );
          })}
        </div>
        {!canAddMissingTarget ? (
          <p className="project-skill-target-panel__hint">
            {group.hasContentConflict
              ? copy("先解决多版本冲突，再添加到其他工具。", "Resolve the version conflict before adding another tool.")
              : copy("先上传到托管，再添加到其他工具。", "Upload to the library before adding another tool.")}
          </p>
        ) : null}
      </section>
      <section className="project-skill-tools">
        <div className="skill-card__section-header"><h4>{copy("同步详情", "Sync details")}</h4></div>
        <div className="project-skill-tools__list">
          {group.instances.map((skill) => {
            const isLinked = Boolean(skill.managedSkillPath);
            const unavailable = skill.entryKind !== "directory"
              || skill.syncStatus === "unavailable"
              || duplicateToolIds.has(skill.toolId);
            return (
              <article className="project-skill-tool-row" key={`${skill.toolId}:${skill.localPath}`}>
                <div className="project-skill-tool-row__identity">
                  <ProjectToolIcon instance={skill} />
                  <div>
                    <strong>{skill.toolName}</strong>
                    <span title={skill.localPath}>{skill.isEnabled ? skill.relativePath : `${skill.relativePath} · ${copy("已关闭", "Disabled")}`}</span>
                  </div>
                </div>
                <span className={`projects-page__status is-${skill.syncStatus}`}>
                  {statusLabels[skill.syncStatus][language === "en" ? "en" : "zh"]}
                </span>
                {skill.projectCapability === "export-only" ? (
                  <span className="projects-page__owner">Agent CLI · {copy("仅下发", "Export only")}</span>
                ) : null}
                <div className="project-skill-tool-row__actions">
                  {!isLinked ? <button className="secondary-button secondary-button--compact" type="button" disabled={props.disabled || unavailable} onClick={() => props.onImport(skill)}>{copy("上传托管", "Import")}</button> : null}
                  {isLinked && canUpdateProject(skill.syncStatus) ? <button className="secondary-button secondary-button--compact is-primary" type="button" disabled={props.disabled || unavailable} onClick={() => props.onUpdateProject(skill)}>{copy("更新项目", "Update project")}</button> : null}
                  {isLinked && skill.projectCapability === "bidirectional" && canUpdateManaged(skill.syncStatus) ? <button className="secondary-button secondary-button--compact" type="button" disabled={props.disabled || unavailable} onClick={() => props.onUpdateManaged(skill)}>{copy("同步回托管", "Sync to library")}</button> : null}
                  {isLinked ? <button className="ghost-button" type="button" disabled={props.disabled} onClick={() => props.onUnlink(skill)}>{copy("解除关联", "Unlink")}</button> : null}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
  return (
    <>
      <article className={`skill-card project-resource-card skill-card--${props.layout}${expanded ? " is-expanded" : ""}`} aria-label={group.name}>
        <div className="skill-card__header">
          <button
            className="skill-card__summary-button"
            type="button"
            aria-expanded={expanded}
            aria-label={expanded
              ? copy(`收起 ${group.name}`, `Collapse ${group.name}`)
              : copy(`展开 ${group.name}`, `Expand ${group.name}`)}
            onClick={() => setExpanded(!expanded)}
          >
            <div className="skill-card__summary-content">
              <div className="skill-card__identity">
                <ProjectSkillMonogram name={group.name} />
                <div className="skill-card__title-stack">
                  <div className="skill-card__title-row">
                    <h3>{group.name}</h3>
                    {!isGridLayout ? <span className={`status-badge skill-card__grid-enabled-badge ${enabledInstances.length > 0 ? "tone-info" : "tone-neutral"}`}>{enabledLabel}</span> : null}
                    {!isGridLayout ? <div className="skill-card__summary-tools">{group.instances.map((instance) => <ProjectToolIcon key={`${instance.toolId}:${instance.localPath}`} instance={instance} />)}</div> : null}
                  </div>
                  <p className="skill-card__summary-description">{group.description || copy("暂无描述", "No description")}</p>
                  {isGridLayout ? (
                    <div className="skill-card__grid-meta">
                      <span className={`status-badge skill-card__grid-enabled-badge ${enabledInstances.length > 0 ? "tone-info" : "tone-neutral"}`}>{enabledLabel}</span>
                      <div className="skill-card__summary-tools">{group.instances.map((instance) => <ProjectToolIcon key={`${instance.toolId}:${instance.localPath}`} instance={instance} />)}</div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </button>
          <div className="skill-card__list-actions project-resource-card__actions">
            <span className={`projects-page__status is-${status}`}>{group.hasContentConflict ? copy("多版本冲突", "Version conflict") : statusLabels[status][language === "en" ? "en" : "zh"]}</span>
            <button
              className={`skill-card__icon-button plugins-page__toggle-icon-button ${toggleState}`}
              type="button"
              disabled={props.disabled || toggleableInstances.length === 0 || hasDuplicateToolInstances}
              aria-label={allEnabled ? copy(`关闭 ${group.name}`, `Disable ${group.name}`) : copy(`启用 ${group.name}`, `Enable ${group.name}`)}
              onClick={() => props.onToggleAll(!allEnabled)}
            ><PowerToggleIcon isSpinning={props.disabled} /></button>
            {!isGridLayout ? (
              <button className="skill-card__chevron-button" type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label={expanded ? copy(`收起 ${group.name} 详情`, `Collapse ${group.name} details`) : copy(`展开 ${group.name} 详情`, `Expand ${group.name} details`)}>
                <span className="skill-card__chevron" aria-hidden="true">{expanded ? "⌄" : "›"}</span>
              </button>
            ) : null}
          </div>
        </div>
        {expanded && !isGridLayout ? <div className="skill-card__details">{details}</div> : null}
      </article>
      {expanded && isGridLayout ? createPortal(
        <div className="skill-card-detail-modal__backdrop" role="presentation" onClick={() => setExpanded(false)}>
          <section className="skill-card-detail-modal" role="dialog" aria-modal="true" aria-label={copy(`${group.name} 详情`, `${group.name} details`)} onClick={(event) => event.stopPropagation()}>
            <header className="skill-card-detail-modal__header">
              <div className="skill-card-detail-modal__identity">
                <ProjectSkillMonogram name={group.name} />
                <div className="skill-card-detail-modal__copy"><div className="skill-card-detail-modal__title"><h3>{group.name}</h3><span className={`projects-page__status is-${status}`}>{group.hasContentConflict ? copy("多版本冲突", "Version conflict") : statusLabels[status][language === "en" ? "en" : "zh"]}</span></div></div>
              </div>
              <button className="skill-card-detail-modal__close" type="button" onClick={() => setExpanded(false)} aria-label={copy(`关闭 ${group.name} 详情`, `Close ${group.name} details`)}><span aria-hidden="true">×</span></button>
            </header>
            <div className="skill-card__details skill-card-detail-modal__body">{details}</div>
          </section>
        </div>,
        document.body,
      ) : null}
    </>
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

function SkillDistributionModal(props: {
  language: "zh-CN" | "en";
  workspace: ProjectWorkspaceSnapshot;
  project: ProjectDetail;
  disabled: boolean;
  onClose: () => void;
  onConfirm: (toolIds: string[], managedSkillPaths: string[]) => void;
}) {
  const copy = (zh: string, en: string) => props.language === "en" ? en : zh;
  const defaultToolIds = props.project.skillTargets
    .filter((target) => target.isDetected)
    .map((target) => target.toolId);
  const [selectedToolIds, setSelectedToolIds] = useState(defaultToolIds);
  const [selectedSkillPaths, setSelectedSkillPaths] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [ownerFilter, setOwnerFilter] = useState<"all" | "skilldock" | "agent-skills-cli">("all");
  const [showAllTargets, setShowAllTargets] = useState(false);
  const sortedTargets = [...props.project.skillTargets].sort((left, right) => (
    Number(right.isDetected) - Number(left.isDetected) || left.toolName.localeCompare(right.toolName)
  ));
  const visibleTargetLimit = Math.max(defaultToolIds.length, 12);
  const visibleTargets = showAllTargets ? sortedTargets : sortedTargets.slice(0, visibleTargetLimit);
  const hiddenTargetCount = sortedTargets.length - visibleTargets.length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredSkills = props.workspace.managedSkills.filter((skill) => (
    (ownerFilter === "all" || skill.managementOwner === ownerFilter)
    && (!normalizedQuery || [skill.name, skill.description]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
  ));
  const allTargetsSelected = sortedTargets.length > 0
    && sortedTargets.every((target) => selectedToolIds.includes(target.toolId));

  function toggleTarget(target: ProjectSkillTarget) {
    const sharedToolIds = sortedTargets
      .filter((candidate) => candidate.targetKey === target.targetKey)
      .map((candidate) => candidate.toolId);
    const sharedTargetsSelected = sharedToolIds.every((toolId) => selectedToolIds.includes(toolId));
    setSelectedToolIds((current) => sharedTargetsSelected
      ? current.filter((toolId) => !sharedToolIds.includes(toolId))
      : [...new Set([...current, ...sharedToolIds])]);
  }

  function skillTargetStatus(managedSkillPath: string, skillName: string) {
    const selectedInstances = selectedToolIds.map((toolId) => props.project.skills.find((skill) => (
      skill.toolId === toolId && skill.name.toLocaleLowerCase() === skillName.toLocaleLowerCase()
    )));
    const added = selectedInstances.filter((instance) => instance?.managedSkillPath === managedSkillPath).length;
    const conflicts = selectedInstances.filter((instance) => (
      instance && instance.managedSkillPath !== managedSkillPath
    )).length;
    if (selectedToolIds.length > 0 && added === selectedToolIds.length) {
      return { key: "added", label: copy("已全部添加", "Added to all") };
    }
    if (conflicts > 0) {
      return { key: "conflict", label: copy("存在冲突", "Conflict") };
    }
    if (added > 0) {
      return { key: "partial", label: copy("部分已添加", "Partially added") };
    }
    return { key: "available", label: copy("可添加", "Available") };
  }

  const selectableSkillPaths = selectedSkillPaths.filter((path) => {
    const skill = props.workspace.managedSkills.find((item) => item.localPath === path);
    return skill && skillTargetStatus(skill.localPath, skill.name).key !== "added";
  });

  return (
    <div className="dialog-backdrop" role="presentation" onClick={props.onClose}>
      <div className="projects-page__dialog projects-page__skill-distribution" role="dialog" aria-modal="true" aria-label={copy("下发 Skill", "Distribute Skill")} onClick={(event) => event.stopPropagation()}>
        <header>
          <h3>{copy("从托管库添加", "Add from library")}</h3>
          <button
            className="skill-card-detail-modal__close"
            type="button"
            onClick={props.onClose}
            aria-label={copy("关闭下发 Skill", "Close Skill distribution")}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="projects-page__dialog-body projects-page__skill-distribution-body">
          <section className="project-distribution-targets">
            <div className="project-distribution-section-title">
              <span>{copy("目标工具", "Target tools")}</span>
              <button type="button" onClick={() => setSelectedToolIds(allTargetsSelected ? [] : sortedTargets.map((target) => target.toolId))}>
                {allTargetsSelected ? copy("取消全选", "Clear all") : copy("全选", "Select all")}
              </button>
            </div>
            <div className="project-distribution-target-grid">
              {visibleTargets.map((target) => {
                const active = selectedToolIds.includes(target.toolId);
                return (
                  <button
                    className={`tool-pill project-distribution-target${active ? " is-enabled" : ""}`}
                    type="button"
                    key={target.toolId}
                    aria-pressed={active}
                    aria-label={target.toolName}
                    onClick={() => toggleTarget(target)}
                    title={`${target.toolName} · ${target.skillRelativePath}`}
                  >
                    <ProjectTargetIcon target={target} />
                    <span className="tool-pill__name">{target.toolName}</span>
                    {target.isDetected ? <span className="project-distribution-target__detected">{copy("项目已有", "Detected")}</span> : null}
                  </button>
                );
              })}
            </div>
            {hiddenTargetCount > 0 ? (
              <button className="project-distribution-more" type="button" onClick={() => setShowAllTargets(true)}>
                {copy(`更多工具 (${hiddenTargetCount})`, `More tools (${hiddenTargetCount})`)}
              </button>
            ) : showAllTargets && sortedTargets.length > visibleTargetLimit ? (
              <button className="project-distribution-more" type="button" onClick={() => setShowAllTargets(false)}>
                {copy("收起工具", "Show fewer")}
              </button>
            ) : null}
          </section>

          <section className="project-distribution-library">
            <label className="search-field project-distribution-search">
              <span className="sr-only">{copy("搜索托管 Skill", "Search managed Skills")}</span>
              <SearchFieldIcon />
              <input type="search" value={query} placeholder={copy("搜索托管 Skill…", "Search managed Skills…")} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <div className="project-distribution-owner-filters" aria-label={copy("托管方筛选", "Library owner filter")}>
              {([
                ["all", copy("全部来源", "All sources")],
                ["skilldock", "SkillDock"],
                ["agent-skills-cli", "Agent CLI"],
              ] as const).map(([value, label]) => (
                <button className={ownerFilter === value ? "is-active" : ""} type="button" key={value} onClick={() => setOwnerFilter(value)}>{label}</button>
              ))}
            </div>
            <div className="project-distribution-skill-list">
              {filteredSkills.map((skill) => {
                const status = skillTargetStatus(skill.localPath, skill.name);
                const checked = selectedSkillPaths.includes(skill.localPath);
                const disabled = status.key === "added";
                return (
                  <label className={`project-distribution-skill${checked ? " is-selected" : ""}${disabled ? " is-disabled" : ""}`} key={skill.localPath}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => setSelectedSkillPaths((current) => checked
                        ? current.filter((path) => path !== skill.localPath)
                        : [...current, skill.localPath])}
                    />
                    <ProjectSkillMonogram name={skill.name} />
                    <span className="project-distribution-skill__copy">
                      <strong>{skill.name}</strong>
                      <span>{skill.description || copy("暂无描述", "No description")}</span>
                    </span>
                    <span className="project-distribution-skill__owner">
                      {skill.managementOwner === "agent-skills-cli" ? "Agent CLI" : "SkillDock"}
                    </span>
                    <span className={`project-distribution-skill__status is-${status.key}`}>{status.label}</span>
                  </label>
                );
              })}
              {filteredSkills.length === 0 ? <div className="projects-page__resource-empty">{copy("没有匹配的托管 Skill", "No matching managed Skills")}</div> : null}
            </div>
          </section>
        </div>
        <footer>
          <span className="project-distribution-selection-summary">
            {copy(`已选 ${selectableSkillPaths.length} 个 Skill、${selectedToolIds.length} 个工具`, `${selectableSkillPaths.length} Skills and ${selectedToolIds.length} tools selected`)}
          </span>
          <button className="secondary-button" type="button" onClick={props.onClose}>{copy("取消", "Cancel")}</button>
          <button className="primary-button" type="button" onClick={() => props.onConfirm(selectedToolIds, selectableSkillPaths)} disabled={props.disabled || selectedToolIds.length === 0 || selectableSkillPaths.length === 0}>
            {copy(`下发 ${selectableSkillPaths.length} 个 Skill 到 ${selectedToolIds.length} 个工具`, `Distribute ${selectableSkillPaths.length} Skills to ${selectedToolIds.length} tools`)}
          </button>
        </footer>
      </div>
    </div>
  );
}

function McpDistributionModal(props: {
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
  const resources = props.workspace.managedMcpServers;
  const normalizedTargetName = props.targetName.trim().toLocaleLowerCase();
  const targetAlreadyExists = props.project.mcpServers.some((server) => (
    server.toolId === props.toolId
    && server.serverName.toLocaleLowerCase() === normalizedTargetName
  ));
  return (
    <div className="dialog-backdrop" role="presentation" onClick={props.onClose}>
      <div className="projects-page__dialog" role="dialog" aria-modal="true" aria-label={copy("下发 MCP", "Distribute MCP")} onClick={(event) => event.stopPropagation()}>
        <header><h3>{copy("下发托管 MCP", "Distribute managed MCP")}</h3></header>
        <div className="projects-page__dialog-body">
          <label>
            <span>{copy("托管资源", "Managed resource")}</span>
            <select value={props.resourceId} onChange={(event) => {
              const resource = resources.find((item) => item.id === event.target.value);
              props.onResourceChange(event.target.value, resource?.name ?? "");
            }}>
              {resources.map((resource) => {
                return <option value={resource.id} key={resource.id}>{resource.name}</option>;
              })}
            </select>
          </label>
          <label>
            <span>{copy("目标工具", "Target tool")}</span>
            <select value={props.toolId} onChange={(event) => props.onToolChange(event.target.value)}>
              {mcpToolOptions.map((tool) => <option value={tool.id} key={tool.id}>{tool.name}</option>)}
            </select>
          </label>
          <label>
            <span>{copy("Server 名称", "Server name")}</span>
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
