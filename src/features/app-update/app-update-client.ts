import { isTauriRuntime } from "@/app/is-tauri-runtime";
import { getVersion } from "@tauri-apps/api/app";
import { type DownloadEvent, check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const FALLBACK_APP_VERSION = "0.1.0";
const APP_UPDATE_CHECK_TIMEOUT_MS = 15_000;
const RELEASE_NOTES_HISTORY_KEY = "releaseNotesHistory";

export type AppUpdateReleaseNoteEntry = {
  version: string;
  body: string;
  date?: string;
};

export type AppUpdateProgress = {
  downloadedBytes: number;
  totalBytes?: number;
};

export type AppUpdateCheckResult = {
  available: boolean;
  currentVersion: string;
  version?: string;
  date?: string;
  body?: string;
  releaseNotesHistory?: AppUpdateReleaseNoteEntry[];
  install?: (onProgress: (progress: AppUpdateProgress) => void) => Promise<void>;
};

function shouldUseTauriUpdater() {
  return isTauriRuntime();
}

export async function fetchCurrentAppVersion(): Promise<string> {
  if (!shouldUseTauriUpdater()) {
    return FALLBACK_APP_VERSION;
  }

  return getVersion();
}

export async function checkForAppUpdate(): Promise<AppUpdateCheckResult> {
  const currentVersion = await fetchCurrentAppVersion();

  if (!shouldUseTauriUpdater()) {
    return {
      available: false,
      currentVersion,
      releaseNotesHistory: [],
    };
  }

  const update = await check({ timeout: APP_UPDATE_CHECK_TIMEOUT_MS });
  if (!update) {
    return {
      available: false,
      currentVersion,
      releaseNotesHistory: [],
    };
  }

  const releaseNotesHistory = buildReleaseNotesHistory({
    currentVersion: update.currentVersion,
    latestVersion: update.version,
    latestBody: update.body,
    latestDate: update.date,
    rawJson: update.rawJson,
  });

  return {
    available: true,
    currentVersion: update.currentVersion,
    version: update.version,
    date: update.date,
    body: update.body,
    releaseNotesHistory,
    install: async (onProgress) => {
      let downloadedBytes = 0;
      let totalBytes: number | undefined;

      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          downloadedBytes = 0;
          totalBytes = event.data.contentLength;
        }

        if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
        }

        onProgress({
          downloadedBytes,
          totalBytes,
        });
      });

      await relaunch();
    },
  };
}

function buildReleaseNotesHistory(input: {
  currentVersion: string;
  latestVersion: string;
  latestBody?: string;
  latestDate?: string;
  rawJson: Record<string, unknown>;
}) {
  const parsedHistory = parseReleaseNotesHistory(input.rawJson);
  const latestVersion = input.latestVersion.trim();
  const latestBody = input.latestBody?.trim();
  const candidateEntries = [...parsedHistory];

  if (latestVersion && latestBody && !candidateEntries.some((entry) => entry.version === latestVersion)) {
    candidateEntries.push({
      version: latestVersion,
      body: latestBody,
      date: input.latestDate?.trim() || undefined,
    });
  }

  const historyOnUpgradePath = candidateEntries
    .filter((entry) => isVersionInUpgradePath(entry.version, input.currentVersion, latestVersion))
    .sort((left, right) => compareVersions(right.version, left.version));

  const uniqueHistory = new Map(historyOnUpgradePath.map((entry) => [entry.version, entry]));
  if (uniqueHistory.size > 0) {
    return [...uniqueHistory.values()];
  }

  if (latestVersion && latestBody) {
    return [
      {
        version: latestVersion,
        body: latestBody,
        date: input.latestDate?.trim() || undefined,
      },
    ];
  }

  return [];
}

function parseReleaseNotesHistory(rawJson: Record<string, unknown>) {
  const rawEntries = rawJson[RELEASE_NOTES_HISTORY_KEY];
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  return rawEntries.flatMap((entry) => {
    const normalizedEntry = normalizeReleaseNoteEntry(entry);
    return normalizedEntry ? [normalizedEntry] : [];
  });
}

function normalizeReleaseNoteEntry(value: unknown): AppUpdateReleaseNoteEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const version = readTrimmedString(record.version);
  const body = readTrimmedString(record.body) || readTrimmedString(record.notes);
  if (!version || !body) {
    return null;
  }

  return {
    version,
    body,
    date: readTrimmedString(record.date) || readTrimmedString(record.pub_date) || undefined,
  };
}

function readTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isVersionInUpgradePath(version: string, currentVersion: string, latestVersion: string) {
  if (!currentVersion || !latestVersion) {
    return true;
  }

  return compareVersions(version, currentVersion) > 0 && compareVersions(version, latestVersion) <= 0;
}

function compareVersions(left: string, right: string) {
  const leftParts = toVersionParts(left);
  const rightParts = toVersionParts(right);
  if (!leftParts || !rightParts) {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  }

  const partCount = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < partCount; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart === rightPart) {
      continue;
    }
    return leftPart - rightPart;
  }

  return 0;
}

function toVersionParts(version: string) {
  const parts = version
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number(part));

  if (parts.length === 0 || parts.some((part) => Number.isNaN(part))) {
    return null;
  }

  return parts;
}
