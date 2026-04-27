import { useEffect, useId, useMemo, useState } from "react";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { SkillFileEntry, SkillSummary } from "@/features/skills/state/skill-store";

type SkillFileDialogProps = {
  skill: SkillSummary;
  isOpen: boolean;
  onClose: () => void;
};

const DEFAULT_ERROR_MESSAGE = "读取 skill 文件失败，请稍后重试。";

function entryIndent(entry: SkillFileEntry) {
  return {
    paddingLeft: `${16 + entry.depth * 14}px`,
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

  const fileEntries = useMemo(
    () => entries.filter((entry) => entry.entryType === "file"),
    [entries],
  );

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
        <div className="skill-file-dialog__body">
          <aside className="skill-file-dialog__sidebar">
            {entries.map((entry) =>
              entry.entryType === "directory" ? (
                <div
                  key={`${entry.path}-${entry.entryType}`}
                  className="skill-file-dialog__tree-item skill-file-dialog__tree-item--directory"
                  style={entryIndent(entry)}
                >
                  <span aria-hidden="true">{entry.depth === 0 ? "⌄" : "›"}</span>
                  <span>{entry.name}</span>
                </div>
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
            ) : (
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
            )}
            {isLoading ? <p className="dialog-note">正在读取文件内容...</p> : null}
            {errorMessage ? <p className="dialog-error">{errorMessage}</p> : null}
          </section>
        </div>
      </div>
    </div>
  );
}
