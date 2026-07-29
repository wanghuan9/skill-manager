import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { NotificationProvider } from "@/app/notifications";
import { MarketplaceInstallPanel } from "@/features/install/components/MarketplaceInstallPanel";
import {
  fetchMarketplaceSkillDetail,
  fetchMarketplaceSkillFileBrowser,
  fetchMarketplaceSkillFileContent,
} from "@/features/skills/api/skill-client";
import { marketplaceSkillFixtures } from "@/features/skills/state/skill-fixtures";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { renderWithI18n } from "@/tests/helpers/render-with-i18n";

vi.mock("@/features/skills/api/skill-client", () => ({
  fetchMarketplaceSkillDetail: vi.fn(),
  fetchMarketplaceSkillFileBrowser: vi.fn(),
  fetchMarketplaceSkillFileContent: vi.fn(),
  openExternalLink: vi.fn(),
}));

vi.mock("@/features/skills/state/skill-workspace", () => ({
  useSkillWorkspace: vi.fn(),
}));

const mockedUseSkillWorkspace = vi.mocked(useSkillWorkspace);
const mockedFetchMarketplaceSkillDetail = vi.mocked(fetchMarketplaceSkillDetail);
const mockedFetchMarketplaceSkillFileBrowser = vi.mocked(fetchMarketplaceSkillFileBrowser);
const mockedFetchMarketplaceSkillFileContent = vi.mocked(fetchMarketplaceSkillFileContent);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchMarketplaceSkillDetail.mockImplementation(async (skill) => skill);
  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installingMarketplaceSkillIds: new Set(),
    installFromMarket: vi.fn(),
    reportGithubRateLimit: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);
  mockedFetchMarketplaceSkillFileBrowser.mockResolvedValue({
    skillName: marketplaceSkillFixtures[0].name,
    rootName: marketplaceSkillFixtures[0].name,
    initialFilePath: "SKILL.md",
    previewMode: "full",
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
        activeSourceSite="clawhub"
        sourceTabs={["skills.sh", "clawhub"]}
        marketplaceSkills={[]}
        onSourceChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        searchScope="all"
        onSearchScopeChange={vi.fn()}
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
  expect(screen.getByText("正在加载 clawhub 中的 skill，请稍等。")).toBeInTheDocument();
  expect(document.querySelectorAll(".loading-ellipsis span")).toHaveLength(3);
  expect(screen.queryByText("暂无可安装项")).not.toBeInTheDocument();
});

