import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SkillListToolbar } from "@/features/skills/components/SkillListPage";
import { installedSkillFixtures } from "@/features/skills/state/skill-fixtures";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";

vi.mock("@/features/skills/state/skill-workspace", () => ({
  useSkillWorkspace: vi.fn(),
}));

const mockedUseSkillWorkspace = vi.mocked(useSkillWorkspace);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("shows update-all loading state before running the update task", async () => {
  const updateAllSkills = vi.fn().mockResolvedValue(undefined);

  mockedUseSkillWorkspace.mockReturnValue({
    installedSkills: installedSkillFixtures,
    isLoading: false,
    refreshWorkspace: vi.fn(),
    updateAllSkills,
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  render(
    <SkillListToolbar
      query=""
      statusFilter="all"
      onQueryChange={vi.fn()}
      onStatusFilterChange={vi.fn()}
      showGroupView
      onShowGroupViewChange={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "全部更新 (1)" }));

  const loadingButton = screen.getByRole("button", { name: "更新中..." });
  expect(loadingButton).toHaveClass("is-loading");
  expect(loadingButton.querySelector(".skills-toolbar-button__svg")).toHaveClass("is-spinning");
  expect(updateAllSkills).not.toHaveBeenCalled();

  await act(async () => {
    vi.advanceTimersByTime(32);
  });

  expect(updateAllSkills).toHaveBeenCalledOnce();
});

test("notifies status filter changes", () => {
  const onStatusFilterChange = vi.fn();

  mockedUseSkillWorkspace.mockReturnValue({
    installedSkills: installedSkillFixtures,
    isLoading: false,
    refreshWorkspace: vi.fn(),
    updateAllSkills: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  render(
    <SkillListToolbar
      query=""
      statusFilter="all"
      onQueryChange={vi.fn()}
      onStatusFilterChange={onStatusFilterChange}
      showGroupView
      onShowGroupViewChange={vi.fn()}
    />,
  );

  fireEvent.change(screen.getByLabelText("按状态筛选技能"), {
    target: { value: "update-available" },
  });

  expect(screen.getByRole("option", { name: "全部 (4)" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "可更新 (1)" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "已同步 (1)" })).not.toBeInTheDocument();
  expect(onStatusFilterChange).toHaveBeenCalledWith("update-available");
});
