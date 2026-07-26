import { invoke } from "@tauri-apps/api/core";
import { beforeEach, vi } from "vitest";
import {
  fetchProjectWorkspaces,
  previewProjectSkillSync,
  syncProjectMcp,
  toggleProjectSkill,
} from "@/features/skills/api/skill-client";
import { projectWorkspaceFixture } from "@/features/skills/state/skill-fixtures";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

test("maps project workspace and sync commands to Tauri arguments", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce(structuredClone(projectWorkspaceFixture))
    .mockResolvedValueOnce({
      direction: "managed-to-project",
      sourceHash: "source",
      targetHash: "target",
      files: [],
    })
    .mockResolvedValueOnce(structuredClone(projectWorkspaceFixture))
    .mockResolvedValueOnce(structuredClone(projectWorkspaceFixture));

  await fetchProjectWorkspaces();
  await previewProjectSkillSync({
    projectId: "project-demo-workspace",
    toolId: "claude-code",
    projectRelativePath: ".claude/skills/skill-publisher",
    direction: "managed-to-project",
  });
  await toggleProjectSkill({
    projectId: "project-demo-workspace",
    toolId: "cursor",
    projectRelativePath: ".cursor/skills/skill-publisher",
    enabled: false,
  });
  await syncProjectMcp({
    projectId: "project-demo-workspace",
    toolId: "cursor",
    serverName: "context7",
    direction: "project-to-managed",
    sourceHash: "source",
    targetHash: "target",
  });

  expect(invoke).toHaveBeenNthCalledWith(1, "list_project_workspaces", {});
  expect(invoke).toHaveBeenNthCalledWith(2, "preview_project_skill_sync", {
    projectId: "project-demo-workspace",
    toolId: "claude-code",
    projectRelativePath: ".claude/skills/skill-publisher",
    direction: "managed-to-project",
  });
  expect(invoke).toHaveBeenNthCalledWith(3, "toggle_project_skill", {
    projectId: "project-demo-workspace",
    toolId: "cursor",
    projectRelativePath: ".cursor/skills/skill-publisher",
    enabled: false,
  });
  expect(invoke).toHaveBeenNthCalledWith(4, "sync_project_mcp", {
    projectId: "project-demo-workspace",
    toolId: "cursor",
    serverName: "context7",
    direction: "project-to-managed",
    sourceHash: "source",
    targetHash: "target",
  });
});
