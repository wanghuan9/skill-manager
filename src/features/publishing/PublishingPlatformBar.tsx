import { useEffect, useRef, useState } from "react";
import { useTranslate } from "@/app/i18n";
import type { PublishingAuthState } from "./types";
import type { PublishingPlatformRegistration } from "./publishing-platform-registration";

type PublishingPlatformBarProps = {
  registrations: PublishingPlatformRegistration[];
  activeRegistration: PublishingPlatformRegistration;
  authState: PublishingAuthState | null;
  onPlatformChange: (registration: PublishingPlatformRegistration) => void;
  onManageAuthorization: () => void;
};

function MoreActionsIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="4" cy="10" r="1.25" fill="currentColor" />
      <circle cx="10" cy="10" r="1.25" fill="currentColor" />
      <circle cx="16" cy="10" r="1.25" fill="currentColor" />
    </svg>
  );
}

export function PublishingPlatformBar({
  registrations,
  activeRegistration,
  authState,
  onPlatformChange,
  onManageAuthorization,
}: PublishingPlatformBarProps) {
  const { t } = useTranslate();
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const activePlatform = activeRegistration.adapter.platform;
  const isConnected = Boolean(authState?.connected);
  const connectionLabel = authState === null
    ? t("publishing.platform.checking")
    : isConnected
      ? t("publishing.platform.connected")
      : t("publishing.platform.disconnected");
  const accountLabel = isConnected ? authState?.accountLabel.trim() : "";

  useEffect(() => {
    if (!isActionsOpen) {
      return undefined;
    }
    function closeActions(event: globalThis.MouseEvent) {
      if (!actionsRef.current?.contains(event.target as Node)) {
        setIsActionsOpen(false);
      }
    }
    window.addEventListener("mousedown", closeActions);
    return () => window.removeEventListener("mousedown", closeActions);
  }, [isActionsOpen]);

  function manageAuthorization() {
    setIsActionsOpen(false);
    onManageAuthorization();
  }

  return (
    <section className="publishing-platform-bar" aria-label={t("publishing.platform.aria")}>
      <div className="publishing-platform-bar__tabs" role="tablist" aria-label={t("publishing.platform.selectAria")}>
        {registrations.map((registration) => {
          const platform = registration.adapter.platform;
          const isActive = platform.id === activePlatform.id;
          return (
            <button
              key={platform.id}
              className={`publishing-platform-bar__tab${isActive ? " is-active" : ""}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => {
                setIsActionsOpen(false);
                onPlatformChange(registration);
              }}
            >
              <span aria-hidden="true" />
              {platform.label}
            </button>
          );
        })}
      </div>
      <div className="publishing-platform-bar__context">
        <strong>{t("publishing.platform.workbench", { platform: activePlatform.label })}</strong>
        <span className="publishing-platform-bar__chip">{t(activeRegistration.badgeLabelKey)}</span>
        <span className={isConnected ? "is-connected" : ""}>{connectionLabel}</span>
        {accountLabel ? <span className="publishing-platform-bar__account">{accountLabel}</span> : null}
      </div>
      <div className="publishing-platform-bar__actions" ref={actionsRef}>
        <button
          className="publishing-platform-bar__more-button"
          type="button"
          aria-label={t("publishing.platform.moreActions")}
          aria-expanded={isActionsOpen}
          aria-haspopup="menu"
          onClick={() => setIsActionsOpen((current) => !current)}
        >
          <MoreActionsIcon />
        </button>
        {isActionsOpen ? (
          <div className="publishing-platform-bar__actions-menu" role="menu">
            <button type="button" role="menuitem" onClick={manageAuthorization}>
              {t(activeRegistration.authorizationActionLabelKey)}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
