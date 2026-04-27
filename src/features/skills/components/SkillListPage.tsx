import { useDeferredValue, useMemo, useState } from "react";
import { filterSkills } from "@/features/skills/state/skill-selectors";
import { SkillCard } from "@/features/skills/components/SkillCard";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { groupSkillsBySource } from "@/features/skills/utils/skill-groups";

type SkillToolbarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  showGroupView: boolean;
  onShowGroupViewChange: (value: boolean) => void;
};

export function SkillListToolbar(props: SkillToolbarProps) {
  const { query, onQueryChange, showGroupView, onShowGroupViewChange } = props;
  const { installedSkills, isLoading, refreshWorkspace, updateAllSkills } = useSkillWorkspace();
  const updatableSkillCount = useMemo(
    () => installedSkills.filter((skill) => skill.collabStatus === "update-available").length,
    [installedSkills],
  );

  return (
    <div className="skills-header-bar__tools">
      <label className="search-field search-field--header">
        <span className="sr-only">搜索技能</span>
        <input
          type="search"
          placeholder="搜索技能名称、来源..."
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>
      <button
        className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--toggle${showGroupView ? " is-active" : ""}`}
        type="button"
        aria-pressed={showGroupView}
        onClick={() => onShowGroupViewChange(!showGroupView)}
      >
        <span aria-hidden="true">{showGroupView ? "☰" : "≣"}</span>
        <span>{showGroupView ? "分组" : "平铺"}</span>
      </button>
      <button className="secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--refresh" type="button" onClick={() => void refreshWorkspace()}>
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          <svg viewBox="0 0 20 20" fill="none">
            <path
              d="M16.2 9.1a6.2 6.2 0 0 0-10.7-3.6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M3.7 3.9v3.7h3.7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M3.8 10.9a6.2 6.2 0 0 0 10.7 3.6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M16.3 16.1v-3.7h-3.7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span>刷新</span>
      </button>
      <button
        className="secondary-button secondary-button--compact skills-toolbar-button"
        type="button"
        onClick={() => void updateAllSkills()}
        disabled={isLoading || updatableSkillCount === 0}
      >
        <span aria-hidden="true">↑</span>
        <span>全部更新</span>
      </button>
    </div>
  );
}

type SkillListPageProps = {
  query: string;
  showGroupView: boolean;
};

export function SkillListPage(props: SkillListPageProps) {
  const { query, showGroupView } = props;
  const { installedSkills, isLoading } = useSkillWorkspace();
  const deferredQuery = useDeferredValue(query);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const skills = useMemo(
    () => filterSkills(installedSkills, { query: deferredQuery, status: "all" }),
    [deferredQuery, installedSkills],
  );
  const groupedSkills = useMemo(() => groupSkillsBySource(skills), [skills]);

  function toggleGroup(groupId: string) {
    setCollapsedGroups((current) => ({
      ...current,
      [groupId]: !current[groupId],
    }));
  }

  return (
    <div className="skills-page">
      <div className="card-list">
        {isLoading ? (
          <div className="panel-card empty-state">
            <h3>正在加载技能</h3>
            <p>正在通过桌面端能力读取本地与仓库状态，请稍等。</p>
          </div>
        ) : groupedSkills.length > 0 ? (
          showGroupView ? (
          groupedSkills.map((group) => {
            const updateCount = group.skills.filter((skill) => skill.collabStatus === "update-available").length;
            const pendingPushCount = group.skills.filter((skill) => skill.collabStatus === "pending-push").length;
            const isCollapsed = collapsedGroups[group.id] ?? false;

            return (
              <section key={group.id} className="skill-group-section">
                <div
                  className="skill-group-section__header"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleGroup(group.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleGroup(group.id);
                    }
                  }}
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? "展开" : "收起"}来源分组 ${group.label}`}
                >
                  <div className="skill-group-section__title">
                    <span className="skill-group-section__badge">分组</span>
                    <h3>{group.label}</h3>
                    <span className="skill-group-section__count">{group.skills.length} 个技能</span>
                  </div>
                  <div className="skill-group-section__meta">
                    {updateCount > 0 ? <span>可更新 {updateCount}</span> : null}
                    {pendingPushCount > 0 ? <span>待推送 {pendingPushCount}</span> : null}
                    <button
                      className="skill-group-section__toggle"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleGroup(group.id);
                      }}
                      aria-expanded={!isCollapsed}
                      aria-label={`${isCollapsed ? "展开" : "收起"}来源分组`}
                    >
                      <span className={`skill-group-section__chevron${isCollapsed ? " is-collapsed" : ""}`}>
                        ⌄
                      </span>
                    </button>
                  </div>
                </div>
                {!isCollapsed ? (
                  <div className="skill-group-section__list">
                    {group.skills.map((skill) => <SkillCard key={skill.name} skill={skill} />)}
                  </div>
                ) : null}
              </section>
            );
          })
          ) : (
            skills.map((skill) => <SkillCard key={skill.name} skill={skill} />)
          )
        ) : (
          <div className="panel-card empty-state">
            <h3>暂无匹配的技能</h3>
            <p>调整搜索词或状态筛选后，这里会重新展示可操作的 skill。</p>
          </div>
        )}
      </div>
    </div>
  );
}
