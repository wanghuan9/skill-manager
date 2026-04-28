import { useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { useNotifications } from "@/app/notifications";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { RepoSkillCandidate } from "@/features/skills/state/skill-store";
import { formatSkillDescription } from "@/features/skills/utils/skill-description";

const supportedHosts = ["github.com", "gitlab.com", "gitee.com"];
const DISCOVERING_MIN_DURATION_MS = 450;

function wait(duration: number) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function normalizeRepoInput(repoInput: string) {
  const trimmed = repoInput.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.includes("://")) {
    return trimmed;
  }

  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 2) {
    return `https://github.com/${segments.join("/")}`;
  }

  return trimmed;
}

function isValidRepoUrl(repoUrl: string) {
  try {
    const url = new URL(repoUrl);
    return supportedHosts.includes(url.hostname);
  } catch {
    return false;
  }
}

function toggleSelection(current: string[], value: string) {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

export function RepoInstallPanel() {
  const { discoverRepoSkills, installFromRepo, installedSkills } = useSkillWorkspace();
  const { notify } = useNotifications();
  const [repoInput, setRepoInput] = useState("");
  const [candidates, setCandidates] = useState<RepoSkillCandidate[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const normalizedRepoUrl = useMemo(() => normalizeRepoInput(repoInput), [repoInput]);
  const isValid = isValidRepoUrl(normalizedRepoUrl);
  const installedSkillNames = useMemo(
    () => new Set(installedSkills.map((skill) => skill.name)),
    [installedSkills],
  );
  const hasSelectableCandidates = useMemo(
    () => candidates.some((candidate) => !installedSkillNames.has(candidate.name)),
    [candidates, installedSkillNames],
  );

  async function handleDiscover(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValid) {
      notify({ message: "当前只支持 GitHub、GitLab、Gitee 仓库地址。", tone: "error" });
      return;
    }

    flushSync(() => {
      setIsDiscovering(true);
    });

    await waitForNextPaint();

    try {
      const [discovered] = await Promise.all([
        discoverRepoSkills(normalizedRepoUrl),
        wait(DISCOVERING_MIN_DURATION_MS),
      ]);
      setCandidates(discovered);
      setSelectedPaths([]);
    } catch (error) {
      setCandidates([]);
      setSelectedPaths([]);
      notify({
        message: error instanceof Error ? error.message : "读取仓库技能失败，请稍后重试。",
        tone: "error",
      });
    } finally {
      setIsDiscovering(false);
    }
  }

  async function handleInstallSelected() {
    if (selectedPaths.length === 0 || !isValid) {
      return;
    }

    setIsInstalling(true);
    try {
      await installFromRepo(normalizedRepoUrl, selectedPaths);
      notify({ message: "选中技能已安装", tone: "success" });
      setRepoInput("");
      setCandidates([]);
      setSelectedPaths([]);
    } catch (error) {
      notify({
        message: error instanceof Error ? error.message : "安装选中技能失败，请稍后重试。",
        tone: "error",
      });
    } finally {
      setIsInstalling(false);
    }
  }

  return (
    <section className="panel-card market-panel">
      {candidates.length === 0 ? (
        <form className="repo-form" onSubmit={(event) => void handleDiscover(event)}>
          <div className="repo-form__section">
            <label className="repo-form__field">
              <span className="repo-form__label">Git 仓库地址</span>
              <input
                type="text"
                placeholder="https://github.com/user/repo 或 user/repo"
                value={repoInput}
                onChange={(event) => setRepoInput(event.target.value)}
              />
            </label>
            <div className="repo-form__hint-block">
              <p className="repo-form__hint-title">支持格式：</p>
              <ul className="repo-form__hint-list">
                <li>https://github.com/user/repo</li>
                <li>user/repo（默认按 GitHub 解析）</li>
                <li>https://github.com/user/repo/tree/main/skills/my-skill</li>
              </ul>
            </div>
          </div>
          <div className="repo-form__actions">
            <button
              className={`primary-button repo-form__submit-button${isDiscovering ? " is-loading" : ""}`}
              type="submit"
              disabled={!repoInput.trim() || isDiscovering}
            >
              {isDiscovering ? "检查中..." : "识别仓库技能"}
            </button>
          </div>
        </form>
      ) : null}
      {candidates.length > 0 ? (
        <div className="repo-install__selection">
          <p className="repo-install__notice">发现 {candidates.length} 个技能，请选择要安装的技能</p>
          <div className="repo-install__list">
            {candidates.map((candidate) => {
              const selected = selectedPaths.includes(candidate.relativePath);

              return (
                <button
                  key={candidate.id}
                  className={`repo-install__option${selected ? " is-selected" : ""}`}
                  type="button"
                  disabled={installedSkillNames.has(candidate.name)}
                  onClick={() =>
                    !installedSkillNames.has(candidate.name)
                      ? setSelectedPaths((current) => toggleSelection(current, candidate.relativePath))
                      : undefined
                  }
                >
                  <div className="repo-install__option-main">
                    <div className="repo-install__option-title">
                      <h3>{candidate.name}</h3>
                      {installedSkillNames.has(candidate.name) ? (
                        <span className="repo-install__option-badge">已安装</span>
                      ) : null}
                    </div>
                    <p>{formatSkillDescription(candidate.description)}</p>
                    <span>{candidate.relativePath}</span>
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
      ) : null}
    </section>
  );
}
