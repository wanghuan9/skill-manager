import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";
import { AppI18nProvider } from "@/app/i18n";
import { NotificationProvider } from "@/app/notifications";
import { resetMcpImportSessionForTests } from "@/features/skills/api/skill-client";
import { SkillFileDialog } from "@/features/skills/components/SkillFileDialog";
import { installedSkillFixtures } from "@/features/skills/state/skill-fixtures";
import { SkillWorkspaceProvider, useSkillWorkspace } from "@/features/skills/state/skill-workspace";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("@/app/utils/wait-for-next-paint", () => ({
  waitForNextPaint: vi.fn(() => Promise.resolve()),
}));

const mockedInvoke = vi.mocked(invoke);

function ActiveSkillMarker({ skillName }: { skillName: string }) {
  const { markSkillAsActive } = useSkillWorkspace();
  const hasMarkedRef = useRef(false);

  useEffect(() => {
    if (hasMarkedRef.current) {
      return;
    }
    hasMarkedRef.current = true;
    markSkillAsActive(skillName);
  }, [markSkillAsActive, skillName]);

  return null;
}

function renderSkillFileDialog(skillName = "drawio-diagram") {
  const skill = installedSkillFixtures.find((item) => item.name === skillName);
  if (!skill) {
    throw new Error(`missing ${skillName} fixture`);
  }

  return render(
    <SkillWorkspaceProvider>
      <AppI18nProvider>
        <NotificationProvider>
          <SkillFileDialog skill={skill} isOpen onClose={vi.fn()} />
        </NotificationProvider>
      </AppI18nProvider>
    </SkillWorkspaceProvider>,
  );
}

beforeEach(() => {
  resetMcpImportSessionForTests();
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
      case "refresh_git_states":
        return installedSkillFixtures;
      case "list_local_skill_candidates":
        return [];
      case "list_tool_configs":
        return [];
      case "get_git_account_summary":
        return null;
      case "get_app_settings":
      case "update_app_settings":
        return {
          storagePath: "",
          defaultOpenToolId: "",
          skillInstallActivation: "apply-all-tools",
          mcpInstallActivation: "disable-all-tools",
          language: "zh-CN",
          languageSource: "auto",
        };
      case "get_skill_file_browser":
        return {
          skillName: "drawio-diagram",
          rootName: "drawio-diagram",
          initialFilePath: "SKILL.md",
          entries: [
            { path: "", name: "drawio-diagram", entryType: "directory", depth: 0 },
            { path: "reference", name: "reference", entryType: "directory", depth: 1 },
            { path: "reference/generation.md", name: "generation.md", entryType: "file", depth: 2 },
            { path: "SKILL.md", name: "SKILL.md", entryType: "file", depth: 1 },
          ],
        };
      case "get_skill_file_content":
        return {
          path: (args as { relativePath: string }).relativePath,
          content:
            (args as { relativePath: string }).relativePath === "SKILL.md"
              ? "# drawio-diagram\n\n用于根据项目上下文生成 Draw.io 图表。\n\n## 使用时机\n\n- 需要输出架构图\n- 需要输出流程图\n\n## 规范文件\n\n[生成说明](reference/generation.md)\n"
              : "reference doc",
        };
      case "save_skill_file_content":
        return {
          path: (args as { relativePath: string }).relativePath,
          content: (args as { content: string }).content,
        };
      case "refresh_local_git_state":
        return installedSkillFixtures.find((item) => item.name === "drawio-diagram");
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});

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

test("opens relative markdown links inside the skill file dialog", async () => {
  renderSkillFileDialog();

  await screen.findByRole("dialog", { name: "drawio-diagram" });

  const preview = document.querySelector(".skill-file-dialog__preview");
  if (!(preview instanceof HTMLElement)) {
    throw new Error("missing preview container");
  }
  preview.scrollTop = 120;

  await userEvent.click(screen.getByRole("link", { name: "生成说明" }));

  expect(await screen.findByText("reference doc")).toBeInTheDocument();
  expect(preview.scrollTop).toBe(0);
  expect(screen.getByRole("button", { name: "generation.md" })).toHaveClass("is-selected");
  expect(
    mockedInvoke.mock.calls.some(
      ([command, args]) =>
        command === "get_skill_file_content" &&
        (args as { relativePath: string }).relativePath === "reference/generation.md",
    ),
  ).toBe(true);
});

