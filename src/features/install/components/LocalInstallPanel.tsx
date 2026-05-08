import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useNotifications } from "@/app/notifications";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";

type FileWithPath = File & {
  path?: string;
};

function firstSelectedPath(selected: string | string[] | null) {
  if (Array.isArray(selected)) {
    return selected[0] ?? "";
  }

  return selected ?? "";
}

function pathFromDroppedFile(file: FileWithPath | undefined) {
  return file?.path ?? "";
}

export function LocalInstallPanel() {
  const { installFromLocalPath } = useSkillWorkspace();
  const { notify } = useNotifications();
  const [localPath, setLocalPath] = useState("");
  const [skillName, setSkillName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const trimmedLocalPath = localPath.trim();

  async function chooseDirectory() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 skill 文件夹",
    });
    const selectedPath = firstSelectedPath(selected);
    if (selectedPath) {
      setLocalPath(selectedPath);
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
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const droppedPath = pathFromDroppedFile(event.dataTransfer.files[0] as FileWithPath | undefined);
    if (!droppedPath) {
      notify({ message: "未读取到拖拽文件路径，请使用选择按钮或手动输入路径。", tone: "error" });
      return;
    }

    setLocalPath(droppedPath);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedLocalPath) {
      notify({ message: "请选择或输入本地 skill 路径。", tone: "error" });
      return;
    }

    setIsInstalling(true);
    try {
      await installFromLocalPath(trimmedLocalPath, skillName.trim() || undefined);
      notify({ message: "本地技能已安装", tone: "success" });
      setLocalPath("");
      setSkillName("");
    } catch (error) {
      notify({
        message: error instanceof Error ? error.message : "安装本地技能失败，请稍后重试。",
        tone: "error",
      });
    } finally {
      setIsInstalling(false);
    }
  }

  return (
    <section className="panel-card market-panel local-install-panel">
      <div className="panel-header">
        <h2>本地安装</h2>
        <p>从本机目录或 .zip/.skill 文件安装一个新的 skill。</p>
      </div>
      <form className="local-install-form" onSubmit={(event) => void handleSubmit(event)}>
        <div
          className={`local-install-dropzone${isDragging ? " is-dragging" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setIsDragging(false)}
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
          <strong>拖拽文件夹或压缩包到此处</strong>
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
              onChange={(event) => setLocalPath(event.target.value)}
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
            disabled={!trimmedLocalPath || isInstalling}
          >
            {isInstalling ? "安装中..." : "安装技能"}
          </button>
        </div>
      </form>
    </section>
  );
}
