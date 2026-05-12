import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNotifications } from "@/app/notifications";
import {
  fetchMcpMarketplaceServers,
  fetchMcpMarketplaceServerConfig,
  fetchMcpWorkspace,
  installMcpServerFromMarketplace,
  openExternalLink,
  resolveMcpMarketplaceSourceUrl,
  refreshMcpServerTools,
} from "@/features/skills/api/skill-client";
import type { McpMarketplaceServer } from "@/features/skills/state/skill-store";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import {
  cacheInstalledServerIds,
  getCachedInstalledServerIds,
  subscribeInstalledServerIdsChange,
} from "@/features/skills/utils/mcp-installed-server-cache";
import {
  cacheMcpWorkspace,
  getCachedMcpWorkspace,
} from "@/features/skills/utils/mcp-workspace-cache";

const MCP_MARKETPLACE_PAGE_SIZE = 24;
const MCP_MARKETPLACE_SOURCE_SITE = "MCP.Directory";
const MCP_MARKETPLACE_SOURCE_LABEL = "mcp.directory";
const MCP_AVATAR_PRIORITY_COUNT = 12;
const MCP_MARKETPLACE_RUNTIME_CACHE_KEY = "__SKILLM_MCP_MARKETPLACE_CACHE__";
const MCP_MARKETPLACE_PERSISTED_CACHE_KEY = "skillm.mcpMarketplaceCache";
const MCP_MARKETPLACE_PERSISTED_CACHE_VERSION = 2;
const MCP_MARKETPLACE_PERSISTED_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type McpMarketplacePanelProps = {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
};

type McpMarketplaceRuntimeCache = {
  pageCache: Map<number, McpMarketplaceServer[]>;
  searchPageCache: Map<string, Map<number, McpMarketplaceServer[]>>;
  workspacePromise: Promise<Set<string>> | null;
};

type CachedMcpSnapshot = {
  servers: McpMarketplaceServer[];
  page: number;
  hasMore: boolean;
};

type PersistedMcpMarketplaceCache = {
  version: number;
  timestamp: number;
  pages: Record<string, McpMarketplaceServer[]>;
};

declare global {
  interface Window {
    __SKILLM_MCP_MARKETPLACE_CACHE__?: McpMarketplaceRuntimeCache;
  }
}

function createMcpMarketplaceRuntimeCache(): McpMarketplaceRuntimeCache {
  return {
    pageCache: new Map<number, McpMarketplaceServer[]>(),
    searchPageCache: new Map<string, Map<number, McpMarketplaceServer[]>>(),
    workspacePromise: null,
  };
}

const fallbackMcpMarketplaceRuntimeCache = createMcpMarketplaceRuntimeCache();

function getMcpMarketplaceRuntimeCache() {
  if (typeof window === "undefined") {
    return fallbackMcpMarketplaceRuntimeCache;
  }

  if (!window[MCP_MARKETPLACE_RUNTIME_CACHE_KEY]) {
    window[MCP_MARKETPLACE_RUNTIME_CACHE_KEY] = createMcpMarketplaceRuntimeCache();
  }

  return window[MCP_MARKETPLACE_RUNTIME_CACHE_KEY]!;
}

function normalizeMcpCacheKey(query: string) {
  return query.trim().toLowerCase();
}

function tryParseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function buildOfficialRepositoryUrl(sourceUrl: string) {
  const parsed = tryParseUrl(sourceUrl);
  if (!parsed) {
    return sourceUrl;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const treeIndex = segments.indexOf("tree");
  const blobIndex = segments.indexOf("blob");
  const cutIndex = treeIndex >= 0 ? treeIndex : blobIndex;
  if (cutIndex > 0) {
    parsed.pathname = `/${segments.slice(0, cutIndex).join("/")}`;
    parsed.search = "";
    parsed.hash = "";
  }

  return parsed.toString();
}

function resolveServerSourceUrl(server: McpMarketplaceServer) {
  const normalizedSourceUrl = buildOfficialRepositoryUrl(server.sourceUrl);
  if (normalizedSourceUrl) {
    return normalizedSourceUrl;
  }

  return buildOfficialRepositoryUrl(server.marketplaceUrl ?? "");
}

function readPersistedMcpMarketplaceCache(): PersistedMcpMarketplaceCache | null {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function"
  ) {
    return null;
  }

  const payload = window.localStorage.getItem(MCP_MARKETPLACE_PERSISTED_CACHE_KEY);
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Partial<PersistedMcpMarketplaceCache>;
    if (
      parsed.version !== MCP_MARKETPLACE_PERSISTED_CACHE_VERSION ||
      typeof parsed.timestamp !== "number" ||
      !parsed.pages ||
      typeof parsed.pages !== "object"
    ) {
      return null;
    }

    if (Date.now() - parsed.timestamp > MCP_MARKETPLACE_PERSISTED_CACHE_TTL_MS) {
      return null;
    }

    return {
      version: parsed.version,
      timestamp: parsed.timestamp,
      pages: parsed.pages,
    };
  } catch {
    return null;
  }
}

