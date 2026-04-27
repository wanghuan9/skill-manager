import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";

export function LocalSkillImportList() {
  const { importCandidate, isLoading, localCandidates } = useSkillWorkspace();

  if (isLoading) {
    return (
      <section className="placeholder-card">
        <h3>正在扫描本地技能</h3>
        <p>系统正在读取常见技能目录，马上给出可导入项。</p>
      </section>
    );
  }

  if (localCandidates.length === 0) {
    return (
      <section className="placeholder-card">
        <h3>没有待导入的本地技能</h3>
        <p>当前本机已发现的 skill 都已经纳入统一管理了。</p>
      </section>
    );
  }

  return (
    <div className="placeholder-grid">
      {localCandidates.map((candidate) => (
        <article key={candidate.localPath} className="placeholder-card install-card">
          <div className="install-card__header">
            <div>
              <h3>{candidate.name}</h3>
              <p>{candidate.description}</p>
            </div>
            <span className="status-badge tone-info">待导入</span>
          </div>
          <dl className="install-meta">
            <div>
              <dt>本地路径</dt>
              <dd>{candidate.localPath}</dd>
            </div>
            <div>
              <dt>检测来源</dt>
              <dd>{candidate.detectedFrom}</dd>
            </div>
          </dl>
          <p className="repo-form__hint">{candidate.sourceHint}</p>
          <button
            className="primary-button"
            type="button"
            onClick={() => void importCandidate(candidate.localPath)}
          >
            导入管理
          </button>
        </article>
      ))}
    </div>
  );
}
