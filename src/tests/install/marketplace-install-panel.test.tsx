import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { NotificationProvider } from "@/app/notifications";
import { MarketplaceInstallPanel } from "@/features/install/components/MarketplaceInstallPanel";
import {
  fetchMarketplaceSkillFileBrowser,
  fetchMarketplaceSkillFileContent,
} from "@/features/skills/api/skill-client";
import { marketplaceSkillFixtures } from "@/features/skills/state/skill-fixtures";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { renderWithI18n } from "@/tests/helpers/render-with-i18n";

vi.mock("@/features/skills/api/skill-client", () => ({
  fetchMarketplaceSkillFileBrowser: vi.fn(),
  fetchMarketplaceSkillFileContent: vi.fn(),
  openExternalLink: vi.fn(),
}));

vi.mock("@/features/skills/state/skill-workspace", () => ({
  useSkillWorkspace: vi.fn(),
}));

const mockedUseSkillWorkspace = vi.mocked(useSkillWorkspace);
const mockedFetchMarketplaceSkillFileBrowser = vi.mocked(fetchMarketplaceSkillFileBrowser);
const mockedFetchMarketplaceSkillFileContent = vi.mocked(fetchMarketplaceSkillFileContent);

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installingMarketplaceSkillIds: new Set(),
    installFromMarket: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);
  mockedFetchMarketplaceSkillFileBrowser.mockResolvedValue({
    skillName: marketplaceSkillFixtures[0].name,
    rootName: marketplaceSkillFixtures[0].name,
    initialFilePath: "SKILL.md",
    entries: [
      { path: "", name: marketplaceSkillFixtures[0].name, entryType: "directory", depth: 0 },
      { path: "reference", name: "reference", entryType: "directory", depth: 1 },
      { path: "reference/checklist.md", name: "checklist.md", entryType: "file", depth: 2 },
      { path: "SKILL.md", name: "SKILL.md", entryType: "file", depth: 1 },
    ],
  });
  mockedFetchMarketplaceSkillFileContent.mockImplementation(async ({ relativePath }) => ({
    path: relativePath,
    content: relativePath === "SKILL.md" ? "# workflow-critic\n\n默认说明" : "# checklist\n\n检查回归风险",
  }));
});

test("shows initialization state before an uncached marketplace source returns", () => {
  renderWithI18n(
    <NotificationProvider>
      <MarketplaceInstallPanel
        activeSourceSite="skillsmp"
        sourceTabs={["skills.sh", "skillsmp"]}
        marketplaceSkills={[]}
        onSourceChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        isSearching={false}
        isSearchLoading={false}
        isInitialLoading
        isLoadingMore={false}
        hasMore
        installedMarketplaceSkillIds={new Set()}
        onLoadMore={vi.fn()}
      />
    </NotificationProvider>,
  );

  expect(screen.getByRole("heading", { name: "正在努力加载 skill 中" })).toBeInTheDocument();
  expect(screen.getByText("正在加载 skillsmp 中的 skill，请稍等。")).toBeInTheDocument();
  expect(document.querySelectorAll(".loading-ellipsis span")).toHaveLength(3);
  expect(screen.queryByText("暂无可安装项")).not.toBeInTheDocument();
});

