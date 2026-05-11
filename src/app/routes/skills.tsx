import { SkillListPage } from "@/features/skills/components/SkillListPage";
import type { SkillStatusFilter } from "@/features/skills/state/skill-store";

type SkillsRouteProps = {
  query: string;
  statusFilter: SkillStatusFilter;
  showGroupView: boolean;
};

export function SkillsRoute(props: SkillsRouteProps) {
  return (
    <SkillListPage
      query={props.query}
      statusFilter={props.statusFilter}
      showGroupView={props.showGroupView}
    />
  );
}
