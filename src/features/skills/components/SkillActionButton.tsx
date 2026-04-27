import type { SkillSummary } from "@/features/skills/state/skill-store";

type SkillActionButtonProps = {
  status: SkillSummary["collabStatus"];
  onClick?: () => void;
};

const actionMap = {
  clean: "同步",
  "update-available": "更新",
  "pending-push": "处理",
  diverged: "查看",
} as const;

export function SkillActionButton({ status, onClick }: SkillActionButtonProps) {
  return (
    <button className="primary-button" type="button" onClick={onClick}>
      {actionMap[status]}
    </button>
  );
}
