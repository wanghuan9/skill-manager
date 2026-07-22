import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { NotificationProvider } from "@/app/notifications";
import { SkillCard } from "@/features/skills/components/SkillCard";
import { appSettingsFixture, installedSkillFixtures } from "@/features/skills/state/skill-fixtures";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { renderWithI18n } from "@/tests/helpers/render-with-i18n";

vi.mock("@/features/skills/state/skill-workspace", () => ({
  useSkillWorkspace: vi.fn(),
}));

const mockedUseSkillWorkspace = vi.mocked(useSkillWorkspace);

let deleteSkillMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  deleteSkillMock = vi.fn().mockResolvedValue(undefined);
  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
    appSettings: {
      ...appSettingsFixture,
      skillLibraryProvider: "skilldock",
      skillLibraryPath: "/Users/demo/.skilldock/skills",
    },
    deleteSkill: deleteSkillMock,
    openSkillWithDefaultTool: vi.fn(),
    toolConfigs: [],
    updateSkill: vi.fn(),
  } as unknown as ReturnType<typeof useSkillWorkspace>);
});

test("calls delete only after the second click and shows success notification", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  renderWithI18n(
    <NotificationProvider>
      <SkillCard skill={skill} />
    </NotificationProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: /删除 drawio-diagram/ }));

  expect(deleteSkillMock).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /确认 drawio-diagram/ })).toHaveTextContent("确认");

  await userEvent.click(screen.getByRole("button", { name: /确认 drawio-diagram/ }));

  expect(deleteSkillMock).toHaveBeenCalledOnce();
  expect(deleteSkillMock).toHaveBeenCalledWith(
    "drawio-diagram",
    "/Users/demo/.skilldock/skills/drawio-diagram",
  );
  expect(await screen.findByRole("status")).toHaveTextContent("已删除 drawio-diagram");
});
