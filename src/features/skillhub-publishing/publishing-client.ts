import { invoke } from "@tauri-apps/api/core";
import type { UpdatePreviewSnapshot } from "@/features/skills/state/skill-store";

export type SkillHubAuthStatus = {
  connected: boolean;
  handle: string;
  userId: number;
  verifiedAt: string;
};

export type SkillHubPublishStatus = "unpublished" | "update-available" | "published" | "publishing" | "reviewing" | "failed";

export type SkillHubPublishableSkill = {
  name: string;
  description: string;
  localPath: string;
  managementOwner?: string;
  sourceLabel?: string;
  sourceType?: string;
  sourceUrl?: string;
  remoteUpdatedAt?: string;
  localUpdatedAt?: string;
  lastEditor?: string;
  gitLinked?: boolean;
  localChangeCount?: number;
  updateFileCount: number;
  localContentHash: string;
  fileCount: number;
  packageSize: number;
  remoteSkillId: string;
  remoteVersion: string;
  lastPublishedAt: string;
  publishStatus: SkillHubPublishStatus;
  failureReason: string;
  marketUrl: string;
  targetVersion: string;
};

export type SkillHubPublishableSkillsSnapshot = {
  skills: SkillHubPublishableSkill[];
  authorizationRequired: boolean;
  statusSyncError: string;
};

export type SkillHubPublishInput = {
  skillName: string;
  localPath: string;
  remoteSkillId?: string;
  expectedRemoteVersion?: string;
  changelog?: string;
};

export type SkillHubUnmanagedSkill = {
  name: string;
  description: string;
  localPath: string;
  detectedFrom: string;
  sourceHint: string;
  toolId?: string;
  resolvedPath?: string;
};

type SkillHubPublishResult = { message: string };

export function getSkillHubAuthStatus(): Promise<SkillHubAuthStatus> {
  return invoke("get_skillhub_auth_status");
}

export function saveSkillHubAuthToken(token: string): Promise<SkillHubAuthStatus> {
  return invoke("save_skillhub_auth_token", { token });
}

export function clearSkillHubAuthToken(): Promise<void> {
  return invoke("clear_skillhub_auth_token");
}

export function listSkillHubPublishableSkills(forceRefresh = false): Promise<SkillHubPublishableSkillsSnapshot> {
  return invoke("list_skillhub_publishable_skills", { forceRefresh });
}

export function reconcileSkillHubPublishableSkills(forceRefresh = false): Promise<SkillHubPublishableSkillsSnapshot> {
  return invoke("reconcile_skillhub_publishable_skills", { forceRefresh });
}

export function publishSkillHubSkill(input: SkillHubPublishInput): Promise<SkillHubPublishResult> {
  return invoke("publish_skillhub_skill", { input });
}

export function fetchSkillHubPublishUpdatePreview(input: {
  skillName: string;
  localPath: string;
  remoteSkillId: string;
  remoteVersion: string;
}): Promise<UpdatePreviewSnapshot> {
  return invoke("get_skillhub_publish_update_preview", input);
}

export function revertSkillHubPublishUpdateHunk(input: {
  skillName: string;
  localPath: string;
  remoteSkillId: string;
  remoteVersion: string;
  relativePath: string;
  expectedContent: string;
  content: string;
}): Promise<UpdatePreviewSnapshot> {
  return invoke("revert_skillhub_publish_update_hunk", input);
}
