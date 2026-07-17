import { SkillListPage } from "@/features/skills/components/SkillListPage";
import type { SkillStatusFilter } from "@/features/skills/state/skill-store";
import type { SkillSourceId, ToolSkillManagementFilter } from "@/features/skills/utils/skill-source-view";

type SkillsRouteProps = {
  activeSourceId: SkillSourceId;
  onActiveSourceIdChange: (sourceId: SkillSourceId) => void;
  onImportFromLocal?: () => void;
  onInstallFromGit?: () => void;
  onInstallFromMarketplace?: () => void;
  query: string;
  statusFilter: SkillStatusFilter;
  managementFilter: ToolSkillManagementFilter;
  showGroupView: boolean;
};

export function SkillsRoute(props: SkillsRouteProps) {
  return (
    <SkillListPage
      activeSourceId={props.activeSourceId}
      onActiveSourceIdChange={props.onActiveSourceIdChange}
      onImportFromLocal={props.onImportFromLocal}
      onInstallFromGit={props.onInstallFromGit}
      onInstallFromMarketplace={props.onInstallFromMarketplace}
      query={props.query}
      statusFilter={props.statusFilter}
      managementFilter={props.managementFilter}
      showGroupView={props.showGroupView}
    />
  );
}
