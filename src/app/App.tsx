import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  Component,
  type ErrorInfo,
  type ReactNode,
  type CSSProperties,
} from "react";
import { SkillsRoute } from "@/app/routes/skills";
import { ToolsRoute } from "@/app/routes/tools";
import { McpRoute } from "@/app/routes/mcp";
import {
  MarketRoute,
  type InstallCategory,
  type InstallTab,
} from "@/app/routes/market";
import { SettingsRoute } from "@/app/routes/settings";
import { AboutRoute } from "@/app/routes/about";
import { PluginsRoute } from "@/app/routes/plugins";
import { AppI18nProvider, tx, useTranslate } from "@/app/i18n";
import { NotificationProvider } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import { FailureTracker } from "@/app/failure-tracker";
import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";
import { AppUpdateAutoPrompt } from "@/features/app-update/AppUpdateAutoPrompt";
import { AppTooltip } from "@/app/components/AppTooltip";
import {
  SkillWorkspaceProvider,
  useSkillWorkspace,
} from "@/features/skills/state/skill-workspace";
import { SkillListToolbar } from "@/features/skills/components/SkillListPage";
import type { SkillStatusFilter } from "@/features/skills/state/skill-store";
import {
  readSkillViewModePreference,
  resolveSkillViewModePreference,
  type SkillViewMode,
  writeSkillViewModePreference,
} from "@/features/skills/utils/skill-view-preference";
import {
  getCachedMcpWorkspace,
  subscribeMcpWorkspaceChange,
} from "@/features/skills/utils/mcp-workspace-cache";
import { isToolInstalledStatus } from "@/features/skills/utils/tool-status";
import { hasEnabledTool } from "@/features/skills/state/skill-selectors";
import {
  buildToolSkillViewItems,
  countToolSkillStatuses,
  listSkillSourceTools,
  MANAGED_SKILL_SOURCE_ID,
  type SkillSourceId,
  type ToolSkillManagementFilter,
} from "@/features/skills/utils/skill-source-view";

type RouteKey =
  | "skills"
  | "plugins"
  | "tools"
  | "install"
  | "settings"
  | "about";
type SkillsSectionKey = "skills" | "mcp";

type RouteDefinition = {
  key: RouteKey;
  labelKey: Parameters<typeof tx>[1];
  descriptionKey: Parameters<typeof tx>[1];
};

type RouteErrorBoundaryProps = {
  children: ReactNode;
  route: RouteKey;
};

type RouteErrorBoundaryState = {
  error: Error | null;
};

const ROUTE_LOCAL_ALIGN_COOLDOWN_MS = 10_000;
const MANAGED_SKILL_DIRECTORY = "~/.skilldock/skills";

