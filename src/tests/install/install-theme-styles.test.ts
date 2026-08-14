import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const tokensCss = readFileSync("src/styles/tokens.css", "utf8");

function getRuleBody(selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tokensCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));

  expect(match, `Missing CSS rule: ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("install theme styles", () => {
  test("uses theme colors for repo progress and selection states", () => {
    expect(getRuleBody(".repo-clone-progress-bar")).toContain("var(--accent)");
    expect(getRuleBody(".repo-clone-progress-bar")).toContain("var(--surface)");
    expect(getRuleBody(".repo-install__option.is-selected")).toContain("var(--accent)");
    expect(getRuleBody(".repo-install__option.is-selected")).toContain("var(--surface)");
  });

  test("uses theme colors for plugin and local install states", () => {
    expect(getRuleBody(".plugin-install-preview__host-toggle.is-selected")).toContain("var(--success)");
    expect(getRuleBody(".plugin-install-preview__host-toggle.is-installed")).toContain("var(--surface)");
    expect(getRuleBody(".local-install-subtab.is-selected")).toContain("var(--accent)");
    expect(getRuleBody(".local-install-dropzone.is-selected")).toContain("var(--success)");
    expect(getRuleBody(".local-install-dropzone.is-selected")).toContain("var(--surface)");
  });

  test("keeps long Git branch names inside the install form", () => {
    expect(getRuleBody(".repo-form__source-row")).toContain(
      "grid-template-columns: minmax(0, 1fr) 260px",
    );
    expect(getRuleBody(".repo-form__field--branch .app-select__trigger")).toContain(
      "overflow: hidden",
    );
    expect(getRuleBody(".repo-form__field--branch .app-select__trigger")).toContain(
      "height: 40px",
    );
    expect(getRuleBody(".repo-form__field--branch .app-select__value")).toContain(
      "text-overflow: ellipsis",
    );
  });

  test("uses the thin Skill scrollbar style throughout the app", () => {
    expect(getRuleBody("*")).toContain("scrollbar-width: thin");
    expect(getRuleBody("*::-webkit-scrollbar")).toContain("width: 10px");
    expect(getRuleBody("*::-webkit-scrollbar")).toContain("height: 10px");
    expect(getRuleBody("*::-webkit-scrollbar-thumb")).toContain(
      "border: 2px solid transparent",
    );
    expect(getRuleBody(".skill-diff__editor .cm-scroller")).toContain(
      "overscroll-behavior-y: none",
    );
    expect(getRuleBody(".skill-diff__editor .cm-scroller")).toContain(
      "scrollbar-gutter: stable",
    );
  });
});
