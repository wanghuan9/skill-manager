import { useEffect, useRef } from "react";
import { minimalSetup } from "codemirror";
import { Annotation, EditorState, Prec, RangeSet, RangeSetBuilder, Transaction } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, lineNumbers } from "@codemirror/view";
import { getChunks, rejectChunk, unifiedMergeView } from "@codemirror/merge";
import { useTranslate } from "@/app/i18n";
import type { GitChangeFile } from "@/features/skills/state/skill-store";

export type SkillDiffDisplayMode = "changes" | "full";

export type SkillDiffHunk = {
  key: string;
  header: string;
  lines: SkillDiffLine[];
  patch: string;
  sourceHunkIndex: number;
  staged: boolean;
};

type SkillDiffLine = {
  kind: "addition" | "context" | "deletion" | "meta";
  marker: string;
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

type SkillDiffViewProps = {
  change: GitChangeFile | null;
  content: string;
  displayMode: SkillDiffDisplayMode;
  isLoading: boolean;
  isReverting: boolean;
  isSaving: boolean;
  hasDirtyChanges: boolean;
  onContentChange: (content: string) => void;
  onDisplayModeChange: (mode: SkillDiffDisplayMode) => void;
  onSave: () => void;
  onRevertFile: () => void;
};

const externalContentSync = Annotation.define<boolean>();

function parseHunkLines(lines: string[], header: string): SkillDiffLine[] {
  const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  let oldLine = Number(range?.[1] ?? 1);
  let newLine = Number(range?.[2] ?? 1);

  return lines.map((line) => {
    const marker = line[0] ?? " ";
    const text = line.slice(1);
    if (marker === "+") {
      return { kind: "addition", marker, text, oldLine: null, newLine: newLine++ };
    }
    if (marker === "-") {
      return { kind: "deletion", marker, text, oldLine: oldLine++, newLine: null };
    }
    if (marker === "\\") {
      return { kind: "meta", marker: "", text: line, oldLine: null, newLine: null };
    }
    return {
      kind: "context",
      marker: " ",
      text: marker === " " ? text : line,
      oldLine: oldLine++,
      newLine: newLine++,
    };
  });
}

export function parseSkillDiffHunks(diff: string, staged: boolean): SkillDiffHunk[] {
  const lines = diff.split("\n");
  const hunks: SkillDiffHunk[] = [];
  let sectionStart = 0;
  let sourceHunkIndex = 0;

  for (let lineIndex = 0; lineIndex < lines.length;) {
    if (lines[lineIndex].startsWith("diff --git ")) {
      sectionStart = lineIndex;
    }
    if (!lines[lineIndex].startsWith("@@ ")) {
      lineIndex += 1;
      continue;
    }

    const hunkStart = lineIndex;
    let hunkEnd = hunkStart + 1;
    while (
      hunkEnd < lines.length
      && !lines[hunkEnd].startsWith("@@ ")
      && !lines[hunkEnd].startsWith("diff --git ")
    ) {
      hunkEnd += 1;
    }
    const previousHunkStart = lines
      .slice(sectionStart, hunkStart)
      .findIndex((line) => line.startsWith("@@ "));
    const headerEnd = previousHunkStart < 0 ? hunkStart : sectionStart + previousHunkStart;
    const headerLines = lines.slice(sectionStart, headerEnd);
    const hunkLines = lines.slice(hunkStart, hunkEnd);
    const patch = `${[...headerLines, ...hunkLines].join("\n")}\n`;
    const header = hunkLines[0];
    hunks.push({
      key: `${staged ? "staged" : "unstaged"}-${sourceHunkIndex}-${header}`,
      header,
      lines: parseHunkLines(hunkLines.slice(1), header),
      patch,
      sourceHunkIndex,
      staged,
    });
    sourceHunkIndex += 1;
    lineIndex = hunkEnd;
  }

  return hunks;
}

export function normalizeSkillChangeStatus(status: string) {
  if (status.includes("?")) {
    return "A";
  }
  if (status.includes("D")) {
    return "D";
  }
  if (status.includes("A")) {
    return "A";
  }
  if (status.includes("R")) {
    return "R";
  }
  return "M";
}

function renderMergeControl() {
  const hiddenControl = document.createElement("span");
  hiddenControl.hidden = true;
  return hiddenControl;
}

class RevertChunkGutterMarker extends GutterMarker {
  constructor(
    private readonly position: number,
    private readonly label: string,
  ) {
    super();
  }

  eq(other: GutterMarker) {
    return other instanceof RevertChunkGutterMarker && other.position === this.position;
  }

  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "skill-diff__revert-gutter";
    button.setAttribute("aria-label", this.label);
    button.title = this.label;
    button.textContent = "↶";
    button.onmousedown = (event) => {
      event.preventDefault();
      rejectChunk(view, this.position);
    };
    return button;
  }
}

function buildRevertChunkGutter(label: string) {
  return gutter({
    class: "skill-diff__revert-gutter-column",
    markers: (view) => {
      const chunkInfo = getChunks(view.state);
      if (!chunkInfo) {
        return RangeSet.empty;
      }

      const builder = new RangeSetBuilder<GutterMarker>();
      for (const chunk of chunkInfo.chunks) {
        const line = view.state.doc.lineAt(chunk.fromB).from;
        builder.add(line, line, new RevertChunkGutterMarker(chunk.fromB, label));
      }
      return builder.finish();
    },
  });
}

