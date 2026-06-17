import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "@/app/App";
import * as skillClient from "@/features/skills/api/skill-client";
import { clickNavInstall } from "@/tests/helpers/nav";

test("renders local skill import list", async () => {
  const fetchCandidatesSpy = vi.spyOn(skillClient, "fetchLocalSkillCandidates");
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "本地安装" }));
  expect(screen.getByRole("heading", { name: "安装", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "扫描导入" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "手动安装" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "扫描导入" })).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "本地 skill 路径" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("本地导入总览")).toHaveTextContent("发现 2 个本地 skill · 4 个位置 · 1 个重复");
  expect(screen.getByRole("button", { name: "全部导入" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "收起列表" })).toHaveAttribute("aria-expanded", "true");

  const excalidrawGroup = screen.getByLabelText("excalidraw-diagram");
  expect(within(excalidrawGroup).getByRole("button", { name: "导入 excalidraw-diagram" })).toBeInTheDocument();
  expect(within(excalidrawGroup).getByRole("button", { name: "展开 excalidraw-diagram" })).toBeInTheDocument();
  await userEvent.click(within(excalidrawGroup).getByText("3 个位置 · cursor / claude_code / windsurf"));
  expect(within(excalidrawGroup).getByText("/Users/demo/.cursor/skills/excalidraw-diagram")).toBeInTheDocument();
  expect(within(excalidrawGroup).getAllByRole("button")).toHaveLength(2);

  await userEvent.click(screen.getByRole("button", { name: "收起列表" }));
  expect(screen.queryByLabelText("excalidraw-diagram")).not.toBeInTheDocument();

  await waitFor(() => {
    expect(fetchCandidatesSpy).toHaveBeenCalled();
  });
  fetchCandidatesSpy.mockRestore();
});

test("switches local install to the manual install form without opening a dialog", async () => {
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "本地安装" }));
  await userEvent.click(screen.getByRole("tab", { name: "手动安装" }));

  expect(screen.getByRole("tab", { name: "手动安装" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("dialog", { name: "手动安装本地 skill" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "本地 skill 路径" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "技能名称（可选）" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "安装技能" })).toBeDisabled();
});

test("imports local skills once per skill group", async () => {
  const importSpy = vi.spyOn(skillClient, "importLocalSkill");
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "本地安装" }));

  await userEvent.click(screen.getByRole("button", { name: "全部导入" }));

  await waitFor(() => {
    expect(importSpy).toHaveBeenCalledTimes(2);
  });
  expect(importSpy.mock.calls.map(([localPath]) => localPath)).toEqual([
    "/Users/demo/.cursor/skills/excalidraw-diagram",
    "/Users/demo/.codex/skills/technical-design",
  ]);
  importSpy.mockRestore();
});

test("removes imported local candidate when installed skill name differs from source folder", async () => {
  const candidate = {
    name: "example-prd-writing",
    description: "示例 PRD 编写规范。",
    localPath: "/Users/demo/.claude/skills/example-prd-writing",
    detectedFrom: "/Users/demo/.claude/skills",
    sourceHint: "本地文件",
  };
  const fetchCandidatesSpy = vi
    .spyOn(skillClient, "fetchLocalSkillCandidates")
    .mockResolvedValue([candidate]);
  const importSpy = vi.spyOn(skillClient, "importLocalSkill").mockResolvedValue({
    name: "示例PRD编写",
    sourceLabel: "本地导入",
    sourceType: "local",
    sourceUrl: candidate.localPath,
    description: candidate.description,
    localPath: "/Users/demo/.skilldock/skills/示例PRD编写",
    branch: "local",
    collabStatus: "clean",
    statusText: "已纳入管理，建议同步到目标工具。",
    remoteUpdatedAt: "",
    localUpdatedAt: "刚刚",
    lastCheckedAt: "刚刚",
    syncedToolCount: 0,
    lastEditor: "",
    commitLabel: "local-only",
    gitLinked: false,
    tools: [],
  });

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "本地安装" }));

  expect(await screen.findByLabelText("example-prd-writing")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "导入 example-prd-writing" }));

  await waitFor(() => {
    expect(screen.queryByLabelText("example-prd-writing")).not.toBeInTheDocument();
  });
  expect(importSpy).toHaveBeenCalledWith(candidate.localPath);
  fetchCandidatesSpy.mockRestore();
  importSpy.mockRestore();
});

test("rescans from the empty local import state", async () => {
  const nextCandidate = {
    name: "new-local-skill",
    description: "新增的本地 skill。",
    localPath: "/Users/demo/.codex/skills/new-local-skill",
    detectedFrom: "/Users/demo/.codex/skills",
    sourceHint: "本地目录",
  };
  let shouldReturnNextCandidate = false;
  const fetchCandidatesSpy = vi
    .spyOn(skillClient, "fetchLocalSkillCandidates")
    .mockImplementation(() => Promise.resolve(shouldReturnNextCandidate ? [nextCandidate] : []));

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "本地安装" }));

  expect(await screen.findByRole("button", { name: "重新扫描" })).toBeInTheDocument();
  shouldReturnNextCandidate = true;
  await userEvent.click(screen.getByRole("button", { name: "重新扫描" }));

  expect(await screen.findByLabelText("new-local-skill")).toBeInTheDocument();
  expect(fetchCandidatesSpy).toHaveBeenCalled();
  fetchCandidatesSpy.mockRestore();
});
