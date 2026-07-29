import { useCallback, useEffect, useState } from "react";
import { useTranslate } from "@/app/i18n";
import { useNotifications } from "@/app/notifications";
import {
  disconnectGithubBackup,
  enableGithubBackup,
  fetchBackupConflicts,
  fetchBackupSnapshots,
  fetchBackupStatus,
  fetchGithubConnection,
  openExternalLink,
  resolveBackupConflict,
  restoreBackupSnapshot,
  runBackupSync,
  setBackupAutoBackup,
  setBackupDeviceName,
  subscribeBackupStatusChanges,
} from "@/features/skills/api/skill-client";
import type {
  BackupConflict,
  BackupSnapshotInfo,
  BackupStatus,
} from "@/features/skills/state/skill-store";

const DEFAULT_REPOSITORY_NAME = "skilldock-backup";

type BackupRouteProps = {
  onOpenGithubSettings: () => void;
};

function formatTimestamp(value: string, language: string) {
  if (!value) {
    return "—";
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return value;
  }
  return timestamp.toLocaleString(language === "en" ? "en-US" : "zh-CN");
}

export function BackupRoute({ onOpenGithubSettings }: BackupRouteProps) {
  const { language, t } = useTranslate();
  const { notify } = useNotifications();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [isGithubConnected, setIsGithubConnected] = useState(false);
  const [repositoryName, setRepositoryName] = useState(DEFAULT_REPOSITORY_NAME);
  const [deviceName, setDeviceName] = useState("");
  const [conflicts, setConflicts] = useState<BackupConflict[]>([]);
  const [snapshots, setSnapshots] = useState<BackupSnapshotInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeAction, setActiveAction] = useState("");

  const loadBackupDetails = useCallback(async (nextStatus?: BackupStatus) => {
    const resolvedStatus = nextStatus ?? await fetchBackupStatus();
    setStatus(resolvedStatus);
    setDeviceName(resolvedStatus.deviceName);
    if (!resolvedStatus.enabled) {
      setConflicts([]);
      setSnapshots([]);
      return;
    }
    const [nextConflicts, nextSnapshots] = await Promise.all([
      fetchBackupConflicts(),
      fetchBackupSnapshots(),
    ]);
    setConflicts(nextConflicts);
    setSnapshots(nextSnapshots);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([fetchGithubConnection(), fetchBackupStatus()])
      .then(async ([connection, initialStatus]) => {
        if (!active) {
          return;
        }
        setIsGithubConnected(connection.connected);
        await loadBackupDetails(initialStatus);
      })
      .catch((error) => {
        notify({ message: String(error), tone: "error" });
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });
    let unlisten: (() => void) | undefined;
    void subscribeBackupStatusChanges((nextStatus) => {
      if (active) {
        void loadBackupDetails(nextStatus);
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [loadBackupDetails, notify]);

  async function runAction(action: string, operation: () => Promise<void>) {
    if (activeAction) {
      return;
    }
    setActiveAction(action);
    try {
      await operation();
    } catch (error) {
      notify({ message: String(error), tone: "error" });
    } finally {
      setActiveAction("");
    }
  }

  function refreshAfterSync(nextStatus: BackupStatus) {
    setStatus(nextStatus);
    void loadBackupDetails(nextStatus);
  }

  if (isLoading || !status) {
    return <div className="panel-card backup-empty-state">{t("backup.loading")}</div>;
  }

  return (
    <div className="backup-page">
      <section className="panel-card backup-overview">
        <div className="backup-overview__identity">
          <span className={`backup-state-dot${status.enabled ? " is-enabled" : ""}`} />
          <div>
            <h2>{status.enabled ? t("backup.enabled") : t("backup.disabled")}</h2>
            <p>
              {status.enabled
                ? `${status.repositoryOwner}/${status.repositoryName}`
                : t("backup.disabledDescription")}
            </p>
          </div>
        </div>
        <div className="backup-overview__actions">
          {status.enabled ? (
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={Boolean(activeAction)}
                onClick={() => void runAction("sync", async () => {
                  const result = await runBackupSync();
                  refreshAfterSync(result.status);
                  notify({ message: t("backup.syncSuccess"), tone: "success" });
                })}
              >
                {activeAction === "sync" ? t("backup.syncing") : t("backup.syncNow")}
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={() => void openExternalLink(
                  `https://github.com/${status.repositoryOwner}/${status.repositoryName}`,
                )}
              >
                {t("backup.openRepository")}
              </button>
            </>
          ) : null}
        </div>
      </section>

      {!status.enabled ? (
        <section className="panel-card backup-setup">
          <h3>{t("backup.setupTitle")}</h3>
          <p>{t("backup.setupDescription")}</p>
          {isGithubConnected ? (
            <div className="backup-setup__form">
              <label htmlFor="backup-repository-name">{t("backup.repositoryName")}</label>
              <input
                id="backup-repository-name"
                value={repositoryName}
                maxLength={100}
                onChange={(event) => setRepositoryName(event.target.value)}
              />
              <button
                className="primary-button"
                type="button"
                disabled={!repositoryName.trim() || Boolean(activeAction)}
                onClick={() => void runAction("enable", async () => {
                  const result = await enableGithubBackup(repositoryName.trim());
                  refreshAfterSync(result.status);
                  notify({ message: t("backup.enableSuccess"), tone: "success" });
                })}
              >
                {activeAction === "enable" ? t("backup.enabling") : t("backup.enable")}
              </button>
            </div>
          ) : (
            <button className="primary-button" type="button" onClick={onOpenGithubSettings}>
              {t("backup.connectGithub")}
            </button>
          )}
        </section>
      ) : (
        <>
          <section className="panel-card backup-settings-card">
            <div className="backup-setting-row">
              <div>
                <h3>{t("backup.autoTitle")}</h3>
                <p>{t("backup.autoDescription")}</p>
              </div>
              <input
                aria-label={t("backup.autoTitle")}
                type="checkbox"
                checked={status.autoBackup}
                disabled={Boolean(activeAction)}
                onChange={(event) => void runAction("auto", async () => {
                  const nextStatus = await setBackupAutoBackup(event.target.checked);
                  setStatus(nextStatus);
                })}
              />
            </div>
            <div className="backup-setting-row">
              <div>
                <h3>{t("backup.deviceName")}</h3>
                <p>{t("backup.deviceDescription")}</p>
              </div>
              <div className="backup-device-field">
                <input value={deviceName} maxLength={80} onChange={(event) => setDeviceName(event.target.value)} />
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!deviceName.trim() || deviceName === status.deviceName || Boolean(activeAction)}
                  onClick={() => void runAction("device", async () => {
                    const nextStatus = await setBackupDeviceName(deviceName.trim());
                    setStatus(nextStatus);
                    notify({ message: t("backup.deviceSaved"), tone: "success" });
                  })}
                >
                  {t("backup.save")}
                </button>
              </div>
            </div>
            <div className="backup-metadata-row">
              <span>{t("backup.lastSync")}</span>
              <strong>{formatTimestamp(status.lastSyncAt, language)}</strong>
            </div>
            {status.lastError ? <div className="backup-error">{status.lastError}</div> : null}
          </section>

          {conflicts.length > 0 ? (
            <section className="backup-section">
              <div className="backup-section__heading">
                <h3>{t("backup.conflictsTitle")}</h3>
                <span>{conflicts.length}</span>
              </div>
              <div className="backup-list">
                {conflicts.map((conflict) => (
                  <article className="panel-card backup-conflict" key={conflict.conflictId}>
                    <div>
                      <h4>{conflict.skillName}</h4>
                      <p>{t("backup.conflictDescription")}</p>
                    </div>
                    <div className="backup-conflict__actions">
                      {(["keepLocal", "useRemote", "keepBoth"] as const).map((resolution) => (
                        <button
                          className={resolution === "keepBoth" ? "primary-button" : "secondary-button"}
                          type="button"
                          key={resolution}
                          disabled={Boolean(activeAction)}
                          onClick={() => void runAction(`${conflict.conflictId}-${resolution}`, async () => {
                            const result = await resolveBackupConflict(conflict.conflictId, resolution);
                            refreshAfterSync(result.status);
                            notify({ message: t("backup.conflictResolved"), tone: "success" });
                          })}
                        >
                          {t(`backup.${resolution}`)}
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <section className="backup-section">
            <div className="backup-section__heading">
              <h3>{t("backup.historyTitle")}</h3>
            </div>
            {snapshots.length > 0 ? (
              <div className="backup-list">
                {snapshots.map((snapshot) => (
                  <article className="panel-card backup-snapshot" key={snapshot.tag}>
                    <div>
                      <h4>{formatTimestamp(snapshot.createdAt, language)}</h4>
                      <p>{snapshot.message}</p>
                    </div>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(activeAction)}
                      onClick={() => {
                        if (!window.confirm(t("backup.restoreConfirm"))) {
                          return;
                        }
                        void runAction(`restore-${snapshot.tag}`, async () => {
                          const result = await restoreBackupSnapshot(snapshot.tag);
                          refreshAfterSync(result.status);
                          notify({ message: t("backup.restoreSuccess"), tone: "success" });
                        });
                      }}
                    >
                      {t("backup.restore")}
                    </button>
                  </article>
                ))}
              </div>
            ) : <div className="panel-card backup-empty-state">{t("backup.noHistory")}</div>}
          </section>

          <section className="panel-card backup-scope-note">
            <h3>{t("backup.scopeTitle")}</h3>
            <p>{t("backup.scopeDescription")}</p>
            <button
              className="danger-button"
              type="button"
              disabled={Boolean(activeAction)}
              onClick={() => {
                if (!window.confirm(t("backup.disconnectConfirm"))) {
                  return;
                }
                void runAction("disconnect", async () => {
                  const nextStatus = await disconnectGithubBackup();
                  setStatus(nextStatus);
                  setConflicts([]);
                  setSnapshots([]);
                });
              }}
            >
              {t("backup.disconnect")}
            </button>
          </section>
        </>
      )}
    </div>
  );
}
