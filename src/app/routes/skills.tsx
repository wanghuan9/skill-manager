import { SkillListPage } from "@/features/skills/components/SkillListPage";

type SkillsRouteProps = {
  query: string;
  showGroupView: boolean;
};

export function SkillsRoute(props: SkillsRouteProps) {
  return <SkillListPage query={props.query} showGroupView={props.showGroupView} />;
}
