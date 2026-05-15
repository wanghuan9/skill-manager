import { isTauriRuntime } from "@/app/is-tauri-runtime";
import { getVersion } from "@tauri-apps/api/app";
import { type DownloadEvent, check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const FALLBACK_APP_VERSION = "0.1.0";

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
    };
  }

  const update = await check();
  if (!update) {
    return {
      available: false,
      currentVersion,
    };
  }

  return {
    available: true,
    currentVersion: update.currentVersion,
    version: update.version,
    date: update.date,
    body: update.body,
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
