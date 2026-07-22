import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { NotificationProvider } from "@/app/notifications";
import { SkillListToolbar } from "@/features/skills/components/SkillListPage";
import { installedSkillFixtures } from "@/features/skills/state/skill-fixtures";
import type { SkillSummary } from "@/features/skills/state/skill-store";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { renderWithI18n } from "@/tests/helpers/render-with-i18n";

vi.mock("@/features/skills/state/skill-workspace", () => ({
  useSkillWorkspace: vi.fn(),
}));

const mockedUseSkillWorkspace = vi.mocked(useSkillWorkspace);

const disabledSkillFixture: SkillSummary = {
  ...installedSkillFixtures[0],
  name: "disabled-skill",
  tools: [{ name: "Codex", statusLabel: "未启用" }],
};

const pendingCommitSkillFixture: SkillSummary = {
  ...installedSkillFixtures[0],
  name: "pending-commit-skill",
  collabStatus: "pending-commit",
};

beforeEach(() => {
  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
  } as unknown as ReturnType<typeof useSkillWorkspace>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("switches between list, grouped, and card views", () => {
  const onViewModeChange = vi.fn();

  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installedSkills: installedSkillFixtures,
    isLoading: false,
    refreshWorkspace: vi.fn(),
    updateAllSkills: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <SkillListToolbar
        query=""
        statusFilter="all"
        onQueryChange={vi.fn()}
        onStatusFilterChange={vi.fn()}
        viewMode="list"
        onViewModeChange={onViewModeChange}
      />
    </NotificationProvider>,
  );

  expect(screen.getByRole("group", { name: "Skill 展示方式" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "列表" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "分组" }));
  fireEvent.click(screen.getByRole("button", { name: "卡片" }));

  expect(onViewModeChange).toHaveBeenNthCalledWith(1, "grouped");
  expect(onViewModeChange).toHaveBeenNthCalledWith(2, "grid");
});

test("offers list and card views for a tool source", () => {
  const onViewModeChange = vi.fn();

  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installedSkills: installedSkillFixtures,
    isLoading: false,
    refreshWorkspace: vi.fn(),
    updateAllSkills: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <SkillListToolbar
        activeSourceId="codex"
        query=""
        statusFilter="all"
        onQueryChange={vi.fn()}
        onStatusFilterChange={vi.fn()}
        viewMode="grouped"
        onViewModeChange={onViewModeChange}
      />
    </NotificationProvider>,
  );

  expect(screen.getByRole("button", { name: "列表" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: "分组" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("按托管方筛选 Skill")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "卡片" }));
  fireEvent.click(screen.getByRole("button", { name: "列表" }));

  expect(onViewModeChange).toHaveBeenNthCalledWith(1, "grid");
  expect(onViewModeChange).toHaveBeenNthCalledWith(2, "list");
});

test("shows update-all loading state from the workspace session", () => {
  const updateAllSkills = vi.fn().mockResolvedValue(undefined);

  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installedSkills: installedSkillFixtures,
    isLoading: false,
    isUpdatingAllSkills: true,
    refreshWorkspace: vi.fn(),
    updateAllSkills,
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <SkillListToolbar
        query=""
        statusFilter="all"
        onQueryChange={vi.fn()}
        onStatusFilterChange={vi.fn()}
        viewMode="grouped"
        onViewModeChange={vi.fn()}
      />
    </NotificationProvider>,
  );

  const loadingButton = screen.getByRole("button", { name: "更新中..." });
  expect(loadingButton).toHaveClass("is-loading");
  expect(loadingButton.querySelector(".skills-toolbar-button__svg")).toHaveClass("is-spinning");
});

test("starts update-all from the toolbar", () => {
  const updateAllSkills = vi.fn().mockResolvedValue(undefined);

  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installedSkills: installedSkillFixtures,
    isLoading: false,
    isUpdatingAllSkills: false,
    refreshWorkspace: vi.fn(),
    updateAllSkills,
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <SkillListToolbar
        query=""
        statusFilter="all"
        onQueryChange={vi.fn()}
        onStatusFilterChange={vi.fn()}
        viewMode="grouped"
        onViewModeChange={vi.fn()}
      />
    </NotificationProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "更新 (1)" }));
  expect(updateAllSkills).toHaveBeenCalledOnce();
});

test("renders go-install as the last toolbar action", () => {
  const onGoInstall = vi.fn();

  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installedSkills: installedSkillFixtures,
    isLoading: false,
    refreshWorkspace: vi.fn(),
    updateAllSkills: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <SkillListToolbar
        query=""
        statusFilter="all"
        onQueryChange={vi.fn()}
        onStatusFilterChange={vi.fn()}
        viewMode="grouped"
        onViewModeChange={vi.fn()}
        onGoInstall={onGoInstall}
      />
    </NotificationProvider>,
  );

  const installButton = screen.getByRole("button", { name: "去安装" });
  expect(installButton.parentElement?.lastElementChild).toBe(installButton);
  fireEvent.click(installButton);
  expect(onGoInstall).toHaveBeenCalledOnce();
});

test("notifies status filter changes", async () => {
  const user = userEvent.setup();
  const onStatusFilterChange = vi.fn();

  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installedSkills: [...installedSkillFixtures, disabledSkillFixture, pendingCommitSkillFixture],
    isLoading: false,
    refreshWorkspace: vi.fn(),
    updateAllSkills: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <SkillListToolbar
        query=""
        statusFilter="all"
        onQueryChange={vi.fn()}
        onStatusFilterChange={onStatusFilterChange}
        viewMode="grouped"
        onViewModeChange={vi.fn()}
      />
    </NotificationProvider>,
  );

  await user.click(screen.getByLabelText("按状态筛选技能"));

  expect(screen.getByRole("option", { name: "全部 (6)" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "可更新 (1)" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "待提交 (1)" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /冲突/ })).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "未启用 (1)" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "已同步 (1)" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("option", { name: "待提交 (1)" }));
  expect(onStatusFilterChange).toHaveBeenCalledWith("pending-commit");
});

test("filters managed skills by management owner", async () => {
  const user = userEvent.setup();
  const onOwnerFilterChange = vi.fn();
  const agentCliSkillFixture: SkillSummary = {
    ...installedSkillFixtures[0],
    name: "agent-cli-skill",
    localPath: "/Users/demo/.agents/skills/agent-cli-skill",
    managementOwner: "agent-skills-cli",
  };

  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installedSkills: [...installedSkillFixtures, agentCliSkillFixture],
    isLoading: false,
    refreshWorkspace: vi.fn(),
    updateAllSkills: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <SkillListToolbar
        query=""
        statusFilter="all"
        ownerFilter="all"
        onQueryChange={vi.fn()}
        onStatusFilterChange={vi.fn()}
        onOwnerFilterChange={onOwnerFilterChange}
        viewMode="grouped"
        onViewModeChange={vi.fn()}
      />
    </NotificationProvider>,
  );

  const statusFilter = screen.getByLabelText("按状态筛选技能");
  const ownerFilter = screen.getByLabelText("按托管方筛选 Skill");
  expect(statusFilter.compareDocumentPosition(ownerFilter)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(ownerFilter).toHaveTextContent("全部");

  await user.click(screen.getByLabelText("按托管方筛选 Skill"));

  expect(screen.getByRole("listbox", { name: "按托管方筛选 Skill" })).toHaveStyle({ width: "92px" });
  expect(screen.getByRole("option", { name: "全部" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "SkillDock" })).toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "Agent CLI" }));
  expect(onOwnerFilterChange).toHaveBeenCalledWith("agent-skills-cli");
});
