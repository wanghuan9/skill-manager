export const PUBLISHING_PLATFORM_IDS = ["secondary-market", "skillhub"] as const;

export type PublishingPlatformId = (typeof PUBLISHING_PLATFORM_IDS)[number];

export type PublishingPlatform = {
  id: PublishingPlatformId;
  label: string;
};

export type PublishingAuthState = {
  connected: boolean;
  accountLabel: string;
  verifiedAt: string;
};

export type PublishingUnmanagedSkill = {
  name: string;
  description: string;
  localPath: string;
  detectedFrom: string;
  sourceHint: string;
  toolId?: string;
  resolvedPath?: string;
};

export type PublishStatus =
  | "unpublished"
  | "update-available"
  | "published"
  | "publishing"
  | "reviewing"
  | "failed";

/**
 * Platform-neutral publish information for a SkillDock-managed skill.
 *
 * Adapters should use empty strings for values their remote platform does not expose so the
 * workbench can render one stable card shape for every platform.
 */
export type PublishableSkill = {
  name: string;
  description: string;
  localPath: string;
  sourceLabel?: string;
  sourceType?: string;
  sourceUrl?: string;
  remoteUpdatedAt?: string;
  localUpdatedAt?: string;
  lastEditor?: string;
  gitLinked?: boolean;
  localChangeCount?: number;
  updateFileCount?: number;
  localContentHash: string;
  fileCount: number;
  packageSize: number;
  remoteSkillId?: string;
  remoteVersion: string;
  lastPublishedAt?: string;
  remoteContentHash: string;
  remotePrimaryContentHash?: string;
  publishStatus: PublishStatus;
  failureReason: string;
  marketUrl: string;
  targetVersion: string;
};

export type PublishableSkillSnapshot = {
  skills: PublishableSkill[];
  authorizationRequired: boolean;
  statusSyncError?: string;
};

export type PublishSkillInput = {
  skillName: string;
  remoteSkillId?: string;
  expectedRemoteVersion?: string;
  changelog?: string;
};

export type PublishUpdatePreviewInput = {
  skillName: string;
  localPath: string;
  remoteSkillId: string;
  remoteVersion: string;
};

export type PublishUpdateFileRevertInput = PublishUpdatePreviewInput & {
  relativePath: string;
};

export type PublishUpdateHunkRevertInput = PublishUpdateFileRevertInput & {
  expectedContent: string;
  content: string;
};
