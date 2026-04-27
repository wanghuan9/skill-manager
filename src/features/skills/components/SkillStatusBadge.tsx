import type { SkillSummary } from "@/features/skills/state/skill-store";

type SkillStatusBadgeProps = {
  status: SkillSummary["collabStatus"];
};

const statusMap = {
  "update-available": { label: "可更新", toneClass: "tone-positive" },
  "pending-push": { label: "待推送", toneClass: "tone-info" },
} as const;

export function SkillStatusBadge({ status }: SkillStatusBadgeProps) {
  if (!(status in statusMap)) {
    return null;
  }

  const config = statusMap[status as keyof typeof statusMap];

  return <span className={`status-badge ${config.toneClass}`}>{config.label}</span>;
}
