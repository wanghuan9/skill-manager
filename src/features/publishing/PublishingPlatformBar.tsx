import { useEffect, useRef, useState } from "react";
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
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const activePlatform = activeRegistration.adapter.platform;
  const isConnected = Boolean(authState?.connected);
  const connectionLabel = authState === null ? "● 检查中" : isConnected ? "● 已连接" : "● 未连接";
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
    <section className="publishing-platform-bar" aria-label="发布平台">
      <div className="publishing-platform-bar__tabs" role="tablist" aria-label="选择发布平台">
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
        <strong>{activePlatform.label} 发布工作台</strong>
        <span className="publishing-platform-bar__chip">{activeRegistration.badgeLabel}</span>
        <span className={isConnected ? "is-connected" : ""}>{connectionLabel}</span>
        {accountLabel ? <span className="publishing-platform-bar__account">{accountLabel}</span> : null}
      </div>
      <div className="publishing-platform-bar__actions" ref={actionsRef}>
        <button
          className="publishing-platform-bar__more-button"
          type="button"
          aria-label="更多发布操作"
          aria-expanded={isActionsOpen}
          aria-haspopup="menu"
          onClick={() => setIsActionsOpen((current) => !current)}
        >
          <MoreActionsIcon />
        </button>
        {isActionsOpen ? (
          <div className="publishing-platform-bar__actions-menu" role="menu">
            <button type="button" role="menuitem" onClick={manageAuthorization}>
              {activeRegistration.authorizationActionLabel}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
