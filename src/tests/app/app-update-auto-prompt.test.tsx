import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { NotificationProvider } from "@/app/notifications";
import {
  AppUpdateAutoPrompt,
  resetAutoUpdatePromptStateForTests,
} from "@/features/app-update/AppUpdateAutoPrompt";
import { checkForAppUpdate } from "@/features/app-update/app-update-client";

const reportFailureMock = vi.hoisted(() => vi.fn());

vi.mock("@/features/app-update/app-update-client", () => ({
  checkForAppUpdate: vi.fn(),
}));

vi.mock("@/app/i18n", async () => {
  const actual = await vi.importActual<typeof import("@/app/i18n")>("@/app/i18n");
  return {
    ...actual,
    useTranslate: () => ({
      language: "zh-CN",
      t: (key: string) => {
        const map: Record<string, string> = {
          "updates.popover.aria": "软件更新",
          "updates.installing": "正在下载并安装更新...",
          "updates.installFailed": "安装更新失败",
        };
        return map[key] ?? key;
      },
    }),
  };
});

vi.mock("@/app/failure-feedback", () => ({
  useFailureReporter: () => reportFailureMock,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  resetAutoUpdatePromptStateForTests();
});

test("shows an in-app prompt and installs when automatic update check finds a new version", async () => {
  vi.useFakeTimers();
  const install = vi.fn().mockResolvedValue(undefined);
  vi.mocked(checkForAppUpdate).mockResolvedValue({
    available: true,
    currentVersion: "0.1.4",
    version: "0.1.6",
    body: "## 优化\n\n- 刷新工具图标资源与映射。",
    releaseNotesHistory: [
      {
        version: "0.1.6",
        body: "## 优化\n\n- 刷新工具图标资源与映射。",
      },
      {
        version: "0.1.5",
        body: [
          "## 修复",
          "",
          "- 修复 skill 商店搜索中页面提前切换的问题。",
          "- 修复首次安装默认编辑器未同步到实际打开行为。",
          "",
          "## 优化",
          "",
          "- 默认语言选择由 IP 改为识别系统语言规则。",
        ].join("\n"),
      },
    ],
    install,
  });

  const view = render(
    <NotificationProvider>
      <AppUpdateAutoPrompt />
    </NotificationProvider>,
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });

  expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  expect(screen.getByLabelText("软件更新")).toHaveAttribute("aria-hidden", "true");

  fireEvent.mouseEnter(screen.getByRole("button", { name: "Update" }));

  expect(screen.getByLabelText("软件更新")).toHaveAttribute("aria-hidden", "false");
  expect(screen.getByText("What's in this update")).toBeInTheDocument();
  expect(screen.getAllByText("Version 0.1.6")).toHaveLength(2);
  expect(screen.getByText("Version 0.1.5")).toBeInTheDocument();
  expect(screen.getByText("刷新工具图标资源与映射。")).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 2, name: "修复" })).toBeInTheDocument();
  expect(screen.getByText("修复 skill 商店搜索中页面提前切换的问题。")).toBeInTheDocument();
  expect(screen.getByText("修复首次安装默认编辑器未同步到实际打开行为。")).toBeInTheDocument();
  expect(screen.getAllByRole("heading", { level: 2, name: "优化" })).toHaveLength(2);
  expect(screen.getByText("默认语言选择由 IP 改为识别系统语言规则。")).toBeInTheDocument();
  expect(screen.getAllByRole("listitem")).toHaveLength(4);

  fireEvent.click(screen.getByRole("button", { name: "Update" }));

  expect(install).toHaveBeenCalled();
  expect(screen.getByText("正在下载并安装更新...")).toBeInTheDocument();

  view.unmount();
});

test("falls back to the latest release body when structured history is unavailable", async () => {
  vi.useFakeTimers();
  const install = vi.fn().mockResolvedValue(undefined);
  vi.mocked(checkForAppUpdate).mockResolvedValue({
    available: true,
    currentVersion: "0.1.0",
    version: "0.1.1",
    body: "## 修复\n\n- 修复安装更新后偶尔没有刷新提示的问题。",
    install,
  });

  const view = render(
    <NotificationProvider>
      <AppUpdateAutoPrompt />
    </NotificationProvider>,
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });

  fireEvent.mouseEnter(screen.getByRole("button", { name: "Update" }));

  expect(screen.getAllByText("Version 0.1.1")).toHaveLength(2);
  expect(screen.getByText("修复安装更新后偶尔没有刷新提示的问题。")).toBeInTheDocument();

  view.unmount();
});

test("reports when automatic update check cannot reach the updater endpoint", async () => {
  vi.useFakeTimers();
  vi.mocked(checkForAppUpdate).mockRejectedValue(new Error("error sending request for url (https://github.com/...)"));
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const view = render(
    <NotificationProvider>
      <AppUpdateAutoPrompt />
    </NotificationProvider>,
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
  expect(warnSpy).toHaveBeenCalledWith(
    "Automatic app update check failed",
    expect.any(Error),
  );
  expect(reportFailureMock).toHaveBeenCalledWith(
    expect.any(Error),
    {
      operation: "auto_check_for_app_update",
      fallbackMessage: "updates.autoCheckFailed",
    },
  );

  view.unmount();
  warnSpy.mockRestore();
});

test("checks again on a later interval and only prompts once per version", async () => {
  vi.useFakeTimers();
  const install = vi.fn().mockResolvedValue(undefined);
  vi.mocked(checkForAppUpdate)
    .mockResolvedValueOnce({
      available: false,
      currentVersion: "0.1.6",
      releaseNotesHistory: [],
    })
    .mockResolvedValueOnce({
      available: true,
      currentVersion: "0.1.6",
      version: "0.1.7",
      body: "## 修复\n\n- 修复定时检查更新未触发的问题。",
      install,
    })
    .mockResolvedValueOnce({
      available: true,
      currentVersion: "0.1.6",
      version: "0.1.7",
      body: "## 修复\n\n- 修复定时检查更新未触发的问题。",
      install,
    });

  const view = render(
    <NotificationProvider>
      <AppUpdateAutoPrompt />
    </NotificationProvider>,
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });

  expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  });

  expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  });

  expect(vi.mocked(checkForAppUpdate)).toHaveBeenCalledTimes(3);
  expect(screen.getAllByRole("button", { name: "Update" })).toHaveLength(1);

  view.unmount();
});
