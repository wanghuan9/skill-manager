import { invoke, isTauri } from "@tauri-apps/api/core";
import { beforeEach, vi } from "vitest";
import {
  fetchStartupInstalledPlugins,
  revertPluginChange,
  savePluginFileContent,
} from "@/features/skills/api/skill-client";
import { pluginFixtures } from "@/features/skills/state/skill-fixtures";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(isTauri).mockReturnValue(true);
});

test("preserves plugin local change counts returned by Tauri", async () => {
  vi.mocked(invoke).mockResolvedValueOnce([{
    ...pluginFixtures[0],
    localChangeCount: 7,
  }]);

  const plugins = await fetchStartupInstalledPlugins();

  expect(plugins[0]?.localChangeCount).toBe(7);
});

test("saves plugin file content with the verified preview target", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    path: "commands/review.md",
    content: "# Updated",
  });

  await expect(savePluginFileContent({
    hostTool: "codex",
    rootPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout",
    repoRootPath: "/Users/demo/.skilldock/plugins/repo-scout",
    pluginRelativePath: "plugins/repo-scout",
    relativePath: "commands/review.md",
    content: "# Updated",
  })).resolves.toEqual({
    path: "commands/review.md",
    content: "# Updated",
  });
  expect(invoke).toHaveBeenCalledWith("save_plugin_file_content", {
    hostTool: "codex",
    rootPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout",
    repoRootPath: "/Users/demo/.skilldock/plugins/repo-scout",
    pluginRelativePath: "plugins/repo-scout",
    relativePath: "commands/review.md",
    content: "# Updated",
  });
});

test("normalizes optional plugin revert arguments for whole-file and hunk reverts", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  const target = {
    hostTool: "cursor" as const,
    rootPath: "/Users/demo/.cursor/plugins/local/repo-scout",
    repoRootPath: "/Users/demo/.skilldock/plugins/repo-scout",
    pluginRelativePath: "plugins/repo-scout",
    relativePath: "commands/review.md",
  };

  await revertPluginChange(target);
  await revertPluginChange({
    ...target,
    hunkIndex: 1,
    expectedPatch: "@@ -1 +1 @@\n-old\n+new\n",
    staged: true,
  });

  expect(invoke).toHaveBeenNthCalledWith(1, "revert_plugin_change", {
    ...target,
    hunkIndex: null,
    expectedPatch: null,
    staged: false,
  });
  expect(invoke).toHaveBeenNthCalledWith(2, "revert_plugin_change", {
    ...target,
    hunkIndex: 1,
    expectedPatch: "@@ -1 +1 @@\n-old\n+new\n",
    staged: true,
  });
});
