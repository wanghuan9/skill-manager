import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslate } from "@/app/i18n";
import { useFailureReporter } from "@/app/failure-feedback";
import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";
import { HighlightedCode, SkillCodePreview } from "@/features/skills/components/SkillCodePreview";
import { SkillFileTreeIcon, TreeChevronIcon } from "@/features/skills/components/SkillFileTreeIcons";
import {
  normalizeSkillChangeStatus,
  SkillDiffView,
  type SkillDiffDisplayMode,
} from "@/features/skills/components/SkillDiffView";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { GitChangeFile, SkillFileEntry, SkillSummary } from "@/features/skills/state/skill-store";
import {
  getSkillFileLanguage,
  normalizeCodeFenceLanguage,
} from "@/features/skills/utils/skill-file-language";

type SkillFileDialogProps = {
  skill: Pick<SkillSummary, "name"> & Partial<Pick<
    SkillSummary,
    "canonicalPath"
    | "gitLinked"
    | "collabStatus"
    | "localPath"
    | "localChangeCount"
    | "updateDriver"
  >>;
  isOpen: boolean;
  onClose: () => void;
  toolId?: string;
  readOnly?: boolean;
  initialMode?: SkillFilePanelMode;
};

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MARKDOWN_CODE_LANGUAGE_PATTERN = /(?:^|\s)language-([^\s]+)/i;

export type SkillFileViewMode = "edit" | "preview";
export type SkillFilePanelMode = "changes" | "files" | "updates";

type SkillRevertInput = {
  hunkIndex?: number;
  expectedPatch?: string;
  staged?: boolean;
};

type PendingSkillRevert = {
  path: string;
  confirmationKey: "skill.changes.confirmFile" | "skill.changes.confirmHunk";
  input: SkillRevertInput;
};

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

function SkillFilePanelModeToggle({
  mode,
  changeCount,
  updateCount,
  canShowChanges,
  canShowUpdates,
  onModeChange,
}: {
  mode: SkillFilePanelMode;
  changeCount: number;
  updateCount: number;
  canShowChanges: boolean;
  canShowUpdates: boolean;
  onModeChange: (mode: SkillFilePanelMode) => void;
}) {
  const { t } = useTranslate();
  return (
    <div className="skill-file-dialog__panel-toggle" role="group" aria-label={t("skill.files.panelMode")}>
      <button
        className={mode === "files" ? "is-selected" : ""}
        type="button"
        aria-pressed={mode === "files"}
        onClick={() => onModeChange("files")}
      >
        {t("skill.files.allFiles")}
      </button>
      {canShowChanges ? (
        <button
          className={mode === "changes" ? "is-selected" : ""}
          type="button"
          aria-pressed={mode === "changes"}
          onClick={() => onModeChange("changes")}
        >
          {t("skill.files.localChanges", { count: changeCount })}
        </button>
      ) : null}
      {canShowUpdates ? (
        <button
          className={mode === "updates" ? "is-selected" : ""}
          type="button"
          aria-pressed={mode === "updates"}
          onClick={() => onModeChange("updates")}
        >
          {t("skill.files.updateContents", { count: updateCount })}
        </button>
      ) : null}
    </div>
  );
}

