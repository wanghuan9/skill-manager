import type { McpWorkspaceSnapshot } from "@/features/skills/state/skill-store";
import { cacheInstalledServerIds, invalidateCachedInstalledServerIds } from "@/features/skills/utils/mcp-installed-server-cache";

const MCP_WORKSPACE_UPDATED_EVENT = "skillm:mcp-workspace-updated";

declare global {
  interface Window {
    __SKILLM_MCP_WORKSPACE__?: McpWorkspaceSnapshot | null;
  }
}

function notifyWorkspaceUpdated(snapshot: McpWorkspaceSnapshot | null) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<McpWorkspaceSnapshot | null>(MCP_WORKSPACE_UPDATED_EVENT, {
    detail: snapshot,
  }));
}

export function getCachedMcpWorkspace() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.__SKILLM_MCP_WORKSPACE__ ?? null;
}

export function cacheMcpWorkspace(snapshot: McpWorkspaceSnapshot | null) {
  if (typeof window === "undefined") {
    return;
  }

  window.__SKILLM_MCP_WORKSPACE__ = snapshot;
  if (snapshot) {
    cacheInstalledServerIds(snapshot.servers.map((server) => server.id));
  } else {
    invalidateCachedInstalledServerIds();
  }
  notifyWorkspaceUpdated(snapshot);
}

export function subscribeMcpWorkspaceChange(listener: (snapshot: McpWorkspaceSnapshot | null) => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleChange = (event: Event) => {
    listener((event as CustomEvent<McpWorkspaceSnapshot | null>).detail ?? null);
  };

  window.addEventListener(MCP_WORKSPACE_UPDATED_EVENT, handleChange);
  return () => {
    window.removeEventListener(MCP_WORKSPACE_UPDATED_EVENT, handleChange);
  };
}
