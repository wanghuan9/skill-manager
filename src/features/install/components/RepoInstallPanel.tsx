import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { useTranslate } from "@/app/i18n";
import { useNotifications } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { fetchGitRepoBranches } from "@/features/skills/api/skill-client";
import type { GitBranchOption, RepoSkillCandidate } from "@/features/skills/state/skill-store";
import { formatSkillDescription } from "@/features/skills/utils/skill-description";

const DISCOVERING_MIN_DURATION_MS = 450;

type RepoPanelCache = {
  repoInput: string;
  branches: GitBranchOption[];
  selectedBranch: string;
  candidates: RepoSkillCandidate[];
  selectedPaths: string[];
  candidateSearchQuery: string;
};

let repoPanelCache: RepoPanelCache | null = null;

function readCache(): RepoPanelCache {
  return repoPanelCache ?? {
    repoInput: "",
    branches: [],
    selectedBranch: "",
    candidates: [],
    selectedPaths: [],
    candidateSearchQuery: "",
  };
}

function clearCache() {
  repoPanelCache = null;
}

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
  if (/^[^@\s]+@[^:\s]+:[^\s]+\/[^\s]+(?:\.git)?$/i.test(repoUrl)) {
    return true;
  }

  try {
    const parsed = new URL(repoUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "ssh:";
  } catch {
    return false;
  }
}