test("hides authors in ClawHub browse cards and resolves them in details", async () => {
  let resolveDetail: ((skill: typeof marketplaceSkillFixtures[number]) => void) | undefined;
  const detailPromise = new Promise<typeof marketplaceSkillFixtures[number]>((resolve) => {
    resolveDetail = resolve;
  });
  const browseSkill = {
    ...marketplaceSkillFixtures[2],
    id: "clawhub-release-guardian",
    maintainer: "",
    owner: "",
    topicLabel: "Marketing",
    sourceUrl: "https://clawhub.ai/skills/release-guardian",
    marketplaceUrl: "https://clawhub.ai/skills/release-guardian",
  };
  const resolvedSkill = {
    ...browseSkill,
    id: "clawhub-asleep123-release-guardian",
    maintainer: "Asleep",
    owner: "asleep123",
    avatarUrl: "https://avatars.githubusercontent.com/u/122379135?v=4",
  };
  mockedFetchMarketplaceSkillDetail.mockReturnValue(detailPromise);

  renderWithI18n(
    <NotificationProvider>
      <MarketplaceInstallPanel
        activeSourceSite="clawhub"
        sourceTabs={["skills.sh", "clawhub"]}
        marketplaceSkills={[browseSkill]}
        onSourceChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        searchScope="all"
        onSearchScopeChange={vi.fn()}
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

  expect(screen.queryByText(/作者:/)).not.toBeInTheDocument();
  expect(screen.getByText("Marketing")).toHaveClass("install-card__chip");

  await userEvent.click(screen.getByRole("heading", { name: browseSkill.name, level: 3 }));
  const detailDialog = screen.getByRole("dialog", { name: `${browseSkill.name} 详情` });

  await waitFor(() => expect(mockedFetchMarketplaceSkillFileBrowser).toHaveBeenCalled());
  resolveDetail?.(resolvedSkill);
  expect(
    await within(detailDialog).findByText("来源 clawhub · 作者 Asleep · 531.0K 次下载"),
  ).toBeInTheDocument();
  expect(mockedFetchMarketplaceSkillDetail).toHaveBeenCalledWith(browseSkill);
});

test("hides ClawHub topics in search results", () => {
  const searchSkill = {
    ...marketplaceSkillFixtures[2],
    topicLabel: "Api Integration",
  };

  renderWithI18n(
    <NotificationProvider>
      <MarketplaceInstallPanel
        activeSourceSite="clawhub"
        sourceTabs={["skills.sh", "clawhub"]}
        marketplaceSkills={[searchSkill]}
        onSourceChange={vi.fn()}
        searchQuery="youtube"
        onSearchQueryChange={vi.fn()}
        searchScope="all"
        onSearchScopeChange={vi.fn()}
        isSearching
        isSearchLoading={false}
        isInitialLoading={false}
        isLoadingMore={false}
        hasMore={false}
        installedMarketplaceSkillIds={new Set()}
        onLoadMore={vi.fn()}
      />
    </NotificationProvider>,
  );

  expect(screen.queryByText("Api Integration")).not.toBeInTheDocument();
  expect(screen.getByText("作者: release-team")).toBeInTheDocument();
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
        sourceTabs={["skills.sh", "clawhub"]}
        marketplaceSkills={[marketplaceSkillFixtures[0]]}
        onSourceChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        searchScope="all"
        onSearchScopeChange={vi.fn()}
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
    sourceSite: "skills.sh",
    sourceUrl: marketplaceSkillFixtures[0].sourceUrl,
    skillPath: "",
    skillName: "workflow-critic",
    owner: undefined,
    slug: undefined,
    version: undefined,
  });

  await userEvent.click(within(detailDialog).getByRole("button", { name: "展开 reference" }));
  await userEvent.click(within(detailDialog).getByRole("button", { name: "checklist.md" }));

  expect(await within(detailDialog).findByText("检查回归风险")).toBeInTheDocument();
  expect(mockedFetchMarketplaceSkillFileContent).toHaveBeenLastCalledWith({
    sourceSite: "skills.sh",
    sourceUrl: marketplaceSkillFixtures[0].sourceUrl,
    skillPath: "",
    relativePath: "reference/checklist.md",
    owner: undefined,
    slug: undefined,
    version: undefined,
  });
});

test("shows marketplace request failures instead of an empty result", () => {
  renderWithI18n(
    <NotificationProvider>
      <MarketplaceInstallPanel
        activeSourceSite="clawhub"
        sourceTabs={["skills.sh", "clawhub"]}
        marketplaceSkills={[]}
        onSourceChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        searchScope="all"
        onSearchScopeChange={vi.fn()}
        isSearching={false}
        isSearchLoading={false}
        isInitialLoading={false}
        isLoadingMore={false}
        hasMore={false}
        errorMessage="ClawHub 请求过于频繁，请稍后再试"
        installedMarketplaceSkillIds={new Set()}
        onLoadMore={vi.fn()}
      />
    </NotificationProvider>,
  );

  expect(screen.getByRole("alert")).toHaveTextContent("ClawHub 请求过于频繁，请稍后再试");
  expect(screen.queryByRole("heading", { name: "暂无可安装项" })).not.toBeInTheDocument();
});

test("installs a marketplace skill from the detail modal", async () => {
  const installFromMarket = vi.fn().mockResolvedValue(undefined);
  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installingMarketplaceSkillIds: new Set(),
    installFromMarket,
  } as unknown as ReturnType<typeof useSkillWorkspace>);

  renderWithI18n(
    <NotificationProvider>
      <MarketplaceInstallPanel
        activeSourceSite="skills.sh"
        sourceTabs={["skills.sh", "clawhub"]}
        marketplaceSkills={[marketplaceSkillFixtures[0]]}
        onSourceChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        searchScope="all"
        onSearchScopeChange={vi.fn()}
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
  const installButton = within(detailDialog).getByRole("button", { name: "安装" });

  expect(installButton).toHaveClass("skill-detail-modal__install-button");
  await userEvent.click(installButton);

  expect(installFromMarket).toHaveBeenCalledWith(marketplaceSkillFixtures[0]);
});

