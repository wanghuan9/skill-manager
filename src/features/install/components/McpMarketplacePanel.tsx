import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNotifications } from "@/app/notifications";
import {
  fetchMcpMarketplaceServers,
  fetchMcpWorkspace,
  installMcpServerFromMarketplace,
  openExternalLink,
} from "@/features/skills/api/skill-client";
import type { McpMarketplaceServer } from "@/features/skills/state/skill-store";

const MCP_MARKETPLACE_PAGE_SIZE = 24;
const MCP_MARKETPLACE_SOURCE_SITE = "MCP.Directory";
const MCP_MARKETPLACE_SOURCE_LABEL = "mcp.directory";

type McpMarketplacePanelProps = {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
};

export function McpMarketplacePanel(props: McpMarketplacePanelProps) {
  const { searchQuery, onSearchQueryChange } = props;
  const { notify } = useNotifications();
  const [servers, setServers] = useState<McpMarketplaceServer[]>([]);
  const [installedServerIds, setInstalledServerIds] = useState<Set<string>>(new Set());
  const [installingServerIds, setInstallingServerIds] = useState<Set<string>>(new Set());
  const [selectedServer, setSelectedServer] = useState<McpMarketplaceServer | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const normalizedQuery = searchQuery.trim();

  useEffect(() => {
    let active = true;

    async function loadServers() {
      setIsLoading(true);
      try {
        const [marketplaceServers, workspace] = await Promise.all([
          fetchMcpMarketplaceServers({
            sourceSite: MCP_MARKETPLACE_SOURCE_SITE,
            page: 1,
            limit: MCP_MARKETPLACE_PAGE_SIZE,
            query: normalizedQuery,
          }),
          fetchMcpWorkspace(),
        ]);
        if (!active) {
          return;
        }

        setServers(marketplaceServers);
        setInstalledServerIds(new Set(workspace.servers.map((server) => server.id)));
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    const timer = window.setTimeout(() => {
      void loadServers();
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [normalizedQuery]);

  async function handleInstall(server: McpMarketplaceServer) {
    if (!server.server) {
      notify({ message: `${server.name} 暂未提供可自动安装的 MCP 配置`, tone: "error" });
      return;
    }

    setInstallingServerIds((current) => new Set(current).add(server.id));
    try {
      const workspace = await installMcpServerFromMarketplace({ server });
      setInstalledServerIds(new Set(workspace.servers.map((item) => item.id)));
      notify({ message: `MCP "${server.name}" 已加入管理列表，可到 MCP 页启用到工具`, tone: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "安装 MCP 失败，请稍后重试。";
      notify({ message, tone: "error" });
    } finally {
      setInstallingServerIds((current) => {
        const next = new Set(current);
        next.delete(server.id);
        return next;
      });
    }
  }

  function handleServerSurfaceKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
    server: McpMarketplaceServer,
  ) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    setSelectedServer(server);
  }

  return (
    <section className="panel-card market-panel mcp-market-panel">
      <div className="market-source-bar">
        <div className="panel-header">
          <h2>安装源</h2>
        </div>
        <label className="market-search-field">
          <span className="sr-only">搜索 MCP</span>
          <div className="market-search-input-wrap">
            <input
              className="market-search-input"
              type="search"
              value={searchQuery}
              placeholder="搜索 MCP（支持全部安装源）"
              onChange={(event) => onSearchQueryChange(event.target.value)}
            />
            {isLoading ? (
              <span className="loading-spinner market-search-spinner" aria-label="正在搜索" />
            ) : null}
          </div>
        </label>
        <div className="source-tab-row" role="tablist" aria-label="安装源">
          <button className="source-tab is-selected" type="button" role="tab" aria-selected="true">
            {MCP_MARKETPLACE_SOURCE_LABEL}
          </button>
        </div>
      </div>

      <div className="install-grid">
        {isLoading ? (
          <section className="placeholder-card">
            <h3>正在搜索 MCP</h3>
            <p>{normalizedQuery ? `正在从 ${MCP_MARKETPLACE_SOURCE_LABEL} 搜索 "${normalizedQuery}"...` : `正在加载 ${MCP_MARKETPLACE_SOURCE_LABEL} 推荐服务。`}</p>
          </section>
        ) : servers.length > 0 ? (
          servers.map((server) => {
            const resolvedId = normalizeMcpServerId(server.name);
            const isInstalled = installedServerIds.has(resolvedId);
            const isInstalling = installingServerIds.has(server.id);
            const canInstall = Boolean(server.server);

            return (
              <article key={server.id} className="placeholder-card install-card mcp-market-card">
                <div
                  className="install-card__surface"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedServer(server)}
                  onKeyDown={(event) => handleServerSurfaceKeyDown(event, server)}
                >
                  <div className="install-card__header">
                    <div className="install-card__lead">
                      <div className="install-card__avatar install-card__avatar--sky">
                        {server.avatarUrl ? <img src={server.avatarUrl} alt="" loading="lazy" /> : <McpIcon />}
                      </div>
                      <div className="install-card__title-group">
                        <div className="install-card__title-row">
                          <h3 title={server.name}>{server.name}</h3>
                          <a
                            className="install-card__link"
                            href={server.sourceUrl}
                            aria-label={`打开 ${server.name} 来源`}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void openExternalLink(server.sourceUrl);
                            }}
                          >
                            <ExternalLinkIcon />
                          </a>
                        </div>
                        <p>{server.description}</p>
                      </div>
                    </div>
                    <button
                      className="primary-button install-card__install-button"
                      type="button"
                      disabled={isInstalled || isInstalling || !canInstall}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleInstall(server);
                      }}
                    >
                      {isInstalled ? "已加入" : isInstalling ? "安装中..." : canInstall ? "安装" : "需补全"}
                    </button>
                  </div>
                  <div className="install-card__chips">
                    <span className="install-card__chip">来源: {server.sourceSite.toLowerCase()}</span>
                    <span className="install-card__chip">作者: {server.publisher}</span>
                    <span className="install-card__chip">下载量: {server.popularityLabel}</span>
                    <span className="install-card__chip">分类: {server.category}</span>
                  </div>
                </div>
              </article>
            );
          })
        ) : (
          <section className="placeholder-card">
            <h3>暂无可安装 MCP</h3>
            <p>{normalizedQuery ? `没有在 ${MCP_MARKETPLACE_SOURCE_LABEL} 中找到 "${normalizedQuery}"。` : `${MCP_MARKETPLACE_SOURCE_LABEL} 暂时没有可展示的服务。`}</p>
          </section>
        )}
      </div>

      {selectedServer ? (
        <McpServerDetailModal server={selectedServer} onClose={() => setSelectedServer(null)} />
      ) : null}
    </section>
  );
}

