import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

type ReleaseNoteSections = Record<"features" | "fixes" | "improvements", string[]>;

const require = createRequire(import.meta.url);
const {
  MAX_RELEASE_NOTE_ITEMS,
  buildSections,
  countReleaseNoteItems,
  isPublicVersionTag,
  limitSections,
} = require("../../../scripts/generate-release-notes.cjs") as {
  MAX_RELEASE_NOTE_ITEMS: number;
  buildSections: (commits: Array<{ subject: string; body: string }>) => ReleaseNoteSections;
  countReleaseNoteItems: (notes: string) => number;
  isPublicVersionTag: (tag: string) => boolean;
  limitSections: (sections: ReleaseNoteSections) => ReleaseNoteSections;
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
});
