import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslate } from "@/app/i18n";
import { PublishingWorkbench } from "./PublishingWorkbench";
import { PublishingPlatformBar } from "./PublishingPlatformBar";
import {
  getDefaultPublishingPlatformRegistration,
  publishingPlatformRegistrations,
} from "./platform-registry";
import type { PublishingPlatformRegistration } from "./publishing-platform-registration";
import type { PublishingAuthState } from "./types";

const DISCONNECTED_AUTH_STATE: PublishingAuthState = {
  connected: false,
  accountLabel: "",
  verifiedAt: "",
};

function readInitialAuthState(registration: PublishingPlatformRegistration): PublishingAuthState | null {
  return registration.adapter.readCachedAuthState?.() ?? null;
}

export function PublishingRouteShell() {
  const { t } = useTranslate();
  const [activeRegistration, setActiveRegistration] = useState(getDefaultPublishingPlatformRegistration);
  const [authState, setAuthState] = useState<PublishingAuthState | null>(() => (
    readInitialAuthState(getDefaultPublishingPlatformRegistration())
  ));
  const adapter = activeRegistration.adapter;
  const activePlatformIdRef = useRef(adapter.platform.id);
  const authorizationRequestRef = useRef(0);
  activePlatformIdRef.current = adapter.platform.id;

  const commitAdapterAuthState = useCallback((
    targetAdapter: PublishingPlatformRegistration["adapter"],
    nextAuthState: PublishingAuthState,
  ) => {
    targetAdapter.writeCachedAuthState?.(nextAuthState);
    if (activePlatformIdRef.current === targetAdapter.platform.id) {
      setAuthState(nextAuthState);
    }
  }, []);

  const commitAuthState = useCallback((nextAuthState: PublishingAuthState) => {
    commitAdapterAuthState(adapter, nextAuthState);
  }, [adapter, commitAdapterAuthState]);

  const refreshAuthorization = useCallback(async () => {
    const requestId = authorizationRequestRef.current + 1;
    authorizationRequestRef.current = requestId;
    const targetAdapter = adapter;
    try {
      const nextAuthState = await targetAdapter.getAuthState();
      if (requestId === authorizationRequestRef.current) {
        commitAdapterAuthState(targetAdapter, nextAuthState);
      }
    } catch {
      if (requestId === authorizationRequestRef.current) {
        commitAdapterAuthState(targetAdapter, DISCONNECTED_AUTH_STATE);
      }
    }
  }, [adapter, commitAdapterAuthState]);

  useEffect(() => {
    let isActive = true;
    const requestId = authorizationRequestRef.current + 1;
    authorizationRequestRef.current = requestId;
    setAuthState(readInitialAuthState(activeRegistration));
    void adapter.getAuthState().then((nextAuthState) => {
      if (isActive && requestId === authorizationRequestRef.current) {
        commitAdapterAuthState(adapter, nextAuthState);
      }
    }).catch(() => {
      if (isActive && requestId === authorizationRequestRef.current) {
        commitAdapterAuthState(adapter, DISCONNECTED_AUTH_STATE);
      }
    });
    return () => {
      isActive = false;
    };
  }, [activeRegistration, adapter, commitAdapterAuthState]);

  function changePlatform(registration: PublishingPlatformRegistration) {
    if (registration.adapter.platform.id !== adapter.platform.id) {
      setAuthState(readInitialAuthState(registration));
      setActiveRegistration(registration);
    }
  }

  function manageAuthorization() {
    void Promise.resolve(activeRegistration.manageAuthorization()).catch(() => undefined);
  }

  const authentication = activeRegistration.renderAuthentication({
    refreshAuth: refreshAuthorization,
  });

  return (
    <div className="publishing-route">
      <PublishingPlatformBar
        registrations={publishingPlatformRegistrations}
        activeRegistration={activeRegistration}
        authState={authState}
        onPlatformChange={changePlatform}
        onManageAuthorization={manageAuthorization}
      />
      <PublishingWorkbench
        adapter={adapter}
        externalAuthState={authState}
        isVisible={authState?.connected === true}
        onAuthStateChange={commitAuthState}
        renderAuthentication={(refreshWorkbenchAuth) => activeRegistration.renderAuthentication({
          refreshAuth: async () => {
            await refreshWorkbenchAuth();
            await refreshAuthorization();
          },
        })}
      />
      {authState === null ? (
        <section className="panel-card skillhub-publish-card" aria-busy="true">
          <h2>{t("publishing.auth.checking", { platform: adapter.platform.label })}</h2>
        </section>
      ) : authState.connected ? null : authentication}
    </div>
  );
}
