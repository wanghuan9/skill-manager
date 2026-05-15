import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslate } from "@/app/i18n";
import { LocalInstallPanel } from "@/features/install/components/LocalInstallPanel";
import { useNotifications } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { LocalSkillCandidate } from "@/features/skills/state/skill-store";

type LocalSkillGroup = {
  name: string;
  candidates: LocalSkillCandidate[];
};

type LocalInstallTab = "scan" | "manual";

const SOURCE_LABEL_ORDER = ["cursor", "claude_code", "codex", "windsurf"];

function sourceOrder(candidate: LocalSkillCandidate) {
  const index = SOURCE_LABEL_ORDER.indexOf(sourceLabel(candidate));
  return index === -1 ? SOURCE_LABEL_ORDER.length : index;
}

function buildLocalSkillGroups(candidates: LocalSkillCandidate[]) {
  const groupsByName = new Map<string, LocalSkillCandidate[]>();
  for (const candidate of candidates) {
    const group = groupsByName.get(candidate.name) ?? [];
    group.push(candidate);
    groupsByName.set(candidate.name, group);
  }

  return Array.from(groupsByName.entries())
    .map(([name, groupCandidates]) => ({
      name,
      candidates: groupCandidates.sort((left, right) =>
        sourceOrder(left) - sourceOrder(right) || left.localPath.localeCompare(right.localPath)
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sourceLabel(candidate: LocalSkillCandidate) {
  const normalized = candidate.detectedFrom.replace(/\\/g, "/");
  if (normalized.includes("/.cursor/")) {
    return "cursor";
  }
  if (normalized.includes("/.claude/")) {
    return "claude_code";
  }
  if (normalized.includes("/.codeium/windsurf/")) {
    return "windsurf";
  }
  if (normalized.includes("/.codex/")) {
    return "codex";
  }
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-2) ?? parts.at(-1) ?? "local";
}

function formatSourceHint(sourceHint: string, t: ReturnType<typeof useTranslate>["t"]) {
  if (sourceHint === "符号链接" || sourceHint === "Symlink") {
    return t("install.local.sourceHint.symlink");
  }
  if (sourceHint === "本地文件" || sourceHint === "Local File") {
    return t("install.local.sourceHint.file");
  }

  return sourceHint;
}

export function LocalSkillImportList() {
  const { t } = useTranslate();
  const { importCandidate, installedSkills, isLoading, localCandidates, refreshLocalCandidates } = useSkillWorkspace();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const groups = useMemo(() => buildLocalSkillGroups(localCandidates), [localCandidates]);
  const [activeLocalTab, setActiveLocalTab] = useState<LocalInstallTab>("scan");
  const [isScanListExpanded, setIsScanListExpanded] = useState(true);
  const [expandedNames, setExpandedNames] = useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isImportingAll, setIsImportingAll] = useState(false);
  const [importingNames, setImportingNames] = useState<Set<string>>(new Set());
  const refreshLocalCandidatesRef = useRef(refreshLocalCandidates);
  const localManagedCount = installedSkills.filter((skill) => skill.sourceType === "local").length;
  const duplicatedSkillCount = groups.filter((group) => group.candidates.length > 1).length;
  const totalLocationCount = localCandidates.length;

  useEffect(() => {
    refreshLocalCandidatesRef.current = refreshLocalCandidates;
  });

  useEffect(() => {
    let cancelled = false;
    setIsRefreshing(true);
    void refreshLocalCandidatesRef.current()
      .catch((error) => {
        if (cancelled) {
          return;
        }
        reportFailure(error, {
          operation: "refresh_local_candidates",
          fallbackMessage: t("install.local.error.scanFailed"),
        });
      })
      .finally(() => {
        if (!cancelled) {
          setIsRefreshing(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [notify]);

  async function handleRefresh() {
    if (isRefreshing) {
      return;
    }

    setIsRefreshing(true);
    try {
      await refreshLocalCandidates();
      setIsScanListExpanded(true);
      setExpandedNames(new Set());
    } catch (error) {
      reportFailure(error, {
        operation: "refresh_local_candidates",
        fallbackMessage: t("install.local.error.scanFailed"),
      });
    } finally {
      setIsRefreshing(false);
    }
  }

  if (activeLocalTab === "manual") {
    return (
      <LocalInstallShell activeTab={activeLocalTab} onTabChange={setActiveLocalTab}>
        <div className="local-install-panel">
          <div className="panel-header">
            <h2>{t("install.local.manual")}</h2>
            <p>{t("install.local.manualDescription")}</p>
          </div>
          <LocalInstallPanel variant="embedded" />
        </div>
      </LocalInstallShell>
    );
  }

  if (isLoading) {
    return (
      <LocalInstallShell activeTab={activeLocalTab} onTabChange={setActiveLocalTab}>
        <div className="local-scan-panel">
          <div className="panel-header">
            <h2>{t("install.local.scanLoadingTitle")}</h2>
            <p>{t("install.local.scanLoadingDescription")}</p>
          </div>
          <section className="placeholder-card">
            <h3>{t("install.local.scanLoadingCardTitle")}</h3>
            <p>{t("install.local.scanLoadingCardDescription")}</p>
          </section>
        </div>
      </LocalInstallShell>
    );
  }

  if (localCandidates.length === 0) {
    return (
      <LocalInstallShell activeTab={activeLocalTab} onTabChange={setActiveLocalTab}>
        <div className="local-scan-panel">
          <div className="panel-header">
            <h2>{t("install.local.scan")}</h2>
            <p>{t("install.local.scanDescription")}</p>
          </div>
          <div className="local-import-overview__empty">
            <h3>{t("install.local.emptyTitle")}</h3>
            <p>{t("install.local.emptyDescription")}</p>
            <button
              className="secondary-button"
              type="button"
              disabled={isRefreshing}
              onClick={() => void handleRefresh()}
            >
              {isRefreshing ? t("install.local.rescanning") : t("install.local.rescan")}
            </button>
          </div>
        </div>
      </LocalInstallShell>
    );
  }

  function toggleGroup(name: string) {
    setExpandedNames((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  async function handleImportGroup(group: LocalSkillGroup, shouldNotify = true) {
    const candidate = group.candidates[0];
    if (!candidate || importingNames.has(group.name) || isImportingAll) {
      return false;
    }

    setImportingNames((current) => new Set(current).add(group.name));
    try {
      await importCandidate(candidate.localPath);
      if (shouldNotify) {
        notify({ message: t("install.local.success.importOne", { name: group.name }), tone: "success" });
      }
      return true;
    } catch (error) {
      if (shouldNotify) {
        reportFailure(error, {
          operation: "import_local_skill",
          fallbackMessage: t("install.local.error.importOne", { name: group.name }),
          context: { skillName: group.name, localPath: candidate.localPath },
        });
      }
      return false;
    } finally {
      setImportingNames((current) => {
        const next = new Set(current);
        next.delete(group.name);
        return next;
      });
    }
  }

  async function handleImportAll() {
    if (groups.length === 0 || isImportingAll) {
      return;
    }

    setIsImportingAll(true);
    setImportingNames(new Set(groups.map((group) => group.name)));
    let importedCount = 0;
    let failedCount = 0;

    try {
      for (const group of groups) {
        const candidate = group.candidates[0];
        if (!candidate) {
          failedCount += 1;
          continue;
        }

        try {
          await importCandidate(candidate.localPath);
          importedCount += 1;
        } catch {
          failedCount += 1;
        }
      }

      if (failedCount > 0) {
        notify({ message: t("install.local.summaryError", { imported: importedCount, failed: failedCount }), tone: "error" });
        return;
      }

      notify({ message: t("install.local.summarySuccess", { count: importedCount }), tone: "success" });
    } finally {
      setIsImportingAll(false);
      setImportingNames(new Set());
    }
  }

  return (
    <LocalInstallShell activeTab={activeLocalTab} onTabChange={setActiveLocalTab}>
      <div className="local-scan-panel">
        <div className="panel-header">
          <h2>{t("install.local.scan")}</h2>
          <p>{t("install.local.scanDescription")}</p>
        </div>
        <div className="local-import-summary-bar" aria-label={t("install.local.overviewAria")}>
          <p>
            {t("install.local.summary", {
              groups: groups.length,
              locations: totalLocationCount,
              duplicates: duplicatedSkillCount,
              managed: localManagedCount,
            })}
          </p>
          <div className="local-import-overview__actions">
            <button
              className="secondary-button"
              type="button"
              aria-expanded={isScanListExpanded}
              aria-controls="local-scan-results"
              onClick={() => setIsScanListExpanded((current) => !current)}
            >
              {isScanListExpanded ? t("install.local.collapse") : t("install.local.expand")}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={isRefreshing}
              onClick={() => void handleRefresh()}
            >
              {isRefreshing ? t("install.local.rescanning") : t("install.local.rescan")}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={isImportingAll || groups.length === 0}
              onClick={() => void handleImportAll()}
            >
              {isImportingAll ? t("install.local.importAllLoading") : t("install.local.importAll")}
            </button>
          </div>
        </div>

        {isScanListExpanded ? (
          <section id="local-scan-results" className="local-scan-results" aria-label={t("install.local.resultsAria")}>
            <div className="local-scan-list-header" aria-hidden="true">
              <span>{t("install.local.name")}</span>
              <span>{t("install.local.sourceLocation")}</span>
              <span>{t("install.local.action")}</span>
            </div>
            <div className="local-scan-list">
              {groups.map((group) => {
                const isExpanded = expandedNames.has(group.name);
                const isGroupImporting = importingNames.has(group.name);
                const sourceSummary = group.candidates.map(sourceLabel).join(" / ");

                return (
                  <article key={group.name} className="local-scan-group" aria-label={group.name}>
                    <div className="local-scan-group__row">
                      <button
                        className="local-scan-group__toggle"
                        type="button"
                        aria-label={isExpanded ? t("install.local.collapseItem", { name: group.name }) : t("install.local.expandItem", { name: group.name })}
                        aria-expanded={isExpanded}
                        onClick={() => toggleGroup(group.name)}
                      >
                        <span className="local-scan-group__header">
                          <span className="local-scan-group__chevron" aria-hidden="true">
                            {isExpanded ? "⌄" : "›"}
                          </span>
                          <strong>{group.name}</strong>
                        </span>
                        <span className="local-scan-group__sources">
                          {t("install.local.locations", { count: group.candidates.length, sources: sourceSummary })}
                        </span>
                      </button>
                      <button
                        className="primary-button local-scan-group__import-button"
                        type="button"
                        aria-label={t("install.local.importAria", { name: group.name })}
                        disabled={isGroupImporting || isImportingAll}
                        onClick={() => void handleImportGroup(group)}
                      >
                        {isGroupImporting ? t("install.local.importingOne") : t("install.local.importOne")}
                      </button>
                    </div>

                    {isExpanded ? (
                      <div className="local-scan-group__locations">
                        {group.candidates.map((candidate) => (
                          <div key={candidate.localPath} className="local-scan-location">
                            <span className="local-scan-location__source">{sourceLabel(candidate)}</span>
                            <span className="local-scan-location__path">{candidate.localPath}</span>
                            <span className="local-scan-location__hint">{formatSourceHint(candidate.sourceHint, t)}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
    </LocalInstallShell>
  );
}

type LocalInstallShellProps = {
  activeTab: LocalInstallTab;
  children: ReactNode;
  onTabChange: (tab: LocalInstallTab) => void;
};

function LocalInstallShell(props: LocalInstallShellProps) {
  const { activeTab, children, onTabChange } = props;
  const { t } = useTranslate();
  const localInstallTabs: { key: LocalInstallTab; label: string }[] = [
    { key: "scan", label: t("install.local.scan") },
    { key: "manual", label: t("install.local.manual") },
  ];
  return (
    <section className="panel-card market-panel local-install-workspace">
      <div className="local-install-workspace__toolbar">
        <div className="page-tabs filter-tabs local-install-subtabs" role="tablist" aria-label={t("install.local.tabAria")}>
          {localInstallTabs.map((tab) => {
            const selected = tab.key === activeTab;

            return (
              <button
                key={tab.key}
                className={`filter-tab local-install-subtab${selected ? " active is-selected" : ""}`}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onTabChange(tab.key)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
      {children}
    </section>
  );
}
