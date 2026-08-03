import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, test, vi } from "vitest";
import { PublishRoute } from "@/app/routes/publish";
import { revertSkillHubPublishUpdateHunk } from "@/features/skillhub-publishing/publishing-client";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/features/skills/api/skill-client", () => ({
  fetchLocalSkillCandidates: vi.fn().mockResolvedValue([]),
  importLocalSkill: vi.fn(),
  openExternalLink: vi.fn(),
  subscribeSkillLibraryChanges: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("@/app/i18n", () => ({
  useTranslate: () => ({ t: (key: string) => key }),
}));

const invokeMock = vi.mocked(invoke);
let connected = false;

beforeEach(() => {
  connected = false;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_skillhub_auth_status") {
      return connected
        ? { connected: true, handle: "skilldock", userId: 1, verifiedAt: "2026-07-31T00:00:00Z" }
        : { connected: false, handle: "", userId: 0, verifiedAt: "" };
    }
    if (command === "list_skillhub_publishable_skills") {
      return { skills: [], authorizationRequired: false, statusSyncError: "" };
    }
    if (command === "save_skillhub_auth_token") {
      connected = true;
      return { connected: true, handle: "skilldock", userId: 1, verifiedAt: "2026-07-31T00:00:00Z" };
    }
    return undefined;
  });
});

test("verifies a pasted SkillHub token before showing the publish workbench", async () => {
  render(<PublishRoute />);

  expect(await screen.findByRole("heading", { name: "连接 SkillHub" })).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("SkillHub Token"), "skh_test_token");
  await userEvent.click(screen.getByRole("button", { name: "验证并登录" }));

  expect(invokeMock).toHaveBeenCalledWith("save_skillhub_auth_token", { token: "skh_test_token" });
  expect(await screen.findByRole("heading", { name: "还没有可发布的 Skill" })).toBeInTheDocument();
});

test("reverts a SkillHub publish update hunk through the dedicated command", async () => {
  const input = {
    skillName: "skill-creator",
    localPath: "/tmp/skill-creator",
    remoteSkillId: "skill-creator",
    remoteVersion: "1.0.0",
    relativePath: "SKILL.md",
    expectedContent: "local change\n",
    content: "published content\n",
  };

  await revertSkillHubPublishUpdateHunk(input);

  expect(invokeMock).toHaveBeenCalledWith("revert_skillhub_publish_update_hunk", input);
});
