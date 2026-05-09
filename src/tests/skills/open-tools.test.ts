import { buildOpenToolOptions } from "@/features/skills/utils/open-tools";
import type { ToolConfig } from "@/features/skills/state/skill-store";

function buildToolConfig(overrides: Partial<ToolConfig>): ToolConfig {
  return {
    id: "cursor",
    name: "Cursor",
    skillsPath: "/Users/demo/.cursor/skills",
    mcpConfigPath: "/Users/demo/.cursor/mcp.json",
    statusLabel: "已安装",
    isEnabled: true,
    primaryType: "editor",
    surfaceTypes: ["editor"],
    supportsDirectOpen: true,
    ...overrides,
  };
}

test("adds Finder as a selectable default open tool", () => {
  const options = buildOpenToolOptions([
    buildToolConfig({ id: "cursor", name: "Cursor" }),
    buildToolConfig({
      id: "intellij",
      name: "IntelliJ IDEA",
      skillsPath: "/Users/demo/.intellij/skills",
      mcpConfigPath: "",
    }),
  ]);

  expect(options.map((tool) => tool.id)).toEqual(["cursor", "intellij", "finder"]);
});

test("falls back to Finder when no editor can open directories directly", () => {
  const options = buildOpenToolOptions([
    buildToolConfig({
      id: "claude-code",
      name: "Claude Code",
      primaryType: "cli",
      surfaceTypes: ["cli"],
      supportsDirectOpen: false,
    }),
    buildToolConfig({
      id: "kiro",
      name: "Kiro",
      statusLabel: "未安装",
    }),
  ]);

  expect(options).toEqual([
    {
      id: "finder",
      name: "访达",
      primaryType: "desktop",
    },
  ]);
});
