import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { NotificationProvider } from "@/app/notifications";
import {
  AppUpdateAutoPrompt,
  resetAutoUpdatePromptStateForTests,
} from "@/features/app-update/AppUpdateAutoPrompt";
import { checkForAppUpdate } from "@/features/app-update/app-update-client";

vi.mock("@/features/app-update/app-update-client", () => ({
  checkForAppUpdate: vi.fn(),
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
    currentVersion: "0.1.0",
    version: "0.1.1",
    body: "Release notes\n- Update installs from the in-app capsule",
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
  expect(screen.getByText("Version 0.1.1")).toBeInTheDocument();
  expect(screen.getByText("- Update installs from the in-app capsule")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Update" }));

  expect(install).toHaveBeenCalled();
  expect(screen.getByText("正在下载并安装更新...")).toBeInTheDocument();

  view.unmount();
});

test("fails silently when automatic update check cannot reach the updater endpoint", async () => {
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

  view.unmount();
  warnSpy.mockRestore();
});
