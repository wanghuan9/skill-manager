import { afterEach, expect, test, vi } from "vitest";
import { checkForAppUpdate } from "@/features/app-update/app-update-client";

const getVersionMock = vi.fn();
const checkMock = vi.fn();

vi.mock("@/app/is-tauri-runtime", () => ({
  isTauriRuntime: () => true,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => getVersionMock(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: () => checkMock(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

test("parses structured release note history from updater metadata", async () => {
  getVersionMock.mockResolvedValue("0.1.4");
  checkMock.mockResolvedValue({
    currentVersion: "0.1.4",
    version: "0.1.6",
    date: "2026-05-20T10:00:00.000Z",
    body: "## 优化\n\n- 刷新工具图标资源与映射。",
    rawJson: {
      releaseNotesHistory: [
        {
          version: "0.1.6",
          body: "## 优化\n\n- 刷新工具图标资源与映射。",
        },
        {
          version: "0.1.5",
          body: "## 修复\n\n- 修复 skill 商店搜索中页面提前切换的问题。",
        },
        {
          version: "0.1.4",
          body: "## 优化\n\n- 历史版本日志。",
        },
      ],
    },
    downloadAndInstall: vi.fn(),
  });

  const result = await checkForAppUpdate();

  expect(result.releaseNotesHistory).toEqual([
    {
      version: "0.1.6",
      body: "## 优化\n\n- 刷新工具图标资源与映射。",
      date: undefined,
    },
    {
      version: "0.1.5",
      body: "## 修复\n\n- 修复 skill 商店搜索中页面提前切换的问题。",
      date: undefined,
    },
  ]);
});

test("falls back to the latest release body when structured history is missing", async () => {
  getVersionMock.mockResolvedValue("0.1.4");
  checkMock.mockResolvedValue({
    currentVersion: "0.1.4",
    version: "0.1.6",
    date: "2026-05-20T10:00:00.000Z",
    body: "## 优化\n\n- 刷新工具图标资源与映射。",
    rawJson: {},
    downloadAndInstall: vi.fn(),
  });

  const result = await checkForAppUpdate();

  expect(result.releaseNotesHistory).toEqual([
    {
      version: "0.1.6",
      body: "## 优化\n\n- 刷新工具图标资源与映射。",
      date: "2026-05-20T10:00:00.000Z",
    },
  ]);
});
