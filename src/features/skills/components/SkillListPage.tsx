import { useDeferredValue, useMemo, useState } from "react";
import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";
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

function GridIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 4.25h4.5v4.5H4v-4.5ZM11.5 4.25H16v4.5h-4.5v-4.5ZM4 11.25h4.5v4.5H4v-4.5ZM11.5 11.25H16v4.5h-4.5v-4.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function GroupIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 5.5h12M4 10h12M4 14.5h12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M4 5.5h2M4 10h2M4 14.5h2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function RefreshIcon({ isSpinning = false }: { isSpinning?: boolean }) {
  return (
    <svg className={isSpinning ? "skills-toolbar-button__svg is-spinning" : "skills-toolbar-button__svg"} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M16.2 9.1a6.2 6.2 0 0 0-10.7-3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.7 3.9v3.7h3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.8 10.9a6.2 6.2 0 0 0 10.7 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.3 16.1v-3.7h-3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UpdateAllIcon({ isSpinning = false }: { isSpinning?: boolean }) {
  return (
    <svg className={isSpinning ? "skills-toolbar-button__svg is-spinning" : "skills-toolbar-button__svg"} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M15.2 6.6A6.25 6.25 0 1 0 16 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15.3 4.2v2.8h-2.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SkillListToolbar(props: SkillToolbarProps) {
  const { query, onQueryChange, showGroupView, onShowGroupViewChange } = props;
  const { installedSkills, isLoading, refreshWorkspace, updateAllSkills } = useSkillWorkspace();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const updatableSkillCount = useMemo(
    () => installedSkills.filter((skill) => skill.collabStatus === "update-available").length,
    [installedSkills],
  );
  const updateAllButtonLabel = updatableSkillCount > 0 ? `全部更新 (${updatableSkillCount})` : "全部更新";

  async function handleRefreshWorkspace() {
    if (isRefreshing) {
      return;
    }

    setIsRefreshing(true);
    await waitForNextPaint();
    try {
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : "刷新失败";
      window.alert(message);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function handleUpdateAllSkills() {
    if (updatableSkillCount === 0 || isUpdatingAll) {
      return;
    }

    setIsUpdatingAll(true);
    await waitForNextPaint();
    try {
      await updateAllSkills();
    } catch (error) {
      const message = error instanceof Error ? error.message : "批量更新失败";
      window.alert(message);
    } finally {
      setIsUpdatingAll(false);
    }
  }

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
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          {showGroupView ? <GroupIcon /> : <GridIcon />}
        </span>
        <span>{showGroupView ? "分组" : "平铺"}</span>
      </button>
      <button
        className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--refresh${isRefreshing ? " is-loading" : ""}`}
        type="button"
        onClick={() => void handleRefreshWorkspace()}
        disabled={isRefreshing}
      >
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          <RefreshIcon isSpinning={isRefreshing} />
        </span>
        <span>刷新</span>
      </button>
      <button
        className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--update-all${isUpdatingAll ? " is-loading" : ""}`}
        type="button"
        onClick={() => void handleUpdateAllSkills()}
        disabled={isLoading || isUpdatingAll || updatableSkillCount === 0}
      >
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          <UpdateAllIcon isSpinning={isUpdatingAll} />
        </span>
        <span>{isUpdatingAll ? "更新中..." : updateAllButtonLabel}</span>
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

  function isGroupCollapsed(groupId: string) {
    return collapsedGroups[groupId] ?? true;
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroups((current) => ({
      ...current,
      [groupId]: !(current[groupId] ?? true),
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
            const isCollapsed = isGroupCollapsed(group.id);

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
