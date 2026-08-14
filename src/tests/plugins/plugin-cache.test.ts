import { expect, test } from "vitest";
import { pluginFixtures } from "@/features/skills/state/skill-fixtures";
import { mergeStartupPluginStatusCache } from "@/features/skills/utils/plugin-cache";
import type { PluginSummary } from "@/features/skills/state/skill-store";

test("keeps cached remote plugin update markers during startup refresh", () => {
  const cachedPlugin: PluginSummary = {
    ...pluginFixtures[0],
    collabStatus: "update-available",
    updateAvailable: true,
    statusText: "远端存在更新。",
  };
  const startupPlugin: PluginSummary = {
    ...cachedPlugin,
    collabStatus: "clean",
    updateAvailable: false,
    statusText: "插件目录已是最新。",
  };

  const [mergedPlugin] = mergeStartupPluginStatusCache([startupPlugin], [cachedPlugin]);

  expect(mergedPlugin.collabStatus).toBe("update-available");
  expect(mergedPlugin.updateAvailable).toBe(true);
  expect(mergedPlugin.statusText).toBe("远端存在更新。");
});

test("does not restore stale cached local plugin markers", () => {
  const cachedPlugin: PluginSummary = {
    ...pluginFixtures[0],
    collabStatus: "pending-push",
    statusText: "本地存在待推送提交。",
  };
  const startupPlugin: PluginSummary = {
    ...cachedPlugin,
    collabStatus: "clean",
    statusText: "插件目录已是最新。",
  };

  const [mergedPlugin] = mergeStartupPluginStatusCache([startupPlugin], [cachedPlugin]);

  expect(mergedPlugin.collabStatus).toBe("clean");
  expect(mergedPlugin.statusText).toBe("插件目录已是最新。");
});

test("does not apply cached plugin markers to a different root", () => {
  const cachedPlugin: PluginSummary = {
    ...pluginFixtures[0],
    collabStatus: "update-available",
    updateAvailable: true,
  };
  const movedPlugin: PluginSummary = {
    ...cachedPlugin,
    rootPath: `${cachedPlugin.rootPath}-new`,
    collabStatus: "clean",
    updateAvailable: false,
  };

  const [mergedPlugin] = mergeStartupPluginStatusCache([movedPlugin], [cachedPlugin]);

  expect(mergedPlugin.collabStatus).toBe("clean");
  expect(mergedPlugin.updateAvailable).toBe(false);
});
