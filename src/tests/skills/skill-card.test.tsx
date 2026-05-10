import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { NotificationProvider } from "@/app/notifications";
import { SkillCard } from "@/features/skills/components/SkillCard";
import { installedSkillFixtures } from "@/features/skills/state/skill-fixtures";
import { SkillWorkspaceProvider } from "@/features/skills/state/skill-workspace";

function renderSkillCardWithProviders(skill: (typeof installedSkillFixtures)[number]) {
  return render(
    <NotificationProvider>
      <SkillWorkspaceProvider>
        <SkillCard skill={skill} />
      </SkillWorkspaceProvider>
    </NotificationProvider>,
  );
}

test("updates directly from list action when skill has remote update", async () => {
  const updateSkill = installedSkillFixtures.find((skill) => skill.name === "excalidraw-diagram");
  if (!updateSkill) {
    throw new Error("missing excalidraw-diagram fixture");
  }

  renderSkillCardWithProviders(updateSkill);
  expect(screen.getByText("excalidraw-diagram")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument();
  const updateButton = screen.getByRole("button", { name: /更新 excalidraw-diagram/ });
  expect(updateButton).toBeInTheDocument();
  await userEvent.click(updateButton);
  expect(screen.queryByRole("dialog", { name: "更新 skill" })).not.toBeInTheDocument();
  expect(screen.queryByText("将拉取提交")).not.toBeInTheDocument();
});

test("shows remote and local updated time on skill card", () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  renderSkillCardWithProviders(skill);

  expect(screen.getByText("更新时间：")).toBeInTheDocument();
  expect(screen.queryByText("远端更新时间：")).not.toBeInTheDocument();
  expect(screen.queryByText("更新人：")).not.toBeInTheDocument();
});

test("sanitizes trailing emoticon in remote updater", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "excalidraw-diagram");
  if (!skill) {
    throw new Error("missing excalidraw-diagram fixture");
  }

  renderSkillCardWithProviders({ ...skill, lastEditor: "Agent Fitz ;-)" });

  await userEvent.click(screen.getByRole("button", { name: /展开 excalidraw-diagram/ }));

  expect(screen.getByText("更新人")).toBeInTheDocument();
  expect(screen.getByText("Agent Fitz")).toBeInTheDocument();
  expect(screen.queryByText("Agent Fitz ;-)")).not.toBeInTheDocument();
});

test("opens skill file dialog from fixed action button", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  renderSkillCardWithProviders(skill);

  await userEvent.click(screen.getByRole("button", { name: /查看 drawio-diagram 文件/ }));

  expect(screen.getByRole("dialog", { name: "drawio-diagram" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
});

test("shows fixed open action button on skill card", () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  renderSkillCardWithProviders(skill);

  expect(screen.getByRole("button", { name: /打开 drawio-diagram 目录/ })).toBeInTheDocument();
});

test("uses inline confirmation before deleting a skill", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  renderSkillCardWithProviders(skill);

  await userEvent.click(screen.getByRole("button", { name: /删除 drawio-diagram/ }));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /确认删除 drawio-diagram/ })).toHaveTextContent("确认");
  expect(screen.getByText("drawio-diagram")).toBeInTheDocument();
});

test("renders enabled tool with checkmark in tool sync panel", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  renderSkillCardWithProviders(skill);

  await userEvent.click(screen.getByRole("button", { name: /展开 drawio-diagram/ }));

  expect(screen.getAllByRole("button", { name: /取消启用/ }).length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: /IntelliJ IDEA/ })).not.toBeInTheDocument();
});

test("opens GitHub source url from skill card details", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "excalidraw-diagram");
  if (!skill) {
    throw new Error("missing excalidraw-diagram fixture");
  }
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

  renderSkillCardWithProviders(skill);

  await userEvent.click(screen.getByRole("button", { name: /展开 excalidraw-diagram/ }));
  await userEvent.click(screen.getByRole("link", { name: "https://github.com/xstongxue/best-skills/tree/main" }));

  expect(openSpy).toHaveBeenCalledWith(
    "https://github.com/xstongxue/best-skills/tree/main",
    "_blank",
    "noopener,noreferrer",
  );
});
