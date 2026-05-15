import { isTauri } from "@tauri-apps/api/core";

type WindowWithTauriInternals = Window & {
  __TAURI_INTERNALS__?: unknown;
};

export function isTauriRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  return isTauri() || Boolean((window as WindowWithTauriInternals).__TAURI_INTERNALS__);
}
