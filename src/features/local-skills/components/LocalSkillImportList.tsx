import { useMemo, useState } from "react";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { LocalSkillCandidate } from "@/features/skills/state/skill-store";

type LocalSkillGroup = {
  name: string;
  candidates: LocalSkillCandidate[];
};

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
      candidates: groupCandidates.sort((left, right) => left.detectedFrom.localeCompare(right.detectedFrom)),
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
  const { importCandidate, installedSkills, isLoading, localCandidates, refreshWorkspace } = useSkillWorkspace();
  const groups = useMemo(() => buildLocalSkillGroups(localCandidates), [localCandidates]);
  const [expandedNames, setExpandedNames] = useState<Set<string>>(new Set());
  const [showDetails, setShowDetails] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const localManagedCount = installedSkills.filter((skill) => skill.sourceType === "local").length;
  const duplicatedSkillCount = groups.filter((group) => group.candidates.length > 1).length;

  if (isLoading) {
    return (
      <section className="panel-card market-panel local-scan-panel">
        <div className="panel-header">
          <h2>本地导入</h2>
          <p>从已存在的工具目录中导入 skill。</p>
        </div>
        <section className="placeholder-card">
          <h3>正在扫描本地技能</h3>
          <p>系统正在读取常见技能目录，马上给出可导入项。</p>
        </section>
      </section>
    );
  }

  if (localCandidates.length === 0) {
    return (
      <section className="panel-card market-panel local-scan-panel">
        <div className="panel-header">
          <h2>本地导入</h2>
          <p>从已存在的工具目录中导入 skill。</p>
        </div>
        <div className="local-import-overview__empty">
          <h3>没有待导入的本地技能</h3>
          <p>当前本机已发现的 skill 都已经纳入统一管理了。</p>
        </div>
      </section>
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

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await refreshWorkspace();
      setShowDetails(false);
      setExpandedNames(new Set());
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <>
      <section className="panel-card market-panel local-scan-panel">
        <div className="panel-header">
          <h2>本地导入</h2>
          <p>从已存在的工具目录中导入 skill。</p>
        </div>
        <div className="local-import-overview" aria-label="本地导入总览">
        <div className="local-import-overview__hero">
          <span>发现本地 skill</span>
          <strong>{groups.length}</strong>
        </div>
        <div className="local-import-overview__metrics">
          <div>
            <span>{localCandidates.length}</span>
            <strong>发现位置</strong>
          </div>
          <div>
            <span>{duplicatedSkillCount}</span>
            <strong>多位置重复</strong>
          </div>
          <div>
            <span>{localManagedCount}</span>
            <strong>已管理本地</strong>
          </div>
        </div>
        <div className="local-import-overview__actions">
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
            onClick={() => setShowDetails((current) => !current)}
          >
            {showDetails ? "收起详情" : "查看可导入"}
          </button>
        </div>
        </div>
      </section>

      {showDetails ? (
        <section className="panel-card market-panel local-scan-detail-panel">
          <div className="panel-header">
            <h2>可导入技能</h2>
            <p>按 skill 名聚合本机不同工具目录中的位置。</p>
          </div>
          <div className="local-scan-list">
            {groups.map((group) => (
              <article key={group.name} className="local-scan-group">
                <button
                  className="local-scan-group__header"
                  type="button"
                  aria-expanded={expandedNames.has(group.name)}
                  onClick={() => toggleGroup(group.name)}
                >
                  <span className="local-scan-group__chevron" aria-hidden="true">
                    {expandedNames.has(group.name) ? "⌄" : "›"}
                  </span>
                  <strong>{group.name}</strong>
                  <span>{group.candidates.length} 个位置</span>
                </button>

                {expandedNames.has(group.name) ? (
                  <div className="local-scan-group__locations">
                    {group.candidates.map((candidate) => (
                      <div key={candidate.localPath} className="local-scan-location">
                        <span className="local-scan-location__source">{sourceLabel(candidate)}</span>
                        <span className="local-scan-location__path">{candidate.localPath}</span>
                        <span className="local-scan-location__hint">{candidate.sourceHint}</span>
                        <button
                          className="primary-button local-scan-location__button"
                          type="button"
                          onClick={() => void importCandidate(candidate.localPath)}
                        >
                          导入
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
