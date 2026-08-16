import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const publishScript = path.join(repositoryRoot, "scripts/publish-release.sh");
const temporaryRoots: string[] = [];

function runGit(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createPublishedRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skilldock-release-source-"));
  temporaryRoots.push(root);
  const remote = path.join(root, "remote.git");
  const worktree = path.join(root, "worktree");

  runGit(root, ["init", "--bare", "--initial-branch=main", remote]);
  fs.mkdirSync(worktree);
  runGit(worktree, ["init", "-b", "main"]);
  runGit(worktree, ["config", "user.name", "SkillDock Test"]);
  runGit(worktree, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(worktree, "README.md"), "initial\n");
  runGit(worktree, ["add", "README.md"]);
  runGit(worktree, ["commit", "-m", "initial"]);
  runGit(worktree, ["remote", "add", "origin", remote]);
  runGit(worktree, ["push", "-u", "origin", "main"]);

  return worktree;
}

function checkPushedHead(worktree: string) {
  return spawnSync(
    "bash",
    ["-c", 'source "$1"; require_pushed_head', "bash", publishScript],
    { cwd: worktree, encoding: "utf8" },
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("release source guard", () => {
  test("accepts the exact upstream commit and rejects an unpushed commit", () => {
    const worktree = createPublishedRepository();
    const pushedHead = runGit(worktree, ["rev-parse", "HEAD"]);

    const pushedResult = checkPushedHead(worktree);
    expect(pushedResult.status).toBe(0);
    expect(pushedResult.stdout.trim()).toBe(pushedHead);

    fs.writeFileSync(path.join(worktree, "README.md"), "local change\n");
    runGit(worktree, ["add", "README.md"]);
    runGit(worktree, ["commit", "-m", "local change"]);

    const unpushedResult = checkPushedHead(worktree);
    expect(unpushedResult.status).not.toBe(0);
    expect(unpushedResult.stderr).toContain(
      "push the exact release commit first",
    );
  });
});
