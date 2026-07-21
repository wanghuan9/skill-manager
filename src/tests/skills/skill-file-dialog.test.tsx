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

if (typeof Range.prototype.getClientRects !== "function") {
  Object.defineProperty(Range.prototype, "getClientRects", {
    value: () => [],
  });
}

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

function renderSkillFileDialog(
  skillName = "drawio-diagram",
  initialMode: "changes" | "files" = "files",
) {
  const skill = installedSkillFixtures.find((item) => item.name === skillName);
  if (!skill) {
    throw new Error(`missing ${skillName} fixture`);
  }

  return render(
    <SkillWorkspaceProvider>
      <AppI18nProvider>
        <NotificationProvider>
          <SkillFileDialog skill={skill} isOpen initialMode={initialMode} onClose={vi.fn()} />
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
          mcpInstallActivation: "apply-all-tools",
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
            { path: "scripts", name: "scripts", entryType: "directory", depth: 1 },
            { path: "scripts/render.ts", name: "render.ts", entryType: "file", depth: 2 },
            { path: "SKILL.md", name: "SKILL.md", entryType: "file", depth: 1 },
          ],
        };
      case "get_skill_file_content":
        if ((args as { relativePath: string }).relativePath === "scripts/render.ts") {
          return {
            path: "scripts/render.ts",
            content: "export const renderSkill = (name: string) => name;",
          };
        }
        return {
          path: (args as { relativePath: string }).relativePath,
          content:
            (args as { relativePath: string }).relativePath === "SKILL.md"
              ? [
                  "# drawio-diagram",
                  "",
                  "用于根据项目上下文生成 Draw.io 图表。",
                  "",
                  "```ts",
                  "const ready = true;",
                  "```",
                  "",
                  "## 使用时机",
                  "",
                  "- 需要输出架构图",
                  "- 需要输出流程图",
                  "",
                  "## 规范文件",
                  "",
                  "[生成说明](reference/generation.md)",
                  "",
                ].join("\n")
              : "reference doc",
        };
      case "get_skill_local_changes": {
        const diff = [
          "diff --git a/SKILL.md b/SKILL.md",
          "index 1111111..2222222 100644",
          "--- a/SKILL.md",
          "+++ b/SKILL.md",
          "@@ -1,3 +1,3 @@",
          " # drawio-diagram",
          "-old description",
          "+new description",
          " content",
        ].join("\n");
        const addedDiff = [
          "diff --git a/scripts/new.ts b/scripts/new.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/scripts/new.ts",
          "@@ -0,0 +1 @@",
          "+new file content",
        ].join("\n");
        const deletedDiff = [
          "diff --git a/references/old.md b/references/old.md",
          "deleted file mode 100644",
          "--- a/references/old.md",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-deleted file content",
        ].join("\n");
        return [
          {
            path: "SKILL.md",
            status: " M",
            diff,
            stagedDiff: "",
            unstagedDiff: diff,
            originalContent: [
              "# drawio-diagram",
              "old description",
              "content",
              "unchanged 4",
              "unchanged 5",
              "unchanged 6",
              "unchanged 7",
              "unchanged 8",
              "unchanged 9",
              "unchanged 10",
            ].join("\n"),
            currentContent: [
              "# drawio-diagram",
              "new description",
              "content",
              "unchanged 4",
              "unchanged 5",
              "unchanged 6",
              "unchanged 7",
              "unchanged 8",
              "unchanged 9",
              "unchanged 10",
            ].join("\n"),
          },
          {
            path: "scripts/new.ts",
            status: "??",
            diff: addedDiff,
            stagedDiff: "",
            unstagedDiff: addedDiff,
            originalContent: "",
            currentContent: "new file content",
          },
          {
            path: "references/old.md",
            status: "D",
            diff: deletedDiff,
            stagedDiff: "",
            unstagedDiff: deletedDiff,
            originalContent: "deleted file content",
            currentContent: "",
          },
        ];
      }
      case "revert_skill_change":
        return installedSkillFixtures.find((item) => item.name === "drawio-diagram");
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

