import { describe, expect, it } from "vitest";
import {
  installedSkillRepoIdentity,
  isRepoSkillCandidateInstalled,
  repoSkillInstallIdentity,
} from "@/features/skills/utils/repo-skill-identity";
import type { SkillSummary } from "@/features/skills/state/skill-store";

function skillFixture(name: string, sourceUrl: string): SkillSummary {
  return {
    name,
    sourceUrl,
    sourceLabel: "GitHub",
    sourceType: "github",
    description: "",
    localPath: `/tmp/${name}`,
    branch: "main",
    collabStatus: "clean",
    statusText: "",
    remoteUpdatedAt: "",
    localUpdatedAt: "",
    lastCheckedAt: "",
    syncedToolCount: 0,
    lastEditor: "",
    commitLabel: "",
    gitLinked: true,
    tools: [],
  };
}

describe("repo-skill-identity", () => {
  it("matches installed skills by repo path instead of install directory name", () => {
    const repoUrl = "https://github.com/anthropics/skills";
    const installed = [
      skillFixture(
        "algorithmic-art-skills",
        "https://github.com/anthropics/skills/tree/main/skills/algorithmic-art",
      ),
    ];

    expect(
      isRepoSkillCandidateInstalled("skills/algorithmic-art", repoUrl, installed),
    ).toBe(true);
    expect(repoSkillInstallIdentity(repoUrl, "skills/algorithmic-art")).toBe(
      installedSkillRepoIdentity(installed[0]),
    );
  });
});
