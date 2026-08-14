import { useEffect, useRef } from "react";
import { minimalSetup } from "codemirror";
import {
  Annotation,
  EditorState,
  Prec,
  RangeSet,
  RangeSetBuilder,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  gutter,
  gutterLineClass,
  lineNumbers,
  lineNumberWidgetMarker,
  type BlockInfo,
} from "@codemirror/view";
import { getChunks, getOriginalDoc, rejectChunk, unifiedMergeView } from "@codemirror/merge";
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
  onRevertHunk?: (expectedContent: string, content: string) => void;
  readOnly?: boolean;
  isUpdatePreview?: boolean;
  canRevertFile?: boolean;
  emptyLabel?: string;
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
    private readonly onRevert?: (expectedContent: string, content: string) => void,
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
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "skill-diff__revert-icon");
    icon.setAttribute("viewBox", "0 0 14 14");
    icon.setAttribute("fill", "none");
    icon.setAttribute("aria-hidden", "true");
    const curve = document.createElementNS("http://www.w3.org/2000/svg", "path");
    curve.setAttribute(
      "d",
      "M4.6666 12.5h4.7917c2.1861 0 3.9583-1.7722 3.9583-3.9583s-1.7722-3.9584-3.9583-3.9584H.5",
    );
    curve.setAttribute("stroke", "currentColor");
    curve.setAttribute("stroke-width", "1");
    curve.setAttribute("stroke-linecap", "round");
    curve.setAttribute("stroke-linejoin", "round");
    const arrowTop = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrowTop.setAttribute("d", "M.5 4.5833 4.5.5");
    arrowTop.setAttribute("stroke", "currentColor");
    arrowTop.setAttribute("stroke-width", "1");
    arrowTop.setAttribute("stroke-linecap", "round");
    arrowTop.setAttribute("stroke-linejoin", "round");
    const arrowBottom = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrowBottom.setAttribute("d", "m.5 4.5833 4 3.9167");
    arrowBottom.setAttribute("stroke", "currentColor");
    arrowBottom.setAttribute("stroke-width", "1");
    arrowBottom.setAttribute("stroke-linecap", "round");
    arrowBottom.setAttribute("stroke-linejoin", "round");
    icon.append(curve, arrowTop, arrowBottom);
    button.append(icon);
    button.onmousedown = (event) => {
      event.preventDefault();
      const expectedContent = view.state.doc.toString();
      rejectChunk(view, this.position);
      this.onRevert?.(expectedContent, view.state.doc.toString());
    };
    return button;
  }
}

class AddedLineNumberMarker extends GutterMarker {
  elementClass = "skill-diff__added-line-number";
}

class DeletedLineNumberMarker extends GutterMarker {
  elementClass = "skill-diff__deleted-line-number-block";

  constructor(
    private readonly firstLineNumber: number,
    private readonly lineCount: number,
  ) {
    super();
  }

  eq(other: GutterMarker) {
    return other instanceof DeletedLineNumberMarker
      && other.firstLineNumber === this.firstLineNumber
      && other.lineCount === this.lineCount;
  }

  toDOM() {
    const container = document.createElement("span");
    for (let offset = 0; offset < this.lineCount; offset += 1) {
      const lineNumber = document.createElement("span");
      lineNumber.className = "skill-diff__deleted-line-number";
      lineNumber.textContent = String(this.firstLineNumber + offset);
      container.append(lineNumber);
    }
    return container;
  }
}

const addedLineNumberMarker = new AddedLineNumberMarker();

function buildAddedLineNumberMarkers(state: EditorState) {
  const chunkInfo = getChunks(state);
  if (!chunkInfo) {
    return RangeSet.empty;
  }

  const builder = new RangeSetBuilder<GutterMarker>();
  for (const chunk of chunkInfo.chunks) {
    if (chunk.fromB >= chunk.toB) {
      continue;
    }

    const firstPosition = Math.min(chunk.fromB, state.doc.length);
    const lastPosition = Math.max(firstPosition, Math.min(chunk.toB, state.doc.length) - 1);
    const firstLineNumber = state.doc.lineAt(firstPosition).number;
    const lastLineNumber = state.doc.lineAt(lastPosition).number;
    for (let lineNumber = firstLineNumber; lineNumber <= lastLineNumber; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      builder.add(line.from, line.from, addedLineNumberMarker);
    }
  }
  return builder.finish();
}

const addedLineNumberMarkers = StateField.define<RangeSet<GutterMarker>>({
  create: buildAddedLineNumberMarkers,
  update(markers, transaction) {
    return transaction.docChanged ? buildAddedLineNumberMarkers(transaction.state) : markers;
  },
  provide: (field) => gutterLineClass.from(field),
});

