import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getDirectoryPath } from "@/app/path-utils";
import { useTranslate } from "@/app/i18n";
import { useFailureReporter } from "@/app/failure-feedback";
import { AppSelect } from "@/app/components/AppSelect";
import { alignExpandedRowIntoView } from "@/app/utils/align-expanded-row";
import {
  type AppUpdateCheckResult,
  type AppUpdateProgress,
  checkForAppUpdate,
  fetchCurrentAppVersion,
} from "@/features/app-update/app-update-client";
import { resolveAppUpdateReleaseNoteEntries } from "@/features/app-update/release-notes";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import {
  ListGridViewToggle,
  type ListGridViewMode,
} from "@/features/skills/components/ListGridViewToggle";
import {
  buildOpenToolOptions,
  buildSupportedAiToolCards,
  getToolSurfaceLabels,
  sortToolCards,
} from "@/features/skills/utils/open-tools";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";
import { clearRepoCache, getRepoCacheSize } from "@/features/skills/api/skill-client";
import type { AppTheme } from "@/features/skills/state/skill-store";
import {
  applyGlobalListGridViewPreference,
  readGlobalListGridViewPreference,
} from "@/features/skills/utils/list-grid-view-preference";

function FolderOpenIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M2.75 5.25A1.5 1.5 0 0 1 4.25 3.75h3.1l1.2 1.35h4.95A1.5 1.5 0 0 1 15 6.6v1.15"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <path
        d="M3.15 7.75h11.7l-.7 4.7a1.5 1.5 0 0 1-1.48 1.28H4.98a1.5 1.5 0 0 1-1.48-1.28l-.35-2.35"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RefreshIcon({ isSpinning = false }: { isSpinning?: boolean }) {
  return (
    <svg className={isSpinning ? "settings-update-button__svg is-spinning" : "settings-update-button__svg"} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M16.2 9.1a6.2 6.2 0 0 0-10.7-3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.7 3.9v3.7h3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.8 10.9a6.2 6.2 0 0 0 10.7 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.3 16.1v-3.7h-3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="settings-update-button__svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M4.75 6.65h10.5M8.15 6.65V5.5c0-.5.4-.9.9-.9h1.9c.5 0 .9.4.9.9v1.15"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.65 8.6l.48 5.9c.07.75.69 1.32 1.44 1.32h2.86c.75 0 1.37-.57 1.44-1.32l.48-5.9"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.85 9.75v3.7M11.15 9.75v3.7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function ThemeIcon({ theme }: { theme: AppTheme }) {
  if (theme === "system") {
    return (
      <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <rect x="2.5" y="3" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.45" />
        <path d="M6.5 15h5M9 12v3" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
      </svg>
    );
  }

  if (theme === "dark") {
    return (
      <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path
          d="M14.2 11.2A6 6 0 0 1 6.8 3.8 5.6 5.6 0 1 0 14.2 11.2Z"
          stroke="currentColor"
          strokeWidth="1.45"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="2.75" stroke="currentColor" strokeWidth="1.45" />
      <path
        d="M9 2.2v1.4M9 14.4v1.4M15.8 9h-1.4M3.6 9H2.2M13.8 4.2l-1 1M5.2 12.8l-1 1M13.8 13.8l-1-1M5.2 5.2l-1-1"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
      />
    </svg>
  );
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

type SettingsFormItem = {
  label: string;
  description: string;
  value: ReactNode;
  readonly?: boolean;
  actionLabel?: string;
  disabled?: boolean;
  onActivate?: () => void | Promise<void>;
};

export function SettingsRoute() {
  const { language, t } = useTranslate();
  const {
    appSettings,
    defaultOpenToolId,
    openPathInFinder,
    setLanguage,
    setTheme,
    setMcpInstallActivation,
    setDefaultOpenToolId,
    setSkillInstallActivation,
    setSkillSourceViewStyle,
    toolConfigs,
  } = useSkillWorkspace();
  const openToolOptions = useMemo(
    () => buildOpenToolOptions(toolConfigs, language),
    [language, toolConfigs],
  );
  const supportedToolCards = useMemo(
    () => sortToolCards(buildSupportedAiToolCards(toolConfigs), defaultOpenToolId),
    [defaultOpenToolId, toolConfigs],
  );
  const toolSurfaceLabels = useMemo(() => getToolSurfaceLabels(language), [language]);
  const selectedDefaultToolId = openToolOptions.some((tool) => tool.id === defaultOpenToolId)
    ? defaultOpenToolId
    : openToolOptions[0]?.id ?? "";
  const [isToolStatusExpanded, setIsToolStatusExpanded] = useState(false);
  const [listGridViewPreference, setListGridViewPreference] = useState<ListGridViewMode>(
    readGlobalListGridViewPreference,
  );
  const [isOpeningStoragePath, setIsOpeningStoragePath] = useState(false);
  const [repoCacheSize, setRepoCacheSize] = useState<number | null>(null);
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [currentAppVersion, setCurrentAppVersion] = useState("");
  const [appUpdate, setAppUpdate] = useState<AppUpdateCheckResult | null>(null);
  const [appUpdateStatus, setAppUpdateStatus] = useState<
    "idle" | "checking" | "available" | "not-available" | "installing" | "error"
  >("idle");
  const [isAppUpdateReleaseNotesOpen, setIsAppUpdateReleaseNotesOpen] = useState(false);
  const [appUpdateMessage, setAppUpdateMessage] = useState(t("settings.update.status.idle"));
  const [appUpdateProgress, setAppUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const toolStatusGroupRef = useRef<HTMLElement | null>(null);
  const reportFailure = useFailureReporter();
  const toolStatusPanelClassName = "panel-card placeholder-panel settings-panel settings-panel--tool-status";
  const storageDirectoryPath = getDirectoryPath(appSettings.storagePath);
  const isCheckingAppUpdate = appUpdateStatus === "checking";
  const isInstallingAppUpdate = appUpdateStatus === "installing";
  const appUpdateReleaseNoteEntries = useMemo(
    () => resolveAppUpdateReleaseNoteEntries(appUpdate),
    [appUpdate],
  );
  const shouldShowInstallAppUpdate = Boolean(appUpdate?.available && appUpdate?.install);
  const shouldShowAppUpdateReleaseNotes = shouldShowInstallAppUpdate && appUpdateReleaseNoteEntries.length > 0;
  const appUpdateActionLabel = shouldShowInstallAppUpdate
    ? (isInstallingAppUpdate ? t("settings.update.action.installing") : t("settings.update.action.install"))
    : (isCheckingAppUpdate ? t("settings.update.action.checking") : t("settings.update.action.check"));
  const appUpdateActionClassName = shouldShowInstallAppUpdate
    ? "primary-button primary-button--compact settings-update-button settings-update-button--install"
    : "secondary-button secondary-button--compact settings-update-button";
  const repoCacheSizeLabel =
    repoCacheSize === null
      ? t("settings.cache.loading")
      : repoCacheSize === 0
        ? t("settings.cache.empty")
        : formatBytes(repoCacheSize);
  const canClearRepoCache = !isClearingCache && repoCacheSize !== null && repoCacheSize > 0;

  useEffect(() => {
    if (!shouldShowAppUpdateReleaseNotes && isAppUpdateReleaseNotesOpen) {
      setIsAppUpdateReleaseNotesOpen(false);
    }
  }, [isAppUpdateReleaseNotesOpen, shouldShowAppUpdateReleaseNotes]);

  useEffect(() => {
    setAppUpdateMessage((current) => {
      if (current.trim().length === 0 || current === t("settings.update.status.idle")) {
        return t("settings.update.status.idle");
      }
      return current;
    });
  }, [t]);

  useEffect(() => {
    let shouldIgnore = false;

    void fetchCurrentAppVersion()
      .then((version) => {
        if (!shouldIgnore) {
          setCurrentAppVersion(version);
        }
      })
      .catch(() => {
        if (!shouldIgnore) {
          setCurrentAppVersion(t("settings.about.versionUnknown"));
        }
      });

    return () => {
      shouldIgnore = true;
    };
  }, []);

  useEffect(() => {
    void getRepoCacheSize().then(setRepoCacheSize).catch(() => setRepoCacheSize(0));
  }, []);

  async function handleClearCache() {
    if (isClearingCache) return;
    setIsClearingCache(true);
    try {
      await clearRepoCache();
      setRepoCacheSize(0);
    } finally {
      setIsClearingCache(false);
    }
  }

  async function handleOpenStoragePath() {
    if (!storageDirectoryPath || isOpeningStoragePath) {
      return;
    }

    setIsOpeningStoragePath(true);
    try {
      await openPathInFinder(storageDirectoryPath);
    } finally {
      setIsOpeningStoragePath(false);
    }
  }

  function formatUpdateSize(progress: AppUpdateProgress) {
    if (!progress.totalBytes) {
      return t("settings.update.downloaded", { size: formatBytes(progress.downloadedBytes) });
    }

    return `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`;
  }

  async function handleCheckAppUpdate() {
    if (isCheckingAppUpdate || isInstallingAppUpdate) {
      return;
    }

    setIsAppUpdateReleaseNotesOpen(false);
    setAppUpdate(null);
    setAppUpdateStatus("checking");
    setAppUpdateMessage(t("settings.update.status.checking"));
    setAppUpdateProgress(null);

    try {
      const update = await checkForAppUpdate();
      setCurrentAppVersion(update.currentVersion);
      setAppUpdate(update);

      if (update.available) {
        setAppUpdateStatus("available");
        setAppUpdateMessage(
          update.version
            ? t("settings.update.status.available", { version: update.version })
            : t("settings.update.status.availableNoVersion"),
        );
        return;
      }

      setAppUpdateStatus("not-available");
      setAppUpdateMessage(t("settings.update.status.latest"));
    } catch (error) {
      setIsAppUpdateReleaseNotesOpen(false);
      setAppUpdateStatus("error");
      const message = error instanceof Error ? error.message : t("settings.update.status.checkFailed");
      setAppUpdateMessage(message);
      reportFailure(error, {
        operation: "check_for_app_update",
        fallbackMessage: t("settings.update.status.checkFailed"),
      });
    }
  }

  async function handleInstallAppUpdate() {
    if (!appUpdate?.install || isInstallingAppUpdate) {
      return;
    }

    setAppUpdateStatus("installing");
    setAppUpdateMessage(t("settings.update.status.installing"));

    try {
      await appUpdate.install((progress) => {
        setAppUpdateProgress(progress);
      });
    } catch (error) {
      setAppUpdateStatus("error");
      const message = error instanceof Error ? error.message : t("settings.update.status.installFailed");
      setAppUpdateMessage(message);
      reportFailure(error, {
        operation: "install_app_update",
        fallbackMessage: t("settings.update.status.installFailed"),
      });
    }
  }

  async function handleToggleToolStatus() {
    const shouldExpand = !isToolStatusExpanded;
    setIsToolStatusExpanded((current) => !current);
    if (shouldExpand) {
      await alignExpandedRowIntoView(toolStatusGroupRef.current);
    }
  }

  function handleListGridViewPreferenceChange(value: ListGridViewMode) {
    setListGridViewPreference(value);
    applyGlobalListGridViewPreference(value);
  }

  const generalSettingsItems: SettingsFormItem[] = [
    {
      label: t("settings.storage.label"),
      description: t("settings.storage.description"),
      value: (
        <div className="settings-form-item__path-group">
          <div className="settings-form-item__value settings-form-item__value--path">
            {storageDirectoryPath || t("settings.storage.empty")}
          </div>
          <button
            className="secondary-button secondary-button--compact settings-open-button"
            type="button"
            aria-label={t("settings.storage.action")}
            disabled={!storageDirectoryPath || isOpeningStoragePath}
            onClick={() => void handleOpenStoragePath()}
          >
            <FolderOpenIcon />
            {t("settings.storage.open")}
          </button>
        </div>
      ),
      readonly: true,
    },
    {
      label: t("settings.language.label"),
      description: t("settings.language.description"),
      value: (
        <div className="settings-form-item__control">
          <AppSelect
            ariaLabel={t("settings.language.label")}
            value={appSettings.language}
            options={[
              { value: "zh-CN", label: t("settings.language.option.zh-CN") },
              { value: "en", label: t("settings.language.option.en") },
            ]}
            onChange={(value) => void setLanguage(value)}
          />
        </div>
      ),
    },
    {
      label: t("settings.defaultEditor.label"),
      description: t("settings.defaultEditor.description"),
      value: (
        <div className="settings-form-item__control">
          <AppSelect
            ariaLabel={t("settings.defaultEditor.aria")}
            value={selectedDefaultToolId}
            options={openToolOptions.length === 0
              ? [{ value: "", label: t("settings.defaultEditor.empty") }]
              : openToolOptions.map((tool) => ({ value: tool.id, label: tool.name }))}
            onChange={setDefaultOpenToolId}
            disabled={openToolOptions.length === 0}
          />
        </div>
      ),
    },
    {
      label: t("settings.theme.label"),
      description: t("settings.theme.description"),
      value: (
        <div className="settings-form-item__control settings-form-item__control--theme">
          <div className="settings-theme-picker" role="group" aria-label={t("settings.theme.label")}>
            <button
              className={`settings-theme-option${appSettings.theme === "light" ? " is-selected" : ""}`}
              type="button"
              aria-pressed={appSettings.theme === "light"}
              onClick={() => void setTheme("light")}
            >
              <ThemeIcon theme="light" />
              <span>{t("settings.theme.option.light")}</span>
            </button>
            <button
              className={`settings-theme-option${appSettings.theme === "dark" ? " is-selected" : ""}`}
              type="button"
              aria-pressed={appSettings.theme === "dark"}
              onClick={() => void setTheme("dark")}
            >
              <ThemeIcon theme="dark" />
              <span>{t("settings.theme.option.dark")}</span>
            </button>
            <button
              className={`settings-theme-option${appSettings.theme === "system" ? " is-selected" : ""}`}
              type="button"
              aria-pressed={appSettings.theme === "system"}
              onClick={() => void setTheme("system")}
            >
              <ThemeIcon theme="system" />
              <span>{t("settings.theme.option.system")}</span>
            </button>
          </div>
        </div>
      ),
    },
    {
      label: t("settings.listGridView.label"),
      description: t("settings.listGridView.description"),
      value: (
        <div className="settings-form-item__control">
          <ListGridViewToggle
            value={listGridViewPreference}
            onChange={handleListGridViewPreferenceChange}
            ariaLabel={t("settings.listGridView.label")}
          />
        </div>
      ),
    },
    {
      label: t("settings.skillSourceView.label"),
      description: t("settings.skillSourceView.description"),
      value: (
        <div className="settings-form-item__control settings-form-item__control--layout">
          <div className="settings-layout-picker" role="group" aria-label={t("settings.skillSourceView.label")}>
            <button
              className={`settings-layout-option${(appSettings.skillSourceViewStyle ?? "flat") === "flat" ? " is-selected" : ""}`}
              type="button"
              aria-pressed={(appSettings.skillSourceViewStyle ?? "flat") === "flat"}
              onClick={() => void setSkillSourceViewStyle("flat")}
            >
              <span>{t("settings.skillSourceView.option.flat")}</span>
            </button>
            <button
              className={`settings-layout-option${appSettings.skillSourceViewStyle === "select" ? " is-selected" : ""}`}
              type="button"
              aria-pressed={appSettings.skillSourceViewStyle === "select"}
              onClick={() => void setSkillSourceViewStyle("select")}
            >
              <span>{t("settings.skillSourceView.option.select")}</span>
            </button>
          </div>
        </div>
      ),
    },
  ];
  const installBehaviorItems: SettingsFormItem[] = [
    {
      label: t("settings.install.skill.label"),
      description: t("settings.install.skill.description"),
      value: (
        <div className="settings-toggle-control">
          <span className="settings-toggle-control__state">
            {appSettings.skillInstallActivation === "apply-all-tools" ? t("settings.toggle.on") : t("settings.toggle.off")}
          </span>
          <button
            className={`switch-button${appSettings.skillInstallActivation === "apply-all-tools" ? " is-enabled" : ""}`}
            type="button"
            onClick={() =>
              void setSkillInstallActivation(
                appSettings.skillInstallActivation === "apply-all-tools"
                  ? "disable-all-tools"
                  : "apply-all-tools",
              )
            }
            aria-pressed={appSettings.skillInstallActivation === "apply-all-tools"}
            aria-label={t("settings.install.skill.label")}
          >
            <span className="switch-button__thumb" />
          </button>
        </div>
      ),
    },
    {
      label: t("settings.install.mcp.label"),
      description: t("settings.install.mcp.description"),
      value: (
        <div className="settings-toggle-control">
          <span className="settings-toggle-control__state">
            {appSettings.mcpInstallActivation === "apply-all-tools" ? t("settings.toggle.on") : t("settings.toggle.off")}
          </span>
          <button
            className={`switch-button${appSettings.mcpInstallActivation === "apply-all-tools" ? " is-enabled" : ""}`}
            type="button"
            onClick={() =>
              void setMcpInstallActivation(
                appSettings.mcpInstallActivation === "apply-all-tools"
                  ? "disable-all-tools"
                  : "apply-all-tools",
              )
            }
            aria-pressed={appSettings.mcpInstallActivation === "apply-all-tools"}
            aria-label={t("settings.install.mcp.label")}
          >
            <span className="switch-button__thumb" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="placeholder-grid settings-page">
      <section className="settings-group">
        <div className="settings-group__heading">
          <span className="settings-group__bar" aria-hidden="true" />
          <h2 className="settings-group__title">{t("settings.group.preferences")}</h2>
        </div>
        <div className="panel-card placeholder-panel settings-panel settings-panel--module">
          <div className="settings-form-list">
            {generalSettingsItems.map((item) => {
              const className = `settings-form-item${item.readonly ? " settings-form-item--readonly" : ""}${
                item.onActivate ? " settings-form-item--action" : ""
              }`;
              const content = (
                <>
                  <div className="settings-form-item__copy">
                    <span className="settings-form-item__title">{item.label}</span>
                    <p>{item.description}</p>
                  </div>
                  {item.value}
                </>
              );

              if (item.onActivate) {
                return (
                  <button
                    key={item.label}
                    className={className}
                    type="button"
                    aria-label={item.actionLabel}
                    disabled={item.disabled}
                    onClick={() => void item.onActivate?.()}
                  >
                    {content}
                  </button>
                );
              }

              return (
                <div key={item.label} className={className}>
                  {content}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group__heading">
          <span className="settings-group__bar" aria-hidden="true" />
          <h2 className="settings-group__title">{t("settings.group.updates")}</h2>
        </div>
        <div className="panel-card placeholder-panel settings-panel settings-panel--module">
          <div className="settings-form-list">
            <div className="settings-form-item settings-form-item--readonly">
              <div className="settings-form-item__copy">
                <span className="settings-form-item__title">{t("settings.update.currentVersion")}</span>
                <p>{t("settings.update.currentVersionDescription")}</p>
              </div>
              <div className="settings-form-item__value">
                {currentAppVersion || t("settings.update.loadingVersion")}
              </div>
            </div>
            <div className="settings-update-block">
              <div className="settings-form-item">
                <div className="settings-form-item__copy">
                  <span className="settings-form-item__title">{t("settings.update.status")}</span>
                  <p>{appUpdateMessage}</p>
                  {appUpdateProgress ? <p>{formatUpdateSize(appUpdateProgress)}</p> : null}
                </div>
                <div className="settings-form-item__control settings-update-actions">
                  {shouldShowAppUpdateReleaseNotes ? (
                    <button
                      className="secondary-button secondary-button--compact settings-update-button settings-update-button--notes"
                      type="button"
                      onClick={() => setIsAppUpdateReleaseNotesOpen((current) => !current)}
                      aria-expanded={isAppUpdateReleaseNotesOpen}
                      aria-controls="settings-update-release-notes"
                      disabled={isCheckingAppUpdate}
                    >
                      <span>{t("settings.update.releaseNotes")}</span>
                    </button>
                  ) : null}
                  <button
                    className={appUpdateActionClassName}
                    type="button"
                    onClick={() =>
                      void (shouldShowInstallAppUpdate ? handleInstallAppUpdate() : handleCheckAppUpdate())
                    }
                    disabled={isCheckingAppUpdate || isInstallingAppUpdate}
                  >
                    {shouldShowInstallAppUpdate ? null : (
                      <span aria-hidden="true" className="settings-update-button__icon">
                        <RefreshIcon isSpinning={isCheckingAppUpdate} />
                      </span>
                    )}
                    <span>{appUpdateActionLabel}</span>
                  </button>
                </div>
              </div>
              {shouldShowAppUpdateReleaseNotes && isAppUpdateReleaseNotesOpen ? (
                <div id="settings-update-release-notes" className="settings-update-release-notes">
                  <div className="settings-update-release-notes__header">
                    <span className="settings-update-release-notes__title">{t("settings.update.releaseNotesTitle")}</span>
                  </div>
                  <div className="settings-update-release-notes__content">
                    <div className="settings-update-release-notes__markdown">
                      {appUpdateReleaseNoteEntries.map((entry) => (
                        <section key={entry.version || entry.body} className="settings-update-release-notes__section">
                          {entry.version ? <p className="settings-update-release-notes__version">{`Version ${entry.version}`}</p> : null}
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.body}</ReactMarkdown>
                        </section>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group__heading">
          <span className="settings-group__bar" aria-hidden="true" />
          <h2 className="settings-group__title">{t("settings.group.installBehavior")}</h2>
        </div>
        <div className="panel-card placeholder-panel settings-panel settings-panel--module">
          <div className="settings-form-list">
            {installBehaviorItems.map((item) => (
              <div key={item.label} className="settings-form-item">
                <div className="settings-form-item__copy">
                  <span className="settings-form-item__title">{item.label}</span>
                  <p>{item.description}</p>
                </div>
                {item.value}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group__heading">
          <span className="settings-group__bar" aria-hidden="true" />
          <h2 className="settings-group__title">{t("settings.group.cache")}</h2>
        </div>
        <div className="panel-card placeholder-panel settings-panel settings-panel--module">
          <div className="settings-form-list">
            <div className="settings-form-item">
              <div className="settings-form-item__copy">
                <span className="settings-form-item__title">{t("settings.cache.repoCache.label")}</span>
                <p>{t("settings.cache.repoCache.description")}</p>
                <p className="settings-cache-meta">
                  {t("settings.cache.sizeUsed", { size: repoCacheSizeLabel })}
                </p>
              </div>
              <div className="settings-form-item__control settings-update-actions">
                <button
                  className="secondary-button secondary-button--compact settings-update-button settings-update-button--cache"
                  type="button"
                  disabled={!canClearRepoCache}
                  onClick={() => void handleClearCache()}
                >
                  <span aria-hidden="true" className="settings-update-button__icon">
                    <TrashIcon />
                  </span>
                  <span>{isClearingCache ? t("settings.cache.clearing") : t("settings.cache.clear")}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section ref={toolStatusGroupRef} className="settings-group">
        <div className="settings-group__heading">
          <span className="settings-group__bar" aria-hidden="true" />
          <h2 className="settings-group__title">{t("settings.group.toolStatus")}</h2>
        </div>
        <section className={toolStatusPanelClassName}>
          <button
            className="settings-section-toggle"
            type="button"
            onClick={() => void handleToggleToolStatus()}
            aria-expanded={isToolStatusExpanded}
            aria-label={t("settings.group.toolStatus")}
          >
            <span className="settings-section-toggle__copy">
              <span className="settings-section-hint">{t("settings.toolStatus.hint")}</span>
            </span>
            <span className="settings-section-toggle__chevron" aria-hidden="true">
              {isToolStatusExpanded ? "⌄" : "›"}
            </span>
          </button>
          {isToolStatusExpanded ? (
            <div className="settings-tool-grid">
              {supportedToolCards.map((tool) => {
                const logoUrl = getToolLogoUrl(tool.id);

                return (
                  <article
                    key={tool.id}
                    className={`settings-tool-card${tool.isInstalled ? " is-installed" : ""}`}
                  >
                    <span className="settings-tool-card__status-row">
                      <span
                        className={`settings-tool-card__status-badge${tool.isInstalled ? " is-installed" : ""}`}
                      >
                        {tool.statusLabel}
                      </span>
                    </span>
                    <span className="settings-tool-card__content-row">
                      <span className="settings-tool-card__logo" aria-hidden="true">
                        {logoUrl ? <img src={logoUrl} alt="" /> : <span>{tool.name.slice(0, 1)}</span>}
                      </span>
                      <span className="settings-tool-card__copy">
                        <span className="settings-tool-card__title">{tool.name}</span>
                        <span className="settings-tool-card__surface">
                          {tool.surfaceTypes.map((surface) => toolSurfaceLabels[surface]).join(" / ")}
                        </span>
                      </span>
                    </span>
                  </article>
                );
              })}
            </div>
          ) : null}
        </section>
      </section>

      <section className="settings-group">
        <div className="settings-group__heading">
          <span className="settings-group__bar" aria-hidden="true" />
          <h2 className="settings-group__title">{t("settings.group.github")}</h2>
        </div>
        <div className="panel-card placeholder-panel settings-panel settings-panel--git-account">
          <div className="settings-row settings-row--account">
            <span className="settings-row__title">{t("settings.github.provider")}</span>
            <span>{t("settings.github.placeholder")}</span>
            <span className="status-badge tone-info">{t("settings.github.badge")}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
