import { expect, test } from "vitest";
import {
  getSkillFileLanguage,
  normalizeCodeFenceLanguage,
} from "@/features/skills/utils/skill-file-language";

test.each([
  ["SKILL.md", "markdown", "Markdown", "markdown"],
  ["scripts/render.tsx", "typescript", "TypeScript", "code"],
  ["config/settings.yaml", "yaml", "YAML", "config"],
  ["Dockerfile", "dockerfile", "Dockerfile", "config"],
  ["scripts/setup.ps1", "powershell", "PowerShell", "code"],
])("recognizes the preview language for %s", (path, language, label, kind) => {
  expect(getSkillFileLanguage(path)).toEqual({ language, label, kind });
});

test("normalizes common fenced code language aliases", () => {
  expect(normalizeCodeFenceLanguage("ts")).toBe("typescript");
  expect(normalizeCodeFenceLanguage("shell")).toBe("bash");
  expect(normalizeCodeFenceLanguage("html")).toBe("xml");
  expect(normalizeCodeFenceLanguage("unknown-language")).toBe("");
});

test("leaves unsupported binary files unclassified", () => {
  expect(getSkillFileLanguage("assets/icon.png")).toBeNull();
});
