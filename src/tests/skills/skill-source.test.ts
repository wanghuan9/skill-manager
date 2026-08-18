import { describe, expect, it } from "vitest";
import { formatSkillSourceLabel } from "@/features/skills/utils/skill-source";

describe("formatSkillSourceLabel", () => {
  it("maps local install labels to local", () => {
    expect(formatSkillSourceLabel("本地导入")).toBe("本地");
    expect(formatSkillSourceLabel("本地安装")).toBe("本地");
  });

  it("uses source type to expand generic custom repository labels", () => {
    expect(formatSkillSourceLabel("自定义仓库", { sourceType: "github" })).toBe("GitHub");
    expect(formatSkillSourceLabel("自定义仓库", { sourceType: "gitlab" })).toBe("GitLab");
    expect(formatSkillSourceLabel("自定义仓库", { sourceType: "gitee" })).toBe("Gitee");
  });

  it("falls back to source url when source type is missing", () => {
    expect(formatSkillSourceLabel("自定义仓库", { sourceUrl: "https://github.com/demo/skills" })).toBe("GitHub");
    expect(formatSkillSourceLabel("自定义仓库", { sourceUrl: "git@gitee.com:demo/skills.git" })).toBe("Gitee");
  });

  it("prefers normalized provider label for regular source labels", () => {
    expect(formatSkillSourceLabel("GitHub", { sourceType: "github" })).toBe("GitHub");
    expect(formatSkillSourceLabel("第三方仓库", { sourceType: "gitlab" })).toBe("GitLab");
  });

  it("identifies well-known Agent CLI sources as remote", () => {
    expect(formatSkillSourceLabel("Agent Skills CLI", {
      sourceType: "well-known",
      sourceUrl: "https://open.feishu.cn/.well-known/skills/lark-okr/SKILL.md",
    })).toBe("在线");
  });
});
