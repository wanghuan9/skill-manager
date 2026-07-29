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
});