function buildDeletedLineNumberMarker(view: EditorView, block: BlockInfo) {
  const chunk = getChunks(view.state)?.chunks.find((item) => (
    item.fromB === block.from && item.fromA < item.toA
  ));
  if (!chunk) {
    return null;
  }

  const originalDoc = getOriginalDoc(view.state);
  const firstPosition = Math.min(chunk.fromA, originalDoc.length);
  const lastPosition = Math.max(firstPosition, Math.min(chunk.toA, originalDoc.length) - 1);
  const firstLineNumber = originalDoc.lineAt(firstPosition).number;
  const lastLineNumber = originalDoc.lineAt(lastPosition).number;
  return new DeletedLineNumberMarker(firstLineNumber, lastLineNumber - firstLineNumber + 1);
}

function buildDiffLineNumberExtensions() {
  return [
    addedLineNumberMarkers,
    lineNumberWidgetMarker.of((view, _widget, block) => buildDeletedLineNumberMarker(view, block)),
  ];
}

function buildRevertChunkGutter(
  label: string,
  onRevert?: (expectedContent: string, content: string) => void,
) {
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
        builder.add(line, line, new RevertChunkGutterMarker(chunk.fromB, label, onRevert));
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
  onRevertHunk,
  readOnly,
  isUpdatePreview,
}: {
  change: GitChangeFile;
  content: string;
  displayMode: SkillDiffDisplayMode;
  onContentChange: (content: string) => void;
  onRevertHunk?: (expectedContent: string, content: string) => void;
  readOnly: boolean;
  isUpdatePreview: boolean;
}) {
  const { t } = useTranslate();
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const onContentChangeRef = useRef(onContentChange);
  const onRevertHunkRef = useRef(onRevertHunk);

  useEffect(() => {
    onContentChangeRef.current = onContentChange;
  }, [onContentChange]);

  useEffect(() => {
    onRevertHunkRef.current = onRevertHunk;
  }, [onRevertHunk]);

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
        readOnly ? [] : Prec.highest(buildRevertChunkGutter(
          t("skill.changes.revertHunk"),
          (expectedContent, nextContent) => {
            onRevertHunkRef.current?.(expectedContent, nextContent);
          },
        )),
        lineNumbers(),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorState.phrases.of({
          "$ unchanged lines": t("skill.changes.unchangedLines"),
        }),
        EditorView.contentAttributes.of({
          "aria-label": t(isUpdatePreview ? "skill.updates.editor" : "skill.changes.editor"),
        }),
        unifiedMergeView({
          original: change.originalContent,
          collapseUnchanged: displayMode === "changes"
            ? { margin: 2, minSize: 1 }
            : undefined,
          gutter: true,
          mergeControls: () => renderMergeControl(),
        }),
        buildDiffLineNumberExtensions(),
        readOnly ? [] : EditorView.updateListener.of((update) => {
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
  }, [change.currentContent, change.originalContent, change.path, displayMode, isUpdatePreview, readOnly, t]);

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

  const changeStatus = normalizeSkillChangeStatus(change.status).toLowerCase();
  return <div className={`skill-diff__editor is-${changeStatus}`} ref={editorHostRef} />;
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
  onRevertHunk,
  readOnly = false,
  isUpdatePreview = false,
  canRevertFile = false,
  emptyLabel,
}: SkillDiffViewProps) {
  const { t } = useTranslate();

  if (!change) {
    return <div className="skill-file-dialog__empty">{emptyLabel ?? t("skill.changes.empty")}</div>;
  }

  const canDisplayDiff = change.originalContent != null && change.currentContent != null;
  const canEdit = canDisplayDiff && !readOnly;

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
          {canDisplayDiff ? (
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
          {canRevertFile ? (
            <button
              className="secondary-button secondary-button--compact skill-diff__revert-file"
              type="button"
              onClick={onRevertFile}
              disabled={isLoading || isReverting}
            >
              {t("skill.changes.revertFile")}
            </button>
          ) : null}
        </div>
      </div>
      {canDisplayDiff ? (
        <SkillDiffEditor
          change={change}
          content={content}
          displayMode={displayMode}
          onContentChange={onContentChange}
          onRevertHunk={onRevertHunk}
          readOnly={readOnly}
          isUpdatePreview={isUpdatePreview}
        />
      ) : (
        <div className="skill-diff skill-file-dialog__empty">
          {t("skill.changes.binaryOrEmpty")}
        </div>
      )}
    </>
  );
}