test("edits local changes and switches between changed and full file views", async () => {
  renderSkillFileDialog();

  await userEvent.click(await screen.findByRole("button", { name: "本地变更 3" }));

  expect(screen.getByText("变更文件 3")).toBeInTheDocument();
  const changedFileButton = screen.getByRole("button", { name: "new.ts scripts" });
  expect(changedFileButton).toHaveClass("skill-file-dialog__tree-item--file");
  expect(changedFileButton.querySelector(".skill-file-dialog__tree-leading")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "old.md references" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "展开 scripts" })).not.toBeInTheDocument();
  await waitFor(() => {
    expect(document.querySelector(".cm-deletedChunk")).toHaveTextContent("old description");
  });
  expect(document.querySelector(".skill-change-status.is-a")).toBeInTheDocument();
  expect(document.querySelector(".skill-change-status.is-d")).toBeInTheDocument();
  expect(document.querySelector(".skill-change-status.is-m")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "new.ts scripts" }));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "可编辑的文件变更" })).toHaveTextContent("new file content");
  });
  expect(await screen.findByRole("button", { name: "回退此变更块" })).toBeInTheDocument();
  expect(document.querySelector(".cm-changedLineGutter")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "old.md references" }));
  await waitFor(() => {
    expect(document.querySelector(".cm-deletedChunk")).toHaveTextContent("deleted file content");
  });
  expect(await screen.findByRole("button", { name: "回退此变更块" })).toBeInTheDocument();
  expect(document.querySelector(".cm-deletedLineGutter")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "SKILL.md" }));
  const initialEditor = await screen.findByRole("textbox", { name: "可编辑的文件变更" });
  expect(initialEditor).toHaveTextContent("new description");
  const revertHunkButton = await waitFor(() => screen.getByRole("button", { name: "回退此变更块" }));
  expect(revertHunkButton).toHaveClass("skill-diff__revert-gutter");
  expect(revertHunkButton.querySelector(".skill-diff__revert-icon")).toHaveAttribute("viewBox", "0 0 14 14");
  expect(revertHunkButton.closest(".skill-diff__revert-gutter-column")).toBeInTheDocument();
  expect(document.querySelector(".cm-changedLineGutter")).toBeInTheDocument();
  expect(document.querySelector(".cm-deletedLineGutter")).toBeInTheDocument();
  expect(document.querySelectorAll(".cm-lineNumbers")).toHaveLength(1);
  const gutterClasses = Array.from(document.querySelector(".cm-gutters")?.children ?? [])
    .map((element) => element.className);
  expect(gutterClasses).toEqual([
    "cm-gutter skill-diff__revert-gutter-column",
    "cm-gutter cm-lineNumbers",
    "cm-gutter cm-changeGutter",
  ]);
  expect(screen.getByRole("button", { name: "只看变动" })).toHaveAttribute("aria-pressed", "true");
  expect(document.querySelector(".cm-collapsedLines")).toHaveTextContent(/^\d+ 行未变更$/);
  await userEvent.click(screen.getByRole("button", { name: "查看全部" }));
  expect(screen.getByRole("button", { name: "查看全部" })).toHaveAttribute("aria-pressed", "true");
  expect(document.querySelector(".cm-collapsedLines")).not.toBeInTheDocument();

  const fullViewRevertButton = await screen.findByRole("button", { name: "回退此变更块" });
  await userEvent.click(fullViewRevertButton);
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "可编辑的文件变更" })).toHaveTextContent("old description");
  });
  expect(screen.getByText("未保存")).toBeInTheDocument();

  const editor = screen.getByRole("textbox", { name: "可编辑的文件变更" });
  await userEvent.click(editor);
  await userEvent.keyboard("{End} edited");
  expect(screen.getByText("未保存")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => {
    expect(mockedInvoke).toHaveBeenCalledWith("save_skill_file_content", expect.objectContaining({
      skillName: "drawio-diagram",
      relativePath: "SKILL.md",
      content: expect.stringContaining(" edited"),
    }));
  });
});

test("opens local changes directly with the changed file content", async () => {
  renderSkillFileDialog("drawio-diagram", "changes");

  const editor = await screen.findByRole("textbox", { name: "可编辑的文件变更" });
  await waitFor(() => {
    expect(editor).toHaveTextContent("new description");
  });
  expect(editor).not.toHaveTextContent("用于根据项目上下文生成 Draw.io 图表");
  expect(document.querySelector(".cm-deletedChunk")).toHaveTextContent("old description");
});

test("cancels a requested local change revert without calling the backend", async () => {
  renderSkillFileDialog();

  await userEvent.click(await screen.findByRole("button", { name: "本地变更 3" }));
  await screen.findByRole("textbox", { name: "可编辑的文件变更" });
  await userEvent.click(screen.getByRole("button", { name: "回退文件" }));

  expect(await screen.findByRole("alertdialog", {
    name: "确定回退 SKILL.md 的全部本地修改吗？此操作无法撤销。",
  })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "取消" }));

  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(mockedInvoke).not.toHaveBeenCalledWith("revert_skill_change", expect.anything());
});

test("confirms a file-level local change revert", async () => {
  renderSkillFileDialog();

  await userEvent.click(await screen.findByRole("button", { name: "本地变更 3" }));
  await screen.findByRole("textbox", { name: "可编辑的文件变更" });
  await userEvent.click(screen.getByRole("button", { name: "回退文件" }));
  await userEvent.click(await screen.findByRole("button", { name: "确认回退" }));

  await waitFor(() => {
    expect(mockedInvoke).toHaveBeenCalledWith("revert_skill_change", {
      skillName: "drawio-diagram",
      relativePath: "SKILL.md",
      hunkIndex: null,
      expectedPatch: null,
      staged: false,
    });
  });
});

test("uses modern file icons and highlights markdown and code files", async () => {
  renderSkillFileDialog();

  await screen.findByRole("dialog", { name: "drawio-diagram" });
  const skillFileButton = screen.getByRole("button", { name: "SKILL.md" });
  const markdownCode = document.querySelector(".skill-file-dialog__markdown code.hljs");

  expect(skillFileButton).toHaveAttribute("title", "SKILL.md");
  expect(skillFileButton.querySelector("svg")).toBeInTheDocument();
  expect(screen.queryByText("📄")).not.toBeInTheDocument();
  expect(markdownCode?.querySelector(".hljs-keyword")).toHaveTextContent("const");

  await userEvent.click(screen.getByRole("button", { name: "展开 scripts" }));
  await userEvent.click(screen.getByRole("button", { name: "render.ts" }));

  await waitFor(() => {
    const codePreview = document.querySelector(".skill-file-dialog__code-preview code.language-typescript");
    expect(codePreview?.querySelector(".hljs-keyword")).toHaveTextContent("export");
  });
  expect(screen.getByText("TypeScript")).toHaveClass("skill-file-dialog__language-badge");
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
          mcpInstallActivation: "apply-all-tools",
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