test("loads the complete skill tree and previews files on demand", async () => {
  let resolveInitialContent: ((document: { path: string; content: string }) => void) | undefined;
  const initialContentPromise = new Promise<{ path: string; content: string }>((resolve) => {
    resolveInitialContent = resolve;
  });
  mockedFetchMarketplaceSkillFileContent.mockImplementation(async ({ relativePath }) => {
    if (relativePath === "SKILL.md") {
      return initialContentPromise;
    }
    return {
      path: relativePath,
      content: "# checklist\n\n检查回归风险",
    };
  });

  renderWithI18n(
    <NotificationProvider>
      <MarketplaceInstallPanel
        activeSourceSite="skills.sh"
        sourceTabs={["skills.sh", "skillsmp"]}
        marketplaceSkills={[marketplaceSkillFixtures[0]]}
        onSourceChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        isSearching={false}
        isSearchLoading={false}
        isInitialLoading={false}
        isLoadingMore={false}
        hasMore={false}
        installedMarketplaceSkillIds={new Set()}
        onLoadMore={vi.fn()}
      />
    </NotificationProvider>,
  );

  await userEvent.click(screen.getByRole("heading", { name: "workflow-critic", level: 3 }));
  const detailDialog = screen.getByRole("dialog", { name: "workflow-critic 详情" });

  await waitFor(() => expect(mockedFetchMarketplaceSkillFileContent).toHaveBeenCalled());
  expect(within(detailDialog).queryByText("当前 Markdown 没有可预览内容。")).not.toBeInTheDocument();
  expect(within(detailDialog).getByText("正在读取文件内容...")).toBeInTheDocument();
  resolveInitialContent?.({ path: "SKILL.md", content: "# workflow-critic\n\n默认说明" });

  expect(await within(detailDialog).findByText("默认说明")).toBeInTheDocument();
  expect(detailDialog).toHaveClass("skill-file-dialog", "marketplace-skill-file-dialog");
  expect(detailDialog.querySelector(".skill-file-dialog__body")).toBeInTheDocument();
  expect(detailDialog.querySelector(".skill-file-dialog__sidebar")).toBeInTheDocument();
  expect(detailDialog.querySelector(".skill-file-dialog__preview")).toBeInTheDocument();
  expect(within(detailDialog).getByText("来源 skills.sh · 作者 skills.sh · 731.2K 次下载")).toBeInTheDocument();
  expect(detailDialog.querySelector(".skill-detail-modal__meta")).not.toBeInTheDocument();
  expect(within(detailDialog).getByRole("button", { name: "关闭详情" })).toHaveClass(
    "skill-detail-modal__close",
  );
  expect(within(detailDialog).queryByText(marketplaceSkillFixtures[0].description)).not.toBeInTheDocument();
  expect(within(detailDialog).getByRole("button", { name: "展开 reference" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(mockedFetchMarketplaceSkillFileBrowser).toHaveBeenCalledWith({
    sourceUrl: marketplaceSkillFixtures[0].sourceUrl,
    skillPath: "",
    skillName: "workflow-critic",
  });

  await userEvent.click(within(detailDialog).getByRole("button", { name: "展开 reference" }));
  await userEvent.click(within(detailDialog).getByRole("button", { name: "checklist.md" }));

  expect(await within(detailDialog).findByText("检查回归风险")).toBeInTheDocument();
  expect(mockedFetchMarketplaceSkillFileContent).toHaveBeenLastCalledWith({
    sourceUrl: marketplaceSkillFixtures[0].sourceUrl,
    skillPath: "",
    relativePath: "reference/checklist.md",
  });
});

test("shows a compact error state when the remote tree is unavailable", async () => {
  const skill = marketplaceSkillFixtures[1];
  mockedFetchMarketplaceSkillFileBrowser.mockRejectedValue("GitHub API 请求受限，请稍后重试");

  renderWithI18n(
    <NotificationProvider>
      <MarketplaceInstallPanel
        activeSourceSite="skills.sh"
        sourceTabs={["skills.sh", "skillsmp"]}
        marketplaceSkills={[skill]}
        onSourceChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        isSearching={false}
        isSearchLoading={false}
        isInitialLoading={false}
        isLoadingMore={false}
        hasMore={false}
        installedMarketplaceSkillIds={new Set()}
        onLoadMore={vi.fn()}
      />
    </NotificationProvider>,
  );

  await userEvent.click(screen.getByRole("heading", { name: skill.name, level: 3 }));
  const detailDialog = screen.getByRole("dialog", { name: `${skill.name} 详情` });

  expect(await within(detailDialog).findByRole("heading", { name: "Skill 介绍" })).toBeInTheDocument();
  expect(within(detailDialog).getByText("GitHub API 请求受限，请稍后重试")).toBeInTheDocument();
  expect(within(detailDialog).queryByText("暂时无法读取 Skill 文件。")).not.toBeInTheDocument();
});
