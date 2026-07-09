import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslate } from "@/app/i18n";
import { useFailureReporter } from "@/app/failure-feedback";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { SkillFileEntry, SkillSummary } from "@/features/skills/state/skill-store";

type SkillFileDialogProps = {
  skill: SkillSummary;
  isOpen: boolean;
  onClose: () => void;
};

const MARKDOWN_FILE_PATTERN = /\.(md|markdown)$/i;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type SkillFileViewMode = "edit" | "preview";

type SkillFileViewModeToggleProps = {
  viewMode: SkillFileViewMode;
  groupLabel: string;
  previewLabel: string;
  editLabel: string;
  onViewModeChange: (mode: SkillFileViewMode) => void;
};

type SkillFileContentSurfaceProps = {
  selectedPath: string;
  content: string;
  viewMode: SkillFileViewMode;
  fileEntries: SkillFileEntry[];
  isLoading: boolean;
  isSaving: boolean;
  hasDirtyChanges: boolean;
  noEditableFileLabel: string;
  unsavedLabel: string;
  emptyLabel: string;
  emptyMarkdownLabel: string;
  onContentChange: (content: string) => void;
  onSelectFile: (path: string) => void;
};

function ViewModeIcon({ mode }: { mode: SkillFileViewMode }) {
  if (mode === "preview") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M2.5 10s2.7-4.5 7.5-4.5S17.5 10 17.5 10 14.8 14.5 10 14.5 2.5 10 2.5 10Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M10 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="m7.4 6.2-3.7 3.7 3.7 3.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m12.6 6.2 3.7 3.7-3.7 3.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SkillFileViewModeToggle({
  viewMode,
  groupLabel,
  previewLabel,
  editLabel,
  onViewModeChange,
}: SkillFileViewModeToggleProps) {
  return (
    <div className="skill-file-dialog__view-toggle" role="group" aria-label={groupLabel}>
      <button
        className={`skill-file-dialog__view-toggle-button${viewMode === "preview" ? " is-selected" : ""}`}
        type="button"
        aria-label={previewLabel}
        aria-pressed={viewMode === "preview"}
        onClick={() => onViewModeChange("preview")}
      >
        <ViewModeIcon mode="preview" />
      </button>
      <button
        className={`skill-file-dialog__view-toggle-button${viewMode === "edit" ? " is-selected" : ""}`}
        type="button"
        aria-label={editLabel}
        aria-pressed={viewMode === "edit"}
        onClick={() => onViewModeChange("edit")}
      >
        <ViewModeIcon mode="edit" />
      </button>
    </div>
  );
}

export function entryIndent(entry: SkillFileEntry) {
  return {
    paddingLeft: `${16 + entry.depth * 14}px`,
  };
}

export function parentDirectoryPath(path: string) {
  const slashIndex = path.lastIndexOf("/");
  if (slashIndex < 0) {
    return "";
  }
  return path.slice(0, slashIndex);
}

export function collectAncestorDirectoryPaths(path: string) {
  const directories: string[] = [];
  let currentPath = parentDirectoryPath(path);

  while (currentPath) {
    directories.push(currentPath);
    currentPath = parentDirectoryPath(currentPath);
  }

  return directories;
}

export function buildInitialCollapsedDirectories(entries: SkillFileEntry[], initialPath: string) {
  const collapsedDirectories = entries.reduce<Record<string, boolean>>((result, entry) => {
    if (entry.entryType === "directory" && entry.depth > 0) {
      result[entry.path] = true;
    }
    return result;
  }, {});

  for (const directoryPath of collectAncestorDirectoryPaths(initialPath)) {
    collapsedDirectories[directoryPath] = false;
  }

  return collapsedDirectories;
}

export function hasCollapsedAncestor(entry: SkillFileEntry, collapsedDirectories: Record<string, boolean>) {
  let currentPath = parentDirectoryPath(entry.path);

  while (currentPath) {
    if (collapsedDirectories[currentPath]) {
      return true;
    }
    currentPath = parentDirectoryPath(currentPath);
  }

  return false;
}