class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Route render failed", {
      route: this.props.route,
      error,
      errorInfo,
    });
  }

  componentDidUpdate(prevProps: RouteErrorBoundaryProps) {
    if (prevProps.route !== this.props.route && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel-card empty-state">
          <h3>页面加载失败</h3>
          <p>{this.state.error.message || "发生未知错误"}</p>
          <button
            className="secondary-button"
            type="button"
            onClick={() => this.setState({ error: null })}
          >
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

const routes: RouteDefinition[] = [
  {
    key: "skills",
    labelKey: "app.nav.skills.label",
    descriptionKey: "app.nav.skills.description",
  },
  {
    key: "plugins",
    labelKey: "app.nav.plugins.label",
    descriptionKey: "app.nav.plugins.description",
  },
  {
    key: "tools",
    labelKey: "app.nav.tools.label",
    descriptionKey: "app.nav.tools.description",
  },
  {
    key: "install",
    labelKey: "app.nav.install.label",
    descriptionKey: "app.nav.install.description",
  },
  {
    key: "settings",
    labelKey: "app.nav.settings.label",
    descriptionKey: "app.nav.settings.description",
  },
  {
    key: "about",
    labelKey: "app.nav.about.label",
    descriptionKey: "app.nav.about.description",
  },
];

function isMacOSWindow() {
  if (typeof window === "undefined") {
    return false;
  }

  const platform = window.navigator.platform || "";
  const userAgent = window.navigator.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(`${platform} ${userAgent}`);
}

function formatSkillDirectoryPath(path: string) {
  return path.trim().replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
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

  if (route === "plugins") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M9 3v5m6-5v5M6.5 8.5h11v4.3a5.5 5.5 0 0 1-11 0V8.5ZM12 18.3V21"
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
        <path
          d="M12 7.6h.01"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
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
  activeSkillSourceId: SkillSourceId,
  onActiveSkillSourceIdChange: (sourceId: SkillSourceId) => void,
  focusedManagedSkillName: string,
  onShowManagedSkill: (skillName: string) => void,
  skillQuery: string,
  skillStatusFilter: SkillStatusFilter,
  skillManagementFilter: ToolSkillManagementFilter,
  skillViewMode: SkillViewMode,
  activeInstallCategory: InstallCategory,
  activeInstallTab: InstallTab,
  onInstallCategoryChange: (category: InstallCategory) => void,
  onInstallTabChange: (tab: InstallTab) => void,
  onInstallSkillFromGit: () => void,
  onInstallSkillFromLocal: () => void,
  onInstallSkillFromMarketplace: () => void,
  onInstallMcpFromMarketplace: () => void,
  onInstallPluginFromMarketplace: () => void,
  onPluginHostChange: (hostName: string | null) => void,
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
  if (route === "plugins") {
    return (
      <PluginsRoute
        onGoInstall={onInstallPluginFromMarketplace}
        onActiveHostChange={onPluginHostChange}
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
      activeSourceId={activeSkillSourceId}
      onActiveSourceIdChange={onActiveSkillSourceIdChange}
      focusedManagedSkillName={focusedManagedSkillName}
      onShowManagedSkill={onShowManagedSkill}
      onImportFromLocal={onInstallSkillFromLocal}
      onInstallFromGit={onInstallSkillFromGit}
      onInstallFromMarketplace={onInstallSkillFromMarketplace}
      query={skillQuery}
      statusFilter={skillStatusFilter}
      managementFilter={skillManagementFilter}
      viewMode={skillViewMode}
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
  const { t } = useTranslate();
  const { className, isSidebarCollapsed, onToggle, style } = props;
  const buttonClassName = `sidebar-toggle${className ? ` ${className}` : ""}`;
  const label = isSidebarCollapsed
    ? t("app.sidebar.expand")
    : t("app.sidebar.collapse");

  return (
    <button
      className={buttonClassName}
      type="button"
      aria-label={label}
      title={label}
      onClick={onToggle}
      style={style}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect
          x="3"
          y="3"
          width="18"
          height="18"
          rx="2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M9 3v18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
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
  const {
    alignLocalWorkspaceState,
    appSettings,
    installedSkills,
    isWorkspaceRefreshing,
    language,
    toolSkillEntries,
    refreshWorkspace,
    toolConfigs,
  } = useSkillWorkspace();
  const { t } = useTranslate();
  const reportFailure = useFailureReporter();
  const initialSkillViewMode = readSkillViewModePreference();
  const isMacOS = isMacOSWindow();
  const macOSDragRegion = isMacOS ? "" : undefined;
  const brandIconRef = useRef<HTMLDivElement | null>(null);
  const pageContentRef = useRef<HTMLElement | null>(null);
  const [activeRoute, setActiveRoute] = useState<RouteKey>("skills");
  const [activeSkillsSection, setActiveSkillsSection] =
    useState<SkillsSectionKey>("skills");
  const [skillQuery, setSkillQuery] = useState("");
  const [activeSkillSourceId, setActiveSkillSourceId] = useState<SkillSourceId>(
    MANAGED_SKILL_SOURCE_ID,
  );
  const [focusedManagedSkillName, setFocusedManagedSkillName] = useState("");
  const [skillStatusFilter, setSkillStatusFilter] =
    useState<SkillStatusFilter>("all");
  const [skillManagementFilter, setSkillManagementFilter] =
    useState<ToolSkillManagementFilter>("all");
  const [skillViewMode, setSkillViewMode] = useState<SkillViewMode>(
    () => resolveSkillViewModePreference(initialSkillViewMode, installedSkills.length),
  );
  const [hasSavedSkillViewPreference, setHasSavedSkillViewPreference] =
    useState(initialSkillViewMode !== null);
  const [activeInstallCategory, setActiveInstallCategory] =
    useState<InstallCategory>("skill");
  const [activeInstallTab, setActiveInstallTab] =
    useState<InstallTab>("market");
  const [activePluginHostName, setActivePluginHostName] = useState<string | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarHandleTop, setSidebarHandleTop] = useState<number | null>(null);
  const [mcpServerCount, setMcpServerCount] = useState(
    () => getCachedMcpWorkspace()?.servers.length ?? 0,
  );
  const routeLocalAlignInFlightRef = useRef(false);
  const lastRouteLocalAlignRef = useRef<{ key: string; timestamp: number } | null>(null);
  const activeDefinition =
    routes.find((route) => route.key === activeRoute) ?? routes[0];
  const updatableSkillCount = installedSkills.filter(
    (skill) => skill.collabStatus === "update-available",
  ).length;
  const pendingPushSkillCount = installedSkills.filter(
    (skill) => skill.collabStatus === "pending-push",
  ).length;
  const enabledManagedSkillCount = installedSkills.filter(hasEnabledTool).length;
  const activeSkillSourceTool = listSkillSourceTools(toolConfigs)
    .find((tool) => tool.id === activeSkillSourceId);
  const activeToolSkillCounts = activeSkillSourceTool
    ? countToolSkillStatuses(buildToolSkillViewItems({
        tool: activeSkillSourceTool,
        installedSkills,
        toolSkillEntries,
      }))
    : null;
  const activeSkillPageTitle = activeSkillSourceTool?.name
    ?? tx(language, "app.nav.skills.label");
  const isCompactManagementHeader = appSettings.skillSourceViewStyle === "select";
  const installedToolCount = toolConfigs.filter((tool) =>
    isToolInstalledStatus(tool.statusLabel),
  ).length;
  const mcpToolCount = toolConfigs.filter(
    (tool) =>
      isToolInstalledStatus(tool.statusLabel) &&
      tool.supportsMcp &&
      tool.mcpConfigPathRecognized,
  ).length;
  const activeDescription =
    activeRoute === "skills" && activeSkillsSection === "skills"
      ? activeSkillSourceTool && activeToolSkillCounts
        ? tx(language, "app.header.skills.sourceSummary", {
            path: formatSkillDirectoryPath(activeSkillSourceTool.skillsPath),
            managed: activeToolSkillCounts.managed,
            unmanaged: activeToolSkillCounts.unmanaged,
            mismatch: activeToolSkillCounts.mismatch,
          })
        : tx(language, "app.header.skills.summary", {
            path: MANAGED_SKILL_DIRECTORY,
            installed: enabledManagedSkillCount,
            updatable: updatableSkillCount,
            pending: pendingPushSkillCount,
          })
      : activeRoute === "skills"
        ? tx(language, "app.header.mcp.summary", {
            count: mcpServerCount,
            tools: mcpToolCount,
          })
        : activeRoute === "tools"
          ? tx(language, "app.header.tools.summary", {
              count: installedToolCount,
            })
          : tx(language, activeDefinition.descriptionKey);

  function handleActiveSkillSourceIdChange(sourceId: SkillSourceId) {
    if (pageContentRef.current) {
      pageContentRef.current.scrollTop = 0;
    }
    setActiveSkillSourceId(sourceId);
    setFocusedManagedSkillName("");
    setSkillManagementFilter("all");
  }

  function handleShowManagedSkill(skillName: string) {
    setActiveSkillSourceId(MANAGED_SKILL_SOURCE_ID);
    setFocusedManagedSkillName(skillName);
    setSkillQuery("");
    setSkillStatusFilter("all");
    setSkillManagementFilter("all");
  }

  useEffect(
    () =>
      subscribeMcpWorkspaceChange((snapshot) => {
        setMcpServerCount(snapshot?.servers.length ?? 0);
      }),
    [],
  );

  useEffect(() => {
    if (hasSavedSkillViewPreference) {
      return;
    }

    const defaultSkillViewMode = resolveSkillViewModePreference(
      null,
      installedSkills.length,
    );
    setSkillViewMode(defaultSkillViewMode);
  }, [hasSavedSkillViewPreference, installedSkills.length]);

  useEffect(() => {
    if (activeRoute !== "skills") {
      return;
    }

    const savedMode = readSkillViewModePreference();
    if (!savedMode || savedMode === skillViewMode) {
      return;
    }

    setSkillViewMode(savedMode);
    setHasSavedSkillViewPreference(true);
  }, [activeRoute, skillViewMode]);

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

  useEffect(() => {
    const routeAlignKey =
      activeRoute === "tools"
        ? "tools"
        : activeRoute === "skills" && activeSkillsSection === "skills"
          ? "skills"
          : "";
    if (routeLocalAlignInFlightRef.current || !routeAlignKey) {
      return;
    }

    const now = Date.now();
    const lastRouteAlign = lastRouteLocalAlignRef.current;
    if (
      lastRouteAlign?.key === routeAlignKey
      && now - lastRouteAlign.timestamp < ROUTE_LOCAL_ALIGN_COOLDOWN_MS
    ) {
      return;
    }

    routeLocalAlignInFlightRef.current = true;
    lastRouteLocalAlignRef.current = { key: routeAlignKey, timestamp: now };
    void alignLocalWorkspaceState()
      .catch((error) => {
        reportFailure(error, {
          operation: "align_local_workspace_state_on_route_enter",
          fallbackMessage: t("app.header.refreshFailed"),
        });
      })
      .finally(() => {
        routeLocalAlignInFlightRef.current = false;
      });
  }, [activeRoute, activeSkillsSection, alignLocalWorkspaceState, reportFailure, t]);

  async function handleToolsRefresh() {
    if (isWorkspaceRefreshing) {
      return;
    }

    await waitForNextPaint();
    try {
      await refreshWorkspace({ showRefreshing: true });
    } catch (error) {
      reportFailure(error, {
        operation: "refresh_workspace_from_app_shell",
        fallbackMessage: t("app.header.refreshFailed"),
      });
    }
  }

  function handleSkillViewModeChange(nextViewMode: SkillViewMode) {
    setSkillViewMode(nextViewMode);
    setHasSavedSkillViewPreference(true);
    writeSkillViewModePreference(nextViewMode);
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

  function handleOpenPluginInstall() {
    setActiveRoute("install");
    setActiveInstallCategory("plugin");
    setActiveInstallTab("market");
  }

  const skillToolbar = (
    <SkillListToolbar
      activeSourceId={activeSkillSourceId}
      query={skillQuery}
      statusFilter={skillStatusFilter}
      managementFilter={skillManagementFilter}
      managementFilterCounts={activeToolSkillCounts ?? undefined}
      onQueryChange={setSkillQuery}
      onStatusFilterChange={setSkillStatusFilter}
      onManagementFilterChange={setSkillManagementFilter}
      viewMode={skillViewMode}
      onViewModeChange={handleSkillViewModeChange}
      onGoInstall={() => handleOpenSkillInstall("market")}
    />
  );

  return (
    <div
      className={`app-shell${isSidebarCollapsed ? " is-sidebar-collapsed" : ""}${isMacOS ? " is-macos-window" : ""}`}
    >
      {isMacOS ? (
        <SidebarToggleButton
          className="sidebar-toggle--macos"
          isSidebarCollapsed={isSidebarCollapsed}
          onToggle={() => setIsSidebarCollapsed((current) => !current)}
          style={
            sidebarHandleTop == null
              ? undefined
              : { top: `${sidebarHandleTop}px` }
          }
        />
      ) : null}
      <aside className="sidebar">
        {isMacOS ? (
          <div className="window-topbar window-topbar--sidebar">
            <div
              className="window-topbar__drag-region"
              data-tauri-drag-region
              aria-hidden="true"
            />
          </div>
        ) : null}
        <div className="brand-block">
          <div ref={brandIconRef} className="brand-icon" aria-hidden="true">
            <svg viewBox="0 0 228 228" role="img">
              <defs>
                <linearGradient
                  id="brand-gradient"
                  x1="24"
                  y1="24"
                  x2="210"
                  y2="204"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0" stopColor="#163257" />
                  <stop offset="0.55" stopColor="#116396" />
                  <stop offset="1" stopColor="#1fc4b1" />
                </linearGradient>
                <linearGradient
                  id="brand-star"
                  x1="114"
                  y1="54"
                  x2="114"
                  y2="176"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0" stopColor="#ffffff" />
                  <stop offset="1" stopColor="#d7f8ff" />
                </linearGradient>
              </defs>
              <rect
                x="18"
                y="18"
                width="192"
                height="192"
                rx="50"
                fill="url(#brand-gradient)"
              />
              <circle
                cx="114"
                cy="114"
                r="54"
                fill="none"
                stroke="rgba(255,255,255,0.26)"
                strokeWidth="14"
              />
              <path
                d="M114 56c11 26 18 33 44 44c-26 11-33 18-44 44c-11-26-18-33-44-44c26-11 33-18 44-44Z"
                fill="url(#brand-star)"
              />
              <path
                d="M114 84c6 14 10 18 24 24c-14 6-18 10-24 24c-6-14-10-18-24-24c14-6 18-10 24-24Z"
                fill="#16b3a8"
              />
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
            const selected =
              route.key === activeRoute &&
              (route.key !== "skills" || activeSkillsSection === "skills");

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
                  <span className="nav-label">
                    {tx(language, route.labelKey)}
                  </span>
                </button>
                {route.key === "skills" ? (
                  <button
                    className={`nav-item nav-sub-item${
                      activeRoute === "skills" && activeSkillsSection === "mcp"
                        ? " is-selected"
                        : ""
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
        {isMacOS ? (
          <div
            className="window-topbar window-topbar--main"
            data-tauri-drag-region
            aria-hidden="true"
          />
        ) : null}
        <header className="page-header">
          {activeRoute === "skills" ? (
            <div
              key={`skills-${activeSkillsSection}`}
              className={`page-header--split${isCompactManagementHeader ? " management-page-header--compact" : ""}`}
              data-tauri-drag-region={macOSDragRegion}
            >
              {isCompactManagementHeader ? (
                <>
                  <div
                    className="management-page-header__identity"
                    data-tauri-drag-region={macOSDragRegion}
                  >
                    <h1>{activeSkillsSection === "mcp" ? "MCP" : activeSkillPageTitle}</h1>
                    <p>{activeDescription}</p>
                  </div>
                  <div className="management-page-header__toolbar-row">
                    {activeSkillsSection === "skills" ? (
                      <div
                        className="skills-source-header-slot management-page-header__source"
                        id="skills-source-header-slot"
                      />
                    ) : null}
                    {activeSkillsSection === "skills" ? (
                      <div className="management-page-header__toolbar">
                        {skillToolbar}
                      </div>
                    ) : (
                      <div
                        className="mcp-header-toolbar-slot management-page-header__toolbar"
                        id="mcp-header-toolbar-slot"
                      />
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div
                    className="page-header__row"
                    data-tauri-drag-region={macOSDragRegion}
                  >
                    <h1>
                      {activeSkillsSection === "mcp"
                        ? "MCP"
                        : activeSkillPageTitle}
                    </h1>
                    {activeSkillsSection === "skills" ? (
                      skillToolbar
                    ) : (
                      <div
                        className="mcp-header-toolbar-slot"
                        id="mcp-header-toolbar-slot"
                      />
                    )}
                  </div>
                  <p>{activeDescription}</p>
                  {activeSkillsSection === "skills" ? (
                    <div
                      className="skills-source-header-slot"
                      id="skills-source-header-slot"
                    />
                  ) : null}
                </>
              )}
            </div>
          ) : activeRoute === "tools" ? (
            <div
              key="tools"
              className="page-header--split"
              data-tauri-drag-region={macOSDragRegion}
            >
              <div
                className="page-header__row"
                data-tauri-drag-region={macOSDragRegion}
              >
                <h1>{tx(language, activeDefinition.labelKey)}</h1>
                <button
                  className={`ghost-button tools-refresh-button${isWorkspaceRefreshing ? " is-loading" : ""}`}
                  type="button"
                  onClick={() => void handleToolsRefresh()}
                  disabled={isWorkspaceRefreshing}
                >
                  <span
                    aria-hidden="true"
                    className="skills-toolbar-button__icon"
                  >
                    <svg
                      className={
                        isWorkspaceRefreshing
                          ? "skills-toolbar-button__svg is-spinning"
                          : "skills-toolbar-button__svg"
                      }
                      viewBox="0 0 20 20"
                      fill="none"
                    >
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
                  <span>{t("app.header.refresh")}</span>
                </button>
              </div>
              <p>{activeDescription}</p>
            </div>
          ) : activeRoute === "install" ? (
            <div
              key="install"
              className="page-header--split"
              data-tauri-drag-region={macOSDragRegion}
            >
              <div
                className="page-header__row page-header__row--install"
                data-tauri-drag-region={macOSDragRegion}
              >
                <h1>{tx(language, activeDefinition.labelKey)}</h1>
                <div
                  className="install-header-toolbar-slot"
                  id="install-header-toolbar-slot"
                />
              </div>
              <p>{activeDescription}</p>
            </div>
          ) : activeRoute === "plugins" ? (
            <div
              key="plugins"
              className={`page-header--split${isCompactManagementHeader ? " management-page-header--compact" : ""}`}
              data-tauri-drag-region={macOSDragRegion}
            >
              {isCompactManagementHeader ? (
                <>
                  <div
                    className="management-page-header__identity"
                    data-tauri-drag-region={macOSDragRegion}
                  >
                    <h1>{activePluginHostName ?? tx(language, activeDefinition.labelKey)}</h1>
                    <p>{activeDescription}</p>
                  </div>
                  <div className="management-page-header__toolbar-row">
                    <div
                      className="skills-source-header-slot management-page-header__source"
                      id="plugins-source-header-slot"
                    />
                    <div
                      className="mcp-header-toolbar-slot management-page-header__toolbar"
                      id="plugins-header-toolbar-slot"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div
                    className="page-header__row"
                    data-tauri-drag-region={macOSDragRegion}
                  >
                    <h1>{activePluginHostName ?? tx(language, activeDefinition.labelKey)}</h1>
                    <div
                      className="mcp-header-toolbar-slot"
                      id="plugins-header-toolbar-slot"
                    />
                  </div>
                  <p>{activeDescription}</p>
                  <div
                    className="skills-source-header-slot"
                    id="plugins-source-header-slot"
                  />
                </>
              )}
            </div>
          ) : (
            <div
              key={activeRoute}
              className="page-header--split"
              data-tauri-drag-region={macOSDragRegion}
            >
              <h1>{tx(language, activeDefinition.labelKey)}</h1>
              <p>{activeDescription}</p>
            </div>
          )}
        </header>
        <div
          className={`page-header-divider${
            (isCompactManagementHeader
              && (activeRoute === "skills" || activeRoute === "plugins"))
              || (activeRoute === "skills" && activeSkillsSection === "skills")
              || activeRoute === "plugins"
              ? " page-header-divider--skills"
              : ""
          }`}
          aria-hidden="true"
        />
        <section ref={pageContentRef} className="page-content">
          <RouteErrorBoundary route={activeRoute}>
            {renderRoute(
              activeRoute,
              activeSkillSourceId,
              handleActiveSkillSourceIdChange,
              focusedManagedSkillName,
              handleShowManagedSkill,
              skillQuery,
              skillStatusFilter,
              skillManagementFilter,
              skillViewMode,
              activeInstallCategory,
              activeInstallTab,
              setActiveInstallCategory,
              setActiveInstallTab,
              () => handleOpenSkillInstall("git"),
              () => handleOpenSkillInstall("local"),
              () => handleOpenSkillInstall("market"),
              handleOpenMcpInstall,
              handleOpenPluginInstall,
              setActivePluginHostName,
              activeSkillsSection,
            )}
          </RouteErrorBoundary>
        </section>
      </main>
    </div>
  );
}

export function App() {
  return (
    <SkillWorkspaceProvider>
      <AppI18nProvider>
        <NotificationProvider>
          <FailureTracker>
            <AppUpdateAutoPrompt />
            <AppContent />
            <AppTooltip />
          </FailureTracker>
        </NotificationProvider>
      </AppI18nProvider>
    </SkillWorkspaceProvider>
  );
}
