import { SkillListPage } from "@/features/skills/components/SkillListPage";
import type { ManagedSkillOwnerFilter, SkillStatusFilter } from "@/features/skills/state/skill-store";
import type { SkillSourceId, ToolSkillManagementFilter } from "@/features/skills/utils/skill-source-view";
import type { SkillGroupMode, SkillViewMode } from "@/features/skills/utils/skill-view-preference";

type SkillsRouteProps = {
  activeSourceId: SkillSourceId;
  onActiveSourceIdChange: (sourceId: SkillSourceId) => void;
  focusedManagedSkillName: string;
  onShowManagedSkill: (skillName: string) => void;
  onImportFromLocal?: () => void;
  onInstallFromGit?: () => void;
  onInstallFromMarketplace?: () => void;
  query: string;
  statusFilter: SkillStatusFilter;
  ownerFilter: ManagedSkillOwnerFilter;
  managementFilter: ToolSkillManagementFilter;
  viewMode: SkillViewMode;
  groupMode: SkillGroupMode;
  isBatchSelecting: boolean;
  onBatchSelectingChange: (isSelecting: boolean) => void;
};

export function SkillsRoute(props: SkillsRouteProps) {
  return (
    <SkillListPage
      activeSourceId={props.activeSourceId}
      onActiveSourceIdChange={props.onActiveSourceIdChange}
      focusedManagedSkillName={props.focusedManagedSkillName}
      onShowManagedSkill={props.onShowManagedSkill}
      onImportFromLocal={props.onImportFromLocal}
      onInstallFromGit={props.onInstallFromGit}
      onInstallFromMarketplace={props.onInstallFromMarketplace}
      query={props.query}
      statusFilter={props.statusFilter}
      ownerFilter={props.ownerFilter}
      managementFilter={props.managementFilter}
      viewMode={props.viewMode}
      groupMode={props.groupMode}
      isBatchSelecting={props.isBatchSelecting}
      onBatchSelectingChange={props.onBatchSelectingChange}
    />
  );
}
