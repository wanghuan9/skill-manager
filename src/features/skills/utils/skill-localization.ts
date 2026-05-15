import type {
  AppLanguage,
  GitAccountSummary,
  SkillSummary,
  ToolConfig,
} from "@/features/skills/state/skill-store";
import { localizeToolStatusLabel } from "@/features/skills/utils/tool-status";

const SKILL_STATUS_TEXT_MAPPINGS: Array<[string, string]> = [
  ["已安装到本地，可继续同步到工具。", "Installed locally. You can continue syncing it to tools."],
  ["仓库技能已导入，后续可继续同步到工具。", "Repository skills imported. You can continue syncing them to tools."],
  ["本地技能已安装，可继续同步到目标工具。", "Local skill installed. You can continue syncing it to target tools."],
  ["已纳入管理，建议同步到目标工具。", "Now managed here. Sync it to target tools when you're ready."],
  ["已拉取远端最新内容，可继续同步到工具。", "Pulled the latest remote changes. You can continue syncing to tools."],
  ["本地已修改 4 个文件，建议打开 canonical repo 后提交 MR。", "4 local files changed. Open the canonical repo and submit an MR."],
  ["远端有新版本，建议更新后重新同步到工具。", "A newer remote version is available. Update and resync to tools."],
  ["本地存在待处理改动，可在 canonical repo 中提交 MR。", "There are pending local changes. You can submit an MR from the canonical repo."],
  ["本地与远端一致，可直接使用。", "Local and remote are in sync. Ready to use."],
];

const GIT_ACCOUNT_STATUS_MAPPINGS: Array<[string, string]> = [
  ["已连接，可发起 PR", "Connected. Ready to open PRs."],
];

function pickLocalizedValue(
  value: string,
  language: AppLanguage,
  mappings: Array<[string, string]>,
) {
  const normalizedValue = value.trim();
  const matched = mappings.find(([chinese, english]) =>
    normalizedValue === chinese || normalizedValue === english
  );
  if (!matched) {
    return value;
  }

  return language === "en" ? matched[1] : matched[0];
}

export function localizeSkillStatusText(statusText: string, language: AppLanguage) {
  return pickLocalizedValue(statusText, language, SKILL_STATUS_TEXT_MAPPINGS);
}

export function localizeGitAccountStatusLabel(statusLabel: string, language: AppLanguage) {
  return pickLocalizedValue(statusLabel, language, GIT_ACCOUNT_STATUS_MAPPINGS);
}

export function localizeSkillSummary(skill: SkillSummary, language: AppLanguage): SkillSummary {
  return {
    ...skill,
    statusText: localizeSkillStatusText(skill.statusText, language),
    tools: skill.tools.map((tool) => ({
      ...tool,
      statusLabel: localizeToolStatusLabel(tool.statusLabel, language),
    })),
  };
}

export function localizeSkillSummaries(skills: SkillSummary[], language: AppLanguage) {
  return skills.map((skill) => localizeSkillSummary(skill, language));
}

export function localizeToolConfigs(toolConfigs: ToolConfig[], language: AppLanguage) {
  return toolConfigs.map((tool) => ({
    ...tool,
    statusLabel: localizeToolStatusLabel(tool.statusLabel, language),
  }));
}

export function localizeGitAccountSummary(
  gitAccount: GitAccountSummary | null,
  language: AppLanguage,
) {
  if (!gitAccount) {
    return gitAccount;
  }

  return {
    ...gitAccount,
    statusLabel: localizeGitAccountStatusLabel(gitAccount.statusLabel, language),
  };
}