export function entryIndent(entry: SkillFileEntry) {
  return {
    paddingLeft: `${8 + entry.depth * 12}px`,
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

type SkillFileTreeSidebarProps = {
  entries: SkillFileEntry[];
  selectedPath: string;
  collapsedDirectories: Record<string, boolean>;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
};

type SkillFileTreeItemProps = {
  entry: SkillFileEntry;
  selectedPath: string;
  expanded: boolean;
  hasChildren: boolean;
  directoryLabel: string;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
};

function SkillFileTreeItem({
  entry,
  selectedPath,
  expanded,
  hasChildren,
  directoryLabel,
  onToggleDirectory,
  onSelectFile,
}: SkillFileTreeItemProps) {
  const isRoot = entry.depth === 0;
  const isDirectory = entry.entryType === "directory";
  const isSelected = entry.path === selectedPath;
  const content = (
    <>
      <span className="skill-file-dialog__tree-leading" aria-hidden="true">
        <TreeChevronIcon expanded={expanded} visible={isRoot || (isDirectory && hasChildren)} />
        <SkillFileTreeIcon entry={entry} expanded={expanded} />
      </span>
      <span className="skill-file-dialog__tree-label">{entry.name}</span>
    </>
  );

  if (isRoot) {
    return (
      <div
        className="skill-file-dialog__tree-item skill-file-dialog__tree-item--directory is-root"
        style={entryIndent(entry)}
        title={entry.name}
      >
        {content}
      </div>
    );
  }
  if (isDirectory) {
    return (
      <button
        className="skill-file-dialog__tree-item skill-file-dialog__tree-item--directory"
        style={entryIndent(entry)}
        type="button"
        title={entry.path}
        onClick={() => onToggleDirectory(entry.path)}
        aria-expanded={expanded}
        aria-label={directoryLabel}
      >
        {content}
      </button>
    );
  }
  return (
    <button
      className={`skill-file-dialog__tree-item skill-file-dialog__tree-item--file${isSelected ? " is-selected" : ""}`}
      style={entryIndent(entry)}
      type="button"
      title={entry.path}
      aria-current={isSelected ? "true" : undefined}
      onClick={() => onSelectFile(entry.path)}
    >
      {content}
    </button>
  );
}

export function SkillFileTreeSidebar({
  entries,
  selectedPath,
  collapsedDirectories,
  onToggleDirectory,
  onSelectFile,
}: SkillFileTreeSidebarProps) {
  const { t } = useTranslate();
  const visibleEntries = useMemo(
    () =>
      entries.filter(
        (entry) => entry.depth === 0 || !hasCollapsedAncestor(entry, collapsedDirectories),
      ),
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

  return (
    <aside className="skill-file-dialog__sidebar">
      {visibleEntries.map((entry) => {
        const expanded = entry.depth === 0 || !collapsedDirectories[entry.path];
        const hasChildren = (directoryChildCounts.get(entry.path) ?? 0) > 0;
        const directoryLabel = entry.entryType === "directory" && entry.depth > 0
          ? t(expanded ? "skill.files.collapse" : "skill.files.expand", { name: entry.name })
          : "";
        return (
          <SkillFileTreeItem
            key={`${entry.path}-${entry.entryType}`}
            entry={entry}
            selectedPath={selectedPath}
            expanded={expanded}
            hasChildren={hasChildren}
            directoryLabel={directoryLabel}
            onToggleDirectory={onToggleDirectory}
            onSelectFile={onSelectFile}
          />
        );
      })}
    </aside>
  );
}

function SkillChangeTreeSidebar({
  changes,
  isLoading,
  loadingLabel,
  selectedPath,
  onSelectFile,
}: {
  changes: GitChangeFile[];
  isLoading?: boolean;
  loadingLabel?: string;
  selectedPath: string;
  onSelectFile: (path: string) => void;
}) {
  const { t } = useTranslate();
  return (
    <aside className="skill-file-dialog__sidebar skill-change-tree">
      <div className="skill-change-tree__header">
        <TreeChevronIcon expanded visible />
        <strong aria-live="polite">
          {isLoading ? loadingLabel : t("skill.changes.treeTitle", { count: changes.length })}
        </strong>
      </div>
      {changes.map((change) => {
        const name = change.path.split("/").at(-1) ?? change.path;
        const parentPath = parentDirectoryPath(change.path);
        const status = normalizeSkillChangeStatus(change.status);
        const entry: SkillFileEntry = {
          path: change.path,
          name,
          entryType: "file",
          depth: 1,
        };
        return (
          <button
            className={`skill-file-dialog__tree-item skill-file-dialog__tree-item--file skill-change-tree__file${
              change.path === selectedPath ? " is-selected" : ""
            }`}
            style={entryIndent(entry)}
            type="button"
            key={change.path}
            title={change.path}
            aria-label={[name, parentPath].filter(Boolean).join(" ")}
            aria-current={change.path === selectedPath ? "true" : undefined}
            onClick={() => onSelectFile(change.path)}
          >
            <span className="skill-file-dialog__tree-leading" aria-hidden="true">
              <TreeChevronIcon expanded={false} visible={false} />
              <SkillFileTreeIcon entry={entry} expanded={false} />
            </span>
            <span className="skill-change-tree__name">{name}</span>
            {parentPath ? <span className="skill-change-tree__parent">{parentPath}</span> : null}
            <span className={`skill-change-status is-${status.toLowerCase()}`}>{status}</span>
          </button>
        );
      })}
    </aside>
  );
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
  const fileLanguage = useMemo(() => getSkillFileLanguage(selectedPath), [selectedPath]);
  const isMarkdownFile = fileLanguage?.kind === "markdown";
  const previewDocument = useMemo(() => splitFrontmatter(content), [content]);

  useEffect(() => {
    if (viewMode === "preview" && previewRef.current) {
      previewRef.current.scrollTop = 0;
    }
  }, [selectedPath, viewMode]);

  return (
    <>
      <div className="skill-file-dialog__editor-header">
        <div className="skill-file-dialog__file-identity">
          <strong title={selectedPath}>{selectedPath || noEditableFileLabel}</strong>
          {fileLanguage ? (
            <span className="skill-file-dialog__language-badge" data-kind={fileLanguage.kind}>
              {fileLanguage.label}
            </span>
          ) : null}
        </div>
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
          {isLoading ? null : isMarkdownFile ? (
            <>
              {previewDocument.frontmatter ? (
                <pre className="skill-file-dialog__frontmatter">
                  <HighlightedCode
                    content={`---\n${previewDocument.frontmatter}\n---`}
                    language="yaml"
                    className="language-yaml"
                  />
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
                      code({ className = "", children, node: _node, ...codeProps }) {
                        const declaredLanguage = MARKDOWN_CODE_LANGUAGE_PATTERN.exec(className)?.[1] ?? "";
                        const language = normalizeCodeFenceLanguage(declaredLanguage);
                        if (!language) {
                          return <code {...codeProps} className={className}>{children}</code>;
                        }
                        const source = String(children).replace(/\n$/, "");
                        return <HighlightedCode content={source} language={language} className={className} />;
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
            fileLanguage?.kind === "text" || !fileLanguage ? (
              <pre className="skill-file-dialog__plain-preview">{content}</pre>
            ) : (
              <SkillCodePreview path={selectedPath} content={content} />
            )
          )}
        </div>
      )}
    </>
  );
}

export function SkillFileDialog({
  skill,
  isOpen,
  onClose,
  toolId,
  readOnly = false,
  initialMode = "files",
}: SkillFileDialogProps) {
  const { t } = useTranslate();
  const reportFailure = useFailureReporter();
  const {
    loadSkillFileBrowser,
    loadSkillFileContent,
    loadSkillLocalChanges,
    loadSkillUpdatePreview,
    loadToolSkillFileBrowser,
    loadToolSkillFileContent,
    markSkillAsActive,
    refreshSkillLocalGitState,
    revertSkillChange,
    saveSkillFileContent,
  } = useSkillWorkspace();
  const dialogTitleId = useId();
  const revertConfirmationId = useId();
  const [entries, setEntries] = useState<SkillFileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [content, setContent] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isChangesLoading, setIsChangesLoading] = useState(false);
  const [isUpdatesLoading, setIsUpdatesLoading] = useState(false);
  const [isReverting, setIsReverting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [hasDirtyChanges, setHasDirtyChanges] = useState(false);
  const [panelMode, setPanelMode] = useState<SkillFilePanelMode>(initialMode);
  const [viewMode, setViewMode] = useState<SkillFileViewMode>("preview");
  const [diffDisplayMode, setDiffDisplayMode] = useState<SkillDiffDisplayMode>("changes");
  const [collapsedDirectories, setCollapsedDirectories] = useState<Record<string, boolean>>({});
  const [changeFiles, setChangeFiles] = useState<GitChangeFile[]>([]);
  const [updateFiles, setUpdateFiles] = useState<GitChangeFile[]>([]);
  const [hasLoadedBrowser, setHasLoadedBrowser] = useState(false);
  const [hasLoadedUpdates, setHasLoadedUpdates] = useState(false);
  const [updatesRefreshVersion, setUpdatesRefreshVersion] = useState(0);
  const [changesRefreshVersion, setChangesRefreshVersion] = useState(0);
  const [browserRefreshVersion, setBrowserRefreshVersion] = useState(0);
  const [pendingRevert, setPendingRevert] = useState<PendingSkillRevert | null>(null);
  const canUseChanges = Boolean(skill.gitLinked) && !toolId && !readOnly;
  const canUseUpdatePreview = (
    Boolean(skill.gitLinked)
    || skill.updateDriver === "agent-skills-cli"
    || skill.updateDriver === "clawhub"
  )
    && !toolId
    && !readOnly;
  const hasLocalChanges = skill.localChangeCount == null || skill.localChangeCount > 0;
  const showChangesTab = canUseChanges
    && (hasLocalChanges || initialMode === "changes");
  const canShowUpdates = canUseUpdatePreview
    && (skill.collabStatus === "update-available" || initialMode === "updates");
  const activeChangeFiles = panelMode === "updates" ? updateFiles : changeFiles;
  const skillPath = skill.canonicalPath ?? skill.localPath ?? "";

  const fileEntries = useMemo(
    () => entries.filter((entry) => entry.entryType === "file"),
    [entries],
  );
  const selectedChange = useMemo(
    () => activeChangeFiles.find((change) => change.path === selectedPath) ?? null,
    [activeChangeFiles, selectedPath],
  );
  const handleContentChange = useCallback((nextContent: string) => {
    setContent(nextContent);
    setHasDirtyChanges(true);
  }, []);
  const handleSave = useCallback(async () => {
    if (
      readOnly
      || panelMode === "updates"
      || !selectedPath
      || isSaving
      || (panelMode === "changes" && selectedChange?.currentContent == null)
    ) {
      return;
    }

    setIsSaving(true);
    setErrorMessage("");

    try {
      const document = await saveSkillFileContent({
        skillName: skill.name,
        skillPath,
        relativePath: selectedPath,
        content,
      });
      setContent(document.content);
      setHasDirtyChanges(false);
      setChangesRefreshVersion((current) => current + 1);
      setIsSaving(false);
      void refreshSkillLocalGitState(skill.name, skillPath).catch((error) => {
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
    panelMode,
    refreshSkillLocalGitState,
    readOnly,
    reportFailure,
    saveSkillFileContent,
    selectedChange,
    selectedPath,
    skillPath,
    skill.name,
    t,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (!toolId) {
      markSkillAsActive(skill.name);
    }
  }, [isOpen, markSkillAsActive, skill.name, toolId]);

  useEffect(() => {
    if (!isOpen || panelMode !== "files" || hasLoadedBrowser) {
      return;
    }

    let active = true;

    async function loadBrowser() {
      setIsLoading(true);
      setErrorMessage("");

      try {
        const snapshot = toolId
          ? await loadToolSkillFileBrowser({ toolId, skillName: skill.name })
          : await loadSkillFileBrowser(skill.name, skillPath);
        if (!active) {
          return;
        }

        setEntries(snapshot.entries);
        const initialPath =
          snapshot.initialFilePath ?? snapshot.entries.find((entry) => entry.entryType === "file")?.path ?? "";
        setSelectedFilePath(initialPath);
        setCollapsedDirectories(buildInitialCollapsedDirectories(snapshot.entries, initialPath));
        setViewMode("preview");
        setSelectedPath(initialPath);

        if (initialPath) {
          const document = toolId
            ? await loadToolSkillFileContent({
                toolId,
                skillName: skill.name,
                relativePath: initialPath,
              })
            : await loadSkillFileContent({
                skillName: skill.name,
                skillPath,
                relativePath: initialPath,
              });
          if (!active) {
            return;
          }
          setContent(document.content);
        } else {
          setContent("");
        }
        setHasLoadedBrowser(true);
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
  }, [
    isOpen,
    browserRefreshVersion,
    hasLoadedBrowser,
    loadSkillFileBrowser,
    loadSkillFileContent,
    loadToolSkillFileBrowser,
    loadToolSkillFileContent,
    panelMode,
    skill.name,
    skillPath,
    t,
    toolId,
  ]);

  useEffect(() => {
    if (!isOpen || !showChangesTab || panelMode === "updates") {
      return;
    }

    let active = true;
    async function loadChanges() {
      setIsChangesLoading(true);
      try {
        const changes = await loadSkillLocalChanges(skill.name, skillPath);
        if (!active) {
          return;
        }
        setChangeFiles(changes);
      } catch (error) {
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : t("skill.changes.error.load"));
          setChangeFiles([]);
        }
      } finally {
        if (active) {
          setIsChangesLoading(false);
        }
      }
    }

    void loadChanges();
    return () => {
      active = false;
    };
  }, [changesRefreshVersion, isOpen, loadSkillLocalChanges, panelMode, showChangesTab, skill.name, t]);

  useEffect(() => {
    if (
      !isOpen
      || panelMode !== "updates"
      || !canShowUpdates
      || hasLoadedUpdates
    ) {
      return;
    }

    let active = true;
    async function loadUpdates() {
      setIsUpdatesLoading(true);
      setErrorMessage("");
      try {
        await waitForNextPaint();
        const preview = await loadSkillUpdatePreview(skill.name, skillPath);
        if (!active) {
          return;
        }
        setUpdateFiles(preview.changedFiles);
        setHasLoadedUpdates(true);
      } catch (error) {
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : t("skill.updates.error.load"));
          setUpdateFiles([]);
        }
      } finally {
        if (active) {
          setIsUpdatesLoading(false);
        }
      }
    }

    void loadUpdates();
    return () => {
      active = false;
    };
  }, [
    canShowUpdates,
    hasLoadedUpdates,
    isOpen,
    loadSkillUpdatePreview,
    panelMode,
    skillPath,
    skill.name,
    t,
    updatesRefreshVersion,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    if (panelMode === "files") {
      setSelectedPath(selectedFilePath);
      return;
    }

    const currentChangeExists = activeChangeFiles.some((change) => change.path === selectedPath);
    if (!currentChangeExists) {
      const nextChange = activeChangeFiles[0];
      setSelectedPath(nextChange?.path ?? "");
      if (!hasDirtyChanges && nextChange?.currentContent != null) {
        setContent(nextChange.currentContent);
      }
    }
  }, [activeChangeFiles, hasDirtyChanges, isOpen, panelMode, selectedFilePath, selectedPath]);

  useEffect(() => {
    if (
      panelMode !== "files"
      && selectedChange?.currentContent != null
      && !hasDirtyChanges
    ) {
      setContent(selectedChange.currentContent);
    }
  }, [hasDirtyChanges, panelMode, selectedChange?.currentContent, selectedChange?.path]);

  useEffect(() => {
    if (!isOpen) {
      setEntries([]);
      setSelectedPath("");
      setSelectedFilePath("");
      setContent("");
      setErrorMessage("");
      setHasDirtyChanges(false);
      setViewMode("preview");
      setDiffDisplayMode("changes");
      setPanelMode(initialMode);
      setCollapsedDirectories({});
      setChangeFiles([]);
      setUpdateFiles([]);
      setHasLoadedBrowser(false);
      setHasLoadedUpdates(false);
      setUpdatesRefreshVersion(0);
      setPendingRevert(null);
    }
  }, [initialMode, isOpen]);

  useEffect(() => {
    if (
      pendingRevert
      && (panelMode !== "changes" || selectedChange?.path !== pendingRevert.path)
    ) {
      setPendingRevert(null);
    }
  }, [panelMode, pendingRevert, selectedChange?.path]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (pendingRevert) {
          setPendingRevert(null);
        } else {
          onClose();
        }
        return;
      }

      const isSaveShortcut = event.key.toLowerCase() === "s" && (event.metaKey || event.ctrlKey);
      if (readOnly || panelMode === "updates" || !isSaveShortcut) {
        return;
      }

      event.preventDefault();
      void handleSave();
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleSave, isOpen, onClose, panelMode, pendingRevert, readOnly]);

  if (!isOpen) {
    return null;
  }

  async function handleSelectFile(path: string) {
    if (path === selectedPath || isSaving) {
      return;
    }
    if (hasDirtyChanges) {
      setErrorMessage(t("skill.files.saveBeforeSwitch"));
      return;
    }

    if (panelMode !== "files") {
      const change = activeChangeFiles.find((item) => item.path === path);
      setContent(change?.currentContent ?? "");
      setSelectedPath(path);
      return;
    }

    setIsLoading(true);
    setErrorMessage("");

    try {
      const document = toolId
        ? await loadToolSkillFileContent({
            toolId,
            skillName: skill.name,
            relativePath: path,
          })
        : await loadSkillFileContent({
            skillName: skill.name,
            skillPath,
            relativePath: path,
          });
      setSelectedPath(path);
      setSelectedFilePath(path);
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

  function handlePanelModeChange(mode: SkillFilePanelMode) {
    const modeUnavailable = (mode === "changes" && !showChangesTab)
      || (mode === "updates" && !canShowUpdates);
    if (mode === panelMode || modeUnavailable) {
      return;
    }
    if (hasDirtyChanges) {
      setErrorMessage(t("skill.files.saveBeforeSwitch"));
      return;
    }
    setErrorMessage("");
    if (mode === "files") {
      setSelectedPath(selectedFilePath);
    } else {
      const targetChanges = mode === "updates" ? updateFiles : changeFiles;
      const currentChangeExists = targetChanges.some((change) => change.path === selectedPath);
      const nextChange = currentChangeExists
        ? targetChanges.find((change) => change.path === selectedPath)
        : targetChanges[0];
      setSelectedPath(nextChange?.path ?? "");
      setContent(nextChange?.currentContent ?? "");
    }
    setPanelMode(mode);
  }

  function handleRequestRevert(input: SkillRevertInput) {
    if (!selectedChange || isReverting) {
      return;
    }

    setPendingRevert({
      path: selectedChange.path,
      confirmationKey: input.hunkIndex === undefined
        ? "skill.changes.confirmFile"
        : "skill.changes.confirmHunk",
      input,
    });
  }

  async function handleConfirmRevert() {
    if (!pendingRevert || isReverting) {
      return;
    }

    setIsReverting(true);
    setErrorMessage("");
    try {
      await revertSkillChange({
        skillName: skill.name,
        skillPath,
        relativePath: pendingRevert.path,
        ...pendingRevert.input,
      });
      setChangesRefreshVersion((current) => current + 1);
      setHasLoadedBrowser(false);
      setBrowserRefreshVersion((current) => current + 1);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t("skill.changes.error.revert"));
    } finally {
      setIsReverting(false);
      setPendingRevert(null);
    }
  }

  function handleClose() {
    setPendingRevert(null);
    onClose();
  }

  return (
    <div className="dialog-backdrop skill-file-dialog-backdrop" role="presentation" onClick={handleClose}>
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
            {showChangesTab || canShowUpdates ? (
              <SkillFilePanelModeToggle
                mode={panelMode}
                changeCount={changeFiles.length}
                updateCount={updateFiles.length}
                canShowChanges={showChangesTab}
                canShowUpdates={canShowUpdates}
                onModeChange={handlePanelModeChange}
              />
            ) : null}
          </div>
          <div className="skill-file-dialog__toolbar">
            {!readOnly && panelMode === "files" ? (
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
            ) : null}
            <button className="skill-file-dialog__close" type="button" onClick={handleClose} aria-label={t("skill.files.close")}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </div>
        <div className="skill-file-dialog__body">
          {panelMode !== "files" ? (
            <SkillChangeTreeSidebar
              changes={activeChangeFiles}
              isLoading={panelMode === "updates" && isUpdatesLoading}
              loadingLabel={t("skill.updates.loading")}
              selectedPath={selectedPath}
              onSelectFile={(path) => void handleSelectFile(path)}
            />
          ) : (
            <SkillFileTreeSidebar
              entries={entries}
              selectedPath={selectedPath}
              collapsedDirectories={collapsedDirectories}
              onToggleDirectory={handleToggleDirectory}
              onSelectFile={(path) => void handleSelectFile(path)}
            />
          )}
          <section className="skill-file-dialog__editor">
            {panelMode !== "files" ? (
              <SkillDiffView
                change={selectedChange}
                content={content}
                displayMode={diffDisplayMode}
                isLoading={panelMode === "updates" ? isUpdatesLoading : isChangesLoading}
                isReverting={isReverting}
                isSaving={isSaving}
                hasDirtyChanges={hasDirtyChanges}
                onContentChange={handleContentChange}
                onDisplayModeChange={setDiffDisplayMode}
                onSave={() => void handleSave()}
                onRevertFile={() => handleRequestRevert({})}
                readOnly={panelMode === "updates"}
                emptyLabel={panelMode === "updates" ? t("skill.updates.empty") : undefined}
              />
            ) : (
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
                onContentChange={handleContentChange}
                onSelectFile={(path) => void handleSelectFile(path)}
              />
            )}
            {(panelMode === "files" && isLoading)
            || (panelMode === "changes" && isChangesLoading)
            || (panelMode === "updates" && isUpdatesLoading) ? (
              <p className="dialog-note">
                {t(panelMode === "updates" ? "skill.updates.loading" : "skill.files.loading")}
              </p>
            ) : null}
            {errorMessage ? <p className="dialog-error">{errorMessage}</p> : null}
            {errorMessage && panelMode === "updates" ? (
              <button
                className="secondary-button secondary-button--compact"
                type="button"
                onClick={() => setUpdatesRefreshVersion((current) => current + 1)}
                disabled={isUpdatesLoading}
              >
                {t("skill.updates.retry")}
              </button>
            ) : null}
          </section>
        </div>
        {pendingRevert ? (
          <div className="skill-revert-confirmation__backdrop">
            <div
              className="skill-revert-confirmation"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={revertConfirmationId}
            >
              <p id={revertConfirmationId}>
                {t(pendingRevert.confirmationKey, { path: pendingRevert.path })}
              </p>
              <div className="skill-revert-confirmation__actions">
                <button
                  className="secondary-button secondary-button--compact"
                  type="button"
                  onClick={() => setPendingRevert(null)}
                  disabled={isReverting}
                  autoFocus
                >
                  {t("skill.changes.cancel")}
                </button>
                <button
                  className="secondary-button secondary-button--compact danger-button"
                  type="button"
                  onClick={() => void handleConfirmRevert()}
                  disabled={isReverting}
                >
                  {t("skill.changes.confirmAction")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