test("shows the basic preview notice when GitHub API is rate limited", async () => {
  const reportGithubRateLimit = vi.fn();
  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installingMarketplaceSkillIds: new Set(),
    installFromMarket: vi.fn(),
    reportGithubRateLimit,
  } as unknown as ReturnType<typeof useSkillWorkspace>);
  const skill = {
    ...marketplaceSkillFixtures[0],
    id: "basic-preview-skill",
    name: "basic-preview-skill",
    sourceUrl: "https://github.com/example/basic-preview-skill",
  };
  mockedFetchMarketplaceSkillFileBrowser.mockResolvedValue({
    skillName: skill.name,
    rootName: skill.name,
    initialFilePath: "SKILL.md",
    previewMode: "basic",
    entries: [
      { path: "", name: skill.name, entryType: "directory", depth: 0 },
      { path: "SKILL.md", name: "SKILL.md", entryType: "file", depth: 1 },
    ],
  });

  renderWithI18n(
    <NotificationProvider>
      <MarketplaceInstallPanel
        activeSourceSite="skills.sh"
        sourceTabs={["skills.sh", "clawhub"]}
        marketplaceSkills={[skill]}
        onSourceChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        searchScope="all"
        onSearchScopeChange={vi.fn()}
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

  expect(
    await within(detailDialog).findByText("GitHub API 受限，当前仅展示 SKILL.md / README.md。"),
  ).toBeInTheDocument();
  expect(await within(detailDialog).findByText("默认说明")).toBeInTheDocument();
  expect(reportGithubRateLimit).toHaveBeenCalledTimes(1);
});

test("reports a GitHub rate limit when the marketplace file tree fails", async () => {
  const skill = {
    ...marketplaceSkillFixtures[0],
    id: "rate-limited-tree",
    name: "rate-limited-tree",
    sourceUrl: "https://github.com/example/rate-limited-tree",
  };
  const reportGithubRateLimit = vi.fn();
  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installingMarketplaceSkillIds: new Set(),
    installFromMarket: vi.fn(),
    reportGithubRateLimit,
  } as unknown as ReturnType<typeof useSkillWorkspace>);
  mockedFetchMarketplaceSkillFileBrowser.mockRejectedValue("GitHub API 请求受限，请稍后重试");

  renderWithI18n(
    <NotificationProvider>
      <MarketplaceInstallPanel
        activeSourceSite="skills.sh"
        sourceTabs={["skills.sh", "clawhub"]}
        marketplaceSkills={[skill]}
        onSourceChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        searchScope="all"
        onSearchScopeChange={vi.fn()}
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

  expect(await within(detailDialog).findByText("GitHub API 请求受限，请稍后重试")).toBeInTheDocument();
  expect(reportGithubRateLimit).toHaveBeenCalledTimes(1);
});

test("reports a GitHub rate limit when marketplace file content fails", async () => {
  const skill = {
    ...marketplaceSkillFixtures[0],
    id: "rate-limited-content",
    name: "rate-limited-content",
    sourceUrl: "https://github.com/example/rate-limited-content",
  };
  const reportGithubRateLimit = vi.fn();
  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    installingMarketplaceSkillIds: new Set(),
    installFromMarket: vi.fn(),
    reportGithubRateLimit,
  } as unknown as ReturnType<typeof useSkillWorkspace>);
  mockedFetchMarketplaceSkillFileContent.mockRejectedValue("GitHub API request limit reached");

  renderWithI18n(
    <NotificationProvider>
      <MarketplaceInstallPanel
        activeSourceSite="skills.sh"
        sourceTabs={["skills.sh", "clawhub"]}
        marketplaceSkills={[skill]}
        onSourceChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        searchScope="all"
        onSearchScopeChange={vi.fn()}
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

  expect(await within(detailDialog).findByText("GitHub API request limit reached")).toBeInTheDocument();
  expect(reportGithubRateLimit).toHaveBeenCalledTimes(1);
});

test("shows a compact error state when the remote tree is unavailable", async () => {
  const skill = marketplaceSkillFixtures[1];
  mockedFetchMarketplaceSkillFileBrowser.mockRejectedValue("读取 GitHub 文件树失败: HTTP 404 Not Found");

  renderWithI18n(
    <NotificationProvider>
      <MarketplaceInstallPanel
        activeSourceSite="skills.sh"
        sourceTabs={["skills.sh", "clawhub"]}
        marketplaceSkills={[skill]}
        onSourceChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        searchScope="all"
        onSearchScopeChange={vi.fn()}
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
  expect(
    within(detailDialog).getByText("读取 GitHub 文件树失败: HTTP 404 Not Found"),
  ).toBeInTheDocument();
  expect(within(detailDialog).queryByText("暂时无法读取 Skill 文件。")).not.toBeInTheDocument();
});
