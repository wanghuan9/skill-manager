import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslate } from "@/app/i18n";
import { useNotifications } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import {
  type AppUpdateCheckResult,
  type AppUpdateProgress,
  checkForAppUpdate,
} from "@/features/app-update/app-update-client";
import { resolveAppUpdateReleaseNoteEntries } from "@/features/app-update/release-notes";

const AUTO_UPDATE_CHECK_DELAY_MS = 2000;
const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let autoUpdatePromptState: "idle" | "scheduled" | "running" | "done" = "idle";
let autoUpdatePromptedVersion = "";

export function resetAutoUpdatePromptStateForTests() {
  autoUpdatePromptState = "idle";
  autoUpdatePromptedVersion = "";
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
    const runAutoCheck = () => {
      autoUpdatePromptState = "running";
      void checkForAppUpdate()
        .then((nextUpdate) => {
          if (
            nextUpdate.available
            && nextUpdate.install
            && nextUpdate.version
            && nextUpdate.version !== autoUpdatePromptedVersion
          ) {
            autoUpdatePromptedVersion = nextUpdate.version;
            setUpdate(nextUpdate);
          }
        })
        .catch((error) => {
          console.warn("Automatic app update check failed", error);
          reportFailure(error, {
            operation: "auto_check_for_app_update",
            fallbackMessage: t("updates.autoCheckFailed"),
          });
        })
        .finally(() => {
          autoUpdatePromptState = "done";
        });
    };
    const timerId = window.setTimeout(runAutoCheck, AUTO_UPDATE_CHECK_DELAY_MS);
    const intervalId = window.setInterval(() => {
      if (autoUpdatePromptState === "running" || isInstalling) {
        return;
      }
      runAutoCheck();
    }, AUTO_UPDATE_CHECK_INTERVAL_MS);

    return () => {
      window.clearTimeout(timerId);
      window.clearInterval(intervalId);
      if (autoUpdatePromptState === "scheduled") {
        autoUpdatePromptState = "idle";
      }
    };
  }, [isInstalling]);

  const releaseNoteEntries = useMemo(() => resolveAppUpdateReleaseNoteEntries(update), [update]);

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
      <section
        className="app-update-popover"
        aria-label={t("updates.popover.aria")}
        aria-hidden={!isPanelOpen}
      >
        <header className="app-update-popover__header">
          <div>
            <h2>What's in this update</h2>
            <p>{update.version ? `Version ${update.version}` : "New version available"}</p>
          </div>
        </header>
        <div className="app-update-popover__content">
          <div className="app-update-popover__markdown">
            {releaseNoteEntries.map((entry) => (
              <section key={entry.version || entry.body} className="app-update-popover__release-section">
                {entry.version ? <p className="app-update-popover__release-version">{`Version ${entry.version}`}</p> : null}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.body}</ReactMarkdown>
              </section>
            ))}
          </div>
        </div>
        {progress ? <p className="app-update-popover__progress">{formatUpdateSize(progress)}</p> : null}
      </section>
    </div>
  );
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
