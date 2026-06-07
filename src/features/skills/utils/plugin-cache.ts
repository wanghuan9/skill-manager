import type { PluginSummary } from "@/features/skills/state/skill-store";

const PLUGINS_UPDATED_EVENT = "skilldock:plugins-updated";
const PERSISTED_PLUGINS_CACHE_KEY = "skilldock.pluginsCache";

declare global {
  interface Window {
    __SKILLM_PLUGINS__?: PluginSummary[] | null;
  }
}

function readPersistedPluginsCache() {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function"
  ) {
    return null;
  }

  const payload = window.localStorage.getItem(PERSISTED_PLUGINS_CACHE_KEY);
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as PluginSummary[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writePersistedPluginsCache(plugins: PluginSummary[] | null) {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.setItem !== "function" ||
    typeof window.localStorage?.removeItem !== "function"
  ) {
    return;
  }

  if (!plugins || plugins.length === 0) {
    window.localStorage.removeItem(PERSISTED_PLUGINS_CACHE_KEY);
    return;
  }

  window.localStorage.setItem(PERSISTED_PLUGINS_CACHE_KEY, JSON.stringify(plugins));
}

function notifyPluginsUpdated(plugins: PluginSummary[] | null) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<PluginSummary[] | null>(PLUGINS_UPDATED_EVENT, {
    detail: plugins,
  }));
}

export function getCachedPlugins() {
  if (typeof window === "undefined") {
    return null;
  }

  if (window.__SKILLM_PLUGINS__ === undefined) {
    window.__SKILLM_PLUGINS__ = readPersistedPluginsCache();
  }

  return window.__SKILLM_PLUGINS__ ?? null;
}

export function cachePlugins(plugins: PluginSummary[] | null) {
  if (typeof window === "undefined") {
    return;
  }

  window.__SKILLM_PLUGINS__ = plugins;
  writePersistedPluginsCache(plugins);
  notifyPluginsUpdated(plugins);
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
