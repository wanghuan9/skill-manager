import {
  fetchLocalSkillCandidates,
  importLocalSkill,
} from "@/features/skills/api/skill-client";
import {
  getSkillHubAuthStatus,
  fetchSkillHubPublishUpdatePreview,
  listSkillHubPublishableSkills,
  publishSkillHubSkill,
  reconcileSkillHubPublishableSkills,
  revertSkillHubPublishUpdateFile,
  revertSkillHubPublishUpdateHunk,
  type SkillHubAuthStatus,
  type SkillHubPublishableSkill,
  type SkillHubPublishableSkillsSnapshot,
} from "@/features/skillhub-publishing/publishing-client";
import {
  CACHED_SNAPSHOT_BACKGROUND_REFRESH_DELAY_MS,
  type PublishingPlatformAdapter,
} from "../publishing-adapter";
import type {
  PublishableSkill,
  PublishingAuthState,
  PublishingUnmanagedSkill,
  PublishableSkillSnapshot,
} from "../types";

const SKILLHUB_PLATFORM = {
  id: "skillhub",
  label: "SkillHub",
} as const;
const SKILLHUB_AUTH_CACHE_KEY = "skilldock.skillhubPublishingAuthCache";
const SKILLHUB_PUBLISHING_CACHE_KEY = "skilldock.skillhubPublishingCache";

function toPublishingAuthState(auth: SkillHubAuthStatus): PublishingAuthState {
  const displayName = auth.displayName.trim();
  const handle = auth.handle.trim();
  const account = displayName || (handle ? `@${handle}` : String(auth.userId));
  return {
    connected: auth.connected,
    accountLabel: auth.connected ? account : "",
    verifiedAt: auth.verifiedAt,
  };
}

function toPublishableSkill(skill: SkillHubPublishableSkill): PublishableSkill {
  return {
    ...skill,
    remoteContentHash: "",
    remotePrimaryContentHash: "",
  };
}

async function fetchSkillHubSkills(forceRefresh = false) {
  const snapshot = await listSkillHubPublishableSkills(forceRefresh);
  return {
    ...snapshot,
    skills: snapshot.skills.map(toPublishableSkill),
  };
}

function toPublishableSkillSnapshot(snapshot: SkillHubPublishableSkillsSnapshot): PublishableSkillSnapshot {
  return {
    ...snapshot,
    skills: snapshot.skills.map(toPublishableSkill),
  };
}

function readCachedSkillHubAuthState(): PublishingAuthState | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.localStorage.getItem(SKILLHUB_AUTH_CACHE_KEY);
    if (!value) {
      const snapshot = readCachedSkillHubSnapshot();
      return snapshot
        ? {
          connected: !snapshot.authorizationRequired,
          accountLabel: "",
          verifiedAt: "",
        }
        : null;
    }
    const authState = JSON.parse(value) as Partial<PublishingAuthState>;
    if (
      typeof authState.connected !== "boolean"
      || typeof authState.accountLabel !== "string"
      || typeof authState.verifiedAt !== "string"
    ) {
      return null;
    }
    return authState as PublishingAuthState;
  } catch {
    return null;
  }
}

function writeCachedSkillHubAuthState(authState: PublishingAuthState) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SKILLHUB_AUTH_CACHE_KEY, JSON.stringify(authState));
  } catch {
    // The native credential remains authoritative when browser storage is unavailable.
  }
}

function readCachedSkillHubSnapshot(): PublishableSkillSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.localStorage.getItem(SKILLHUB_PUBLISHING_CACHE_KEY);
    if (!value) {
      return null;
    }
    const snapshot = JSON.parse(value) as Partial<PublishableSkillSnapshot>;
    if (!Array.isArray(snapshot.skills) || typeof snapshot.authorizationRequired !== "boolean") {
      return null;
    }
    return {
      skills: snapshot.skills,
      displayOrder: Array.isArray(snapshot.displayOrder) ? snapshot.displayOrder : [],
      authorizationRequired: snapshot.authorizationRequired,
      statusSyncError: snapshot.statusSyncError ?? "",
    };
  } catch {
    return null;
  }
}

