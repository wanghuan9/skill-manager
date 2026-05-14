import { SkillListPage } from "@/features/skills/components/SkillListPage";
import type { SkillStatusFilter } from "@/features/skills/state/skill-store";

type SkillsRouteProps = {
  onImportFromLocal?: () => void;
  onInstallFromGit?: () => void;
  onInstallFromMarketplace?: () => void;
  query: string;
  statusFilter: SkillStatusFilter;
  showGroupView: boolean;
};

export function SkillsRoute(props: SkillsRouteProps) {
  return (
    <SkillListPage
      onImportFromLocal={props.onImportFromLocal}
      onInstallFromGit={props.onInstallFromGit}
      onInstallFromMarketplace={props.onInstallFromMarketplace}
      query={props.query}
      statusFilter={props.statusFilter}
      showGroupView={props.showGroupView}
    />
  );
}
