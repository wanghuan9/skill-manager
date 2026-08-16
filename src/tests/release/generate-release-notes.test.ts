import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

type ReleaseNoteSections = Record<"features" | "fixes" | "improvements", string[]>;

const require = createRequire(import.meta.url);
const {
  MAX_RELEASE_NOTE_ITEMS,
  buildSections,
  countReleaseNoteItems,
  detectChangedAreas,
  findUnclassifiedProductionPaths,
  isPublicVersionTag,
  limitSections,
  validateCuratedReleaseNotes,
} = require("../../../scripts/generate-release-notes.cjs") as {
  MAX_RELEASE_NOTE_ITEMS: number;
  buildSections: (commits: Array<{ subject: string; body: string }>) => ReleaseNoteSections;
  countReleaseNoteItems: (notes: string) => number;
  detectChangedAreas: (paths: string[]) => Array<{ id: string; label: string }>;
  findUnclassifiedProductionPaths: (paths: string[], addedPaths?: string[]) => string[];
  isPublicVersionTag: (tag: string) => boolean;
  limitSections: (sections: ReleaseNoteSections) => ReleaseNoteSections;
  validateCuratedReleaseNotes: (
    notes: string,
    changedAreas: Array<{ id: string; label: string }>,
  ) => void;
};

describe("release notes item limit", () => {
  test("keeps all sections represented while limiting the total to eight items", () => {
    const sections: ReleaseNoteSections = {
      features: Array.from({ length: 6 }, (_, index) => `新增 ${index + 1}`),
      fixes: Array.from({ length: 6 }, (_, index) => `修复 ${index + 1}`),
      improvements: Array.from({ length: 6 }, (_, index) => `优化 ${index + 1}`),
    };

    const limited = limitSections(sections);
    const items = Object.values(limited).flat();

    expect(items).toHaveLength(MAX_RELEASE_NOTE_ITEMS);
    expect(limited.features.length).toBeGreaterThan(0);
    expect(limited.fixes.length).toBeGreaterThan(0);
    expect(limited.improvements.length).toBeGreaterThan(0);
    expect(countReleaseNoteItems(items.map((item) => `- ${item}`).join("\n"))).toBe(8);
  });

  test("keeps product names and summarizes the main changes between releases", () => {
    const sections = buildSections([
      {
        subject: "fix:[opencode-mcp-config-compat] 完善 OpenCode MCP 启停兼容",
        body: "- 兼容 OpenCode JSON/JSONC 多层配置并保留注释与原生字段",
      },
      {
        subject: "feat:[opencode-plugin-support] 支持 OpenCode 插件管理",
        body: "- 增加 OpenCode 插件探测与 SkillDock 托管软连接\\n- 完善安装、启停、更新、删除和便携恢复生命周期",
      },
      {
        subject: "feat:[zcode-support] 支持 ZCode Skills 和 MCP",
        body: "",
      },
      {
        subject: "feat:[skillhub-publishing] 完成 SkillHub 商店发布",
        body: "- 增加 Token 登录、状态缓存与真实 SkillHub 发布流程",
      },
      {
        subject: "test: 补充 SkillHub 发布测试",
        body: "",
      },
    ]);

    expect(sections.features).toEqual([
      "新增 SkillHub 发布功能，支持 Token 连接、SkillDock 与 Agent CLI 托管 Skill 发布、状态缓存、版本差异预览和逐块回滚",
      "新增 ZCode 工具支持，可管理 ZCode Skills 和 MCP",
      "新增 OpenCode 插件管理，支持仓库探测，并优先通过 SkillDock 托管目录软连接完成安装、启停、更新、删除和便携恢复",
    ]);
    expect(sections.fixes).toEqual([
      "完善 OpenCode MCP 启停和 JSON/JSONC 配置兼容，保留注释及原生字段，并避免误删同名配置",
    ]);
  });

  test("splits escaped body lines and falls back to a user-facing subject", () => {
    const sections = buildSections([
      {
        subject: "feat: 新增批量选择和批量操作",
        body: "- 补充测试覆盖\\n- 完善参数校验",
      },
      {
        subject: "feat: 新增批量导入",
        body: "- 新增批量导入入口\\n- 补充测试覆盖",
      },
    ]);

    expect(sections.features).toEqual([
      "新增批量选择和批量操作",
      "新增批量导入入口",
    ]);
  });

  test("keeps internal tags out of public release history", () => {
    expect(isPublicVersionTag("v1.0.8")).toBe(true);
    expect(isPublicVersionTag("v1.0.8-beta.1")).toBe(true);
    expect(isPublicVersionTag("internal-v1.0.8")).toBe(false);
  });

  test("detects user-facing change areas from the complete tag diff", () => {
    const areas = detectChangedAreas([
      "src-tauri/src/workspace.rs",
      "src-tauri/src/backup_repository.rs",
      "src-tauri/src/mcp_manager.rs",
      "src-tauri/src/plugin_manager.rs",
      "src-tauri/src/git_changes.rs",
      "src/features/publishing/PublishingWorkbench.tsx",
      "src/features/app-update/AppUpdateAutoPrompt.tsx",
      "scripts/publish-release.sh",
    ]);

    expect(areas.map((area) => area.id)).toEqual([
      "workspace",
      "backup",
      "mcp",
      "plugins",
      "git-workflow",
      "publishing",
      "app-update",
    ]);
  });

  test("rejects curated notes that omit a changed product area", () => {
    const areas = detectChangedAreas([
      "src-tauri/src/mcp_manager.rs",
      "src-tauri/src/plugin_manager.rs",
    ]);
    const incompleteNotes = "## 修复\n\n- 修复插件运行副本同步问题。\n";

    expect(() => validateCuratedReleaseNotes(incompleteNotes, areas)).toThrow(
      "MCP 管理",
    );
  });

  test("fails closed when changed production code has no release-note area", () => {
    expect(findUnclassifiedProductionPaths([
      "src/features/skills/components/NewProductPanel.tsx",
      "src/tests/new-product/new-product.test.tsx",
      "scripts/publish-release.sh",
    ], ["src/features/skills/components/NewProductPanel.tsx"])).toEqual([
      "src/features/skills/components/NewProductPanel.tsx",
    ]);
  });

  test("fails closed for new app-update production files without an explicit rule", () => {
    const newPath = "src/features/app-update/NewCapability.tsx";

    expect(findUnclassifiedProductionPaths([newPath], [newPath])).toEqual([newPath]);
  });

  test("does not count the SkillDock product name as Skill management coverage", () => {
    const areas = detectChangedAreas(["src-tauri/src/commands.rs"]);

    expect(() => validateCuratedReleaseNotes(
      "## 新增\n\n- SkillDock 增加目录迁移。\n",
      areas,
    )).toThrow("Skill 管理");
  });

  test("rejects bullets outside supported release-note sections", () => {
    const notes = "## 其他\n\n- MCP 与插件变更。\n";

    expect(() => validateCuratedReleaseNotes(notes, [])).toThrow(
      "未归入新增、修复或优化章节",
    );
  });

  test("accepts curated notes only when every changed product area is represented", () => {
    const areas = detectChangedAreas([
      "src-tauri/src/workspace.rs",
      "src-tauri/src/backup_repository.rs",
      "src-tauri/src/mcp_manager.rs",
      "src-tauri/src/plugin_manager.rs",
      "src-tauri/src/git_changes.rs",
      "src/features/publishing/PublishingWorkbench.tsx",
      "src/features/app-update/AppUpdateAutoPrompt.tsx",
    ]);
    const completeNotes = [
      "## 新增",
      "",
      "- 工作区采用新目录结构并自动迁移旧数据。",
      "- 插件新增文件编辑、Git 差异预览、待提交和待推送状态。",
      "- 新增 SkillHub 发布工作台。",
      "",
      "## 修复",
      "",
      "- 修复云端备份初始化问题。",
      "* 修复 MCP 市场安装同步问题。",
      "- 修复 Cursor、Codex 和 Claude Code 插件运行副本同步问题。",
      "- 修复应用更新提示交互。",
      "",
    ].join("\n");

    expect(() => validateCuratedReleaseNotes(completeNotes, areas)).not.toThrow();
  });
});
