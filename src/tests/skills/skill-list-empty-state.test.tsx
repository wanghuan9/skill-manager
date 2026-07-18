import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { SkillListPage } from "@/features/skills/components/SkillListPage";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { renderWithI18n } from "@/tests/helpers/render-with-i18n";

vi.mock("@/features/skills/state/skill-workspace", () => ({
  useSkillWorkspace: vi.fn(),
}));

const mockedUseSkillWorkspace = vi.mocked(useSkillWorkspace);

beforeEach(() => {
  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installedSkills: [],
    isLoading: false,
  } as unknown as ReturnType<typeof useSkillWorkspace>);
});

test("guides empty skill library to marketplace, git install, and local import", async () => {
  const onInstallFromMarketplace = vi.fn();
  const onInstallFromGit = vi.fn();
  const onImportFromLocal = vi.fn();

  renderWithI18n(
    <SkillListPage
      onImportFromLocal={onImportFromLocal}
      onInstallFromGit={onInstallFromGit}
      onInstallFromMarketplace={onInstallFromMarketplace}
      query=""
      statusFilter="all"
      viewMode="list"
    />,
  );

  expect(screen.getByRole("heading", { name: "还没有安装 Skill" })).toBeInTheDocument();
  expect(screen.getByText("去商店安装推荐 Skill，或通过 Git 安装、本地导入添加已有 Skill。")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "去商店安装" }));
  await userEvent.click(screen.getByRole("button", { name: "Git 安装" }));
  await userEvent.click(screen.getByRole("button", { name: "本地导入" }));

  expect(onInstallFromMarketplace).toHaveBeenCalledOnce();
  expect(onInstallFromGit).toHaveBeenCalledOnce();
  expect(onImportFromLocal).toHaveBeenCalledOnce();
});
