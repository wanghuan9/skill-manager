import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslate } from "@/app/i18n";
import { useFailureReporter } from "@/app/failure-feedback";
import {
  type AppUpdateCheckResult,
  type AppUpdateProgress,
  checkForAppUpdate,
  fetchCurrentAppVersion,
} from "@/features/app-update/app-update-client";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import {
  buildOpenToolOptions,
  buildSupportedAiToolCards,
  getToolSurfaceLabels,
  sortToolCards,
} from "@/features/skills/utils/open-tools";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";

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

function getDirectoryPath(filePath: string) {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) {
    return "";
  }

  const lastSeparatorIndex = normalizedPath.lastIndexOf("/");
  if (lastSeparatorIndex <= 0) {
    return normalizedPath;
  }

  return normalizedPath.slice(0, lastSeparatorIndex);
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

type LanguageOption = {
  value: "zh-CN" | "en";
  label: string;
};

function LanguagePicker(props: {
  value: "zh-CN" | "en";
  options: LanguageOption[];
  label: string;
  onChange: (value: "zh-CN" | "en") => void | Promise<void>;
}) {
  const { label, onChange, options, value } = props;
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className={`settings-language-picker${isOpen ? " is-open" : ""}`}>
      <button
        className="settings-language-picker__trigger"
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span>{selectedOption?.label ?? ""}</span>
        <span className="settings-language-picker__chevron" aria-hidden="true">
          {isOpen ? "⌃" : "⌄"}
        </span>
      </button>
      {isOpen ? (
        <div className="settings-language-picker__menu" role="listbox" aria-label={label}>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                className={`settings-language-picker__option${selected ? " is-selected" : ""}`}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setIsOpen(false);
                  void onChange(option.value);
                }}
              >
                <span className="settings-language-picker__check" aria-hidden="true">
                  {selected ? "✓" : ""}
                </span>
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function SettingsRoute() {
  const { language, t } = useTranslate();
  const {
    appSettings,
    defaultOpenToolId,
    openPathInFinder,
    setLanguage,
    setMcpInstallActivation,
    setDefaultOpenToolId,
    setSkillInstallActivation,
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
  const languageOptions = useMemo<LanguageOption[]>(
    () => [
      { value: "zh-CN", label: t("settings.language.option.zh-CN") },
      { value: "en", label: t("settings.language.option.en") },
    ],
    [t],
  );
  const toolSurfaceLabels = useMemo(() => getToolSurfaceLabels(language), [language]);
  const selectedDefaultToolId = openToolOptions.some((tool) => tool.id === defaultOpenToolId)
    ? defaultOpenToolId
    : openToolOptions[0]?.id ?? "";
  const [isToolStatusExpanded, setIsToolStatusExpanded] = useState(false);
  const [isOpeningStoragePath, setIsOpeningStoragePath] = useState(false);
  const [currentAppVersion, setCurrentAppVersion] = useState("");
  const [appUpdate, setAppUpdate] = useState<AppUpdateCheckResult | null>(null);
  const [appUpdateStatus, setAppUpdateStatus] = useState<
    "idle" | "checking" | "available" | "not-available" | "installing" | "error"
  >("idle");
  const [appUpdateMessage, setAppUpdateMessage] = useState(t("settings.update.status.idle"));
  const [appUpdateProgress, setAppUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const reportFailure = useFailureReporter();
  const toolStatusPanelClassName = `panel-card placeholder-panel settings-panel settings-panel--tool-status${
    isToolStatusExpanded ? "" : " is-clickable"
  }`;
  const storageDirectoryPath = getDirectoryPath(appSettings.storagePath);
  const isCheckingAppUpdate = appUpdateStatus === "checking";
  const isInstallingAppUpdate = appUpdateStatus === "installing";
  const shouldShowInstallAppUpdate = Boolean(appUpdate?.available && appUpdate?.install);
  const appUpdateActionLabel = shouldShowInstallAppUpdate
    ? (isInstallingAppUpdate ? t("settings.update.action.installing") : t("settings.update.action.install"))
    : (isCheckingAppUpdate ? t("settings.update.action.checking") : t("settings.update.action.check"));
  const appUpdateActionClassName = shouldShowInstallAppUpdate
    ? "primary-button primary-button--compact settings-update-button"
    : "secondary-button secondary-button--compact settings-update-button";

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

  const generalSettingsItems: SettingsFormItem[] = [
    {
      label: t("settings.storage.label"),
      description: t("settings.storage.description"),
      value: (
        <div className="settings-form-item__path-group">
          <div className="settings-form-item__value settings-form-item__value--path">
            {storageDirectoryPath || t("settings.storage.empty")}
          </div>
          <span className="secondary-button secondary-button--compact settings-open-button settings-open-button--static">
            <FolderOpenIcon />
            {t("settings.storage.open")}
          </span>
        </div>
      ),
      readonly: true,
      actionLabel: t("settings.storage.action"),
      disabled: !storageDirectoryPath || isOpeningStoragePath,
      onActivate: handleOpenStoragePath,
    },
    {
      label: t("settings.language.label"),
      description: t("settings.language.description"),
      value: (
        <div className="settings-form-item__control">
          <LanguagePicker
            value={appSettings.language}
            options={languageOptions}
            label={t("settings.language.label")}
            onChange={setLanguage}
          />
        </div>
      ),
    },
    {
      label: t("settings.defaultEditor.label"),
      description: t("settings.defaultEditor.description"),
      value: (
        <div className="settings-form-item__control">
          <select
            aria-label={t("settings.defaultEditor.aria")}
            value={selectedDefaultToolId}
            onChange={(event) => setDefaultOpenToolId(event.target.value)}
            disabled={openToolOptions.length === 0}
          >
            {openToolOptions.length === 0 ? <option value="">{t("settings.defaultEditor.empty")}</option> : null}
            {openToolOptions.map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.name}
              </option>
            ))}
          </select>
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
            <div className="settings-form-item">
              <div className="settings-form-item__copy">
                <span className="settings-form-item__title">{t("settings.update.status")}</span>
                <p>{appUpdateMessage}</p>
                {appUpdateProgress ? <p>{formatUpdateSize(appUpdateProgress)}</p> : null}
              </div>
              <div className="settings-form-item__control settings-update-actions">
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
          <h2 className="settings-group__title">{t("settings.group.toolStatus")}</h2>
        </div>
        <section
          className={toolStatusPanelClassName}
          onClick={() => {
            if (!isToolStatusExpanded) {
              setIsToolStatusExpanded(true);
            }
          }}
        >
          <button
            className="settings-section-toggle"
            type="button"
            onClick={() => setIsToolStatusExpanded((current) => !current)}
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
