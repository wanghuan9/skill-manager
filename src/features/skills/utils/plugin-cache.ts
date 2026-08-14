import type { PluginSummary } from "@/features/skills/state/skill-store";
const PLUGINS_UPDATED_EVENT = "skilldock:plugins-updated";
const PLUGINS_CACHE_STORAGE_KEY = "skilldock.pluginsCache";
const STARTUP_CACHED_REMOTE_COLLAB_STATUSES = new Set<PluginSummary["collabStatus"]>([
  "update-available",
  "diverged",
]);

declare global {
  interface Window {
    __SKILLM_PLUGINS__?: PluginSummary[] | null;
  }
}

function notifyPluginsUpdated(plugins: PluginSummary[] | null) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<PluginSummary[] | null>(PLUGINS_UPDATED_EVENT, {
    detail: plugins,
  }));
}

function readPluginsFromStorage() {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function"
  ) {
    return null;
  }

  const payload = window.localStorage.getItem(PLUGINS_CACHE_STORAGE_KEY);
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as PluginSummary[] | null;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writePluginsToStorage(plugins: PluginSummary[] | null) {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.setItem !== "function" ||
    typeof window.localStorage?.removeItem !== "function"
  ) {
    return;
  }

  if (!plugins || plugins.length === 0) {
    window.localStorage.removeItem(PLUGINS_CACHE_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(PLUGINS_CACHE_STORAGE_KEY, JSON.stringify(plugins));
}

export function getCachedPlugins() {
  if (typeof window === "undefined") {
    return null;
  }

  if (window.__SKILLM_PLUGINS__) {
    return window.__SKILLM_PLUGINS__;
  }

  const storedPlugins = readPluginsFromStorage();
  if (storedPlugins) {
    window.__SKILLM_PLUGINS__ = storedPlugins;
    return storedPlugins;
  }

  return null;
}

export function cachePlugins(plugins: PluginSummary[] | null) {
  if (typeof window === "undefined") {
    return;
  }

  window.__SKILLM_PLUGINS__ = plugins;
  writePluginsToStorage(plugins);
  notifyPluginsUpdated(plugins);
}

function getPluginCacheIdentity(plugin: PluginSummary) {
  const instancePath = plugin.rootPath || plugin.manifestPath || plugin.id;
  return `${plugin.hostTool}::${instancePath}::${plugin.id}`;
}

export function mergeStartupPluginStatusCache(
  plugins: PluginSummary[],
  cachedPlugins: PluginSummary[],
) {
  if (cachedPlugins.length === 0) {
    return plugins;
  }

  const cachedByIdentity = new Map(
    cachedPlugins.map((plugin) => [getPluginCacheIdentity(plugin), plugin]),
  );
  return plugins.map((plugin) => {
    const cachedPlugin = cachedByIdentity.get(getPluginCacheIdentity(plugin));
    if (
      !cachedPlugin
      || plugin.collabStatus !== "clean"
      || !STARTUP_CACHED_REMOTE_COLLAB_STATUSES.has(cachedPlugin.collabStatus)
    ) {
      return plugin;
    }

    return {
      ...plugin,
      collabStatus: cachedPlugin.collabStatus,
      statusText: cachedPlugin.statusText,
      updateAvailable: cachedPlugin.updateAvailable,
      remoteUpdatedAt: cachedPlugin.remoteUpdatedAt,
      lastEditor: cachedPlugin.lastEditor,
      lastScannedAt: cachedPlugin.lastScannedAt,
    };
  });
}

export function subscribePluginsChange(listener: (plugins: PluginSummary[] | null) => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleChange = (event: Event) => {
    listener((event as CustomEvent<PluginSummary[] | null>).detail ?? null);
  };

  window.addEventListener(PLUGINS_UPDATED_EVENT, handleChange);
  return () => {
    window.removeEventListener(PLUGINS_UPDATED_EVENT, handleChange);
  };
}