function writeCachedSkillHubSnapshot(snapshot: PublishableSkillSnapshot) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SKILLHUB_PUBLISHING_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // The live snapshot remains usable when browser storage is unavailable.
  }
}

async function publishSkillHub(input: {
  skillName: string;
  localPath: string;
  remoteSkillId?: string;
  expectedRemoteVersion?: string;
  changelog?: string;
}) {
  await publishSkillHubSkill(input);
  const snapshot = await fetchSkillHubSkills();
  return findPublishedSkill(snapshot.skills, input.skillName, input.remoteSkillId);
}

function toUnmanagedSkill(skill: Awaited<ReturnType<typeof fetchLocalSkillCandidates>>[number]): PublishingUnmanagedSkill {
  return skill;
}

function findPublishedSkill(
  skills: PublishableSkill[],
  skillName: string,
  remoteSkillId?: string,
): PublishableSkill {
  const publishedSkill = skills.find((skill) => (
    skill.name === skillName
      && (!remoteSkillId || skill.remoteSkillId === remoteSkillId || !skill.remoteSkillId)
  ));
  if (!publishedSkill) {
    throw new Error("SkillHub 发布成功后未找到对应的本地 Skill，请刷新后确认发布状态。");
  }
  return publishedSkill;
}

export const skillHubPublishingAdapter: PublishingPlatformAdapter = {
  platform: SKILLHUB_PLATFORM,
  cachedSnapshotRefreshDelayMs: CACHED_SNAPSHOT_BACKGROUND_REFRESH_DELAY_MS,
  capabilities: {
    updatePreview: true,
    revertUpdateFile: true,
    revertUpdateHunk: true,
  },
  getAuthState: async () => toPublishingAuthState(await getSkillHubAuthStatus()),
  fetchSkills: fetchSkillHubSkills,
  reconcileSkills: async (forceRefresh) => toPublishableSkillSnapshot(
    await reconcileSkillHubPublishableSkills(forceRefresh),
  ),
  readCachedAuthState: readCachedSkillHubAuthState,
  writeCachedAuthState: writeCachedSkillHubAuthState,
  readCachedSnapshot: readCachedSkillHubSnapshot,
  writeCachedSnapshot: writeCachedSkillHubSnapshot,
  refreshSkill: async (skill) => {
    // 文件回退后必须走完整 diff，轻量列表不会计算 updateFileCount。
    const snapshot = toPublishableSkillSnapshot(
      await reconcileSkillHubPublishableSkills(true),
    );
    return findPublishedSkill(snapshot.skills, skill.name, skill.remoteSkillId);
  },
  publishSkill: publishSkillHub,
  getUpdatePreview: fetchSkillHubPublishUpdatePreview,
  revertUpdateFile: revertSkillHubPublishUpdateFile,
  revertUpdateHunk: revertSkillHubPublishUpdateHunk,
  fetchUnmanagedSkills: async () => (await fetchLocalSkillCandidates()).map(toUnmanagedSkill),
  importAndPublishUnmanagedSkill: async (skill) => {
    await importLocalSkill(skill.localPath);
    const importedSnapshot = await fetchSkillHubSkills();
    const importedSkill = importedSnapshot.skills.find((item) => item.name === skill.name);
    if (!importedSkill) {
      throw new Error("Skill 导入成功，但尚未出现在 SkillDock 托管列表中，请刷新后再发布。");
    }
    await publishSkillHub({
      skillName: importedSkill.name,
      localPath: importedSkill.localPath,
      remoteSkillId: importedSkill.remoteSkillId || undefined,
      expectedRemoteVersion: importedSkill.remoteVersion || undefined,
    });
  },
};
