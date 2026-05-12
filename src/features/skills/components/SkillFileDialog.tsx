import { useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { SkillFileEntry, SkillSummary } from "@/features/skills/state/skill-store";

type SkillFileDialogProps = {
  skill: SkillSummary;
  isOpen: boolean;
  onClose: () => void;
};

const DEFAULT_ERROR_MESSAGE = "读取 skill 文件失败，请稍后重试。";
const MARKDOWN_FILE_PATTERN = /\.(md|markdown)$/i;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type ViewMode = "edit" | "preview";

function entryIndent(entry: SkillFileEntry) {
  return {
    paddingLeft: `${16 + entry.depth * 14}px`,
  };
}

function parentDirectoryPath(path: string) {
  const slashIndex = path.lastIndexOf("/");
  if (slashIndex < 0) {
    return "";
  }
  return path.slice(0, slashIndex);
}

function collectAncestorDirectoryPaths(path: string) {
  const directories: string[] = [];
  let currentPath = parentDirectoryPath(path);

  while (currentPath) {
    directories.push(currentPath);
    currentPath = parentDirectoryPath(currentPath);
  }

  return directories;
}

function buildInitialCollapsedDirectories(entries: SkillFileEntry[], initialPath: string) {
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

function hasCollapsedAncestor(entry: SkillFileEntry, collapsedDirectories: Record<string, boolean>) {
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

export function SkillFileDialog({ skill, isOpen, onClose }: SkillFileDialogProps) {
  const { loadSkillFileBrowser, loadSkillFileContent, saveSkillFileContent } = useSkillWorkspace();
  const dialogTitleId = useId();
  const [entries, setEntries] = useState<SkillFileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [hasDirtyChanges, setHasDirtyChanges] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
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
  const isMarkdownFile = MARKDOWN_FILE_PATTERN.test(selectedPath);
  const previewDocument = useMemo(() => splitFrontmatter(content), [content]);

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

        setErrorMessage(error instanceof Error ? error.message : DEFAULT_ERROR_MESSAGE);
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
  }, [isOpen, loadSkillFileBrowser, loadSkillFileContent, skill.name]);

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
      setErrorMessage(error instanceof Error ? error.message : DEFAULT_ERROR_MESSAGE);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave() {
    if (!selectedPath) {
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
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "保存失败，请稍后重试。");
    } finally {
      setIsSaving(false);
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
            <button className="secondary-button secondary-button--compact" type="button" onClick={onClose}>
              <span aria-hidden="true">←</span>
              <span>返回</span>
            </button>
            <h3 id={dialogTitleId}>{skill.name}</h3>
          </div>
          <div className="skill-file-dialog__toolbar">
            <div className="skill-file-dialog__view-toggle" role="group" aria-label="文件视图切换">
              <button
                className={`secondary-button secondary-button--compact${viewMode === "preview" ? " is-selected" : ""}`}
                type="button"
                onClick={() => setViewMode("preview")}
              >
                预览
              </button>
              <button
                className={`secondary-button secondary-button--compact${viewMode === "edit" ? " is-selected" : ""}`}
                type="button"
                onClick={() => setViewMode("edit")}
              >
                编辑
              </button>
            </div>
            <button
              className="secondary-button secondary-button--compact"
              type="button"
              onClick={() => void handleSave()}
              disabled={!selectedPath || isSaving}
            >
              <span aria-hidden="true">⌘</span>
              <span>{isSaving ? "保存中..." : "保存"}</span>
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
                    aria-label={`${collapsedDirectories[entry.path] ? "展开" : "收起"} ${entry.name}`}
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
            <div className="skill-file-dialog__editor-header">
              <strong>{selectedPath || "暂无可编辑文件"}</strong>
              {hasDirtyChanges ? <span className="skill-file-dialog__dirty">未保存</span> : null}
            </div>
            {fileEntries.length === 0 ? (
              <div className="skill-file-dialog__empty">当前 skill 没有可编辑的文本文件。</div>
            ) : viewMode === "edit" ? (
              <textarea
                className="skill-file-dialog__textarea"
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  setHasDirtyChanges(true);
                }}
                spellCheck={false}
                disabled={isLoading || isSaving || !selectedPath}
              />
            ) : (
              <div className="skill-file-dialog__preview">
                {isMarkdownFile ? (
                  <>
                    {previewDocument.frontmatter ? (
                      <pre className="skill-file-dialog__frontmatter">
                        <code>{`---\n${previewDocument.frontmatter}\n---`}</code>
                      </pre>
                    ) : null}
                    {previewDocument.body.trim() ? (
                      <div className="skill-file-dialog__markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{previewDocument.body}</ReactMarkdown>
                      </div>
                    ) : (
                      <div className="skill-file-dialog__empty">当前 Markdown 没有可预览内容。</div>
                    )}
                  </>
                ) : (
                  <pre className="skill-file-dialog__plain-preview">{content}</pre>
                )}
              </div>
            )}
            {isLoading ? <p className="dialog-note">正在读取文件内容...</p> : null}
            {errorMessage ? <p className="dialog-error">{errorMessage}</p> : null}
          </section>
        </div>
      </div>
    </div>
  );
}
