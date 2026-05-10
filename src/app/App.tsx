import { useEffect, useState } from "react";
import { SkillsRoute } from "@/app/routes/skills";
import { ToolsRoute } from "@/app/routes/tools";
import { McpRoute } from "@/app/routes/mcp";
import { MarketRoute, type InstallTab } from "@/app/routes/market";
import { SettingsRoute } from "@/app/routes/settings";
import { FeedbackRoute } from "@/app/routes/feedback";
import { NotificationProvider } from "@/app/notifications";
import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";
import { SkillWorkspaceProvider, useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { SkillListToolbar } from "@/features/skills/components/SkillListPage";
import {
  readSkillViewModePreference,
  resolveSkillViewModePreference,
  writeSkillViewModePreference,
} from "@/features/skills/utils/skill-view-preference";

type RouteKey = "skills" | "tools" | "install" | "settings" | "feedback";
type SkillsSectionKey = "skills" | "mcp";

type RouteDefinition = {
  key: RouteKey;
  label: string;
  description: string;
};

const routes: RouteDefinition[] = [
  { key: "skills", label: "Skills", description: "查看已安装 skill 的状态、更新和待处理情况" },
  { key: "tools", label: "工具", description: "检测可打开的编辑器工具并设置默认打开方式" },
  { key: "install", label: "安装", description: "通过安装源、Git 仓库或本地目录纳入新的 skill" },
  { key: "settings", label: "设置", description: "配置默认打开工具、Git 账号和基础偏好" },
  { key: "feedback", label: "反馈", description: "提交问题、建议和工具适配需求" },
];

function isMacOSWindow() {
  if (typeof window === "undefined") {
    return false;
  }

  const platform = window.navigator.platform || "";
  const userAgent = window.navigator.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(`${platform} ${userAgent}`);
}

function NavRouteIcon(props: { route: RouteKey }) {
  const { route } = props;
  if (route === "tools") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M14.8 4.6a5.2 5.2 0 0 0-6.2 6.7L4.7 15.2a1.4 1.4 0 0 0 0 2l2.1 2.1a1.4 1.4 0 0 0 2 0l3.9-3.9a5.2 5.2 0 0 0 6.7-6.2l-3 3h-2l-1.4-1.4v-2l3-3Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (route === "install") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (route === "settings") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M10.55 3.75h2.9l.5 2.04c.45.1.88.28 1.29.52l1.86-.95l2.05 2.05l-.95 1.86c.24.41.42.84.52 1.29l2.04.5v2.9l-2.04.5c-.1.45-.28.88-.52 1.29l.95 1.86l-2.05 2.05l-1.86-.95c-.41.24-.84.42-1.29.52l-.5 2.04h-2.9l-.5-2.04a5.38 5.38 0 0 1-1.29-.52l-1.86.95l-2.05-2.05l.95-1.86a5.38 5.38 0 0 1-.52-1.29l-2.04-.5v-2.9l2.04-.5c.1-.45.28-.88.52-1.29l-.95-1.86l2.05-2.05l1.86.95c.41-.24.84-.42 1.29-.52l.5-2.04ZM12 9.35a2.65 2.65 0 1 0 0 5.3a2.65 2.65 0 0 0 0-5.3Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (route === "feedback") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M6 5h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 4.5 14 10l5.5 2-5.5 2L12 19.5l-2-5.5L4.5 12 10 10 12 4.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function renderRoute(
  route: RouteKey,
  skillQuery: string,
  showGroupView: boolean,
  activeInstallTab: InstallTab,
  onInstallTabChange: (tab: InstallTab) => void,
  activeSkillsSection: SkillsSectionKey,
) {
  if (route === "tools") {
    return <ToolsRoute />;
  }
  if (route === "install") {
    return <MarketRoute activeInstallTab={activeInstallTab} onInstallTabChange={onInstallTabChange} />;
  }
  if (route === "settings") {
    return <SettingsRoute />;
  }
  if (route === "feedback") {
    return <FeedbackRoute />;
  }

  if (activeSkillsSection === "mcp") {
    return <McpRoute />;
  }

  return <SkillsRoute query={skillQuery} showGroupView={showGroupView} />;
}

function McpNavIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M2.4 11.3 11.45 2.26a3.2 3.2 0 0 1 4.53 4.53l-6.84 6.83"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="m9.24 13.53 6.74-6.74a3.2 3.2 0 0 1 4.52 0l.05.05a3.2 3.2 0 0 1 0 4.52l-8.19 8.19a1.07 1.07 0 0 0 0 1.51l1.68 1.68"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="m13.71 4.53-6.69 6.69a3.2 3.2 0 0 0 4.53 4.53l6.69-6.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AppContent() {
  const { installedSkills, refreshWorkspace, toolConfigs } = useSkillWorkspace();
  const initialSkillViewMode = readSkillViewModePreference();
  const isMacOS = isMacOSWindow();
  const [activeRoute, setActiveRoute] = useState<RouteKey>("skills");
  const [activeSkillsSection, setActiveSkillsSection] = useState<SkillsSectionKey>("skills");
  const [skillQuery, setSkillQuery] = useState("");
  const [showGroupView, setShowGroupView] = useState(
    () => resolveSkillViewModePreference(initialSkillViewMode, installedSkills.length) === "grouped",
  );
  const [hasSavedSkillViewPreference, setHasSavedSkillViewPreference] = useState(initialSkillViewMode !== null);
  const [activeInstallTab, setActiveInstallTab] = useState<InstallTab>("market");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isToolsRefreshing, setIsToolsRefreshing] = useState(false);
  const activeDefinition = routes.find((route) => route.key === activeRoute) ?? routes[0];
  const updatableSkillCount = installedSkills.filter((skill) => skill.collabStatus === "update-available").length;
  const pendingPushSkillCount = installedSkills.filter((skill) => skill.collabStatus === "pending-push").length;
  const installedToolCount = toolConfigs.filter((tool) => tool.statusLabel === "已安装").length;
  const mcpToolCount = toolConfigs.filter((tool) => tool.statusLabel === "已安装" && tool.mcpConfigPath).length;
  const activeDescription =
    activeRoute === "skills" && activeSkillsSection === "skills"
      ? `已安装的 ${installedSkills.length} 个技能，可更新 ${updatableSkillCount} 个，待推送 ${pendingPushSkillCount} 个`
      : activeRoute === "skills"
        ? `扫描、编辑并同步 ${mcpToolCount} 个工具的 MCP 配置`
      : activeRoute === "tools"
        ? `已安装 ${installedToolCount} 个工具`
      : activeDefinition.description;

  useEffect(() => {
    if (hasSavedSkillViewPreference) {
      return;
    }

    const defaultSkillViewMode = resolveSkillViewModePreference(null, installedSkills.length);
    setShowGroupView(defaultSkillViewMode === "grouped");
  }, [hasSavedSkillViewPreference, installedSkills.length]);

  async function handleToolsRefresh() {
    if (isToolsRefreshing) {
      return;
    }

    setIsToolsRefreshing(true);
    await waitForNextPaint();
    try {
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : "刷新失败";
      window.alert(message);
    } finally {
      setIsToolsRefreshing(false);
    }
  }

  function handleShowGroupViewChange(nextShowGroupView: boolean) {
    setShowGroupView(nextShowGroupView);
    setHasSavedSkillViewPreference(true);
    writeSkillViewModePreference(nextShowGroupView ? "grouped" : "flat");
  }

  return (
    <div
      className={`app-shell${isSidebarCollapsed ? " is-sidebar-collapsed" : ""}${isMacOS ? " is-macos-window" : ""}`}
    >
      <aside className="sidebar">
        {isMacOS ? <div className="window-topbar window-topbar--sidebar" data-tauri-drag-region aria-hidden="true" /> : null}
        <div className="brand-block">
          <div className="brand-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" role="img">
              <defs>
                <linearGradient id="brand-gradient" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#2f7cff" />
                  <stop offset="1" stopColor="#1ec8b8" />
                </linearGradient>
              </defs>
              <rect x="1.5" y="1.5" width="21" height="21" rx="6.5" fill="url(#brand-gradient)" />
              <path
                d="M14.9 6.6c-2.8.3-4.7 2.2-5.9 4.8l-1.9.7a1 1 0 0 0-.4 1.7l1.4 1.4a1 1 0 0 0 1.1.2l1.5-.6c.9 1.4 2 2.4 3.4 3.3l-.6 1.5a1 1 0 0 0 .2 1.1l1.4 1.4a1 1 0 0 0 1.7-.4l.7-1.9c2.6-1.2 4.5-3.1 4.8-5.9c.1-.9-.2-1.8-.8-2.5l-2.2-2.2c-.7-.6-1.6-.9-2.5-.8Z"
                fill="none"
                stroke="#ffffff"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="15.7" cy="8.4" r="1.2" fill="#ffffff" />
              <path d="M6.4 17.6 9 15" stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
          <p className="brand-title">skillm</p>
          <button
            className="sidebar-toggle"
            type="button"
            aria-label={isSidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            title={isSidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            onClick={() => setIsSidebarCollapsed((current) => !current)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d={isSidebarCollapsed ? "m9 6 6 6-6 6" : "m15 6-6 6 6 6"}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div className="sidebar-divider" aria-hidden="true" />
        <nav aria-label="Primary" className="nav-list">
          {routes.map((route) => {
            const selected = route.key === activeRoute && (
              route.key !== "skills" || activeSkillsSection === "skills"
            );

            return (
              <div key={route.key} className="nav-group">
                <button
                  className={`nav-item${selected ? " is-selected" : ""}`}
                  type="button"
                  onClick={() => {
                    setActiveRoute(route.key);
                    if (route.key === "skills") {
                      setActiveSkillsSection("skills");
                    }
                  }}
                >
                  <span className="nav-icon" aria-hidden="true">
                    <NavRouteIcon route={route.key} />
                  </span>
                  <span className="nav-label">{route.label}</span>
                </button>
                {route.key === "skills" ? (
                  <button
                    className={`nav-item nav-sub-item${
                      activeRoute === "skills" && activeSkillsSection === "mcp" ? " is-selected" : ""
                    }`}
                    type="button"
                    onClick={() => {
                      setActiveRoute("skills");
                      setActiveSkillsSection("mcp");
                    }}
                  >
                    <span className="nav-icon" aria-hidden="true">
                      <McpNavIcon />
                    </span>
                    <span className="nav-label">MCP</span>
                  </button>
                ) : null}
              </div>
            );
          })}
        </nav>
      </aside>
      <main className="main-panel">
        {isMacOS ? <div className="window-topbar window-topbar--main" data-tauri-drag-region aria-hidden="true" /> : null}
        <header className="page-header">
          {activeRoute === "skills" ? (
            <div className="page-header--split">
              <div className="page-header__row">
                <h1>{activeSkillsSection === "mcp" ? "MCP" : activeDefinition.label}</h1>
                {activeSkillsSection === "skills" ? (
                  <SkillListToolbar
                    query={skillQuery}
                    onQueryChange={setSkillQuery}
                    showGroupView={showGroupView}
                    onShowGroupViewChange={handleShowGroupViewChange}
                  />
                ) : (
                  <div className="mcp-header-toolbar-slot" id="mcp-header-toolbar-slot" />
                )}
              </div>
              <p>{activeDescription}</p>
            </div>
          ) : activeRoute === "tools" ? (
            <div className="page-header--split">
              <div className="page-header__row">
                <h1>{activeDefinition.label}</h1>
                <button
                  className={`ghost-button tools-refresh-button${isToolsRefreshing ? " is-loading" : ""}`}
                  type="button"
                  onClick={() => void handleToolsRefresh()}
                  disabled={isToolsRefreshing}
                >
                  <span aria-hidden="true" className="skills-toolbar-button__icon">
                    <svg className={isToolsRefreshing ? "skills-toolbar-button__svg is-spinning" : "skills-toolbar-button__svg"} viewBox="0 0 20 20" fill="none">
                      <path
                        d="M16.2 9.1a6.2 6.2 0 0 0-10.7-3.6"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M3.7 3.9v3.7h3.7"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M3.8 10.9a6.2 6.2 0 0 0 10.7 3.6"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M16.3 16.1v-3.7h-3.7"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span>刷新</span>
                </button>
              </div>
              <p>{activeDescription}</p>
            </div>
          ) : activeRoute === "install" ? (
            <div className="page-header--split">
              <div className="page-header__row">
                <h1>{activeDefinition.label}</h1>
                <div className="install-header-toolbar-slot" id="install-header-toolbar-slot" />
              </div>
              <p>{activeDescription}</p>
            </div>
          ) : (
            <div className="page-header--split">
              <h1>{activeDefinition.label}</h1>
              <p>{activeDescription}</p>
            </div>
          )}
        </header>
        <div className="page-header-divider" aria-hidden="true" />
        <section className="page-content">
          {renderRoute(activeRoute, skillQuery, showGroupView, activeInstallTab, setActiveInstallTab, activeSkillsSection)}
        </section>
      </main>
    </div>
  );
}

export function App() {
  return (
    <SkillWorkspaceProvider>
      <NotificationProvider>
        <AppContent />
      </NotificationProvider>
    </SkillWorkspaceProvider>
  );
}
