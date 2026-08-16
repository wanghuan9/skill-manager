#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO_URL="https://github.com/wanghuan9/skilldock.git"
PUBLIC_RELEASE_REPO="wanghuan9/skilldock"
PUBLIC_REPO_URL="https://github.com/wanghuan9/skilldock"
DEFAULT_SIGNING_KEY_PATH="/Users/wanghuan/data/env/skilldock/skilldock-updater.key"
FALLBACK_SIGNING_KEY_PATH="$HOME/.skilldock/release/skilldock-updater.key"
LEGACY_SIGNING_KEY_PATH="$HOME/.skilldock/updater/skillm.key"
TARGET_DIR="src-tauri/target"
RELEASE_ASSET_DIR="src-tauri/target/release/release-assets"
RELEASE_NOTES_PATH="$RELEASE_ASSET_DIR/release-notes.md"
RELEASE_SUMMARY_PATH="$RELEASE_ASSET_DIR/release-summary.txt"
RELEASE_HISTORY_PATH="$RELEASE_ASSET_DIR/release-history.json"
RELEASE_REVIEW_AUTO_APPROVE="${SKILLDOCK_RELEASE_NOTES_AUTO_APPROVE:-}"
RELEASE_REVIEW_FORCE_BYPASS="${SKILLDOCK_RELEASE_NOTES_FORCE_BYPASS:-}"
APPLE_NOTARIZATION_KEYCHAIN_SERVICE="com.skilldock.notarization"
DEFAULT_APPLE_TEAM_ID="7BMASR586D"
EXPECTED_MACOS_SIGNING_IDENTITY="Developer ID Application: huan wang (7BMASR586D)"
# Public macOS releases support Apple Silicon only. Windows x64 is built by GitHub Actions.
MACOS_TARGETS=("aarch64-apple-darwin:aarch64")

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

open_release_notes_editor() {
  local path="$1"

  if [[ -n "${EDITOR:-}" ]]; then
    EDIT_FILE_PATH="$path" sh -lc '$EDITOR "$EDIT_FILE_PATH"'
    return
  fi

  if command -v nano >/dev/null 2>&1; then
    nano "$path"
    return
  fi

  vi "$path"
}

resolve_signing_key_path() {
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
    printf '%s\n' "$TAURI_SIGNING_PRIVATE_KEY_PATH"
    return
  fi

  if [[ -f "$DEFAULT_SIGNING_KEY_PATH" ]]; then
    printf '%s\n' "$DEFAULT_SIGNING_KEY_PATH"
    return
  fi

  if [[ -f "$FALLBACK_SIGNING_KEY_PATH" ]]; then
    printf '%s\n' "$FALLBACK_SIGNING_KEY_PATH"
    return
  fi

  if [[ -f "$LEGACY_SIGNING_KEY_PATH" ]]; then
    printf '%s\n' "$LEGACY_SIGNING_KEY_PATH"
    return
  fi

  die "updater signing key not found. Expected $DEFAULT_SIGNING_KEY_PATH, or set TAURI_SIGNING_PRIVATE_KEY_PATH. Do not commit this private key to git."
}

require_clean_tree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    die "working tree is not clean; commit or stash changes before publishing"
  fi
}

require_source_remote() {
  local origin_url
  origin_url="$(git remote get-url origin)"

  case "$origin_url" in
    "https://github.com/wanghuan9/skilldock"|\
    "https://github.com/wanghuan9/skilldock.git"|\
    "git@github.com:wanghuan9/skilldock.git"|\
    "ssh://git@github.com/wanghuan9/skilldock.git")
      ;;
    *)
      die "origin must point to $SOURCE_REPO_URL, got: $origin_url"
      ;;
  esac
}