function writePersistedMcpMarketplaceCache(pageCache: Map<number, McpMarketplaceServer[]>) {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.setItem !== "function"
  ) {
    return;
  }

  const pages = Object.fromEntries(
    Array.from(pageCache.entries()).map(([page, servers]) => [String(page), servers]),
  );
  const payload: PersistedMcpMarketplaceCache = {
    version: MCP_MARKETPLACE_PERSISTED_CACHE_VERSION,
    timestamp: Date.now(),
    pages,
  };
  window.localStorage.setItem(MCP_MARKETPLACE_PERSISTED_CACHE_KEY, JSON.stringify(payload));
}

function hydrateRuntimeCacheFromPersistence() {
  const cache = getMcpMarketplaceRuntimeCache();
  if (cache.pageCache.size > 0) {
    return;
  }

  const persistedCache = readPersistedMcpMarketplaceCache();
  if (!persistedCache) {
    return;
  }

  for (const [page, servers] of Object.entries(persistedCache.pages)) {
    const pageNumber = Number(page);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !Array.isArray(servers)) {
      continue;
    }
    cache.pageCache.set(pageNumber, servers);
  }
}

function getCachedMcpPageMap(query: string) {
  const cache = getMcpMarketplaceRuntimeCache();
  const cacheKey = normalizeMcpCacheKey(query);
  if (!cacheKey) {
    hydrateRuntimeCacheFromPersistence();
  }
  return cacheKey ? cache.searchPageCache.get(cacheKey) : cache.pageCache;
}

function getOrCreateCachedMcpPageMap(query: string) {
  const cache = getMcpMarketplaceRuntimeCache();
  const cacheKey = normalizeMcpCacheKey(query);
  if (!cacheKey) {
    return cache.pageCache;
  }

  const cachedSearchPages = cache.searchPageCache.get(cacheKey);
  if (cachedSearchPages) {
    return cachedSearchPages;
  }

  const nextSearchPages = new Map<number, McpMarketplaceServer[]>();
  cache.searchPageCache.set(cacheKey, nextSearchPages);
  return nextSearchPages;
}

function writeCachedMcpPage(query: string, page: number, servers: McpMarketplaceServer[]) {
  const cachedPages = getOrCreateCachedMcpPageMap(query);
  cachedPages.set(page, servers);
  if (!normalizeMcpCacheKey(query)) {
    writePersistedMcpMarketplaceCache(cachedPages);
  }
}

function readCachedMcpSnapshot(query: string): CachedMcpSnapshot | null {
  const cacheKey = normalizeMcpCacheKey(query);
  const cachedPages = getCachedMcpPageMap(cacheKey);
  if (!cachedPages) {
    return null;
  }

  const cachedFirstPage = cachedPages.get(1);
  if (!cachedFirstPage) {
    return null;
  }

  const cachedPageEntries = Array.from(cachedPages.entries())
    .filter(([cachedPage]) => cachedPage >= 1)
    .sort(([leftPage], [rightPage]) => leftPage - rightPage);
  const lastCachedEntry = cachedPageEntries[cachedPageEntries.length - 1];
  const lastCachedPage = lastCachedEntry?.[0] ?? 1;
  const lastCachedServers = lastCachedEntry?.[1] ?? cachedFirstPage;

  return {
    servers: cachedPageEntries.flatMap(([, pageServers]) => pageServers),
    page: lastCachedPage,
    hasMore: cacheKey ? lastCachedServers.length >= MCP_MARKETPLACE_PAGE_SIZE : lastCachedServers.length > 0,
  };
}

