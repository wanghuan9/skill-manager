import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { NotificationProvider } from "@/app/notifications";
import { MarketplaceInstallPanel } from "@/features/install/components/MarketplaceInstallPanel";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";

vi.mock("@/features/skills/state/skill-workspace", () => ({
  useSkillWorkspace: vi.fn(),
}));

const mockedUseSkillWorkspace = vi.mocked(useSkillWorkspace);

beforeEach(() => {
  mockedUseSkillWorkspace.mockReturnValue({
    installingMarketplaceSkillIds: new Set(),
    installFromMarket: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);
});

test("shows initialization state before an uncached marketplace source returns", () => {
  render(
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
