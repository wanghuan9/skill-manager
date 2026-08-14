import "@testing-library/jest-dom";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { resetSkillFixtureState } from "@/features/skills/state/skill-fixtures";

const storageState = new Map<string, string>();

if (typeof Range.prototype.getClientRects !== "function") {
  Object.defineProperty(Range.prototype, "getClientRects", {
    value: () => [],
  });
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return storageState.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storageState.set(key, value);
      },
      removeItem(key: string) {
        storageState.delete(key);
      },
      clear() {
        storageState.clear();
      },
    },
  });
}

afterEach(() => {
  cleanup();
  delete (window as Window & { __SKILLM_MCP_WORKSPACE__?: unknown }).__SKILLM_MCP_WORKSPACE__;
  resetSkillFixtureState();
});