require_pushed_head() {
  local branch upstream head remote_head
  branch="$(git branch --show-current)"
  [[ -n "$branch" ]] || die "publishing from a detached HEAD is not supported"

  if ! upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)"; then
    die "branch $branch has no upstream; push it before publishing"
  fi
  [[ "$upstream" == origin/* ]] || die "branch $branch must track origin, got: $upstream"

  git fetch origin --prune
  head="$(git rev-parse HEAD)"
  remote_head="$(git rev-parse '@{upstream}')"
  [[ "$head" == "$remote_head" ]] \
    || die "HEAD is not identical to $upstream; push the exact release commit first"

  printf '%s\n' "$head"
}

require_release_tag_available() {
  local tag="$1"
  local head remote_sha
  head="$(git rev-parse HEAD)"

  if git rev-parse --verify --quiet "$tag" >/dev/null; then
    local tag_sha
    tag_sha="$(git rev-parse "$tag^{}")"
    [[ "$tag_sha" == "$head" ]] || die "local tag $tag exists but does not point to HEAD"
  fi

  remote_sha="$(git ls-remote --tags origin "refs/tags/$tag^{}" | awk '{ print $1; exit }')"
  if [[ -z "$remote_sha" ]]; then
    remote_sha="$(git ls-remote --tags origin "refs/tags/$tag" | awk '{ print $1; exit }')"
  fi
  if [[ -n "$remote_sha" ]]; then
    [[ "$remote_sha" == "$head" ]] || die "remote tag $tag exists but does not point to HEAD"
  fi
}

publish_source_tag() {
  local tag="$1"

  if ! git rev-parse --verify --quiet "$tag" >/dev/null; then
    git tag "$tag"
  fi

  git push origin "$tag"
}

read_json_field() {
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(process.argv.slice(2).reduce((value, key) => value[key], data));" "$@"
}

require_matching_versions() {
  local package_version tauri_version cargo_version
  package_version="$(read_json_field package.json version)"
  tauri_version="$(read_json_field src-tauri/tauri.conf.json version)"
  cargo_version="$(awk -F' = ' '/^version = / { gsub(/"/, "", $2); print $2; exit }' src-tauri/Cargo.toml)"

  [[ "$package_version" == "$tauri_version" ]] || die "package.json version ($package_version) does not match tauri.conf.json ($tauri_version)"
  [[ "$package_version" == "$cargo_version" ]] || die "package.json version ($package_version) does not match Cargo.toml ($cargo_version)"

  printf '%s\n' "$package_version"
}

verify_updater_endpoint() {
  local endpoint
  endpoint="$(read_json_field src-tauri/tauri.conf.json plugins updater endpoints 0)"
  [[ "$endpoint" == "$PUBLIC_REPO_URL/releases/latest/download/latest.json" ]] || die "updater endpoint must point to $PUBLIC_REPO_URL, got: $endpoint"
}

verify_macos_signing_config() {
  local signing_identity
  signing_identity="$(read_json_field src-tauri/tauri.conf.json bundle macOS signingIdentity)"
  [[ "$signing_identity" == "$EXPECTED_MACOS_SIGNING_IDENTITY" ]] \
    || die "macOS signingIdentity must be '$EXPECTED_MACOS_SIGNING_IDENTITY', got: $signing_identity"
}

resolve_apple_notarization_credentials() {
  APPLE_ID="${APPLE_ID:-}"
  if [[ -z "$APPLE_ID" ]]; then
    require_command security
    APPLE_ID="$(security find-generic-password -s "$APPLE_NOTARIZATION_KEYCHAIN_SERVICE" 2>/dev/null \
      | sed -n 's/.*"acct"<blob>="\(.*\)"/\1/p' \
      | head -n 1)"
  fi
  [[ -n "$APPLE_ID" ]] \
    || die "APPLE_ID is required. Export it or store a Keychain item under service '$APPLE_NOTARIZATION_KEYCHAIN_SERVICE'."
  APPLE_TEAM_ID="${APPLE_TEAM_ID:-$DEFAULT_APPLE_TEAM_ID}"

  if [[ -z "${APPLE_PASSWORD:-}" ]]; then
    require_command security
    if ! APPLE_PASSWORD="$(security find-generic-password \
      -s "$APPLE_NOTARIZATION_KEYCHAIN_SERVICE" \
      -a "$APPLE_ID" \
      -w 2>/dev/null)"; then
      die "Apple notarization password not found in Keychain. Set APPLE_PASSWORD or store it under service '$APPLE_NOTARIZATION_KEYCHAIN_SERVICE' and account '$APPLE_ID'."
    fi
  fi

  [[ "$APPLE_TEAM_ID" == "$DEFAULT_APPLE_TEAM_ID" ]] \
    || die "APPLE_TEAM_ID must be $DEFAULT_APPLE_TEAM_ID, got: $APPLE_TEAM_ID"

  export APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
}

verify_developer_id_identity() {
  require_command security

  local identities
  identities="$(security find-identity -v -p codesigning)"
  grep -Fq "\"$EXPECTED_MACOS_SIGNING_IDENTITY\"" <<<"$identities" \
    || die "Developer ID signing identity not found in Keychain: $EXPECTED_MACOS_SIGNING_IDENTITY"
}

verify_built_app_signature() {
  local release_dir="$1"
  local app_path="$release_dir/bundle/macos/SkillDock.app"

  require_command codesign
  [[ -d "$app_path" ]] || die "expected app bundle missing: $app_path"

  codesign --verify --deep --strict --verbose=2 "$app_path" >/dev/null
  local signature_output
  signature_output="$(codesign -dv --verbose=4 "$app_path" 2>&1 || true)"
  grep -Fq "Authority=$EXPECTED_MACOS_SIGNING_IDENTITY" <<<"$signature_output" \
    || die "built app is not signed with $EXPECTED_MACOS_SIGNING_IDENTITY"
  grep -Fq "TeamIdentifier=$DEFAULT_APPLE_TEAM_ID" <<<"$signature_output" \
    || die "built app TeamIdentifier is not $DEFAULT_APPLE_TEAM_ID"

  require_command spctl
  require_command xcrun
  spctl --assess --type execute --verbose=4 "$app_path"
  xcrun stapler validate "$app_path"
}

release_dir_for_target() {
  local target="$1"
  printf '%s/%s/release\n' "$TARGET_DIR" "$target"
}

build_target() {
  local target="$1"
  local signing_key_path="$2"
  local build_config_path="$3"

  if ! rustup target list --installed | grep -qx "$target"; then
    rustup target add "$target"
  fi

  CI=true \
    APPLE_ID="$APPLE_ID" \
    APPLE_PASSWORD="$APPLE_PASSWORD" \
    APPLE_TEAM_ID="$APPLE_TEAM_ID" \
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$signing_key_path")" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
    npm run desktop:build -- --target "$target" --config "$build_config_path"
}

build_and_verify_target() {
  local target="$1"
  local signing_key_path="$2"
  local build_config_path="$3"

  build_target "$target" "$signing_key_path" "$build_config_path"
  verify_built_app_signature "$(release_dir_for_target "$target")"
}

build_targets_parallel() {
  local signing_key_path="$1"
  local build_config_path="$2"
  local log_dir="$3"
  local pids=()
  local targets=()
  local logs=()
  local target_entry target log_path

  mkdir -p "$log_dir"

  for target_entry in "${MACOS_TARGETS[@]}"; do
    target="${target_entry%%:*}"
    log_path="$log_dir/$target.log"

    printf 'Started build: %s\n' "$target"
    (build_and_verify_target "$target" "$signing_key_path" "$build_config_path") >"$log_path" 2>&1 &
    pids+=("$!")
    targets+=("$target")
    logs+=("$log_path")
  done

  local failed=0
  local index
  for index in "${!pids[@]}"; do
    if wait "${pids[$index]}"; then
      printf 'Built and verified: %s\n' "${targets[$index]}"
      cat "${logs[$index]}"
    else
      failed=1
      printf 'error: build failed: %s\n' "${targets[$index]}" >&2
      cat "${logs[$index]}" >&2
    fi
  done

  [[ "$failed" -eq 0 ]] || die "one or more macOS targets failed to build"
}

write_release_build_config() {
  local build_config_path="$1"

  node - "$build_config_path" <<'NODE'
const fs = require("fs");

// The release script builds the frontend once before running parallel Tauri builds.
// Emptying beforeBuildCommand prevents each architecture build from rebuilding dist.
const config = {
  build: {
    beforeBuildCommand: "",
  },
};

fs.writeFileSync(process.argv[2], `${JSON.stringify(config, null, 2)}\n`);
NODE
}

review_release_notes() {
  if [[ "$RELEASE_REVIEW_AUTO_APPROVE" == "1" ]]; then
    if [[ "${CI:-}" == "1" || "${CI:-}" == "true" ]]; then
      printf 'Skipping release notes review because SKILLDOCK_RELEASE_NOTES_AUTO_APPROVE=1 in CI\n'
      return
    fi

    if [[ "$RELEASE_REVIEW_FORCE_BYPASS" == "1" ]]; then
      printf 'Skipping release notes review because SKILLDOCK_RELEASE_NOTES_FORCE_BYPASS=1\n'
      return
    fi

    die "SKILLDOCK_RELEASE_NOTES_AUTO_APPROVE=1 is only allowed in CI. For an explicit local bypass, also set SKILLDOCK_RELEASE_NOTES_FORCE_BYPASS=1."
  fi

  [[ -t 0 && -t 1 ]] || die "release notes review requires an interactive terminal. In CI, set SKILLDOCK_RELEASE_NOTES_AUTO_APPROVE=1. For an explicit local bypass, set both SKILLDOCK_RELEASE_NOTES_AUTO_APPROVE=1 and SKILLDOCK_RELEASE_NOTES_FORCE_BYPASS=1."

  while true; do
    printf '\nGenerated release notes (%s):\n\n' "$RELEASE_NOTES_PATH"
    cat "$RELEASE_NOTES_PATH"
    printf '\nChoose an action:\n'
    printf '  [c] Continue publishing\n'
    printf '  [e] Edit release notes\n'
    printf '  [q] Quit without publishing\n'
    printf '> '

    local choice
    IFS= read -r choice

    case "$choice" in
      c|C)
        return
        ;;
      e|E)
        open_release_notes_editor "$RELEASE_NOTES_PATH"
        ;;
      q|Q)
        die "publishing cancelled during release notes review"
        ;;
      *)
        printf 'Unknown choice: %s\n' "$choice"
        ;;
    esac
  done
}

collect_assets() {
  local version="$1"
  local tag="$2"
  local release_notes="$3"
  local release_history_path="$4"
  local latest_json="$RELEASE_ASSET_DIR/latest.json"

  mkdir -p "$RELEASE_ASSET_DIR"

  for target_entry in "${MACOS_TARGETS[@]}"; do
    local target="${target_entry%%:*}"
    local arch_suffix="${target_entry##*:}"
    local release_dir updater_archive updater_signature dmg_name release_archive release_signature

    release_dir="$(release_dir_for_target "$target")/bundle"
    updater_archive="$release_dir/macos/SkillDock.app.tar.gz"
    updater_signature="$release_dir/macos/SkillDock.app.tar.gz.sig"
    dmg_name="SkillDock_${version}_${arch_suffix}.dmg"
    release_archive="$RELEASE_ASSET_DIR/SkillDock_${arch_suffix}.app.tar.gz"
    release_signature="$release_archive.sig"

    [[ -f "$release_dir/dmg/$dmg_name" ]] || die "expected build asset missing: $release_dir/dmg/$dmg_name"
    [[ -f "$updater_archive" ]] || die "expected build asset missing: $updater_archive"
    [[ -f "$updater_signature" ]] || die "expected build asset missing: $updater_signature"

    cp "$release_dir/dmg/$dmg_name" "$RELEASE_ASSET_DIR/$dmg_name"
    cp "$updater_archive" "$release_archive"
    cp "$updater_signature" "$release_signature"
  done

  node - "$version" "$tag" "$release_notes" "$release_history_path" <<'NODE'
const fs = require("fs");

const [version, tag, notes, releaseHistoryPath] = process.argv.slice(2);
const releaseBaseUrl = `https://github.com/wanghuan9/skilldock/releases/download/${tag}`;
const readSignature = (arch) =>
  fs.readFileSync(`src-tauri/target/release/release-assets/SkillDock_${arch}.app.tar.gz.sig`, "utf8").trim();
const generatedReleaseNotesHistory = fs.existsSync(releaseHistoryPath)
  ? JSON.parse(fs.readFileSync(releaseHistoryPath, "utf8"))
  : [];
const releaseNotesHistory = (() => {
  const history = Array.isArray(generatedReleaseNotesHistory) ? [...generatedReleaseNotesHistory] : [];
  const currentIndex = history.findIndex((entry) => entry && entry.version === version);
  const currentEntry = currentIndex >= 0 ? { ...history[currentIndex] } : { version };

  currentEntry.version = version;
  currentEntry.body = notes;
  currentEntry.pub_date = currentEntry.pub_date || new Date().toISOString();
  delete currentEntry.summary;

  if (currentIndex >= 0) {
    history.splice(currentIndex, 1);
  }

  return [currentEntry, ...history];
})();
const aarch64 = {
  signature: readSignature("aarch64"),
  url: `${releaseBaseUrl}/SkillDock_aarch64.app.tar.gz`,
};
const latest = {
  version,
  notes,
  releaseNotesHistory,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": aarch64,
    "darwin-aarch64-app": { ...aarch64 },
  },
};

fs.writeFileSync("src-tauri/target/release/release-assets/latest.json", `${JSON.stringify(latest, null, 2)}\n`);
NODE

  local assets=(
    "$RELEASE_ASSET_DIR/SkillDock_${version}_aarch64.dmg"
    "$RELEASE_ASSET_DIR/SkillDock_aarch64.app.tar.gz"
    "$RELEASE_ASSET_DIR/SkillDock_aarch64.app.tar.gz.sig"
    "$latest_json"
  )

  for asset in "${assets[@]}"; do
    [[ -f "$asset" ]] || die "expected build asset missing: $asset"
  done

  printf '%s\n' "${assets[@]}"
}

main() {
  require_command git
  require_command gh
  require_command node
  require_command npm
  require_command rustup

  require_source_remote
  require_clean_tree
  local head_sha
  head_sha="$(require_pushed_head)"
  verify_updater_endpoint
  verify_macos_signing_config
  resolve_apple_notarization_credentials
  verify_developer_id_identity

  local signing_key_path
  signing_key_path="$(resolve_signing_key_path)"
  [[ -f "$signing_key_path" ]] || die "signing key not found: $signing_key_path"

  local version tag
  version="$(require_matching_versions)"
  tag="${1:-v$version}"

  [[ "$tag" == "v$version" ]] || die "tag ($tag) must match app version v$version"
  require_release_tag_available "$tag"
  gh auth status >/dev/null
  if gh release view "$tag" --repo "$PUBLIC_RELEASE_REPO" >/dev/null 2>&1; then
    die "release $tag already exists in $PUBLIC_RELEASE_REPO; delete it manually if you intend to replace it"
  fi

  printf 'Publishing %s\n' "$tag"
  printf 'Source repo: %s\n' "$SOURCE_REPO_URL"
  printf 'Release repo: %s\n' "$PUBLIC_RELEASE_REPO"
  printf 'Release commit: %s\n' "$head_sha"
  printf 'Updater signing key: %s\n' "$signing_key_path"

  local release_tmp_dir build_config_path
  release_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/skilldock-release.XXXXXX")"
  trap "rm -rf '$release_tmp_dir'" EXIT
  build_config_path="$release_tmp_dir/tauri.release.conf.json"
  write_release_build_config "$build_config_path"

  printf 'Building frontend once\n'
  npm run build
  build_targets_parallel "$signing_key_path" "$build_config_path" "$release_tmp_dir/build-logs"

  rm -rf "$RELEASE_ASSET_DIR"
  mkdir -p "$RELEASE_ASSET_DIR"
  node scripts/generate-release-notes.cjs \
    --tag "$tag" \
    --output "$RELEASE_NOTES_PATH" \
    --summary-output "$RELEASE_SUMMARY_PATH" \
    --history-output "$RELEASE_HISTORY_PATH"
  local curated_release_notes="docs/release/notes/$tag.md"
  if [[ -f "$curated_release_notes" ]]; then
    cp "$curated_release_notes" "$RELEASE_NOTES_PATH"
  fi
  review_release_notes

  local assets=()
  while IFS= read -r asset; do
    assets+=("$asset")
  done < <(collect_assets "$version" "$tag" "$(cat "$RELEASE_NOTES_PATH")" "$RELEASE_HISTORY_PATH")

  if ! git rev-parse --verify --quiet "$tag" >/dev/null; then
    git tag "$tag" "$head_sha"
  fi

  # Upload every local artifact while the release is still a draft. Publishing only
  # after the upload completes lets the release workflow safely fill missing platforms.
  gh release create "$tag" "${assets[@]}" \
    --repo "$PUBLIC_RELEASE_REPO" \
    --target "$head_sha" \
    --title "SkillDock $tag" \
    --notes-file "$RELEASE_NOTES_PATH" \
    --draft

  gh release edit "$tag" \
    --repo "$PUBLIC_RELEASE_REPO" \
    --draft=false

  publish_source_tag "$tag"

  curl --fail --location --silent --show-error \
    "$PUBLIC_REPO_URL/releases/latest/download/latest.json" >/dev/null

  printf 'Published release: %s/releases/tag/%s\n' "$PUBLIC_REPO_URL" "$tag"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