function splitFrontmatter(content: string) {
  const frontmatterMatch = FRONTMATTER_PATTERN.exec(content);
  if (!frontmatterMatch) {
    return {
      frontmatter: "",
      body: content,
    };
  }

  return {
    frontmatter: frontmatterMatch[1],
    body: content.slice(frontmatterMatch[0].length),
  };
}

function normalizeSkillFilePath(path: string) {
  const segments: string[] = [];

  for (const segment of path.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return "";
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/");
}

function resolveSkillFileLinkPath(href: string, selectedPath: string, fileEntries: SkillFileEntry[]) {
  if (!href || href.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) {
    return "";
  }

  const pathWithoutHash = href.split("#")[0] ?? "";
  const pathWithoutQuery = pathWithoutHash.split("?")[0] ?? "";
  if (!pathWithoutQuery) {
    return "";
  }

  let decodedPath = pathWithoutQuery;
  try {
    decodedPath = decodeURIComponent(pathWithoutQuery);
  } catch {
    return "";
  }

  const linkPath = decodedPath.startsWith("/")
    ? decodedPath.slice(1)
    : [parentDirectoryPath(selectedPath), decodedPath].filter(Boolean).join("/");
  const normalizedPath = normalizeSkillFilePath(linkPath);
  return fileEntries.some((entry) => entry.path === normalizedPath) ? normalizedPath : "";
}

export function SkillFileContentSurface({
  selectedPath,
  content,
  viewMode,
  fileEntries,
  isLoading,
  isSaving,
  hasDirtyChanges,
  noEditableFileLabel,
  unsavedLabel,
  emptyLabel,
  emptyMarkdownLabel,
  onContentChange,
  onSelectFile,
}: SkillFileContentSurfaceProps) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const isMarkdownFile = MARKDOWN_FILE_PATTERN.test(selectedPath);
  const previewDocument = useMemo(() => splitFrontmatter(content), [content]);

  useEffect(() => {
    if (viewMode === "preview" && previewRef.current) {
      previewRef.current.scrollTop = 0;
    }
  }, [selectedPath, viewMode]);

  return (
    <>
      <div className="skill-file-dialog__editor-header">
        <strong>{selectedPath || noEditableFileLabel}</strong>
        {hasDirtyChanges ? <span className="skill-file-dialog__dirty">{unsavedLabel}</span> : null}
      </div>
      {fileEntries.length === 0 ? (
        <div className="skill-file-dialog__empty">{emptyLabel}</div>
      ) : viewMode === "edit" ? (
        <textarea
          className="skill-file-dialog__textarea"
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          spellCheck={false}
          disabled={isLoading || isSaving || !selectedPath}
        />
      ) : (
        <div className="skill-file-dialog__preview" ref={previewRef}>
          {isMarkdownFile ? (
            <>
              {previewDocument.frontmatter ? (
                <pre className="skill-file-dialog__frontmatter">
                  <code>{`---\n${previewDocument.frontmatter}\n---`}</code>
                </pre>
              ) : null}
              {previewDocument.body.trim() ? (
                <div className="skill-file-dialog__markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a({ href = "", children, node: _node, ...anchorProps }) {
                        const targetPath = resolveSkillFileLinkPath(href, selectedPath, fileEntries);

                        return (
                          <a
                            {...anchorProps}
                            href={href}
                            onClick={(event) => {
                              if (!targetPath) {
                                return;
                              }
                              event.preventDefault();
                              onSelectFile(targetPath);
                            }}
                          >
                            {children}
                          </a>
                        );
                      },
                    }}
                  >
                    {previewDocument.body}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="skill-file-dialog__empty">{emptyMarkdownLabel}</div>
              )}
            </>
          ) : (
            <pre className="skill-file-dialog__plain-preview">{content}</pre>
          )}
        </div>
      )}
    </>
  );
}

