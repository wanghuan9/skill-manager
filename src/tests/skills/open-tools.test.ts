import {
  buildOpenToolOptions,
  resolveDefaultOpenToolId,
  resolvePreferredEditorIdForTextFile,
} from "@/features/skills/utils/open-tools";
import type { ToolConfig } from "@/features/skills/state/skill-store";

function buildToolConfig(overrides: Partial<ToolConfig>): ToolConfig {
  return {
    id: "cursor",
    name: "Cursor",
    skillsPath: "/Users/demo/.cursor/skills",
    mcpConfigPath: "/Users/demo/.cursor/mcp.json",
    supportsMcp: true,
    mcpConfigPathRecognized: true,
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
      skillsPath: "/Users/demo/.junie/skills",
      mcpConfigPath: "",
      mcpConfigPathRecognized: false,
    }),
  ], "zh-CN");

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
  ], "zh-CN");

  expect(options).toEqual([
    {
      id: "finder",
      name: "访达",
      primaryType: "desktop",
    },
  ]);
});

test("resolves installed direct-open editor for text files", () => {
  const editorId = resolvePreferredEditorIdForTextFile([
    buildToolConfig({ id: "cursor", name: "Cursor" }),
    buildToolConfig({
      id: "claude-code",
      name: "Claude Code",
      primaryType: "cli",
      surfaceTypes: ["cli"],
      supportsDirectOpen: false,
    }),
  ], "cursor");

  expect(editorId).toBe("cursor");
});

test("returns undefined when preferred tool is not a direct-open editor", () => {
  const editorId = resolvePreferredEditorIdForTextFile([
    buildToolConfig({ id: "cursor", name: "Cursor" }),
  ], "finder");

  expect(editorId).toBeUndefined();
});

test("resolves default open tool by preferred editor priority", () => {
  const editorId = resolveDefaultOpenToolId([
    buildToolConfig({ id: "qoder", name: "Qoder", supportsDirectOpen: true, statusLabel: "已安装" }),
    buildToolConfig({ id: "trae-cn", name: "Trae CN", supportsDirectOpen: true, statusLabel: "已安装" }),
    buildToolConfig({ id: "windsurf", name: "Devin", supportsDirectOpen: true, statusLabel: "已安装" }),
    buildToolConfig({ id: "cursor", name: "Cursor", supportsDirectOpen: true, statusLabel: "已安装" }),
  ]);

  expect(editorId).toBe("cursor");
});

test("falls back through preferred editors when cursor is missing", () => {
  const editorId = resolveDefaultOpenToolId([
    buildToolConfig({ id: "windsurf", name: "Devin", supportsDirectOpen: true, statusLabel: "已安装" }),
    buildToolConfig({ id: "trae", name: "Trae", supportsDirectOpen: true, statusLabel: "已安装" }),
  ]);

  expect(editorId).toBe("windsurf");
});

test("treats renamed Devin install as the windsurf tool id", () => {
  const editorId = resolveDefaultOpenToolId([
    buildToolConfig({ id: "windsurf", name: "Devin", supportsDirectOpen: true, statusLabel: "已安装" }),
    buildToolConfig({ id: "trae", name: "Trae", supportsDirectOpen: true, statusLabel: "已安装" }),
  ]);

  expect(editorId).toBe("windsurf");
});

test("returns Finder when no direct-open editor is available", () => {
  const editorId = resolveDefaultOpenToolId([
    buildToolConfig({
      id: "claude-code",
      name: "Claude Code",
      primaryType: "cli",
      surfaceTypes: ["cli"],
      supportsDirectOpen: false,
      statusLabel: "已安装",
    }),
  ]);

  expect(editorId).toBe("finder");
});
