import type { UpdatePreviewSnapshot } from "@/features/skills/state/skill-store";
import type {
  PublishSkillInput,
  PublishUpdateFileRevertInput,
  PublishUpdateHunkRevertInput,
  PublishUpdatePreviewInput,
  PublishableSkill,
  PublishableSkillSnapshot,
  PublishingUnmanagedSkill,
  PublishingAuthState,
  PublishingPlatform,
} from "./types";

export type PublishingAdapterCapabilities = {
  batchPublishing: boolean;
  updatePreview: boolean;
  revertUpdateFile: boolean;
  revertUpdateHunk: boolean;
};

export const DEFAULT_PUBLISHING_ADAPTER_CAPABILITIES: PublishingAdapterCapabilities = {
  batchPublishing: false,
  updatePreview: false,
  revertUpdateFile: false,
  revertUpdateHunk: false,
};

export const CACHED_SNAPSHOT_BACKGROUND_REFRESH_DELAY_MS = 1_500;

export type PublishingPlatformAdapter = {
  platform: PublishingPlatform;
  capabilities?: Partial<PublishingAdapterCapabilities>;
  /**
   * Delay the first remote synchronization when a persisted publishing snapshot is available.
   */
  cachedSnapshotRefreshDelayMs?: number;
  /**
   * Whether fetchSkills already compares the complete local and remote file sets.
   */
  fetchSkillsIncludesFileDiff?: boolean;
  getAuthState: () => Promise<PublishingAuthState>;
  fetchSkills: (forceRefresh?: boolean) => Promise<PublishableSkillSnapshot>;
  reconcileSkills?: (forceRefresh?: boolean) => Promise<PublishableSkillSnapshot>;
  readCachedAuthState?: () => PublishingAuthState | null;
  writeCachedAuthState?: (authState: PublishingAuthState) => void;
  readCachedSnapshot?: () => PublishableSkillSnapshot | null;
  writeCachedSnapshot?: (snapshot: PublishableSkillSnapshot) => void;
  refreshSkill: (skill: PublishableSkill) => Promise<PublishableSkill>;
  publishSkill: (input: PublishSkillInput) => Promise<PublishableSkill>;
  isPublishResultUnknown?: (error: unknown) => boolean;
  getUpdatePreview?: (input: PublishUpdatePreviewInput) => Promise<UpdatePreviewSnapshot>;
  revertUpdateFile?: (input: PublishUpdateFileRevertInput) => Promise<UpdatePreviewSnapshot>;
  revertUpdateHunk?: (input: PublishUpdateHunkRevertInput) => Promise<UpdatePreviewSnapshot>;
  fetchUnmanagedSkills?: () => Promise<PublishingUnmanagedSkill[]>;
  importAndPublishUnmanagedSkill?: (skill: PublishingUnmanagedSkill) => Promise<void>;
};

export function getPublishingAdapterCapabilities(
  adapter: Pick<PublishingPlatformAdapter, "capabilities">,
): PublishingAdapterCapabilities {
  return {
    ...DEFAULT_PUBLISHING_ADAPTER_CAPABILITIES,
    ...adapter.capabilities,
  };
}