async function ensureInstalledServerIdsLoaded() {
  const cache = getMcpMarketplaceRuntimeCache();
  const installedServerIds = getCachedInstalledServerIds();
  if (installedServerIds.size > 0) {
    return installedServerIds;
  }

  const cachedWorkspace = getCachedMcpWorkspace();
  if (cachedWorkspace) {
    const cachedInstalledServerIds = new Set(cachedWorkspace.servers.map((server) => server.id));
    cacheInstalledServerIds(cachedInstalledServerIds);
    return cachedInstalledServerIds;
  }

  if (!cache.workspacePromise) {
    cache.workspacePromise = fetchMcpWorkspace()
      .then((workspace) => {
        cacheMcpWorkspace(workspace);
        const installedServerIds = new Set(workspace.servers.map((server) => server.id));
        cacheInstalledServerIds(installedServerIds);
        return installedServerIds;
      })
      .finally(() => {
        cache.workspacePromise = null;
      });
  }

  return cache.workspacePromise.then((installedServerIds) => new Set(installedServerIds));
}

export function McpMarketplacePanel(props: McpMarketplacePanelProps) {
  const { searchQuery, onSearchQueryChange } = props;
  const { notify } = useNotifications();
  const { appSettings } = useSkillWorkspace();
  const configCacheRef = useRef<Map<string, Record<string, unknown> | null>>(new Map());
  const resolvedSourceUrlCacheRef = useRef<Map<string, string>>(new Map());
  const initialCachedSnapshot = readCachedMcpSnapshot(searchQuery);
  const [servers, setServers] = useState<McpMarketplaceServer[]>(() => initialCachedSnapshot?.servers ?? []);
  const [installedServerIds, setInstalledServerIds] = useState<Set<string>>(() => getCachedInstalledServerIds());
  const [installingServerIds, setInstallingServerIds] = useState<Set<string>>(new Set());
  const [selectedServer, setSelectedServer] = useState<McpMarketplaceServer | null>(null);
  const [isLoading, setIsLoading] = useState(() => initialCachedSnapshot == null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(() => initialCachedSnapshot?.hasMore ?? true);
  const [page, setPage] = useState(() => initialCachedSnapshot?.page ?? 0);
  const [errorMessage, setErrorMessage] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery);
  const isLoadingRef = useRef(isLoading);
  const isLoadingMoreRef = useRef(isLoadingMore);
  const hasMoreRef = useRef(hasMore);
  const loadingMoreRef = useRef(false);
  const loadMoreRef = useRef<() => Promise<void>>(async () => undefined);
  const normalizedQuery = debouncedQuery.trim();
  const isSearching = normalizedQuery.length > 0;
  const showLoadingPlaceholder = isLoading && servers.length === 0;
  const installHint =
    appSettings.mcpInstallActivation === "apply-all-tools"
      ? "安装后默认同步到所有已支持应用"
      : "";

  const applyCachedServerConfig = useCallback((server: McpMarketplaceServer) => {
    if (!configCacheRef.current.has(server.id)) {
      return server;
    }

    const cachedConfig = configCacheRef.current.get(server.id);
    if (!cachedConfig) {
      return server;
    }

    return {
      ...server,
      server: cachedConfig,
    };
  }, []);

  const applyCachedServerConfigs = useCallback((items: McpMarketplaceServer[]) => {
    return items.map((server) => applyCachedServerConfig(server));
  }, [applyCachedServerConfig]);

  const handleLoadServerConfig = useCallback(async (server: McpMarketplaceServer) => {
    if (server.server) {
      configCacheRef.current.set(server.id, server.server);
      return server.server;
    }

    if (configCacheRef.current.has(server.id)) {
      return configCacheRef.current.get(server.id) ?? null;
    }

    const serverConfig = await fetchMcpMarketplaceServerConfig({ server });
    configCacheRef.current.set(server.id, serverConfig);
    if (!serverConfig) {
      return null;
    }

    setServers((current) => current.map((item) => (
      item.id === server.id
        ? { ...item, server: serverConfig }
        : item
    )));
    setSelectedServer((current) => (
      current?.id === server.id
        ? { ...current, server: serverConfig }
        : current
    ));
    return serverConfig;
  }, []);

  const handleSelectServer = useCallback((server: McpMarketplaceServer) => {
    setSelectedServer(applyCachedServerConfig(server));
  }, [applyCachedServerConfig]);

  const handleOpenSource = useCallback(async (server: McpMarketplaceServer) => {
    const cachedResolvedSourceUrl = resolvedSourceUrlCacheRef.current.get(server.id);
    const resolvedSourceUrl = cachedResolvedSourceUrl
      ?? await resolveMcpMarketplaceSourceUrl(server);
    const fallbackSourceUrl = resolveServerSourceUrl(server);
    const nextSourceUrl = resolvedSourceUrl.trim() || fallbackSourceUrl;
    if (!cachedResolvedSourceUrl && nextSourceUrl) {
      resolvedSourceUrlCacheRef.current.set(server.id, nextSourceUrl);
    }

    await openExternalLink(nextSourceUrl);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  useEffect(() => {
    let active = true;

    void ensureInstalledServerIdsLoaded()
      .then((nextInstalledServerIds) => {
        if (!active) {
          return;
        }
        setInstalledServerIds(nextInstalledServerIds);
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => subscribeInstalledServerIdsChange(() => {
    setInstalledServerIds(getCachedInstalledServerIds());
  }), []);

  useEffect(() => {
    let active = true;

    async function loadFirstPage() {
      setErrorMessage("");
      const cachedSnapshot = readCachedMcpSnapshot(normalizedQuery);
      if (cachedSnapshot) {
        if (!active) {
          return;
        }
        setServers(applyCachedServerConfigs(cachedSnapshot.servers));
        setPage(cachedSnapshot.page);
        setHasMore(cachedSnapshot.hasMore);
        setIsLoading(false);
        if (normalizedQuery.length > 0) {
          return;
        }
      }

      if (!cachedSnapshot) {
        setIsLoading(true);
      }
      try {
        const marketplaceServers = await fetchMcpMarketplaceServers({
          sourceSite: MCP_MARKETPLACE_SOURCE_SITE,
          page: 1,
          limit: MCP_MARKETPLACE_PAGE_SIZE,
          query: normalizedQuery,
          refresh: normalizedQuery.length === 0 && cachedSnapshot != null,
        });
        if (!active) {
          return;
        }

        writeCachedMcpPage(normalizedQuery, 1, marketplaceServers);
        setServers(applyCachedServerConfigs(marketplaceServers));
        setPage(1);
        setHasMore(isSearching ? marketplaceServers.length >= MCP_MARKETPLACE_PAGE_SIZE : marketplaceServers.length > 0);
      } catch (error) {
        if (!active) {
          return;
        }
        setServers([]);
        setPage(0);
        setHasMore(false);
        const message = error instanceof Error ? error.message : "加载 MCP 市场失败，请稍后重试。";
        setErrorMessage(message);
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    void loadFirstPage();

    return () => {
      active = false;
    };
  }, [applyCachedServerConfigs, normalizedQuery]);

  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    isLoadingMoreRef.current = isLoadingMore;
  }, [isLoadingMore]);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  useEffect(() => {
    const avatarUrls = servers
      .map((server) => getOptimizedMcpAvatarUrl(server.avatarUrl))
      .filter((url): url is string => Boolean(url));

    for (const avatarUrl of avatarUrls) {
      if (prefetchedAvatarUrls.has(avatarUrl)) {
        continue;
      }
      prefetchedAvatarUrls.add(avatarUrl);
      const image = new Image();
      image.decoding = "async";
      image.src = avatarUrl;
    }
  }, [servers]);

  async function handleLoadMore() {
    if (isLoading || isLoadingMore || !hasMore) {
      return;
    }

    const nextPage = page + 1;
    const cachedPage = getCachedMcpPageMap(normalizedQuery)?.get(nextPage);
    if (cachedPage) {
      setServers((current) => [...current, ...applyCachedServerConfigs(cachedPage)]);
      setPage(nextPage);
      setHasMore(isSearching ? cachedPage.length >= MCP_MARKETPLACE_PAGE_SIZE : cachedPage.length > 0);
      return;
    }

    setIsLoadingMore(true);
    setErrorMessage("");
    try {
      const nextServers = await fetchMcpMarketplaceServers({
        sourceSite: MCP_MARKETPLACE_SOURCE_SITE,
        page: nextPage,
        limit: MCP_MARKETPLACE_PAGE_SIZE,
        query: normalizedQuery,
      });
      writeCachedMcpPage(normalizedQuery, nextPage, nextServers);
      setServers((current) => [...current, ...applyCachedServerConfigs(nextServers)]);
      setPage(nextPage);
      setHasMore(isSearching ? nextServers.length >= MCP_MARKETPLACE_PAGE_SIZE : nextServers.length > 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载更多 MCP 失败，请稍后重试。";
      setErrorMessage(message);
      notify({ message, tone: "error" });
    } finally {
      setIsLoadingMore(false);
    }
  }

  useEffect(() => {
    loadMoreRef.current = handleLoadMore;
  });

  const handleScroll = useCallback(() => {
    if (
      loadingMoreRef.current ||
      isLoadingRef.current ||
      isLoadingMoreRef.current ||
      !hasMoreRef.current
    ) {
      return;
    }

    const scrollContainer = document.querySelector(".page-content");
    if (!(scrollContainer instanceof HTMLElement)) {
      return;
    }

    const remain = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    if (remain > 140) {
      return;
    }

    loadingMoreRef.current = true;
    void loadMoreRef.current().finally(() => {
      loadingMoreRef.current = false;
    });
  }, []);

  useEffect(() => {
    const scrollContainer = document.querySelector(".page-content");
    if (!(scrollContainer instanceof HTMLElement)) {
      return;
    }

    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll]);

  async function handleInstall(server: McpMarketplaceServer) {
    setInstallingServerIds((current) => new Set(current).add(server.id));
    try {
      const installedWorkspace = await installMcpServerFromMarketplace({ server });
      cacheMcpWorkspace(installedWorkspace);
      const installedServerId = normalizeMcpServerId(server.name);
      const installedServer = installedWorkspace.servers.find((item) => item.id === installedServerId);
      const shouldRefreshTools = Boolean(
        installedServer
        && installedServer.tools.length === 0
        && !installedServer.toolsDiscoveredAt,
      );
      const nextInstalledServerIds = new Set(installedWorkspace.servers.map((item) => item.id));
      setInstalledServerIds(nextInstalledServerIds);
      notify({ message: `MCP "${server.name}" 已安装，可到 MCP 页查看`, tone: "success" });

      if (shouldRefreshTools) {
        void refreshMcpServerTools(installedServerId)
          .then((workspace) => {
            cacheMcpWorkspace(workspace);
          })
          .catch(() => undefined);
      }
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
    handleSelectServer(server);
  }

  return (
    <section className="panel-card market-panel mcp-market-panel">
      <div className="market-source-bar">
        <div className="panel-header">
          <h2>安装源</h2>
          <p>{installHint}</p>
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
        {showLoadingPlaceholder ? (
          <section className="placeholder-card">
            <h3>正在搜索 MCP</h3>
            <p>{normalizedQuery ? `正在从 ${MCP_MARKETPLACE_SOURCE_LABEL} 搜索 "${normalizedQuery}"...` : `正在加载 ${MCP_MARKETPLACE_SOURCE_LABEL} 真实服务列表。`}</p>
          </section>
        ) : servers.length > 0 ? (
          <>
            {servers.map((server, index) => {
              const resolvedId = normalizeMcpServerId(server.name);
              const isInstalled = installedServerIds.has(resolvedId);
              const isInstalling = installingServerIds.has(server.id);
              const sourceUrl = resolveServerSourceUrl(server);
              const canInstall = Boolean(server.sourceUrl);

              return (
                <article key={server.id} className="placeholder-card install-card mcp-market-card">
                  <div
                    className="install-card__surface"
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectServer(server)}
                    onKeyDown={(event) => handleServerSurfaceKeyDown(event, server)}
                  >
                    <div className="install-card__header">
                      <div className="install-card__lead">
                        <McpMarketplaceAvatar server={server} priority={index < MCP_AVATAR_PRIORITY_COUNT} />
                        <div className="install-card__title-group">
                          <div className="install-card__title-row">
                            <h3 title={server.name}>{server.name}</h3>
                            <a
                              className="install-card__link"
                              href={sourceUrl}
                              aria-label={`打开 ${server.name} 来源`}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void handleOpenSource(server);
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
                        {isInstalled ? "已安装" : isInstalling ? "安装中..." : canInstall ? "安装" : "需补全"}
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
            })}
            {errorMessage ? (
              <p className="install-loading-text" role="status">{errorMessage}</p>
            ) : null}
            {isLoadingMore ? (
              <p className="install-loading-text">加载中...</p>
            ) : null}
            {!hasMore ? (
              <p className="install-loading-text">已加载全部 MCP</p>
            ) : null}
          </>
        ) : (
          <section className="placeholder-card">
            <h3>暂无可安装 MCP</h3>
            <p>
              {errorMessage
                ? errorMessage
                : normalizedQuery
                  ? `没有在 ${MCP_MARKETPLACE_SOURCE_LABEL} 中找到 "${normalizedQuery}"。`
                  : `${MCP_MARKETPLACE_SOURCE_LABEL} 暂时没有可展示的服务。`}
            </p>
          </section>
        )}
      </div>

      {selectedServer ? (
        <McpServerDetailModal
          server={selectedServer}
          onClose={() => setSelectedServer(null)}
          onLoadServerConfig={handleLoadServerConfig}
          onOpenSource={handleOpenSource}
        />
      ) : null}
    </section>
  );
}

type McpServerDetailModalProps = {
  server: McpMarketplaceServer;
  onClose: () => void;
  onLoadServerConfig: (server: McpMarketplaceServer) => Promise<Record<string, unknown> | null>;
  onOpenSource: (server: McpMarketplaceServer) => Promise<void>;
};

function McpServerDetailModal(props: McpServerDetailModalProps) {
  const { server, onClose, onLoadServerConfig, onOpenSource } = props;
  const sourceUrl = resolveServerSourceUrl(server);
  const [serverConfig, setServerConfig] = useState<Record<string, unknown> | null>(server.server ?? null);
  const [configErrorMessage, setConfigErrorMessage] = useState("");
  const [isConfigLoading, setIsConfigLoading] = useState(() => server.server == null);
  const serverJson = useMemo(() => {
    if (serverConfig) {
      return JSON.stringify(serverConfig, null, 2);
    }
    if (isConfigLoading) {
      return "正在加载安装配置...";
    }
    if (configErrorMessage) {
      return configErrorMessage;
    }
    return "当前 MCP 暂未提供安装配置";
  }, [configErrorMessage, isConfigLoading, serverConfig]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let active = true;

    setServerConfig(server.server ?? null);
    setConfigErrorMessage("");
    if (server.server) {
      setIsConfigLoading(false);
      return () => {
        active = false;
      };
    }

    setIsConfigLoading(true);
    void onLoadServerConfig(server)
      .then((nextServerConfig) => {
        if (!active) {
          return;
        }
        setServerConfig(nextServerConfig);
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        const message = error instanceof Error ? error.message : "加载安装配置失败，请稍后重试。";
        setConfigErrorMessage(message);
      })
      .finally(() => {
        if (active) {
          setIsConfigLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [onLoadServerConfig, server]);

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
              href={sourceUrl}
              onClick={(event) => {
                event.preventDefault();
                void onOpenSource(server);
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

const prefetchedAvatarUrls = new Set<string>();

function McpMarketplaceAvatar(props: { server: McpMarketplaceServer; priority: boolean }) {
  const { server, priority } = props;
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const avatarUrl = getOptimizedMcpAvatarUrl(server.avatarUrl);
  const shouldLoadImage = Boolean(avatarUrl) && !hasFailed;

  useEffect(() => {
    setIsLoaded(false);
    setHasFailed(false);
  }, [avatarUrl]);

  const avatarClassName = [
    "install-card__avatar",
    `install-card__avatar--${buildMcpAvatarTone(server)}`,
    isLoaded ? "install-card__avatar--image-loaded" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={avatarClassName}>
      <McpIcon />
      {shouldLoadImage ? (
        <img
          className={`install-card__avatar-image${isLoaded ? " is-loaded" : ""}`}
          src={avatarUrl}
          alt=""
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          {...{ fetchpriority: priority ? "high" : "auto" }}
          onLoad={() => setIsLoaded(true)}
          onError={() => setHasFailed(true)}
        />
      ) : null}
    </div>
  );
}

function getOptimizedMcpAvatarUrl(avatarUrl?: string | null) {
  if (!avatarUrl) {
    return "";
  }

  try {
    const parsed = new URL(avatarUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "github.com" && parsed.pathname.endsWith(".png")) {
      parsed.searchParams.set("size", "80");
      return parsed.toString();
    }
    if (hostname === "avatars.githubusercontent.com") {
      parsed.searchParams.set("s", "80");
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return avatarUrl;
  }
}

function buildMcpAvatarTone(server: McpMarketplaceServer) {
  const tones = ["pink", "gold", "sky", "mint", "violet"];
  let hash = 0;
  const seed = `${server.sourceSite}:${server.publisher}:${server.name}`;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) % tones.length;
  }
  return tones[hash];
}

function McpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7.2 8.2a3 3 0 0 1 4.2 0l4.4 4.4a3 3 0 0 1-4.2 4.2l-1.1-1.1"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M16.8 15.8a3 3 0 0 1-4.2 0L8.2 11.4a3 3 0 0 1 4.2-4.2l1.1 1.1"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
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
