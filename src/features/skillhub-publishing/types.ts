export type PublishStatus =
  | "unpublished"
  | "update-available"
  | "published"
  | "publishing"
  | "reviewing"
  | "failed";

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
