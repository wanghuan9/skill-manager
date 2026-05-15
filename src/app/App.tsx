import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { SkillsRoute } from "@/app/routes/skills";
import { ToolsRoute } from "@/app/routes/tools";
import { McpRoute } from "@/app/routes/mcp";
import { MarketRoute, type InstallCategory, type InstallTab } from "@/app/routes/market";
import { SettingsRoute } from "@/app/routes/settings";
import { AboutRoute } from "@/app/routes/about";
import { NotificationProvider } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import { FailureTracker } from "@/app/failure-tracker";
import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";
import { AppUpdateAutoPrompt } from "@/features/app-update/AppUpdateAutoPrompt";
import { SkillWorkspaceProvider, useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { SkillListToolbar } from "@/features/skills/components/SkillListPage";
import type { SkillStatusFilter } from "@/features/skills/state/skill-store";
import {
  readSkillViewModePreference,
  resolveSkillViewModePreference,
  writeSkillViewModePreference,
} from "@/features/skills/utils/skill-view-preference";
import {
  getCachedMcpWorkspace,
  subscribeMcpWorkspaceChange,
} from "@/features/skills/utils/mcp-workspace-cache";

type RouteKey = "skills" | "tools" | "install" | "settings" | "about";
type SkillsSectionKey = "skills" | "mcp";

type RouteDefinition = {
  key: RouteKey;
  label: string;
  description: string;
};

const routes: RouteDefinition[] = [
  { key: "skills", label: "Skills", description: "查看已安装 skill 的状态、更新和待处理情况" },
  { key: "tools", label: "工具", description: "检测可打开的编辑器工具并设置默认打开方式" },
  { key: "install", label: "安装", description: "通过安装源、Git 仓库或本地目录纳入新的 skill 和 MCP" },
  { key: "settings", label: "设置", description: "配置默认打开工具、GitHub 账号和基础偏好" },
  { key: "about", label: "关于", description: "查看版本信息、项目仓库和反馈入口" },
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

  if (route === "about") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 10.5v5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path d="M12 7.6h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
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
  skillStatusFilter: SkillStatusFilter,
  showGroupView: boolean,
  activeInstallCategory: InstallCategory,
  activeInstallTab: InstallTab,
  onInstallCategoryChange: (category: InstallCategory) => void,
  onInstallTabChange: (tab: InstallTab) => void,
  onInstallSkillFromGit: () => void,
  onInstallSkillFromLocal: () => void,
  onInstallSkillFromMarketplace: () => void,
  onInstallMcpFromMarketplace: () => void,
  activeSkillsSection: SkillsSectionKey,
) {
  if (route === "tools") {
    return <ToolsRoute />;
  }
  if (route === "install") {
    return (
      <MarketRoute
        activeInstallCategory={activeInstallCategory}
        activeInstallTab={activeInstallTab}
        onInstallCategoryChange={onInstallCategoryChange}
        onInstallTabChange={onInstallTabChange}
      />
    );
  }
  if (route === "settings") {
    return <SettingsRoute />;
  }
  if (route === "about") {
    return <AboutRoute />;
  }

  if (activeSkillsSection === "mcp") {
    return <McpRoute onInstallFromMarketplace={onInstallMcpFromMarketplace} />;
  }

  return (
    <SkillsRoute
      onImportFromLocal={onInstallSkillFromLocal}
      onInstallFromGit={onInstallSkillFromGit}
      onInstallFromMarketplace={onInstallSkillFromMarketplace}
      query={skillQuery}
      statusFilter={skillStatusFilter}
      showGroupView={showGroupView}
    />
  );
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

function SidebarToggleButton(props: {
  isSidebarCollapsed: boolean;
  onToggle: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const { className, isSidebarCollapsed, onToggle, style } = props;
  const buttonClassName = `sidebar-toggle${className ? ` ${className}` : ""}`;

  return (
    <button
      className={buttonClassName}
      type="button"
      aria-label={isSidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
      title={isSidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
      onClick={onToggle}
      style={style}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M9 3v18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path
          d={isSidebarCollapsed ? "m14 9 3 3-3 3" : "m16 15-3-3 3-3"}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function AppContent() {
  const { installedSkills, refreshWorkspace, toolConfigs } = useSkillWorkspace();
  const reportFailure = useFailureReporter();
  const initialSkillViewMode = readSkillViewModePreference();
  const isMacOS = isMacOSWindow();
  const brandIconRef = useRef<HTMLDivElement | null>(null);
  const [activeRoute, setActiveRoute] = useState<RouteKey>("skills");
  const [activeSkillsSection, setActiveSkillsSection] = useState<SkillsSectionKey>("skills");
  const [skillQuery, setSkillQuery] = useState("");
  const [skillStatusFilter, setSkillStatusFilter] = useState<SkillStatusFilter>("all");
  const [showGroupView, setShowGroupView] = useState(
    () => resolveSkillViewModePreference(initialSkillViewMode, installedSkills.length) === "grouped",
  );
  const [hasSavedSkillViewPreference, setHasSavedSkillViewPreference] = useState(initialSkillViewMode !== null);
  const [activeInstallCategory, setActiveInstallCategory] = useState<InstallCategory>("skill");
  const [activeInstallTab, setActiveInstallTab] = useState<InstallTab>("market");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarHandleTop, setSidebarHandleTop] = useState<number | null>(null);
  const [isToolsRefreshing, setIsToolsRefreshing] = useState(false);
  const [mcpServerCount, setMcpServerCount] = useState(() => getCachedMcpWorkspace()?.servers.length ?? 0);
  const activeDefinition = routes.find((route) => route.key === activeRoute) ?? routes[0];
  const updatableSkillCount = installedSkills.filter((skill) => skill.collabStatus === "update-available").length;
  const pendingPushSkillCount = installedSkills.filter((skill) => skill.collabStatus === "pending-push").length;
  const installedToolCount = toolConfigs.filter((tool) => tool.statusLabel === "已安装").length;
  const mcpToolCount = toolConfigs.filter((tool) => tool.statusLabel === "已安装" && tool.mcpConfigPath).length;
  const activeDescription =
    activeRoute === "skills" && activeSkillsSection === "skills"
      ? `已安装的 ${installedSkills.length} 个技能，可更新 ${updatableSkillCount} 个，待推送 ${pendingPushSkillCount} 个`
      : activeRoute === "skills"
        ? `扫描、编辑并同步 ${mcpServerCount} 个 MCP，覆盖 ${mcpToolCount} 个工具配置`
      : activeRoute === "tools"
        ? `已安装 ${installedToolCount} 个工具`
      : activeDefinition.description;

  useEffect(() => subscribeMcpWorkspaceChange((snapshot) => {
    setMcpServerCount(snapshot?.servers.length ?? 0);
  }), []);

  useEffect(() => {
    if (hasSavedSkillViewPreference) {
      return;
    }

    const defaultSkillViewMode = resolveSkillViewModePreference(null, installedSkills.length);
    setShowGroupView(defaultSkillViewMode === "grouped");
  }, [hasSavedSkillViewPreference, installedSkills.length]);

  useLayoutEffect(() => {
    if (!isMacOS || typeof window === "undefined") {
      setSidebarHandleTop(null);
      return;
    }

    const updateSidebarHandleTop = () => {
      const rect = brandIconRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      setSidebarHandleTop(rect.top + rect.height / 2);
    };

    updateSidebarHandleTop();
    const frameId = window.requestAnimationFrame(updateSidebarHandleTop);
    const resizeObserver =
      typeof ResizeObserver !== "undefined" && brandIconRef.current
        ? new ResizeObserver(updateSidebarHandleTop)
        : null;

    if (resizeObserver && brandIconRef.current) {
      resizeObserver.observe(brandIconRef.current);
    }

    window.addEventListener("resize", updateSidebarHandleTop);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", updateSidebarHandleTop);
      resizeObserver?.disconnect();
    };
  }, [isMacOS, isSidebarCollapsed]);

  async function handleToolsRefresh() {
    if (isToolsRefreshing) {
      return;
    }

    setIsToolsRefreshing(true);
    await waitForNextPaint();
    try {
      await refreshWorkspace();
    } catch (error) {
      reportFailure(error, {
        operation: "refresh_workspace_from_app_shell",
        fallbackMessage: "刷新失败",
      });
    } finally {
      setIsToolsRefreshing(false);
    }
  }

  function handleShowGroupViewChange(nextShowGroupView: boolean) {
    setShowGroupView(nextShowGroupView);
    setHasSavedSkillViewPreference(true);
    writeSkillViewModePreference(nextShowGroupView ? "grouped" : "flat");
  }

  function handleOpenSkillInstall(tab: InstallTab) {
    setActiveRoute("install");
    setActiveInstallCategory("skill");
    setActiveInstallTab(tab);
  }

  function handleOpenMcpInstall() {
    setActiveRoute("install");
    setActiveInstallCategory("mcp");
    setActiveInstallTab("market");
  }

  return (
    <div
      className={`app-shell${isSidebarCollapsed ? " is-sidebar-collapsed" : ""}${isMacOS ? " is-macos-window" : ""}`}
    >
      {isMacOS ? (
        <SidebarToggleButton
          className="sidebar-toggle--macos"
          isSidebarCollapsed={isSidebarCollapsed}
          onToggle={() => setIsSidebarCollapsed((current) => !current)}
          style={sidebarHandleTop == null ? undefined : { top: `${sidebarHandleTop}px` }}
        />
      ) : null}
      <aside className="sidebar">
        {isMacOS ? (
          <div className="window-topbar window-topbar--sidebar">
            <div className="window-topbar__drag-region" data-tauri-drag-region aria-hidden="true" />
          </div>
        ) : null}
        <div className="brand-block">
          <div ref={brandIconRef} className="brand-icon" aria-hidden="true">
            <svg viewBox="0 0 228 228" role="img">
              <defs>
                <linearGradient id="brand-gradient" x1="24" y1="24" x2="210" y2="204" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#163257" />
                  <stop offset="0.55" stopColor="#116396" />
                  <stop offset="1" stopColor="#1fc4b1" />
                </linearGradient>
                <linearGradient id="brand-star" x1="114" y1="54" x2="114" y2="176" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#ffffff" />
                  <stop offset="1" stopColor="#d7f8ff" />
                </linearGradient>
              </defs>
              <rect x="18" y="18" width="192" height="192" rx="50" fill="url(#brand-gradient)" />
              <circle cx="114" cy="114" r="54" fill="none" stroke="rgba(255,255,255,0.26)" strokeWidth="14" />
              <path d="M114 56c11 26 18 33 44 44c-26 11-33 18-44 44c-11-26-18-33-44-44c26-11 33-18 44-44Z" fill="url(#brand-star)" />
              <path d="M114 84c6 14 10 18 24 24c-14 6-18 10-24 24c-6-14-10-18-24-24c14-6 18-10 24-24Z" fill="#16b3a8" />
              <circle cx="114" cy="114" r="10" fill="#ffffff" />
            </svg>
          </div>
          <p className="brand-title">SkillDock</p>
          {!isMacOS ? (
            <SidebarToggleButton
              isSidebarCollapsed={isSidebarCollapsed}
              onToggle={() => setIsSidebarCollapsed((current) => !current)}
            />
          ) : null}
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
      <main className="main-panel" data-active-route={activeRoute}>
        {isMacOS ? <div className="window-topbar window-topbar--main" data-tauri-drag-region aria-hidden="true" /> : null}
        <header className="page-header">
          {activeRoute === "skills" ? (
            <div className="page-header--split">
              <div className="page-header__row">
                <h1>{activeSkillsSection === "mcp" ? "MCP" : activeDefinition.label}</h1>
                {activeSkillsSection === "skills" ? (
                  <SkillListToolbar
                    query={skillQuery}
                    statusFilter={skillStatusFilter}
                    onQueryChange={setSkillQuery}
                    onStatusFilterChange={setSkillStatusFilter}
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
              <div className="page-header__row page-header__row--install">
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
          {renderRoute(
            activeRoute,
            skillQuery,
            skillStatusFilter,
            showGroupView,
            activeInstallCategory,
            activeInstallTab,
            setActiveInstallCategory,
            setActiveInstallTab,
            () => handleOpenSkillInstall("git"),
            () => handleOpenSkillInstall("local"),
            () => handleOpenSkillInstall("market"),
            handleOpenMcpInstall,
            activeSkillsSection,
          )}
        </section>
      </main>
    </div>
  );
}

export function App() {
  return (
    <SkillWorkspaceProvider>
      <NotificationProvider>
        <FailureTracker>
          <AppUpdateAutoPrompt />
          <AppContent />
        </FailureTracker>
      </NotificationProvider>
    </SkillWorkspaceProvider>
  );
}
