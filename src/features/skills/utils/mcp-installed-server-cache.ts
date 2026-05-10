const MCP_INSTALLED_SERVER_IDS_CACHE_KEY = "__SKILLM_MCP_INSTALLED_SERVER_IDS__";
const MCP_INSTALLED_SERVER_IDS_EVENT = "skillm:mcp-installed-server-ids-updated";

declare global {
  interface Window {
    __SKILLM_MCP_INSTALLED_SERVER_IDS__?: Set<string> | null;
  }
}

function notifyInstalledServerIdsChanged() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(MCP_INSTALLED_SERVER_IDS_EVENT));
}

export function getCachedInstalledServerIds() {
  if (typeof window === "undefined") {
    return new Set<string>();
  }

  const installedServerIds = window[MCP_INSTALLED_SERVER_IDS_CACHE_KEY];
  return installedServerIds ? new Set(installedServerIds) : new Set<string>();
}

export function cacheInstalledServerIds(installedServerIds: Iterable<string>) {
  if (typeof window === "undefined") {
    return;
  }

  window[MCP_INSTALLED_SERVER_IDS_CACHE_KEY] = new Set(installedServerIds);
  notifyInstalledServerIdsChanged();
}

export function invalidateCachedInstalledServerIds() {
  if (typeof window === "undefined") {
    return;
  }

  window[MCP_INSTALLED_SERVER_IDS_CACHE_KEY] = null;
  notifyInstalledServerIdsChanged();
}

export function subscribeInstalledServerIdsChange(listener: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  window.addEventListener(MCP_INSTALLED_SERVER_IDS_EVENT, listener);
  return () => {
    window.removeEventListener(MCP_INSTALLED_SERVER_IDS_EVENT, listener);
  };
}
