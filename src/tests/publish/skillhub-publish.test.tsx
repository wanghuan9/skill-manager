import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, test, vi } from "vitest";
import { PublishRoute } from "@/app/routes/publish";
import { skillHubPublishingAdapter } from "@/features/publishing/adapters/skillhub";
import type { PublishableSkill } from "@/features/publishing/types";
import {
  revertSkillHubPublishUpdateFile,
  revertSkillHubPublishUpdateHunk,
} from "@/features/skillhub-publishing/publishing-client";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/features/skills/api/skill-client", () => ({
  getInternalMarketplaceAccountLabel: vi.fn().mockResolvedValue(""),
  hasInternalMarketplaceSession: vi.fn().mockResolvedValue(false),
  fetchLocalSkillCandidates: vi.fn().mockResolvedValue([]),
  importLocalSkill: vi.fn(),
  openExternalLink: vi.fn(),
  subscribeSkillLibraryChanges: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("@/app/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/i18n")>();
  return {
    ...actual,
    useTranslate: () => ({
      language: "zh-CN",
      t: (key: Parameters<typeof actual.tx>[1], values?: Parameters<typeof actual.tx>[2]) =>
        actual.tx("zh-CN", key, values),
    }),
  };
});

const invokeMock = vi.mocked(invoke);
let connected = false;

beforeEach(() => {
  connected = false;
  window.localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_skillhub_auth_status") {
      return connected
        ? { connected: true, handle: "skilldock", displayName: "SkillDock", userId: 1, verifiedAt: "2026-07-31T00:00:00Z" }
        : { connected: false, handle: "", displayName: "", userId: 0, verifiedAt: "" };
    }
    if (command === "list_skillhub_publishable_skills") {
      return { skills: [], authorizationRequired: false, statusSyncError: "" };
    }
    if (command === "save_skillhub_auth_token") {
      connected = true;
      return { connected: true, handle: "skilldock", displayName: "SkillDock", userId: 1, verifiedAt: "2026-07-31T00:00:00Z" };
    }
    return undefined;
  });
});

test("shows the cached workbench while SkillHub authentication refreshes in the background", async () => {
  connected = true;
  window.localStorage.setItem("skilldock.skillhubPublishingCache", JSON.stringify({
    skills: [{
      name: "cached-private-skill",
      description: "Cached skill",
      localPath: "/tmp/cached-private-skill",
      localContentHash: "cached",
      fileCount: 1,
      packageSize: 1,
      remoteVersion: "1.0.0",
      remoteContentHash: "cached",
      publishStatus: "published",
      failureReason: "",
      marketUrl: "",
      targetVersion: "1.0.0",
    }],
    authorizationRequired: false,
  }));

  render(<PublishRoute />);

  expect(screen.getByText("cached-private-skill")).toBeInTheDocument();
  expect(screen.queryByText("正在检查 SkillHub 授权状态…")).not.toBeInTheDocument();
  expect(await screen.findByText("SkillDock")).toBeInTheDocument();
});

test("uses a cached disconnected state without showing the previous publishing snapshot", async () => {
  window.localStorage.setItem("skilldock.skillhubPublishingAuthCache", JSON.stringify({
    connected: false,
    accountLabel: "",
    verifiedAt: "",
  }));
  window.localStorage.setItem("skilldock.skillhubPublishingCache", JSON.stringify({
    skills: [{ name: "cached-private-skill", localPath: "/tmp/cached-private-skill" }],
    authorizationRequired: false,
  }));

  render(<PublishRoute />);

  expect(screen.getByRole("heading", { name: "连接 SkillHub" })).toBeInTheDocument();
  expect(screen.queryByText("cached-private-skill")).not.toBeInTheDocument();
  expect(screen.queryByText("正在检查 SkillHub 授权状态…")).not.toBeInTheDocument();
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_skillhub_auth_status"));
});

test("replaces a stale connected cache when the local SkillHub credential is gone", async () => {
  window.localStorage.setItem("skilldock.skillhubPublishingAuthCache", JSON.stringify({
    connected: true,
    accountLabel: "SkillDock",
    verifiedAt: "2026-07-31T00:00:00Z",
  }));
  window.localStorage.setItem("skilldock.skillhubPublishingCache", JSON.stringify({
    skills: [{
      name: "cached-private-skill",
      description: "Cached skill",
      localPath: "/tmp/cached-private-skill",
      localContentHash: "cached",
      fileCount: 1,
      packageSize: 1,
      remoteVersion: "1.0.0",
      remoteContentHash: "cached",
      publishStatus: "published",
      failureReason: "",
      marketUrl: "",
      targetVersion: "1.0.0",
    }],
    authorizationRequired: false,
  }));

  render(<PublishRoute />);

  expect(screen.getByText("cached-private-skill")).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "连接 SkillHub" })).toBeInTheDocument();
  expect(screen.queryByText("cached-private-skill")).not.toBeInTheDocument();
  expect(JSON.parse(window.localStorage.getItem("skilldock.skillhubPublishingAuthCache") ?? "{}")).toMatchObject({
    connected: false,
  });
});

test("verifies a pasted SkillHub token before showing the publish workbench", async () => {
  render(<PublishRoute />);

  const platformTab = await screen.findByRole("tab", { name: "SkillHub" });
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByText("SkillHub 发布工作台")).toBeInTheDocument();
  expect(screen.getByText("公开")).toBeInTheDocument();
  await userEvent.click(platformTab);
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

test("reverts a complete SkillHub publish update file through the dedicated command", async () => {
  const input = {
    skillName: "skill-creator",
    localPath: "/tmp/skill-creator",
    remoteSkillId: "skill-creator",
    remoteVersion: "1.0.0",
    relativePath: "SKILL.md",
  };

  await revertSkillHubPublishUpdateFile(input);

  expect(invokeMock).toHaveBeenCalledWith("revert_skillhub_publish_update_file", input);
});

test("reconciles the file diff before refreshing a reverted SkillHub update", async () => {
  const skill: PublishableSkill = {
    name: "skill-creator",
    description: "Creates skills.",
    localPath: "/tmp/skill-creator",
    localContentHash: "local-content",
    fileCount: 1,
    packageSize: 10,
    remoteSkillId: "skill-creator",
    remoteVersion: "1.0.0",
    remoteContentHash: "",
    publishStatus: "update-available",
    updateFileCount: 1,
    failureReason: "",
    marketUrl: "",
    targetVersion: "1.0.1",
  };
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "reconcile_skillhub_publishable_skills") {
      return {
        skills: [{
          ...skill,
          publishStatus: "published",
          updateFileCount: 0,
          targetVersion: "1.0.0",
        }],
        authorizationRequired: false,
        statusSyncError: "",
      };
    }
    return undefined;
  });

  const refreshedSkill = await skillHubPublishingAdapter.refreshSkill(skill);

  expect(invokeMock).toHaveBeenCalledWith("reconcile_skillhub_publishable_skills", { forceRefresh: true });
  expect(refreshedSkill).toMatchObject({
    publishStatus: "published",
    updateFileCount: 0,
    targetVersion: "1.0.0",
  });
});
