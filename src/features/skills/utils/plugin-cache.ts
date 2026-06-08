import type { PluginSummary } from "@/features/skills/state/skill-store";

const PLUGINS_UPDATED_EVENT = "skilldock:plugins-updated";
const PLUGINS_CACHE_STORAGE_KEY = "skilldock.pluginsCache";

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
