type SetSkillAllToolStatuses = (input: {
  skillName: string;
  skillPath?: string;
  enabled: boolean;
  toolNames: string[];
}) => Promise<void>;

type SetToolSkillStatuses = (input: {
  toolName: string;
  skillNames: string[];
  enabled: boolean;
  toolNames: string[];
}) => Promise<void>;

type SetSkillAllToolsEnabledInput = {
  skillName: string;
  skillPath?: string;
  enabled: boolean;
  toolNames: string[];
  setSkillAllToolStatuses: SetSkillAllToolStatuses;
  setToolSkillStatuses: SetToolSkillStatuses;
};

function isMissingBulkCommandError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("set_skill_all_tool_statuses")
    || message.includes("unknown command")
    || message.includes("not found");
}

export async function setSkillAllToolsEnabled(input: SetSkillAllToolsEnabledInput) {
  try {
    await input.setSkillAllToolStatuses({
      skillName: input.skillName,
      skillPath: input.skillPath,
      enabled: input.enabled,
      toolNames: input.toolNames,
    });
    return [];
  } catch (error) {
    if (!isMissingBulkCommandError(error)) {
      throw error;
    }
  }

  const failedToolNames: string[] = [];
  for (const toolName of input.toolNames) {
    try {
      await input.setToolSkillStatuses({
        toolName,
        skillNames: [input.skillName],
        enabled: input.enabled,
        toolNames: input.toolNames,
      });
    } catch {
      failedToolNames.push(toolName);
    }
  }
  return failedToolNames;
}