export function SkillFileDialog({ skill, isOpen, onClose }: SkillFileDialogProps) {
  const { t } = useTranslate();
  const reportFailure = useFailureReporter();
  const {
    loadSkillFileBrowser,
    loadSkillFileContent,
    markSkillAsActive,
    refreshSkillLocalGitState,
    saveSkillFileContent,
  } = useSkillWorkspace();
  const dialogTitleId = useId();
  const [entries, setEntries] = useState<SkillFileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [hasDirtyChanges, setHasDirtyChanges] = useState(false);
  const [viewMode, setViewMode] = useState<SkillFileViewMode>("preview");
  const [collapsedDirectories, setCollapsedDirectories] = useState<Record<string, boolean>>({});

  const fileEntries = useMemo(
    () => entries.filter((entry) => entry.entryType === "file"),
    [entries],
  );
  const visibleEntries = useMemo(
    () => entries.filter((entry) => entry.depth === 0 || !hasCollapsedAncestor(entry, collapsedDirectories)),
    [collapsedDirectories, entries],
  );
  const directoryChildCounts = useMemo(() => {
    const childCounts = new Map<string, number>();

    for (const entry of entries) {
      if (!entry.path) {
        continue;
      }

      const parentPath = parentDirectoryPath(entry.path);
      childCounts.set(parentPath, (childCounts.get(parentPath) ?? 0) + 1);
    }

    return childCounts;
  }, [entries]);
  const handleSave = useCallback(async () => {
    if (!selectedPath || isSaving) {
      return;
    }

    setIsSaving(true);
    setErrorMessage("");

    try {
      const document = await saveSkillFileContent({
        skillName: skill.name,
        relativePath: selectedPath,
        content,
      });
      setContent(document.content);
      setHasDirtyChanges(false);
      setIsSaving(false);
      void refreshSkillLocalGitState(skill.name).catch((error) => {
        reportFailure(error, {
          operation: "refresh_skill_local_git_state",
          fallbackMessage: t("skill.files.error.refreshState"),
          context: { skillName: skill.name },
        });
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t("skill.files.error.save"));
      setIsSaving(false);
    }
  }, [
    content,
    isSaving,
    refreshSkillLocalGitState,
    reportFailure,
    saveSkillFileContent,
    selectedPath,
    skill.name,
    t,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    markSkillAsActive(skill.name);
  }, [isOpen, markSkillAsActive, skill.name]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let active = true;

    async function loadBrowser() {
      setIsLoading(true);
      setErrorMessage("");

      try {
        const snapshot = await loadSkillFileBrowser(skill.name);
        if (!active) {
          return;
        }

        setEntries(snapshot.entries);
        const initialPath =
          snapshot.initialFilePath ?? snapshot.entries.find((entry) => entry.entryType === "file")?.path ?? "";
        setSelectedPath(initialPath);
        setCollapsedDirectories(buildInitialCollapsedDirectories(snapshot.entries, initialPath));
        setViewMode("preview");

        if (initialPath) {
          const document = await loadSkillFileContent({
            skillName: skill.name,
            relativePath: initialPath,
          });
          if (!active) {
            return;
          }
          setContent(document.content);
        } else {
          setContent("");
        }
      } catch (error) {
        if (!active) {
          return;
        }

        setErrorMessage(error instanceof Error ? error.message : t("skill.files.error.load"));
        setEntries([]);
        setSelectedPath("");
        setContent("");
      } finally {
        if (active) {
          setHasDirtyChanges(false);
          setIsLoading(false);
        }
      }
    }

    void loadBrowser();

    return () => {
      active = false;
    };
  }, [isOpen, loadSkillFileBrowser, loadSkillFileContent, skill.name, t]);

  useEffect(() => {
    if (!isOpen) {
      setEntries([]);
      setSelectedPath("");
      setContent("");
      setErrorMessage("");
      setHasDirtyChanges(false);
      setViewMode("preview");
      setCollapsedDirectories({});
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const isSaveShortcut = event.key.toLowerCase() === "s" && (event.metaKey || event.ctrlKey);
      if (!isSaveShortcut) {
        return;
      }

      event.preventDefault();
      void handleSave();
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleSave, isOpen]);

  if (!isOpen) {
    return null;
  }

  async function handleSelectFile(path: string) {
    if (path === selectedPath || isSaving) {
      return;
    }

    setIsLoading(true);
    setErrorMessage("");

    try {
      const document = await loadSkillFileContent({
        skillName: skill.name,
        relativePath: path,
      });
      setSelectedPath(path);
      setCollapsedDirectories((current) => {
        const next = { ...current };
        for (const directoryPath of collectAncestorDirectoryPaths(path)) {
          next[directoryPath] = false;
        }
        return next;
      });
      setContent(document.content);
      setHasDirtyChanges(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t("skill.files.error.load"));
    } finally {
      setIsLoading(false);
    }
  }

  function handleToggleDirectory(path: string) {
    setCollapsedDirectories((current) => ({
      ...current,
      [path]: !current[path],
    }));
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="skill-file-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="skill-file-dialog__header">
          <div className="skill-file-dialog__title">
            <h3 id={dialogTitleId}>{skill.name}</h3>
          </div>
          <div className="skill-file-dialog__toolbar">
            <div className="skill-file-dialog__actions">
              <SkillFileViewModeToggle
                viewMode={viewMode}
                groupLabel={t("skill.files.viewMode")}
                previewLabel={t("skill.files.preview")}
                editLabel={t("skill.files.edit")}
                onViewModeChange={setViewMode}
              />
              <button
                className="secondary-button secondary-button--compact"
                type="button"
                onClick={() => void handleSave()}
                disabled={!selectedPath || isSaving}
              >
                <span aria-hidden="true">⌘</span>
                <span>{isSaving ? t("skill.files.saving") : t("skill.files.save")}</span>
              </button>
            </div>
            <button className="skill-file-dialog__close" type="button" onClick={onClose} aria-label={t("skill.files.close")}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </div>
        <div className="skill-file-dialog__body">
          <aside className="skill-file-dialog__sidebar">
            {visibleEntries.map((entry) =>
              entry.entryType === "directory" ? (
                entry.depth === 0 ? (
                  <div
                    key={`${entry.path}-${entry.entryType}`}
                    className="skill-file-dialog__tree-item skill-file-dialog__tree-item--directory is-root"
                    style={entryIndent(entry)}
                  >
                    <span aria-hidden="true">⌄</span>
                    <span>{entry.name}</span>
                  </div>
                ) : (
                  <button
                    key={`${entry.path}-${entry.entryType}`}
                    className="skill-file-dialog__tree-item skill-file-dialog__tree-item--directory"
                    style={entryIndent(entry)}
                    type="button"
                    onClick={() => handleToggleDirectory(entry.path)}
                    aria-expanded={!collapsedDirectories[entry.path]}
                    aria-label={t(collapsedDirectories[entry.path] ? "skill.files.expand" : "skill.files.collapse", { name: entry.name })}
                  >
                    <span aria-hidden="true">
                      {directoryChildCounts.get(entry.path) ? (collapsedDirectories[entry.path] ? "›" : "⌄") : "•"}
                    </span>
                    <span>{entry.name}</span>
                  </button>
                )
              ) : (
                <button
                  key={entry.path}
                  className={`skill-file-dialog__tree-item skill-file-dialog__tree-item--file${
                    entry.path === selectedPath ? " is-selected" : ""
                  }`}
                  style={entryIndent(entry)}
                  type="button"
                  onClick={() => void handleSelectFile(entry.path)}
                >
                  <span aria-hidden="true">📄</span>
                  <span>{entry.name}</span>
                </button>
              ),
            )}
          </aside>
          <section className="skill-file-dialog__editor">
            <SkillFileContentSurface
              selectedPath={selectedPath}
              content={content}
              viewMode={viewMode}
              fileEntries={fileEntries}
              isLoading={isLoading}
              isSaving={isSaving}
              hasDirtyChanges={hasDirtyChanges}
              noEditableFileLabel={t("skill.files.noEditableFile")}
              unsavedLabel={t("skill.files.unsaved")}
              emptyLabel={t("skill.files.empty")}
              emptyMarkdownLabel={t("skill.files.emptyMarkdown")}
              onContentChange={(nextContent) => {
                setContent(nextContent);
                setHasDirtyChanges(true);
              }}
              onSelectFile={(path) => void handleSelectFile(path)}
            />
            {isLoading ? <p className="dialog-note">{t("skill.files.loading")}</p> : null}
            {errorMessage ? <p className="dialog-error">{errorMessage}</p> : null}
          </section>
        </div>
      </div>
    </div>
  );
}
