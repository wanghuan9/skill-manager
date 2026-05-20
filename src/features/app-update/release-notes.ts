import type { AppUpdateCheckResult, AppUpdateReleaseNoteEntry } from "@/features/app-update/app-update-client";

const DEFAULT_RELEASE_NOTES_TEXT = "New version is ready to install";

export function resolveAppUpdateReleaseNoteEntries(update: AppUpdateCheckResult | null): AppUpdateReleaseNoteEntry[] {
  if (!update) {
    return [];
  }

  const history = update.releaseNotesHistory?.filter((entry) => entry.body.trim()) ?? [];
  if (history.length > 0) {
    return history;
  }

  const body = update.body?.trim();
  if (body) {
    return [
      {
        version: update.version ?? "",
        body,
      },
    ];
  }

  return [
    {
      version: update.version ?? "",
      body: DEFAULT_RELEASE_NOTES_TEXT,
    },
  ];
}