type McpServerDetailModalProps = {
  server: McpMarketplaceServer;
  onClose: () => void;
};

function McpServerDetailModal(props: McpServerDetailModalProps) {
  const { server, onClose } = props;
  const serverJson = useMemo(
    () => (server.server ? JSON.stringify(server.server, null, 2) : "暂无可自动安装配置"),
    [server.server],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="skill-detail-modal__backdrop" role="presentation" onClick={onClose}>
      <section
        className="skill-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${server.name} 详情`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="skill-detail-modal__header">
          <div className="skill-detail-modal__title-group">
            <h3>{server.name}</h3>
            <p>{server.publisher} · {server.category}</p>
          </div>
          <div className="skill-detail-modal__actions">
            <a
              className="skill-detail-modal__action-link"
              href={server.sourceUrl}
              onClick={(event) => {
                event.preventDefault();
                void openExternalLink(server.sourceUrl);
              }}
            >
              <ExternalLinkIcon />
              打开来源
            </a>
            <button className="skill-detail-modal__close" type="button" onClick={onClose} aria-label="关闭详情">
              ×
            </button>
          </div>
        </header>
        <div className="skill-detail-modal__meta">
          <span className="install-card__chip">来源: {server.sourceSite.toLowerCase()}</span>
          <span className="install-card__chip">作者: {server.publisher}</span>
          <span className="install-card__chip">下载量: {server.popularityLabel}</span>
          <span className="install-card__chip">分类: {server.category}</span>
        </div>
        <article className="skill-detail-modal__content">
          <h4>MCP 介绍</h4>
          <p>{server.description}</p>
        </article>
        <article className="skill-detail-modal__config">
          <h4>安装配置</h4>
          <pre className="mcp-market-config-preview">{serverJson}</pre>
        </article>
      </section>
    </div>
  );
}

function normalizeMcpServerId(name: string) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "mcp-server";
}

function McpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7h14v10H5z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 10h8M8 14h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M14 5h5v5m-1-4-7.5 7.5M10 6H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
