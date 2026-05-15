import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
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

const localInstallTabs: { key: LocalInstallTab; label: string }[] = [
  { key: "scan", label: "扫描导入" },
  { key: "manual", label: "手动安装" },
];

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

export function LocalSkillImportList() {
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
          fallbackMessage: "扫描本地技能失败，请稍后重试。",
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
        fallbackMessage: "扫描本地技能失败，请稍后重试。",
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
            <h2>手动安装</h2>
            <p>从本机目录或 .zip/.skill 文件安装一个新的 skill。</p>
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
            <h2>扫描本地 Skills 并导入</h2>
            <p>正在读取常见技能目录，马上给出可导入项。</p>
          </div>
          <section className="placeholder-card">
            <h3>正在扫描本地技能</h3>
            <p>系统正在汇总本机已有工具目录中的 skill。</p>
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
            <h2>扫描导入</h2>
            <p>从已存在的工具目录中导入 skill。</p>
          </div>
          <div className="local-import-overview__empty">
            <h3>没有待导入的本地技能</h3>
            <p>当前本机已发现的 skill 都已经纳入统一管理了。</p>
            <button
              className="secondary-button"
              type="button"
              disabled={isRefreshing}
              onClick={() => void handleRefresh()}
            >
              {isRefreshing ? "扫描中..." : "重新扫描"}
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
        notify({ message: `${group.name} 已导入`, tone: "success" });
      }
      return true;
    } catch (error) {
      if (shouldNotify) {
        reportFailure(error, {
          operation: "import_local_skill",
          fallbackMessage: `${group.name} 导入失败，请稍后重试。`,
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
        notify({ message: `已导入 ${importedCount} 个 skill，${failedCount} 个失败。`, tone: "error" });
        return;
      }

      notify({ message: `已导入 ${importedCount} 个本地 skill`, tone: "success" });
    } finally {
      setIsImportingAll(false);
      setImportingNames(new Set());
    }
  }

  return (
    <LocalInstallShell activeTab={activeLocalTab} onTabChange={setActiveLocalTab}>
      <div className="local-scan-panel">
        <div className="panel-header">
          <h2>扫描导入</h2>
          <p>从已存在的工具目录中导入 skill，列表按技能名称聚合同一技能的多个来源位置。</p>
        </div>
        <div className="local-import-summary-bar" aria-label="本地导入总览">
          <p>
            发现 <strong>{groups.length}</strong> 个本地 skill · <strong>{totalLocationCount}</strong> 个位置 ·{" "}
            <strong>{duplicatedSkillCount}</strong> 个重复 · 已管理 <strong>{localManagedCount}</strong> 个
          </p>
          <div className="local-import-overview__actions">
            <button
              className="secondary-button"
              type="button"
              aria-expanded={isScanListExpanded}
              aria-controls="local-scan-results"
              onClick={() => setIsScanListExpanded((current) => !current)}
            >
              {isScanListExpanded ? "收起列表" : "展开列表"}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={isRefreshing}
              onClick={() => void handleRefresh()}
            >
              {isRefreshing ? "扫描中..." : "重新扫描"}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={isImportingAll || groups.length === 0}
              onClick={() => void handleImportAll()}
            >
              {isImportingAll ? "导入中..." : "全部导入"}
            </button>
          </div>
        </div>

        {isScanListExpanded ? (
          <section id="local-scan-results" className="local-scan-results" aria-label="扫描导入结果">
            <div className="local-scan-list-header" aria-hidden="true">
              <span>skill 名称</span>
              <span>来源位置</span>
              <span>操作</span>
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
                        aria-label={`${isExpanded ? "收起" : "展开"} ${group.name}`}
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
                          {group.candidates.length} 个位置 · {sourceSummary}
                        </span>
                      </button>
                      <button
                        className="primary-button local-scan-group__import-button"
                        type="button"
                        aria-label={`导入 ${group.name}`}
                        disabled={isGroupImporting || isImportingAll}
                        onClick={() => void handleImportGroup(group)}
                      >
                        {isGroupImporting ? "导入中..." : "导入"}
                      </button>
                    </div>

                    {isExpanded ? (
                      <div className="local-scan-group__locations">
                        {group.candidates.map((candidate) => (
                          <div key={candidate.localPath} className="local-scan-location">
                            <span className="local-scan-location__source">{sourceLabel(candidate)}</span>
                            <span className="local-scan-location__path">{candidate.localPath}</span>
                            <span className="local-scan-location__hint">{candidate.sourceHint}</span>
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
  return (
    <section className="panel-card market-panel local-install-workspace">
      <div className="local-install-workspace__toolbar">
        <div className="page-tabs filter-tabs local-install-subtabs" role="tablist" aria-label="本地安装方式">
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
