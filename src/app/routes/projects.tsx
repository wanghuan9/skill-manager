import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useNotifications } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import {
  addManagedProject,
  distributeMcpToProject,
  distributeSkillToProject,
  fetchProjectWorkspaces,
  importProjectMcp,
  importProjectSkill,
  openPathInFinder,
  previewProjectMcpSync,
  previewProjectSkillSync,
  removeManagedProject,
  shouldUseFixtureData,
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

type ProjectResourceTab = "skills" | "mcp";
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

function selectedPath(value: string | string[] | null) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function canUpdateProject(status: ProjectSyncStatus) {
  return ["project-missing", "managed-changed", "diverged"].includes(status);
}

function canUpdateManaged(status: ProjectSyncStatus) {
  return ["managed-missing", "project-changed", "diverged"].includes(status);
}

export function ProjectsRoute() {
  const { language } = useSkillWorkspace();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const copy = (zh: string, en: string) => language === "en" ? en : zh;
  const [workspace, setWorkspace] = useState<ProjectWorkspaceSnapshot | null>(null);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [activeTab, setActiveTab] = useState<ProjectResourceTab>("skills");
  const [activeToolId, setActiveToolId] = useState("all");
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [distributionDialog, setDistributionDialog] = useState<DistributionDialog>(null);
  const [distributionToolId, setDistributionToolId] = useState("claude-code");
  const [distributionResourceId, setDistributionResourceId] = useState("");
  const [distributionName, setDistributionName] = useState("");
  const [diffState, setDiffState] = useState<ProjectDiffState | null>(null);

  const activeProject = workspace?.projects.find((project) => project.id === activeProjectId)
    ?? workspace?.projects[0]
    ?? null;

  useEffect(() => {
    let isMounted = true;
    void fetchProjectWorkspaces()
      .then((snapshot) => {
        if (!isMounted) return;
        setWorkspace(snapshot);
        setActiveProjectId((current) => current || snapshot.projects[0]?.id || "");
      })
      .catch((error) => {
        if (!isMounted) return;
        const message = error instanceof Error ? error.message : copy("读取项目失败", "Failed to load projects");
        setErrorMessage(message);
      });
    return () => {
      isMounted = false;
    };
  }, []);

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
      setWorkspace(snapshot);
      if (!snapshot.projects.some((project) => project.id === activeProjectId)) {
        setActiveProjectId(snapshot.projects[0]?.id ?? "");
      }
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

  async function handleAddProject() {
    const path = shouldUseFixtureData()
      ? "/Users/demo/Projects/new-project"
      : selectedPath(await open({
          directory: true,
          multiple: false,
          title: copy("选择要管理的项目目录", "Choose a project directory"),
        }));
    if (!path) return;
    await runAction(
      "add_managed_project",
      () => addManagedProject(path),
      copy("项目已加入管理", "Project added"),
    );
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

  const filteredSkills = activeProject?.skills.filter(
    (skill) => activeToolId === "all" || skill.toolId === activeToolId,
  ) ?? [];
  const filteredMcpServers = activeProject?.mcpServers.filter(
    (server) => activeToolId === "all" || server.toolId === activeToolId,
  ) ?? [];

  if (!workspace) {
    return <div className="panel-card empty-state"><p>{copy("正在扫描项目…", "Scanning projects…")}</p></div>;
  }

  return (
    <div className="projects-page">
      <div className="projects-page__toolbar">
        <button className="primary-button" type="button" onClick={() => void handleAddProject()} disabled={isBusy}>
          {copy("添加项目", "Add project")}
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void runAction(
            "refresh_managed_projects",
            fetchProjectWorkspaces,
            copy("项目已刷新", "Projects refreshed"),
          )}
          disabled={isBusy}
        >
          {copy("刷新", "Refresh")}
        </button>
        <span className="projects-page__storage">{workspace.storagePath}</span>
      </div>
      {errorMessage ? <div className="dialog-error projects-page__error">{errorMessage}</div> : null}

      {workspace.projects.length === 0 ? (
        <div className="panel-card empty-state projects-page__empty">
          <h3>{copy("还没有受管理项目", "No managed projects")}</h3>
          <p>{copy("添加项目后会识别其中现有的 Skills 和 MCP 配置。", "Add a project to discover its existing Skills and MCP configuration.")}</p>
          <button className="primary-button" type="button" onClick={() => void handleAddProject()}>
            {copy("选择项目目录", "Choose project directory")}
          </button>
        </div>
      ) : (
        <div className="projects-page__layout">
          <aside className="projects-page__sidebar" aria-label={copy("项目列表", "Project list")}>
            {workspace.projects.map((project) => (
              <button
                className={`projects-page__project${project.id === activeProject?.id ? " is-active" : ""}`}
                key={project.id}
                type="button"
                onClick={() => setActiveProjectId(project.id)}
              >
                <span>{project.name}</span>
                <small>{project.availability === "missing" ? copy("目录已缺失", "Missing") : project.rootPath}</small>
              </button>
            ))}
          </aside>

          {activeProject ? (
            <section className="projects-page__detail">
              <header className="projects-page__project-header">
                <div>
                  <h2>{activeProject.name}</h2>
                  <p>{activeProject.canonicalRootPath}</p>
                </div>
                <div className="projects-page__header-actions">
                  <button className="secondary-button secondary-button--compact" type="button" onClick={() => void openPathInFinder({ path: activeProject.canonicalRootPath })}>
                    {copy("打开目录", "Open folder")}
                  </button>
                  <button className="secondary-button secondary-button--compact is-warning" type="button" onClick={() => void handleRemoveProject(activeProject)}>
                    {copy("移除管理", "Remove")}
                  </button>
                </div>
              </header>
              {activeProject.errors.map((error) => <div className="dialog-error" key={error}>{error}</div>)}
              <div className="projects-page__tabs" role="tablist" aria-label={copy("项目资源", "Project resources")}>
                <button role="tab" aria-selected={activeTab === "skills"} className={activeTab === "skills" ? "is-active" : ""} type="button" onClick={() => setActiveTab("skills")}>
                  Skills <span>{activeProject.skills.length}</span>
                </button>
                <button role="tab" aria-selected={activeTab === "mcp"} className={activeTab === "mcp" ? "is-active" : ""} type="button" onClick={() => setActiveTab("mcp")}>
                  MCP <span>{activeProject.mcpServers.length}</span>
                </button>
              </div>
              <div className="projects-page__resource-toolbar">
                <div className="projects-page__tool-filters">
                  <button className={activeToolId === "all" ? "is-active" : ""} type="button" onClick={() => setActiveToolId("all")}>{copy("全部", "All")}</button>
                  {availableToolIds.map((toolId) => (
                    <button className={activeToolId === toolId ? "is-active" : ""} type="button" key={toolId} onClick={() => setActiveToolId(toolId)}>
                      {projectToolOptions.find((tool) => tool.id === toolId)?.name ?? toolId}
                    </button>
                  ))}
                </div>
                <button className="primary-button primary-button--compact" type="button" onClick={() => openDistributionDialog(activeTab === "skills" ? "skill" : "mcp")}>
                  {activeTab === "skills" ? copy("下发 Skill", "Distribute Skill") : copy("下发 MCP", "Distribute MCP")}
                </button>
              </div>

              {activeTab === "skills" ? (
                <div className="projects-page__resources">
                  {filteredSkills.map((skill) => (
                    <ProjectSkillRow
                      key={`${skill.toolId}:${skill.relativePath}`}
                      skill={skill}
                      language={language}
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
                <div className="projects-page__resources">
                  {filteredMcpServers.map((server) => (
                    <ProjectMcpRow
                      key={`${server.toolId}:${server.serverName}`}
                      server={server}
                      language={language}
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
          ) : null}
        </div>
      )}

      {distributionDialog ? (
        <DistributionModal
          type={distributionDialog.type}
          language={language}
          workspace={workspace}
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
    <article className="projects-page__resource-card">
      <div className="projects-page__resource-copy">
        <div className="projects-page__resource-title">
          <h3>{skill.name}</h3>
          <span className={`projects-page__status is-${skill.syncStatus}`}>{statusLabels[skill.syncStatus][language === "en" ? "en" : "zh"]}</span>
          {skill.projectCapability === "export-only" ? <span className="projects-page__owner">Agent CLI · {copy("仅下发", "Export only")}</span> : null}
        </div>
        <p>{skill.description || skill.relativePath}</p>
        <small>{skill.toolName} · {skill.relativePath}</small>
        {skill.error ? <div className="projects-page__resource-warning">{skill.error}</div> : null}
      </div>
      <div className="projects-page__resource-actions">
        {!isLinked ? <button className="secondary-button secondary-button--compact" type="button" disabled={props.disabled || unavailable} onClick={props.onImport}>{copy("上传托管", "Import")}</button> : null}
        {isLinked && canUpdateProject(skill.syncStatus) ? <button className="secondary-button secondary-button--compact is-primary" type="button" disabled={props.disabled} onClick={props.onUpdateProject}>{copy("更新项目", "Update project")}</button> : null}
        {isLinked && canReverse && canUpdateManaged(skill.syncStatus) ? <button className="secondary-button secondary-button--compact" type="button" disabled={props.disabled || unavailable} onClick={props.onUpdateManaged}>{copy("同步回托管", "Sync to library")}</button> : null}
        {isLinked ? <button className="ghost-button" type="button" disabled={props.disabled} onClick={props.onUnlink}>{copy("解除关联", "Unlink")}</button> : null}
      </div>
    </article>
  );
}

function ProjectMcpRow(props: {
  server: ProjectMcpInstance;
  language: "zh-CN" | "en";
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
    <article className="projects-page__resource-card">
      <div className="projects-page__resource-copy">
        <div className="projects-page__resource-title">
          <h3>{server.serverName}</h3>
          <span className={`projects-page__status is-${server.syncStatus}`}>{statusLabels[server.syncStatus][language === "en" ? "en" : "zh"]}</span>
          {hasSecretRisk ? <span className="projects-page__secret">{copy("疑似明文密钥", "Possible plaintext secret")}</span> : null}
        </div>
        <p>{server.toolName} · {server.configRelativePath}</p>
        {server.error ? <div className="projects-page__resource-warning">{server.error}</div> : null}
      </div>
      <div className="projects-page__resource-actions">
        {!isLinked ? <button className="secondary-button secondary-button--compact" type="button" disabled={props.disabled || hasSecretRisk} onClick={props.onImport}>{copy("上传托管", "Import")}</button> : null}
        {isLinked && canUpdateProject(server.syncStatus) ? <button className="secondary-button secondary-button--compact is-primary" type="button" disabled={props.disabled || hasSecretRisk} onClick={props.onUpdateProject}>{copy("更新项目", "Update project")}</button> : null}
        {isLinked && canUpdateManaged(server.syncStatus) ? <button className="secondary-button secondary-button--compact" type="button" disabled={props.disabled || hasSecretRisk} onClick={props.onUpdateManaged}>{copy("同步回托管", "Sync to library")}</button> : null}
        {isLinked ? <button className="ghost-button" type="button" disabled={props.disabled} onClick={props.onUnlink}>{copy("解除关联", "Unlink")}</button> : null}
      </div>
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
        </div>
        <footer>
          <button className="secondary-button" type="button" onClick={props.onClose}>{copy("取消", "Cancel")}</button>
          <button className="primary-button" type="button" onClick={props.onConfirm} disabled={props.disabled || !props.resourceId || !props.targetName.trim()}>{copy("下发到项目", "Distribute")}</button>
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
