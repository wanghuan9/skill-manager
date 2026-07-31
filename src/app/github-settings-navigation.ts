const OPEN_GITHUB_SETTINGS_EVENT = "skilldock:open-github-settings";

export function requestOpenGithubSettings() {
  window.dispatchEvent(new Event(OPEN_GITHUB_SETTINGS_EVENT));
}

export function subscribeOpenGithubSettings(listener: () => void) {
  window.addEventListener(OPEN_GITHUB_SETTINGS_EVENT, listener);
  return () => window.removeEventListener(OPEN_GITHUB_SETTINGS_EVENT, listener);
}
