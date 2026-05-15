import { useTranslate } from "@/app/i18n";
import type { SkillSummary } from "@/features/skills/state/skill-store";

type SkillStatusBadgeProps = {
  status: SkillSummary["collabStatus"];
};

export function SkillStatusBadge({ status }: SkillStatusBadgeProps) {
  const { t } = useTranslate();
  const statusMap = {
    "update-available": { label: t("skill.status.updateAvailable"), toneClass: "tone-positive" },
    "pending-push": { label: t("skill.status.pendingPush"), toneClass: "tone-info" },
  } as const;

  if (!(status in statusMap)) {
    return null;
  }

  const config = statusMap[status as keyof typeof statusMap];

  return <span className={`status-badge ${config.toneClass}`}>{config.label}</span>;
}
