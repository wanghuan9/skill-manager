import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { SearchFieldIcon } from "@/app/components/SearchFieldIcon";
import { useTranslate } from "@/app/i18n";
import { useFailureReporter } from "@/app/failure-feedback";
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
const MCP_SOURCE_URL_PREFETCH_COUNT = 8;
const MCP_MARKETPLACE_RUNTIME_CACHE_KEY = "__SKILLM_MCP_MARKETPLACE_CACHE__";
const MCP_MARKETPLACE_PERSISTED_CACHE_KEY = "skilldock.mcpMarketplaceCache";
const MCP_MARKETPLACE_PERSISTED_CACHE_VERSION = 2;
const INSTALL_PAGE_SCROLL_SELECTOR = ".main-panel[data-active-route=\"install\"] .page-content";

type McpMarketplacePanelProps = {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
};

type McpMarketplaceRuntimeCache = {
  pageCache: Map<number, McpMarketplaceServer[]>;
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
  servers?: McpMarketplaceServer[];
};

declare global {
  interface Window {
    __SKILLM_MCP_MARKETPLACE_CACHE__?: McpMarketplaceRuntimeCache;
  }
}

function createMcpMarketplaceRuntimeCache(): McpMarketplaceRuntimeCache {
  return {
    pageCache: new Map<number, McpMarketplaceServer[]>(),
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

function resolveServerMarketplaceUrl(server: McpMarketplaceServer) {
  const explicitMarketplaceUrl = server.marketplaceUrl?.trim() ?? "";
  if (explicitMarketplaceUrl) {
    return explicitMarketplaceUrl;
  }

  const parsedSourceUrl = tryParseUrl(server.sourceUrl);
  if (parsedSourceUrl?.host === "mcp.directory") {
    return parsedSourceUrl.toString();
  }

  return "";
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
    const parsedPages = parsed.pages && typeof parsed.pages === "object"
      ? parsed.pages
      : {};
    const parsedServers = Array.isArray(parsed.servers) ? parsed.servers : undefined;
    if (
      parsed.version !== MCP_MARKETPLACE_PERSISTED_CACHE_VERSION ||
      typeof parsed.timestamp !== "number" ||
      (!parsedServers && Object.keys(parsedPages).length === 0)
    ) {
      return null;
    }

    return {
      version: parsed.version,
      timestamp: parsed.timestamp,
      pages: parsedPages,
      servers: parsedServers,
    };
  } catch {
    return null;
  }
}

function writePersistedMcpMarketplaceCache(servers: McpMarketplaceServer[]) {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.setItem !== "function"
  ) {
    return;
  }

  const payload: PersistedMcpMarketplaceCache = {
    version: MCP_MARKETPLACE_PERSISTED_CACHE_VERSION,
    timestamp: Date.now(),
    pages: {
      "1": servers,
    },
    servers,
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

  const firstPageServers = persistedCache.servers ?? persistedCache.pages["1"];
  if (Array.isArray(firstPageServers)) {
    cache.pageCache.set(1, firstPageServers);
  }
}

function getCachedMcpPageMap(query: string) {
  const cacheKey = normalizeMcpCacheKey(query);
  if (cacheKey) {
    return undefined;
  }

  const cache = getMcpMarketplaceRuntimeCache();
  hydrateRuntimeCacheFromPersistence();
  return cache.pageCache;
}

function getOrCreateCachedMcpPageMap(query: string) {
  const cacheKey = normalizeMcpCacheKey(query);
  if (cacheKey) {
    return undefined;
  }

  return getMcpMarketplaceRuntimeCache().pageCache;
}

function writeCachedMcpPage(query: string, page: number, servers: McpMarketplaceServer[]) {
  if (page !== 1 || normalizeMcpCacheKey(query)) {
    return;
  }

  const cachedPages = getOrCreateCachedMcpPageMap(query);
  if (!cachedPages) {
    return;
  }
  cachedPages.set(page, servers);
  writePersistedMcpMarketplaceCache(servers);
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

  return {
    servers: cachedFirstPage,
    page: 1,
    hasMore: cachedFirstPage.length >= MCP_MARKETPLACE_PAGE_SIZE,
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
    const cachedInstalledServerIds = new Set(
      cachedWorkspace.servers.filter((server) => !server.hasPendingSync).map((server) => server.id),
    );
    cacheInstalledServerIds(cachedInstalledServerIds);
    return cachedInstalledServerIds;
  }

  if (!cache.workspacePromise) {
    cache.workspacePromise = fetchMcpWorkspace()
      .then((workspace) => {
        cacheMcpWorkspace(workspace);
        const installedServerIds = new Set(
          workspace.servers.filter((server) => !server.hasPendingSync).map((server) => server.id),
        );
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
  const { t } = useTranslate();
  const { searchQuery, onSearchQueryChange } = props;
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const configCacheRef = useRef<Map<string, Record<string, unknown> | null>>(new Map());
  const resolvedSourceUrlCacheRef = useRef<Map<string, string>>(new Map());
  const resolvedSourceUrlPromiseCacheRef = useRef<Map<string, Promise<string>>>(new Map());
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

  const resolveAndCacheSourceUrl = useCallback((server: McpMarketplaceServer) => {
    const cachedResolvedSourceUrl = resolvedSourceUrlCacheRef.current.get(server.id);
    if (cachedResolvedSourceUrl) {
      return Promise.resolve(cachedResolvedSourceUrl);
    }

    const resolvingSourceUrl = resolvedSourceUrlPromiseCacheRef.current.get(server.id);
    if (resolvingSourceUrl) {
      return resolvingSourceUrl;
    }

    const fallbackSourceUrl = resolveServerSourceUrl(server);
    const nextResolvingSourceUrl = resolveMcpMarketplaceSourceUrl(server)
      .then((resolvedSourceUrl) => resolvedSourceUrl.trim() || fallbackSourceUrl)
      .catch(() => fallbackSourceUrl)
      .then((nextSourceUrl) => {
        if (nextSourceUrl) {
          resolvedSourceUrlCacheRef.current.set(server.id, nextSourceUrl);
        }
        return nextSourceUrl;
      })
      .finally(() => {
        resolvedSourceUrlPromiseCacheRef.current.delete(server.id);
      });

    resolvedSourceUrlPromiseCacheRef.current.set(server.id, nextResolvingSourceUrl);
    return nextResolvingSourceUrl;
  }, []);

  const handleOpenSource = useCallback(async (server: McpMarketplaceServer) => {
    const nextSourceUrl = await resolveAndCacheSourceUrl(server);
    if (!nextSourceUrl) {
      return;
    }

    await openExternalLink(nextSourceUrl);
  }, [resolveAndCacheSourceUrl]);

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
        const message = error instanceof Error ? error.message : t("install.mcp.error.loadMarketplace");
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
    const prefetchSourceServers = servers.slice(0, MCP_SOURCE_URL_PREFETCH_COUNT);
    for (const server of prefetchSourceServers) {
      void resolveAndCacheSourceUrl(server);
    }
  }, [resolveAndCacheSourceUrl, servers]);

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
      setServers((current) => [...current, ...applyCachedServerConfigs(nextServers)]);
      setPage(nextPage);
      setHasMore(isSearching ? nextServers.length >= MCP_MARKETPLACE_PAGE_SIZE : nextServers.length > 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("install.mcp.error.loadMore");
      setErrorMessage(message);
      reportFailure(error, {
        operation: "load_more_mcp_marketplace_servers",
        fallbackMessage: t("install.mcp.error.loadMore"),
        context: { page: nextPage, query: normalizedQuery },
      });
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

    const scrollContainer = document.querySelector(INSTALL_PAGE_SCROLL_SELECTOR);
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
    const scrollContainer = document.querySelector(INSTALL_PAGE_SCROLL_SELECTOR);
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
      const installResult = await installMcpServerFromMarketplace({ server });
      const installedWorkspace = installResult.workspace;
      cacheMcpWorkspace(installedWorkspace);
      const installedServerId = normalizeMcpServerId(server.name);
      const installedServer = installedWorkspace.servers.find((item) => item.id === installedServerId);
      const shouldRefreshTools = Boolean(
        installedServer
        && !installedServer.hasPendingSync
        && installedServer.tools.length === 0
        && !installedServer.toolsDiscoveredAt,
      );
      const nextInstalledServerIds = new Set(
        installedWorkspace.servers.filter((item) => !item.hasPendingSync).map((item) => item.id),
      );
      setInstalledServerIds(nextInstalledServerIds);
      if (installResult.syncFailures.length > 0) {
        const failedAppNames = [...new Set(installResult.syncFailures.map((failure) => failure.appName))]
          .join(", ");
        notify({
          message: t("install.mcp.info.installedWithSyncFailures", {
            name: server.name,
            apps: failedAppNames,
          }),
          tone: "info",
        });
      } else {
        notify({ message: t("install.mcp.success.installed", { name: server.name }), tone: "success" });
      }

      if (shouldRefreshTools) {
        void refreshMcpServerTools(installedServerId)
          .then((workspace) => {
            cacheMcpWorkspace(workspace);
          })
          .catch(() => undefined);
      }
    } catch (error) {
      reportFailure(error, {
        operation: "install_mcp_server_from_marketplace",
        fallbackMessage: t("install.mcp.error.installFailed"),
        context: { serverId: server.id, serverName: server.name },
      });
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
          <h2>{t("install.mcp.sources.title")}</h2>
        </div>
        <label className="market-search-field">
          <span className="sr-only">{t("install.mcp.searchAria")}</span>
          <div className="market-search-input-wrap">
            <SearchFieldIcon />
            <input
              className="market-search-input"
              type="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={searchQuery}
              placeholder={t("install.mcp.searchPlaceholder")}
              onChange={(event) => onSearchQueryChange(event.target.value)}
            />
            {isLoading ? (
              <span className="loading-spinner market-search-spinner" aria-label={t("install.mcp.searching")} />
            ) : null}
          </div>
        </label>
        <div className="source-tab-row" role="tablist" aria-label={t("install.mcp.sourcesAria")}>
          <button className="source-tab is-selected" type="button" role="tab" aria-selected="true">
            {MCP_MARKETPLACE_SOURCE_LABEL}
          </button>
        </div>
      </div>

      <div className="install-grid market-install-scroll">
        {showLoadingPlaceholder ? (
          <section className="placeholder-card">
            <h3>{t("install.mcp.loading.title")}</h3>
            <p>{normalizedQuery ? t("install.mcp.loading.searchDescription", { source: MCP_MARKETPLACE_SOURCE_LABEL, query: normalizedQuery }) : t("install.mcp.loading.sourceDescription", { source: MCP_MARKETPLACE_SOURCE_LABEL })}</p>
          </section>
        ) : servers.length > 0 ? (
          <>
            {servers.map((server) => {
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
                        <McpMarketplaceAvatar server={server} />
                        <div className="install-card__title-group">
                          <div className="install-card__title-row">
                            <h3 title={server.name}>{server.name}</h3>
                            <a
                              className="install-card__link"
                              href={sourceUrl}
                              aria-label={t("install.mcp.openRepo", { name: server.name })}
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
                        {isInstalled ? t("install.market.installed") : isInstalling ? t("install.market.installing") : canInstall ? t("install.market.install") : t("install.mcp.installNeedsConfig")}
                      </button>
                    </div>
                    <div className="install-card__chips">
                      <span className="install-card__chip">{t("install.market.author")}: {server.publisher}</span>
                      <span className="install-card__chip">{t("install.mcp.downloads")}: {server.popularityLabel}</span>
                      <span className="install-card__chip">{t("install.mcp.category")}: {server.category}</span>
                    </div>
                  </div>
                </article>
              );
            })}
            {errorMessage ? (
              <p className="install-loading-text" role="status">{errorMessage}</p>
            ) : null}
            {isLoadingMore ? (
              <p className="install-loading-text">{t("install.market.loading.more")}</p>
            ) : null}
            {!hasMore ? (
              <p className="install-loading-text">{t("install.mcp.allLoaded")}</p>
            ) : null}
          </>
        ) : (
          <section className="placeholder-card">
            <h3>{t("install.mcp.emptyTitle")}</h3>
            <p>
              {errorMessage
                ? errorMessage
                : normalizedQuery
                  ? t("install.mcp.emptySearch", { source: MCP_MARKETPLACE_SOURCE_LABEL, query: normalizedQuery })
                  : t("install.mcp.emptySource", { source: MCP_MARKETPLACE_SOURCE_LABEL })}
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
  const { t } = useTranslate();
  const sourceUrl = resolveServerSourceUrl(server);
  const marketplaceUrl = resolveServerMarketplaceUrl(server);
  const [serverConfig, setServerConfig] = useState<Record<string, unknown> | null>(server.server ?? null);
  const [configErrorMessage, setConfigErrorMessage] = useState("");
  const [isConfigLoading, setIsConfigLoading] = useState(() => server.server == null);
  const serverJson = useMemo(() => {
    if (serverConfig) {
      return JSON.stringify(serverConfig, null, 2);
    }
    if (isConfigLoading) {
      return t("install.mcp.config.loading");
    }
    if (configErrorMessage) {
      return configErrorMessage;
    }
    return t("install.mcp.config.unavailable");
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
        const message = error instanceof Error ? error.message : t("install.mcp.config.loadFailed");
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
        aria-label={t("install.mcp.detail.aria", { name: server.name })}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="skill-detail-modal__header">
          <div className="skill-detail-modal__title-group">
            <h3>{server.name}</h3>
            <p>{server.publisher} · {server.category}</p>
          </div>
          <div className="skill-detail-modal__actions">
            {marketplaceUrl ? (
              <a
                className="skill-detail-modal__action-link"
                href={marketplaceUrl}
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalLink(marketplaceUrl);
                }}
              >
                <ExternalLinkIcon />
                {t("install.mcp.detail.viewStore")}
              </a>
            ) : null}
            <a
              className="skill-detail-modal__action-link skill-detail-modal__action-link--primary"
              href={sourceUrl}
              onClick={(event) => {
                event.preventDefault();
                void onOpenSource(server);
              }}
            >
              <ExternalLinkIcon />
              {t("install.mcp.detail.openRepo")}
            </a>
            <button className="skill-detail-modal__close" type="button" onClick={onClose} aria-label={t("install.mcp.detail.close")}>
              ×
            </button>
          </div>
        </header>
        <div className="skill-detail-modal__meta">
          <span className="install-card__chip">{t("install.market.author")}: {server.publisher}</span>
          <span className="install-card__chip">{t("install.mcp.downloads")}: {server.popularityLabel}</span>
          <span className="install-card__chip">{t("install.mcp.category")}: {server.category}</span>
        </div>
        <article className="skill-detail-modal__content">
          <h4>{t("install.mcp.detail.intro")}</h4>
          <p>{server.description}</p>
        </article>
        <article className="skill-detail-modal__config">
          <h4>{t("install.mcp.detail.config")}</h4>
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

function McpMarketplaceAvatar(props: { server: McpMarketplaceServer }) {
  const { server } = props;
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const avatarUrl = getOptimizedMcpAvatarUrl(server.avatarUrl);
  const shouldLoadImage = Boolean(avatarUrl) && !hasFailed;

  useEffect(() => {
    setIsLoaded(false);
    setHasFailed(false);
  }, [avatarUrl]);

  useEffect(() => {
    const image = imageRef.current;
    if (!image || !shouldLoadImage || !image.complete) {
      return;
    }

    if (image.naturalWidth > 0) {
      setIsLoaded(true);
      return;
    }

    setHasFailed(true);
  }, [avatarUrl, shouldLoadImage]);

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
          ref={imageRef}
          className={`install-card__avatar-image${isLoaded ? " is-loaded" : ""}`}
          src={avatarUrl}
          alt=""
          loading="eager"
          decoding="async"
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
