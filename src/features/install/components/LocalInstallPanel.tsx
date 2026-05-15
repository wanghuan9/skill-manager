import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauriRuntime } from "@/app/is-tauri-runtime";
import { useNotifications } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { LocalInstallSkillCandidate } from "@/features/skills/state/skill-store";
import { formatSkillDescription } from "@/features/skills/utils/skill-description";

type LocalInstallPanelProps = {
  variant?: "panel" | "embedded";
  onInstalled?: () => void;
};

type FileWithPath = File & {
  path?: string;
};

type DragDropPosition = Extract<DragDropEvent, { position: unknown }>["position"];

function firstSelectedPath(selected: string | string[] | null) {
  if (Array.isArray(selected)) {
    return selected[0] ?? "";
  }

  return selected ?? "";
}

function pathFromDroppedFile(file: FileWithPath | undefined) {
  return file?.path ?? "";
}

function canUseTauriDragDrop() {
  return isTauriRuntime();
}

function toggleSelection(current: string[], value: string) {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

export function LocalInstallPanel(props: LocalInstallPanelProps) {
  const { variant = "panel", onInstalled } = props;
  const {
    discoverLocalInstallSkills,
    installFromLocalPath,
    installedSkills,
    installSelectedLocalSkills,
  } = useSkillWorkspace();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const dropzoneRef = useRef<HTMLDivElement>(null);
  const [localPath, setLocalPath] = useState("");
  const [skillName, setSkillName] = useState("");
  const [candidates, setCandidates] = useState<LocalInstallSkillCandidate[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const trimmedLocalPath = localPath.trim();
  const installedSkillNames = new Set(installedSkills.map((skill) => skill.name));
  const hasSelectableCandidates = candidates.some((candidate) => !installedSkillNames.has(candidate.name));

  const isDropPositionInsideDropzone = useCallback((position: DragDropPosition) => {
    const dropzone = dropzoneRef.current;
    if (!dropzone) {
      return false;
    }

    const scaleFactor = window.devicePixelRatio || 1;
    const logicalX = position.x / scaleFactor;
    const logicalY = position.y / scaleFactor;
    const rect = dropzone.getBoundingClientRect();

    return logicalX >= rect.left && logicalX <= rect.right && logicalY >= rect.top && logicalY <= rect.bottom;
  }, []);

  const handleDroppedPath = useCallback(
    (droppedPath: string) => {
      if (!droppedPath) {
        notify({ message: "未读取到拖拽文件路径，请使用选择按钮或手动输入路径。", tone: "error" });
        return;
      }

      setLocalPath(droppedPath);
      setCandidates([]);
      setSelectedPaths([]);
    },
    [notify],
  );

  useEffect(() => {
    if (!canUseTauriDragDrop()) {
      return;
    }

    let unlisten: (() => void) | undefined;
    let isMounted = true;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const { payload } = event;
        if (payload.type === "enter" || payload.type === "over") {
          setIsDragging(isDropPositionInsideDropzone(payload.position));
          return;
        }

        if (payload.type === "drop") {
          setIsDragging(false);
          if (isDropPositionInsideDropzone(payload.position)) {
            const droppedPath = payload.paths[0] ?? "";
            handleDroppedPath(droppedPath);
          }
          return;
        }

        setIsDragging(false);
      })
      .then((nextUnlisten) => {
        if (isMounted) {
          unlisten = nextUnlisten;
          return;
        }

        nextUnlisten();
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
      unlisten?.();
    };
  }, [handleDroppedPath, isDropPositionInsideDropzone]);

  async function chooseDirectory() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 skill 文件夹",
    });
    const selectedPath = firstSelectedPath(selected);
    if (selectedPath) {
      setLocalPath(selectedPath);
      setCandidates([]);
      setSelectedPaths([]);
    }
  }

  async function chooseArchive() {
    const selected = await open({
      directory: false,
      multiple: false,
      title: "选择 skill 压缩包",
      filters: [{ name: "Skill", extensions: ["zip", "skill"] }],
    });
    const selectedPath = firstSelectedPath(selected);
    if (selectedPath) {
      setLocalPath(selectedPath);
      setCandidates([]);
      setSelectedPaths([]);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const droppedPath = pathFromDroppedFile(event.dataTransfer.files[0] as FileWithPath | undefined);
    if (!droppedPath && canUseTauriDragDrop()) {
      return;
    }

    handleDroppedPath(droppedPath);
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }

    setIsDragging(false);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedLocalPath) {
      notify({ message: "请选择或输入本地 skill 路径。", tone: "error" });
      return;
    }

    setIsDiscovering(true);
    try {
      const discovered = await discoverLocalInstallSkills(trimmedLocalPath);
      if (discovered.length > 1) {
        setCandidates(discovered);
        setSelectedPaths([]);
        return;
      }

      await installFromLocalPath(trimmedLocalPath, skillName.trim() || undefined);
      notify({ message: "本地技能已安装", tone: "success" });
      setLocalPath("");
      setSkillName("");
      setCandidates([]);
      setSelectedPaths([]);
      onInstalled?.();
    } catch (error) {
      reportFailure(error, {
        operation: "discover_local_install_skills",
        fallbackMessage: "未识别到 skill，请选择包含 SKILL.md 的目录或压缩包。",
      });
    } finally {
      setIsDiscovering(false);
    }
  }

  async function handleInstallSelected() {
    if (selectedPaths.length === 0 || !trimmedLocalPath) {
      return;
    }

    setIsInstalling(true);
    try {
      await installSelectedLocalSkills(trimmedLocalPath, selectedPaths);
      notify({ message: "选中本地技能已安装", tone: "success" });
      setLocalPath("");
      setSkillName("");
      setCandidates([]);
      setSelectedPaths([]);
      onInstalled?.();
    } catch (error) {
      reportFailure(error, {
        operation: "install_selected_local_skills",
        fallbackMessage: "安装选中本地技能失败，请稍后重试。",
      });
    } finally {
      setIsInstalling(false);
    }
  }

  const selection = (
    <div className="repo-install__selection local-install-selection">
      <p className="repo-install__notice">发现 {candidates.length} 个技能，请选择要安装的技能</p>
      <div className="repo-install__list">
        {candidates.map((candidate) => {
          const selected = selectedPaths.includes(candidate.relativePath);
          const installed = installedSkillNames.has(candidate.name);

          return (
            <button
              key={candidate.id}
              className={`repo-install__option${selected ? " is-selected" : ""}`}
              type="button"
              disabled={installed}
              onClick={() =>
                !installed
                  ? setSelectedPaths((current) => toggleSelection(current, candidate.relativePath))
                  : undefined
              }
            >
              <div className="repo-install__option-main">
                <div className="repo-install__option-title">
                  <h3>{candidate.name}</h3>
                  {installed ? <span className="repo-install__option-badge">已安装</span> : null}
                </div>
                <p>{formatSkillDescription(candidate.description)}</p>
                <span>{candidate.relativePath || "."}</span>
              </div>
            </button>
          );
        })}
      </div>
      <div className="repo-install__actions">
        <button
          className="secondary-button"
          type="button"
          onClick={() => {
            setCandidates([]);
            setSelectedPaths([]);
          }}
        >
          返回
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={selectedPaths.length === 0 || isInstalling || !hasSelectableCandidates}
          onClick={() => void handleInstallSelected()}
        >
          {isInstalling ? "安装中..." : "安装选中技能"}
        </button>
      </div>
    </div>
  );

  const form = candidates.length > 0 ? selection : (
      <form className="local-install-form" onSubmit={(event) => void handleSubmit(event)}>
        <div
          ref={dropzoneRef}
          className={`local-install-dropzone${isDragging ? " is-dragging" : ""}${
            trimmedLocalPath ? " is-selected" : ""
          }`}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 4v10m0-10 4 4m-4-4-4 4M5 18h14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {trimmedLocalPath ? (
            <strong className="local-install-dropzone__selected">
              <span>已选择:</span>
              <span>{trimmedLocalPath}</span>
            </strong>
          ) : (
            <strong>拖拽文件夹或压缩包到此处</strong>
          )}
          <span>支持 .zip/.skill 压缩包或技能文件夹</span>
        </div>

        <div className="local-install-form__section">
          <span className="repo-form__label">或手动选择</span>
          <div className="local-install-form__path-row">
            <input
              aria-label="本地 skill 路径"
              type="text"
              placeholder="选择文件夹或 .zip/.skill 文件"
            value={localPath}
              onChange={(event) => {
                setLocalPath(event.target.value);
                setCandidates([]);
                setSelectedPaths([]);
              }}
            />
            <button
              className="secondary-button local-install-form__icon-button"
              type="button"
              aria-label="选择文件夹"
              title="选择文件夹"
              onClick={() => void chooseDirectory()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M4 7.5A2.5 2.5 0 0 1 6.5 5h3.2l1.5 1.5h6.3A2.5 2.5 0 0 1 20 9v7.5A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              className="secondary-button local-install-form__icon-button"
              type="button"
              aria-label="选择压缩包"
              title="选择压缩包"
              onClick={() => void chooseArchive()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M8 4h6l4 4v12H8V4Zm6 0v4h4M5 7v13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M11 11h2m-2 3h2m-2 3h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <label className="repo-form__field">
          <span className="repo-form__label">技能名称（可选）</span>
          <input
            type="text"
            placeholder="留空则自动从 SKILL.md 或文件名推断"
            value={skillName}
            onChange={(event) => setSkillName(event.target.value)}
          />
        </label>

        <div className="repo-form__actions">
          <button
            className="primary-button"
            type="submit"
            disabled={!trimmedLocalPath || isDiscovering}
          >
            {isDiscovering ? "识别中..." : "安装技能"}
          </button>
        </div>
      </form>
  );

  if (variant === "embedded") {
    return form;
  }

  return (
    <section className="panel-card market-panel local-install-panel">
      <div className="panel-header">
        <h2>本地安装</h2>
        <p>从本机目录或 .zip/.skill 文件安装一个新的 skill。</p>
      </div>
      {form}
    </section>
  );
}