test("shows a close button instead of a back button in the header", async () => {
  renderSkillFileDialog();

  expect(await screen.findByRole("dialog", { name: "drawio-diagram" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "返回" })).not.toBeInTheDocument();
});

test("keeps edit mode after workspace activity rerenders the dialog", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  render(
    <SkillWorkspaceProvider>
      <AppI18nProvider>
        <NotificationProvider>
          <SkillFileDialog skill={skill} isOpen onClose={vi.fn()} />
          <ActiveSkillMarker skillName={skill.name} />
        </NotificationProvider>
      </AppI18nProvider>
    </SkillWorkspaceProvider>,
  );

  await screen.findByRole("dialog", { name: "drawio-diagram" });
  await userEvent.click(screen.getByRole("button", { name: "编辑" }));

  expect(screen.getByRole("textbox")).toBeInTheDocument();
});

test("saves the selected file with the system save shortcut", async () => {
  renderSkillFileDialog();

  await screen.findByRole("dialog", { name: "drawio-diagram" });
  await userEvent.click(screen.getByRole("button", { name: "编辑" }));

  const textbox = screen.getByRole("textbox");
  await userEvent.clear(textbox);
  await userEvent.type(textbox, "# changed");

  const event = new KeyboardEvent("keydown", {
    key: "s",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  const preventDefault = vi.spyOn(event, "preventDefault");
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
  });

  await waitFor(() => {
    expect(
      mockedInvoke.mock.calls.some(
        ([command, args]) =>
          command === "save_skill_file_content" &&
          (args as { content: string }).content === "# changed",
      ),
    ).toBe(true);
  });
  expect(preventDefault).toHaveBeenCalled();
});

test("finishes saving immediately and refreshes only the edited skill in background", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  let resolveRefresh: ((value: NonNullable<typeof skill>) => void) | null = null;
  const refreshPromise = new Promise<NonNullable<typeof skill>>((resolve) => {
    resolveRefresh = resolve;
  });

  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
      case "refresh_git_states":
        return [skill];
      case "list_local_skill_candidates":
        return [];
      case "list_tool_configs":
        return [];
      case "get_git_account_summary":
        return null;
      case "get_app_settings":
      case "update_app_settings":
        return {
          storagePath: "",
          defaultOpenToolId: "",
          skillInstallActivation: "apply-all-tools",
          mcpInstallActivation: "disable-all-tools",
          language: "zh-CN",
          languageSource: "auto",
        };
      case "get_skill_file_browser":
        return {
          skillName: skill.name,
          rootName: skill.name,
          entries: [{ path: "SKILL.md", name: "SKILL.md", entryType: "file", depth: 0 }],
          initialFilePath: "SKILL.md",
        };
      case "get_skill_file_content":
        return {
          path: "SKILL.md",
          content: "---\nname: drawio-diagram\ndescription: old\n---\nbody",
        };
      case "save_skill_file_content":
        return {
          path: "SKILL.md",
          content: "---\nname: drawio-diagram\ndescription: new\n---\nbody",
        };
      case "refresh_local_git_state":
        if ((args as { skillName: string }).skillName !== skill.name) {
          throw new Error(`Unexpected refresh target: ${(args as { skillName: string }).skillName}`);
        }
        return refreshPromise;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });

  render(
    <SkillWorkspaceProvider>
      <AppI18nProvider>
        <NotificationProvider>
          <SkillFileDialog skill={skill} isOpen onClose={vi.fn()} />
        </NotificationProvider>
      </AppI18nProvider>
    </SkillWorkspaceProvider>,
  );

  await screen.findByRole("dialog", { name: "drawio-diagram" });
  await userEvent.click(screen.getByRole("button", { name: "编辑" }));

  const textbox = screen.getByRole("textbox");
  await userEvent.clear(textbox);
  await userEvent.type(textbox, "---\nname: drawio-diagram\ndescription: new\n---\nbody");
  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  expect(
    mockedInvoke.mock.calls.some(
      ([command, args]) =>
        command === "refresh_local_git_state" &&
        (args as { skillName: string }).skillName === skill.name,
    ),
  ).toBe(true);

  await act(async () => {
    resolveRefresh?.(skill);
    await Promise.resolve();
  });
});