function toggleSelection(current: string[], value: string) {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

function normalizeCandidateSearch(value: string) {
  return value.trim().toLowerCase();
}

function matchesRepoSkillCandidate(candidate: RepoSkillCandidate, query: string) {
  if (!query) {
    return true;
  }

  return [
    candidate.name,
    formatSkillDescription(candidate.description),
  ].some((value) => value.toLowerCase().includes(query));
}

export function RepoInstallPanel() {
  const { t } = useTranslate();
  const { discoverRepoSkills, installFromRepo, installedSkills } = useSkillWorkspace();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const initial = readCache();
  const [repoInput, setRepoInput] = useState(initial.repoInput);
  const [branches, setBranches] = useState<GitBranchOption[]>(initial.branches);
  const [selectedBranch, setSelectedBranch] = useState(initial.selectedBranch);
  const [candidates, setCandidates] = useState<RepoSkillCandidate[]>(initial.candidates);
  const [selectedPaths, setSelectedPaths] = useState<string[]>(initial.selectedPaths);
  const [candidateSearchQuery, setCandidateSearchQuery] = useState(initial.candidateSearchQuery);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [cloneProgressMessage, setCloneProgressMessage] = useState<string | null>(null);
  const prevRepoInputRef = useRef(initial.repoInput);

  // 同步状态到 module-level 缓存，下次 mount 恢复
  useEffect(() => {
    repoPanelCache = { repoInput, branches, selectedBranch, candidates, selectedPaths, candidateSearchQuery };
  });

  // 监听 git clone 进度事件（仅在 discovering/installing 期间注册）
  useEffect(() => {
    if (!isDiscovering && !isInstalling) {
      return;
    }
    let unlisten: (() => void) | undefined;
    let mounted = true;
    listen<{ phase: string; message: string }>("repo-clone-progress", (event) => {
      if (mounted && event.payload.message) {
        setCloneProgressMessage(event.payload.message);
      }
    }).then((fn) => {
      if (mounted) {
        unlisten = fn;
      } else {
        fn();
      }
    }).catch(() => undefined);
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [isDiscovering, isInstalling]);

  const normalizedRepoUrl = useMemo(() => normalizeRepoInput(repoInput), [repoInput]);
  const isValid = isValidRepoUrl(normalizedRepoUrl);
  const selectedGitRef = selectedBranch.trim() || undefined;
  const installedSkillNames = useMemo(
    () => new Set(installedSkills.map((skill) => skill.name)),
    [installedSkills],
  );
  const isCandidateInstalled = (candidate: RepoSkillCandidate) => installedSkillNames.has(candidate.name);
  const hasSelectableCandidates = useMemo(
    () => candidates.some((candidate) => !installedSkillNames.has(candidate.name)),
    [candidates, installedSkillNames],
  );
  const normalizedCandidateSearchQuery = normalizeCandidateSearch(candidateSearchQuery);
  const filteredCandidates = useMemo(
    () => candidates.filter((candidate) => matchesRepoSkillCandidate(candidate, normalizedCandidateSearchQuery)),
    [candidates, normalizedCandidateSearchQuery],
  );
  const selectableFilteredCandidatePaths = useMemo(
    () => filteredCandidates
      .filter((candidate) => !installedSkillNames.has(candidate.name))
      .map((candidate) => candidate.relativePath),
    [filteredCandidates, installedSkillNames],
  );
  const hasSelectableFilteredCandidates = selectableFilteredCandidatePaths.length > 0;
  const allFilteredCandidatesSelected = hasSelectableFilteredCandidates
    && selectableFilteredCandidatePaths.every((relativePath) => selectedPaths.includes(relativePath));

  useEffect(() => {
    const urlChanged = prevRepoInputRef.current !== repoInput;
    prevRepoInputRef.current = repoInput;

    if (urlChanged) {
      setBranches([]);
      setSelectedBranch("");
      setCandidates([]);
      setSelectedPaths([]);
    }

    if (!isValid) {
      setIsLoadingBranches(false);
      return;
    }
    // 缓存恢复且 URL 未变时，跳过重复拉取
    if (!urlChanged && branches.length > 0) {
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
      setCloneProgressMessage("正在连接仓库...");
    });
    setCandidateSearchQuery("");

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
      setCloneProgressMessage(null);
    }
  }

  async function handleInstallSelected() {
    if (selectedPaths.length === 0 || !isValid) {
      return;
    }

    setIsInstalling(true);
    setCloneProgressMessage("正在准备安装...");
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
      setCloneProgressMessage(null);
    }
  }

  function handleToggleFilteredCandidates() {
    if (!hasSelectableFilteredCandidates) {
      return;
    }

    setSelectedPaths((current) => {
      if (allFilteredCandidatesSelected) {
        return current.filter((selectedPath) => !selectableFilteredCandidatePaths.includes(selectedPath));
      }

      return Array.from(new Set([...current, ...selectableFilteredCandidatePaths]));
    });
  }

  return (
    <section className="panel-card market-panel">
      {(isDiscovering || isInstalling) && cloneProgressMessage ? (
        <div className="repo-clone-progress-bar">
          <span className="repo-clone-progress-bar__text">{cloneProgressMessage}</span>
        </div>
      ) : null}
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
          <div className="repo-install__summary-row">
            <p className="repo-install__notice">{t("install.repo.found", { count: candidates.length })}</p>
            <label className="market-search-field repo-install__search-field">
              <span className="sr-only">{t("install.repo.searchAria")}</span>
              <div className="market-search-input-wrap">
                <input
                  className="market-search-input"
                  type="search"
                  value={candidateSearchQuery}
                  placeholder={t("install.repo.searchPlaceholder")}
                  onChange={(event) => setCandidateSearchQuery(event.target.value)}
                />
              </div>
            </label>
            <button
              className="secondary-button secondary-button--compact repo-install__select-toggle"
              type="button"
              disabled={!hasSelectableFilteredCandidates}
              onClick={handleToggleFilteredCandidates}
            >
              {allFilteredCandidatesSelected ? t("install.repo.deselectAll") : t("install.repo.selectAll")}
            </button>
          </div>
          {filteredCandidates.length > 0 ? (
            <div className="repo-install__list">
              {filteredCandidates.map((candidate) => {
                const selected = selectedPaths.includes(candidate.relativePath);

                return (
                  <button
                    key={candidate.id}
                    className={`repo-install__option${selected ? " is-selected" : ""}`}
                    type="button"
                    disabled={isCandidateInstalled(candidate)}
                    onClick={() =>
                      !isCandidateInstalled(candidate)
                        ? setSelectedPaths((current) => toggleSelection(current, candidate.relativePath))
                        : undefined
                    }
                  >
                    <div className="repo-install__option-main">
                      <div className="repo-install__option-title">
                        <h3>{candidate.name}</h3>
                        {isCandidateInstalled(candidate) ? (
                          <span className="repo-install__option-badge">{t("install.repo.badgeInstalled")}</span>
                        ) : null}
                      </div>
                      <p className="repo-install__option-description">
                        {formatSkillDescription(candidate.description) || t("skills.description.empty")}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="repo-install__empty">
              <h3>{t("install.repo.emptySearchTitle")}</h3>
              <p>{t("install.repo.emptySearchDescription")}</p>
            </div>
          )}
          <div className="repo-install__actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setCandidates([]);
                setSelectedPaths([]);
                setCandidateSearchQuery("");
                clearCache();
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
