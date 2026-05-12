import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { NotificationProvider } from "@/app/notifications";
import { SkillFileDialog } from "@/features/skills/components/SkillFileDialog";
import { installedSkillFixtures } from "@/features/skills/state/skill-fixtures";
import { SkillWorkspaceProvider } from "@/features/skills/state/skill-workspace";

function renderSkillFileDialog(skillName = "drawio-diagram") {
  const skill = installedSkillFixtures.find((item) => item.name === skillName);
  if (!skill) {
    throw new Error(`missing ${skillName} fixture`);
  }

  return render(
    <NotificationProvider>
      <SkillWorkspaceProvider>
        <SkillFileDialog skill={skill} isOpen onClose={vi.fn()} />
      </SkillWorkspaceProvider>
    </NotificationProvider>,
  );
}

test("keeps nested skill directories collapsed by default", async () => {
  renderSkillFileDialog();

  expect(await screen.findByRole("dialog", { name: "drawio-diagram" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开 reference" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "generation.md" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "展开 reference" }));

  expect(await screen.findByRole("button", { name: "收起 reference" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "generation.md" })).toBeInTheDocument();
});

test("switches between edit and markdown preview views", async () => {
  renderSkillFileDialog();

  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(await screen.findByText("用于根据项目上下文生成 Draw.io 图表。")).toBeInTheDocument();
  expect(screen.getByText("使用时机")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "编辑" }));

  expect(screen.getByRole("textbox")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "预览" }));

  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});