function SkillDiffEditor({
  change,
  content,
  displayMode,
  onContentChange,
}: {
  change: GitChangeFile;
  content: string;
  displayMode: SkillDiffDisplayMode;
  onContentChange: (content: string) => void;
}) {
  const { t } = useTranslate();
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const onContentChangeRef = useRef(onContentChange);

  useEffect(() => {
    onContentChangeRef.current = onContentChange;
  }, [onContentChange]);

  useEffect(() => {
    const editorHost = editorHostRef.current;
    if (!editorHost || change.originalContent == null || change.currentContent == null) {
      return;
    }

    const editorView = new EditorView({
      parent: editorHost,
      doc: content,
      extensions: [
        minimalSetup,
        Prec.highest(buildRevertChunkGutter(t("skill.changes.revertHunk"))),
        lineNumbers(),
        EditorState.phrases.of({
          "$ unchanged lines": t("skill.changes.unchangedLines"),
        }),
        EditorView.contentAttributes.of({
          "aria-label": t("skill.changes.editor"),
        }),
        unifiedMergeView({
          original: change.originalContent,
          collapseUnchanged: displayMode === "changes"
            ? { margin: 2, minSize: 1 }
            : undefined,
          gutter: true,
          mergeControls: () => renderMergeControl(),
        }),
        EditorView.updateListener.of((update) => {
          const isExternalSync = update.transactions.some(
            (transaction) => transaction.annotation(externalContentSync),
          );
          if (update.docChanged && !isExternalSync) {
            onContentChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    editorViewRef.current = editorView;
    const gutterContainer = editorView.dom.querySelector(".cm-gutters");
    gutterContainer?.removeAttribute("aria-hidden");
    editorView.dom.querySelector(".cm-lineNumbers")?.setAttribute("aria-hidden", "true");
    editorView.dom.querySelector(".cm-changeGutter")?.setAttribute("aria-hidden", "true");

    return () => {
      if (editorViewRef.current === editorView) {
        editorViewRef.current = null;
      }
      editorView.destroy();
    };
  }, [change.currentContent, change.originalContent, change.path, displayMode, t]);

  useEffect(() => {
    const editorView = editorViewRef.current;
    if (!editorView || editorView.state.doc.toString() === content) {
      return;
    }

    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: content },
      annotations: [externalContentSync.of(true), Transaction.addToHistory.of(false)],
    });
  }, [content]);

  return <div className="skill-diff__editor" ref={editorHostRef} />;
}

export function SkillDiffView({
  change,
  content,
  displayMode,
  isLoading,
  isReverting,
  isSaving,
  hasDirtyChanges,
  onContentChange,
  onDisplayModeChange,
  onSave,
  onRevertFile,
}: SkillDiffViewProps) {
  const { t } = useTranslate();

  if (!change) {
    return <div className="skill-file-dialog__empty">{t("skill.changes.empty")}</div>;
  }

  const canEdit = change.originalContent != null && change.currentContent != null;

  return (
    <>
      <div className="skill-file-dialog__editor-header">
        <div className="skill-file-dialog__file-identity">
          <strong title={change.path}>{change.path}</strong>
          <span className={`skill-change-status is-${normalizeSkillChangeStatus(change.status).toLowerCase()}`}>
            {normalizeSkillChangeStatus(change.status)}
          </span>
        </div>
        <div className="skill-diff__actions">
          {canEdit ? (
            <div
              className="skill-diff__display-toggle"
              role="group"
              aria-label={t("skill.changes.displayMode")}
            >
              <button
                className={displayMode === "changes" ? "is-selected" : ""}
                type="button"
                aria-pressed={displayMode === "changes"}
                onClick={() => onDisplayModeChange("changes")}
              >
                {t("skill.changes.onlyChanges")}
              </button>
              <button
                className={displayMode === "full" ? "is-selected" : ""}
                type="button"
                aria-pressed={displayMode === "full"}
                onClick={() => onDisplayModeChange("full")}
              >
                {t("skill.changes.showAll")}
              </button>
            </div>
          ) : null}
          {hasDirtyChanges ? (
            <span className="skill-file-dialog__dirty">{t("skill.files.unsaved")}</span>
          ) : null}
          {canEdit ? (
            <button
              className="secondary-button secondary-button--compact"
              type="button"
              onClick={onSave}
              disabled={isLoading || isSaving || !hasDirtyChanges}
            >
              {isSaving ? t("skill.files.saving") : t("skill.files.save")}
            </button>
          ) : null}
          <button
            className="secondary-button secondary-button--compact skill-diff__revert-file"
            type="button"
            onClick={onRevertFile}
            disabled={isLoading || isReverting}
          >
            {t("skill.changes.revertFile")}
          </button>
        </div>
      </div>
      {canEdit ? (
        <SkillDiffEditor
          change={change}
          content={content}
          displayMode={displayMode}
          onContentChange={onContentChange}
        />
      ) : (
        <div className="skill-diff skill-file-dialog__empty">
          {t("skill.changes.binaryOrEmpty")}
        </div>
      )}
    </>
  );
}
