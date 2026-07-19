import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { NotificationProvider } from "@/app/notifications";
import { ToolSyncPanel } from "@/features/skills/components/ToolSyncPanel";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { renderWithI18n } from "@/tests/helpers/render-with-i18n";

vi.mock("@/features/skills/state/skill-workspace", () => ({
  useSkillWorkspace: vi.fn(),
}));

vi.mock("@/app/utils/wait-for-next-paint", () => ({
  waitForNextPaint: vi.fn().mockResolvedValue(undefined),
}));

const mockedUseSkillWorkspace = vi.mocked(useSkillWorkspace);

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
  } as unknown as ReturnType<typeof useSkillWorkspace>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("enables all disabled tools for the current skill", async () => {
  let resolveUpdate: (() => void) | undefined;
  const setSkillAllToolStatuses = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
    resolveUpdate = () => resolve();
  }));
  const setToolSkillStatuses = vi.fn();

  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    setSkillAllToolStatuses,
    setToolSkillStatuses,
    toggleSkillTool: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <ToolSyncPanel
        skillName="drawio-diagram"
        tools={[
          { name: "Cursor", statusLabel: "已启用" },
          { name: "Codex", statusLabel: "未启用" },
          { name: "Claude Code", statusLabel: "未启用" },
        ]}
      />
    </NotificationProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "全部开启" }));

  expect(screen.getByRole("button", { name: "开启中..." })).toBeDisabled();
  expect(screen.getByRole("button", { name: "全部关闭" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "取消启用 Codex" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "取消启用 Claude Code" })).toHaveAttribute("aria-pressed", "true");
  expect(setSkillAllToolStatuses).toHaveBeenCalledTimes(1);
  resolveUpdate?.();

  await waitFor(() => {
    expect(setSkillAllToolStatuses).toHaveBeenCalledTimes(1);
  });
  expect(setSkillAllToolStatuses).toHaveBeenCalledWith({
    skillName: "drawio-diagram",
    enabled: true,
    toolNames: ["Cursor", "Codex", "Claude Code"],
  });
});

test("disables all enabled tools for the current skill", async () => {
  let resolveUpdate: (() => void) | undefined;
  const setSkillAllToolStatuses = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
    resolveUpdate = () => resolve();
  }));
  const setToolSkillStatuses = vi.fn();

  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    setSkillAllToolStatuses,
    setToolSkillStatuses,
    toggleSkillTool: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <ToolSyncPanel
        skillName="drawio-diagram"
        tools={[
          { name: "Cursor", statusLabel: "已启用" },
          { name: "Codex", statusLabel: "未启用" },
          { name: "Claude Code", statusLabel: "已同步" },
        ]}
      />
    </NotificationProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "全部关闭" }));

  expect(screen.getByRole("button", { name: "全部开启" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "关闭中..." })).toBeDisabled();
  expect(screen.getByRole("button", { name: "启用 Cursor" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "启用 Claude Code" })).toHaveAttribute("aria-pressed", "false");
  expect(setSkillAllToolStatuses).toHaveBeenCalledTimes(1);
  resolveUpdate?.();

  await waitFor(() => {
    expect(setSkillAllToolStatuses).toHaveBeenCalledTimes(1);
  });
  expect(setSkillAllToolStatuses).toHaveBeenCalledWith({
    skillName: "drawio-diagram",
    enabled: false,
    toolNames: ["Cursor", "Codex", "Claude Code"],
  });
});

test("locks bulk actions and tool pills until bulk update finishes", async () => {
  let resolveUpdate: (() => void) | undefined;
  const setSkillAllToolStatuses = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
    resolveUpdate = () => resolve();
  }));
  const setToolSkillStatuses = vi.fn();

  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    setSkillAllToolStatuses,
    setToolSkillStatuses,
    toggleSkillTool: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <ToolSyncPanel
        skillName="drawio-diagram"
        tools={[
          { name: "Cursor", statusLabel: "已启用" },
          { name: "Codex", statusLabel: "未启用" },
          { name: "Claude Code", statusLabel: "未启用" },
        ]}
      />
    </NotificationProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "全部开启" }));

  expect(setSkillAllToolStatuses).toHaveBeenCalledTimes(1);
  expect(setSkillAllToolStatuses).toHaveBeenCalledWith({
    skillName: "drawio-diagram",
    enabled: true,
    toolNames: ["Cursor", "Codex", "Claude Code"],
  });
  expect(screen.getByRole("button", { name: "开启中..." })).toBeDisabled();
  expect(screen.getByRole("button", { name: "全部关闭" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "取消启用 Cursor" })).toBeDisabled();

  resolveUpdate?.();

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "全部关闭" })).toBeEnabled();
  });
});

test("updates a single tool immediately and only disables that tool while saving", async () => {
  let resolveUpdate: (() => void) | undefined;
  const toggleSkillTool = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
    resolveUpdate = () => resolve();
  }));

  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    setSkillAllToolStatuses: vi.fn(),
    setToolSkillStatuses: vi.fn(),
    toggleSkillTool,
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <ToolSyncPanel
        skillName="drawio-diagram"
        tools={[
          { name: "Cursor", statusLabel: "已启用" },
          { name: "Codex", statusLabel: "未启用" },
          { name: "Claude Code", statusLabel: "未启用" },
        ]}
      />
    </NotificationProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "启用 Codex" }));

  expect(toggleSkillTool).toHaveBeenCalledWith({
    skillName: "drawio-diagram",
    toolName: "Codex",
    toolNames: ["Cursor", "Codex", "Claude Code"],
  });
  expect(screen.getByRole("button", { name: "取消启用 Codex" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "取消启用 Codex" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "启用 Claude Code" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "全部关闭" })).toBeDisabled();

  resolveUpdate?.();

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "取消启用 Codex" })).toBeEnabled();
  });
});

test("falls back to per-tool updates when the bulk command is unavailable", async () => {
  const setSkillAllToolStatuses = vi.fn().mockRejectedValue(
    new Error("unknown command set_skill_all_tool_statuses"),
  );
  const setToolSkillStatuses = vi.fn().mockResolvedValue(undefined);

  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    setSkillAllToolStatuses,
    setToolSkillStatuses,
    toggleSkillTool: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <ToolSyncPanel
        skillName="drawio-diagram"
        tools={[
          { name: "Cursor", statusLabel: "未启用" },
          { name: "Codex", statusLabel: "未启用" },
        ]}
      />
    </NotificationProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "全部开启" }));

  await waitFor(() => {
    expect(setToolSkillStatuses).toHaveBeenCalledTimes(2);
  });
  expect(setToolSkillStatuses).toHaveBeenNthCalledWith(1, {
    toolName: "Cursor",
    skillNames: ["drawio-diagram"],
    enabled: true,
    toolNames: ["Cursor", "Codex"],
  });
});
