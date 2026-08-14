import { EditorView } from "@codemirror/view";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { SkillDiffView } from "@/features/skills/components/SkillDiffView";
import type { GitChangeFile } from "@/features/skills/state/skill-store";

vi.mock("@/app/i18n", () => ({
  useTranslate: () => ({ t: (key: string) => key }),
}));

function renderDiff(change: GitChangeFile, onContentChange = vi.fn(), onRevertHunk = vi.fn()) {
  function ControlledDiff() {
    const [content, setContent] = useState(change.currentContent ?? "");
    return (
      <SkillDiffView
        change={change}
        content={content}
        displayMode="changes"
        isLoading={false}
        isReverting={false}
        isSaving={false}
        hasDirtyChanges={false}
        onContentChange={(nextContent) => {
          setContent(nextContent);
          onContentChange(nextContent);
        }}
        onDisplayModeChange={vi.fn()}
        onSave={vi.fn()}
        onRevertFile={vi.fn()}
        onRevertHunk={onRevertHunk}
      />
    );
  }

  render(<ControlledDiff />);
}

test("keeps the retained EOF line unchanged when deleting the final line without a trailing newline", async () => {
  const retainedLine = "- **组件设计原则**：参见 `bp-component-design` Skill（SOLID、设计模式）";
  const originalContent = ["## 进阶", retainedLine, "11测试2"].join("\n");
  const currentContent = ["## 进阶", retainedLine].join("\n");
  const onContentChange = vi.fn();
  const onRevertHunk = vi.fn();

  renderDiff({
    path: "SKILL.md",
    status: "M",
    diff: "@@ -2,2 +2 @@\n retained line\n-11测试2",
    originalContent,
    currentContent,
  }, onContentChange, onRevertHunk);

  await waitFor(() => {
    expect(document.querySelector(".cm-deletedChunk")).toHaveTextContent("11测试2");
  });
  expect(document.querySelector(".cm-deletedChunk")).not.toHaveTextContent(retainedLine);
  expect(document.querySelector(".cm-insertedLine")).not.toBeInTheDocument();
  expect(document.querySelector(".cm-lineNumbers .skill-diff__added-line-number")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "skill.changes.revertHunk" }));

  await waitFor(() => {
    expect(onContentChange).toHaveBeenLastCalledWith(originalContent);
  });
  expect(onRevertHunk).toHaveBeenCalledWith(currentContent, originalContent);
});

test("keeps a real one-sided trailing newline visible as a change", async () => {
  const onRevertHunk = vi.fn();
  renderDiff({
    path: "SKILL.md",
    status: "M",
    diff: "@@ -1 +1 @@\n-line\n\\ No newline at end of file\n+line",
    originalContent: "line",
    currentContent: "line\n",
  }, vi.fn(), onRevertHunk);

  await waitFor(() => {
    expect(document.querySelector(".cm-changedLine")).toBeInTheDocument();
  });

  await userEvent.click(screen.getByRole("button", { name: "skill.changes.revertHunk" }));
  expect(onRevertHunk).toHaveBeenCalledWith("line\n", "line");
});

test("preserves an intentional trailing newline when replacing all editor content", async () => {
  const onContentChange = vi.fn();
  renderDiff({
    path: "SKILL.md",
    status: "M",
    diff: "@@ -1,2 +1 @@\n retained\n-removed",
    originalContent: "retained\nremoved",
    currentContent: "retained",
  }, onContentChange);

  const editor = await screen.findByRole("textbox", { name: "skill.changes.editor" });
  const editorView = EditorView.findFromDOM(editor);
  expect(editorView).not.toBeNull();
  act(() => {
    editorView?.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: "replacement\n" },
    });
  });

  await waitFor(() => {
    expect(onContentChange).toHaveBeenLastCalledWith("replacement\n");
  });
});

test("marks every line of a newly added file without creating an EOF anchor", async () => {
  renderDiff({
    path: "new.md",
    status: "A",
    diff: "@@ -0,0 +1,2 @@\n+first\n+second",
    originalContent: "",
    currentContent: "first\nsecond",
  });

  await waitFor(() => {
    expect(Array.from(
      document.querySelectorAll(".cm-lineNumbers .skill-diff__added-line-number"),
      (element) => element.textContent,
    )).toEqual(["1", "2"]);
  });
});

test("captures the editor scroll position before syncing external content", async () => {
  const change: GitChangeFile = {
    path: "SKILL.md",
    status: "M",
    diff: "@@ -1 +1 @@\n-before\n+after",
    originalContent: "before",
    currentContent: "after",
  };
  const scrollSnapshot = vi.spyOn(EditorView.prototype, "scrollSnapshot");

  function ExternalSyncDiff() {
    const [content, setContent] = useState("after");
    return (
      <>
        <button type="button" onClick={() => setContent("externally updated")}>sync</button>
        <SkillDiffView
          change={change}
          content={content}
          displayMode="changes"
          isLoading={false}
          isReverting={false}
          isSaving={false}
          hasDirtyChanges={false}
          onContentChange={vi.fn()}
          onDisplayModeChange={vi.fn()}
          onSave={vi.fn()}
          onRevertFile={vi.fn()}
        />
      </>
    );
  }

  render(<ExternalSyncDiff />);
  await screen.findByRole("textbox", { name: "skill.changes.editor" });
  scrollSnapshot.mockClear();
  await userEvent.click(screen.getByRole("button", { name: "sync" }));

  await waitFor(() => {
    expect(scrollSnapshot).toHaveBeenCalledTimes(1);
  });
  scrollSnapshot.mockRestore();
});
