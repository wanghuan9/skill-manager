import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslate } from "@/app/i18n";
import { useNotifications } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { fetchGitRepoBranches } from "@/features/skills/api/skill-client";
import type { GitBranchOption, RepoSkillCandidate } from "@/features/skills/state/skill-store";
import { formatSkillDescription } from "@/features/skills/utils/skill-description";

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

  return trimmed;
}

function isValidRepoUrl(repoUrl: string) {
  try {
    new URL(repoUrl);
    return true;
  } catch {
    return false;
  }
}

function toggleSelection(current: string[], value: string) {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

export function RepoInstallPanel() {
  const { t } = useTranslate();
  const { discoverRepoSkills, installFromRepo, installedSkills } = useSkillWorkspace();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const [repoInput, setRepoInput] = useState("");
  const [branches, setBranches] = useState<GitBranchOption[]>([]);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [candidates, setCandidates] = useState<RepoSkillCandidate[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const normalizedRepoUrl = useMemo(() => normalizeRepoInput(repoInput), [repoInput]);
  const isValid = isValidRepoUrl(normalizedRepoUrl);
  const selectedGitRef = selectedBranch.trim() || undefined;
  const installedSkillNames = useMemo(
    () => new Set(installedSkills.map((skill) => skill.name)),
    [installedSkills],
  );
  const hasSelectableCandidates = useMemo(
    () => candidates.some((candidate) => !installedSkillNames.has(candidate.name)),
    [candidates, installedSkillNames],
  );

  useEffect(() => {
    setBranches([]);
    setSelectedBranch("");
    setCandidates([]);
    setSelectedPaths([]);
    if (!isValid) {
      setIsLoadingBranches(false);
      return;
    }

    let active = true;
    setIsLoadingBranches(true);
    const timer = window.setTimeout(() => {
      void fetchGitRepoBranches({ repoUrl: normalizedRepoUrl })
        .then((nextBranches) => {
          if (!active) {
            return;
          }
          setBranches(nextBranches);
          setSelectedBranch(
            nextBranches.find((branch) => branch.isSelected)?.name
              ?? nextBranches.find((branch) => branch.isDefault)?.name
              ?? nextBranches[0]?.name
              ?? "",
          );
        })
        .catch(() => {
          if (active) {
            setBranches([]);
          }
        })
        .finally(() => {
          if (active) {
            setIsLoadingBranches(false);
          }
        });
    }, 350);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [isValid, normalizedRepoUrl]);

  async function handleDiscover(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValid) {
      notify({ message: t("install.repo.error.invalidUrl"), tone: "error" });
      return;
    }

    flushSync(() => {
      setIsDiscovering(true);
    });

    await waitForNextPaint();

    try {
      const [discovered] = await Promise.all([
        discoverRepoSkills(normalizedRepoUrl, selectedGitRef),
        wait(DISCOVERING_MIN_DURATION_MS),
      ]);
      setCandidates(discovered);
      setSelectedPaths([]);
    } catch (error) {
      setCandidates([]);
      setSelectedPaths([]);
      reportFailure(error, {
        operation: "discover_repo_skills",
        fallbackMessage: t("install.repo.error.readFailed"),
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
      await installFromRepo(normalizedRepoUrl, selectedPaths, selectedGitRef);
      notify({ message: t("install.repo.success.selectedInstalled"), tone: "success" });
      setSelectedPaths([]);
    } catch (error) {
      reportFailure(error, {
        operation: "install_from_repo",
        fallbackMessage: t("install.repo.error.installFailed"),
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
            <div className="repo-form__source-row">
              <label className="repo-form__field">
                <span className="repo-form__label">{t("install.repo.url")}</span>
                <input
                  type="text"
                  placeholder="https://github.com/anthropics/skills"
                  value={repoInput}
                  onChange={(event) => setRepoInput(event.target.value)}
                />
              </label>
              {branches.length > 0 ? (
                <label className="repo-form__field repo-form__field--branch">
                  <span className="repo-form__label">{t("install.repo.gitBranch")}</span>
                  <select
                    value={selectedBranch}
                    disabled={!isValid || isLoadingBranches}
                    onChange={(event) => {
                      setSelectedBranch(event.target.value);
                      setCandidates([]);
                      setSelectedPaths([]);
                    }}
                  >
                    {branches.map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.isDefault ? t("install.repo.defaultBranch", { branch: branch.name }) : branch.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <div className="repo-form__hint-block">
              <p className="repo-form__hint-title">{t("install.repo.supported")}</p>
              <ul className="repo-form__hint-list">
                <li>https://github.com/anthropics/skills</li>
                <li>https://github.com/anthropics/skills/tree/main/skills/frontend-design</li>
              </ul>
            </div>
          </div>
          <div className="repo-form__actions">
            <button
              className={`primary-button repo-form__submit-button${isDiscovering ? " is-loading" : ""}`}
              type="submit"
              disabled={!repoInput.trim() || isDiscovering}
            >
              {isDiscovering ? t("install.repo.discovering") : t("install.repo.discover")}
            </button>
          </div>
        </form>
      ) : null}
      {candidates.length > 0 ? (
        <div className="repo-install__selection">
          <p className="repo-install__notice">{t("install.repo.found", { count: candidates.length })}</p>
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
                        <span className="repo-install__option-badge">{t("install.repo.badgeInstalled")}</span>
                      ) : null}
                    </div>
                    <p>{formatSkillDescription(candidate.description) || t("skills.description.empty")}</p>
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
              {t("install.repo.back")}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={selectedPaths.length === 0 || isInstalling || !hasSelectableCandidates}
              onClick={() => void handleInstallSelected()}
            >
              {isInstalling ? t("install.repo.installing") : t("install.repo.installSelected")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
