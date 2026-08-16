import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const generator = path.join(repositoryRoot, "scripts/generate-release-notes.cjs");
const temporaryRoots: string[] = [];

function runGit(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createVersionedRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skilldock-release-notes-"));
  temporaryRoots.push(root);
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.name", "SkillDock Test"]);
  runGit(root, ["config", "user.email", "test@example.com"]);

  fs.mkdirSync(path.join(root, "docs/release/notes"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs/release/notes/v1.0.0.md"),
    "## 新增\n\n- 初始版本。\n",
  );
  fs.writeFileSync(path.join(root, "package.json"), '{"version":"1.1.0"}\n');
  runGit(root, ["add", "package.json", "docs/release/notes/v1.0.0.md"]);
  runGit(root, ["commit", "-m", "initial"]);
  runGit(root, ["tag", "v1.0.0"]);

  fs.mkdirSync(path.join(root, "src-tauri/src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src-tauri/src/mcp_manager.rs"), "// MCP change\n");
  fs.writeFileSync(path.join(root, "src-tauri/src/plugin_manager.rs"), "// plugin change\n");
  runGit(root, ["add", "src-tauri/src"]);
  runGit(root, ["commit", "-m", "feat: update MCP and plugins"]);
  runGit(root, ["tag", "v1.1.0"]);

  return root;
}

function generatorArgs(root: string, curatedNotes: string, outputPrefix: string) {
  return [
    generator,
    "--version", "1.1.0",
    "--tag", "v1.1.0",
    "--previous-tag", "v1.0.0",
    "--output", path.join(root, `${outputPrefix}-notes.md`),
    "--summary-output", path.join(root, `${outputPrefix}-summary.txt`),
    "--history-output", path.join(root, `${outputPrefix}-history.json`),
    "--curated-notes", curatedNotes,
  ];
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("release notes CLI", () => {
  test("publishes one validated body to notes and current release history", () => {
    const root = createVersionedRepository();
    const curatedPath = path.join(root, "curated.md");
    const curatedNotes = [
      "## 修复",
      "",
      "- 修复 MCP 安装同步。",
      "- 修复 Cursor 与 Codex 插件运行副本同步。",
      "",
    ].join("\n");
    fs.writeFileSync(curatedPath, curatedNotes);

    execFileSync(process.execPath, generatorArgs(root, curatedPath, "valid"), {
      cwd: root,
      encoding: "utf8",
    });

    const outputNotes = fs.readFileSync(path.join(root, "valid-notes.md"), "utf8");
    const history = JSON.parse(fs.readFileSync(path.join(root, "valid-history.json"), "utf8"));
    const currentEntry = history.find((entry: { version: string }) => entry.version === "1.1.0");
    const previousEntry = history.find((entry: { version: string }) => entry.version === "1.0.0");

    expect(outputNotes).toBe(curatedNotes);
    expect(currentEntry.body).toBe(curatedNotes);
    expect(previousEntry.body).toBe("## 新增\n\n- 初始版本。\n");
  });

  test("rejects incomplete curated notes before writing release artifacts", () => {
    const root = createVersionedRepository();
    const curatedPath = path.join(root, "incomplete.md");
    fs.writeFileSync(curatedPath, "## 修复\n\n- 修复插件运行副本同步。\n");

    const result = spawnSync(process.execPath, generatorArgs(root, curatedPath, "invalid"), {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MCP 管理");
    expect(fs.existsSync(path.join(root, "invalid-notes.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "invalid-summary.txt"))).toBe(false);
    expect(fs.existsSync(path.join(root, "invalid-history.json"))).toBe(false);
  });

  test("rejects an invalid version range instead of treating it as an empty diff", () => {
    const root = createVersionedRepository();
    const curatedPath = path.join(root, "curated.md");
    fs.writeFileSync(
      curatedPath,
      "## 修复\n\n- 修复 MCP 与插件安装同步。\n",
    );
    const args = generatorArgs(root, curatedPath, "missing-range");
    args[args.indexOf("--previous-tag") + 1] = "v0.0.0-missing";

    const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(root, "missing-range-notes.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "missing-range-summary.txt"))).toBe(false);
    expect(fs.existsSync(path.join(root, "missing-range-history.json"))).toBe(false);
  });

  test("validates against the exact build commit when an existing tag is behind", () => {
    const root = createVersionedRepository();
    const curatedPath = path.join(root, "curated.md");
    fs.writeFileSync(
      curatedPath,
      "## 修复\n\n- 修复 MCP 与插件安装同步。\n",
    );
    fs.writeFileSync(path.join(root, "src-tauri/src/workspace.rs"), "// workspace change\n");
    runGit(root, ["add", "src-tauri/src/workspace.rs"]);
    runGit(root, ["commit", "-m", "feat: migrate workspace"]);
    const args = generatorArgs(root, curatedPath, "exact-ref");
    args.push("--current-ref", "HEAD");

    const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("工作区与目录迁移");
    expect(fs.existsSync(path.join(root, "exact-ref-notes.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "exact-ref-summary.txt"))).toBe(false);
    expect(fs.existsSync(path.join(root, "exact-ref-history.json"))).toBe(false);
  });
});
