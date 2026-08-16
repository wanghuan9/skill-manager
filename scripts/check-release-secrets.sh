#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO="wanghuan9/skilldock"
REQUIRED_SOURCE_SECRETS=(
  APPLE_CERTIFICATE
  APPLE_CERTIFICATE_PASSWORD
  APPLE_ID
  APPLE_PASSWORD
  APPLE_TEAM_ID
  KEYCHAIN_PASSWORD
  TAURI_SIGNING_PRIVATE_KEY
)

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

secret_names_for_repo() {
  local repo="$1"
  gh secret list --repo "$repo" --json name --jq '.[].name'
}

main() {
  require_command gh
  gh auth status >/dev/null

  local source_secrets
  source_secrets="$(secret_names_for_repo "$SOURCE_REPO")"

  local missing=()
  for secret in "${REQUIRED_SOURCE_SECRETS[@]}"; do
    if ! grep -qx "$secret" <<<"$source_secrets"; then
      missing+=("$secret")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    printf 'Missing required secret(s) in %s: %s\n' "$SOURCE_REPO" "${missing[*]}" >&2
    printf '\nAdd them here:\n' >&2
    printf '  https://github.com/%s/settings/secrets/actions\n' "$SOURCE_REPO" >&2
    printf '\nStore signing material in GitHub Actions Secrets only; never commit it to git.\n' >&2
    exit 1
  fi

  printf 'Release secrets are configured in %s.\n' "$SOURCE_REPO"
}

main "$@"
