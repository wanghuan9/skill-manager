import { useEffect, useMemo, useState } from "react";
import { useTranslate } from "@/app/i18n";
import { useNotifications } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import {
  type AppUpdateCheckResult,
  type AppUpdateProgress,
  checkForAppUpdate,
} from "@/features/app-update/app-update-client";

const AUTO_UPDATE_CHECK_DELAY_MS = 2000;

let autoUpdatePromptState: "idle" | "scheduled" | "running" | "done" = "idle";

export function resetAutoUpdatePromptStateForTests() {
  autoUpdatePromptState = "idle";
}

export function AppUpdateAutoPrompt() {
  const { t } = useTranslate();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const [update, setUpdate] = useState<AppUpdateCheckResult | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);

  useEffect(() => {
    if (autoUpdatePromptState !== "idle") {
      return;
    }

    autoUpdatePromptState = "scheduled";
    const timerId = window.setTimeout(() => {
      autoUpdatePromptState = "running";
      void checkForAppUpdate()
        .then((nextUpdate) => {
          if (nextUpdate.available && nextUpdate.install) {
            setUpdate(nextUpdate);
          }
        })
        .catch((error) => {
          console.warn("Automatic app update check failed", error);
        })
        .finally(() => {
          autoUpdatePromptState = "done";
        });
    }, AUTO_UPDATE_CHECK_DELAY_MS);

    return () => {
      window.clearTimeout(timerId);
      if (autoUpdatePromptState === "scheduled") {
        autoUpdatePromptState = "idle";
      }
    };
  }, []);

  const releaseNotes = useMemo(() => buildReleaseNotes(update), [update]);

  if (!update?.available || !update.install) {
    return null;
  }

  async function handleInstallUpdate() {
    if (!update?.install || isInstalling) {
      return;
    }

    setIsInstalling(true);
    setProgress(null);
    notify({ message: t("updates.installing"), tone: "info" });

    try {
      await update.install((nextProgress) => {
        setProgress(nextProgress);
      });
    } catch (error) {
      setIsInstalling(false);
      reportFailure(error, {
        operation: "install_app_update",
        fallbackMessage: t("updates.installFailed"),
      });
    }
  }

  return (
    <div
      className={`app-update-notice${isPanelOpen ? " is-panel-open" : ""}`}
      aria-live="polite"
      onMouseEnter={() => setIsPanelOpen(true)}
      onMouseLeave={() => setIsPanelOpen(false)}
      onFocus={() => setIsPanelOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setIsPanelOpen(false);
        }
      }}
    >
      <button
        className={`app-update-pill${isPanelOpen ? " is-open" : ""}`}
        type="button"
        onClick={() => void handleInstallUpdate()}
        aria-expanded={isPanelOpen}
        disabled={isInstalling}
      >
        {isInstalling ? "Updating" : "Update"}
      </button>
      <section className="app-update-popover" aria-label={t("updates.popover.aria")} aria-hidden={!isPanelOpen}>
        <header className="app-update-popover__header">
          <div>
            <h2>What's in this update</h2>
            <p>{update.version ? `Version ${update.version}` : "New version available"}</p>
          </div>
        </header>
        <div className="app-update-popover__content">
          {releaseNotes.map((line, index) => (
            <p key={`${line}-${index}`} className={line.startsWith("-") || line.startsWith("*") ? "is-bullet" : ""}>
              {line}
            </p>
          ))}
        </div>
        {progress ? <p className="app-update-popover__progress">{formatUpdateSize(progress)}</p> : null}
      </section>
    </div>
  );
}

function buildReleaseNotes(update: AppUpdateCheckResult | null) {
  const bodyLines = update?.body
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (bodyLines && bodyLines.length > 0) {
    return bodyLines;
  }

  if (update?.version) {
    return [`Version ${update.version}`, "- New version is ready to install"];
  }

  return ["New version is ready to install"];
}

function formatUpdateSize(progress: AppUpdateProgress) {
  if (!progress.totalBytes) {
    return `${formatBytes(progress.downloadedBytes)} downloaded`;
  }

  return `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`;
}

function formatBytes(bytes: number) {
  if (bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  const precision = unitIndex === 0 ? 0 : 1;

  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}
