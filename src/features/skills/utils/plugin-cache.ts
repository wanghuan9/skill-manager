import type { PluginSummary } from "@/features/skills/state/skill-store";

const PLUGINS_UPDATED_EVENT = "skilldock:plugins-updated";

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

export function getCachedPlugins() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.__SKILLM_PLUGINS__ ?? null;
}

export function cachePlugins(plugins: PluginSummary[] | null) {
  if (typeof window === "undefined") {
    return;
  }

  window.__SKILLM_PLUGINS__ = plugins;
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
