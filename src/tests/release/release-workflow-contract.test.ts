import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readRepositoryFile(relativePath: string) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

describe("public release workflow contract", () => {
  test("binds local releases to the exact pushed public commit", () => {
    const publishScript = readRepositoryFile("scripts/publish-release.sh");

    expect(publishScript).toContain(
      'SOURCE_REPO_URL="https://github.com/wanghuan9/skilldock.git"',
    );
    expect(publishScript).toContain("require_pushed_head");
    expect(publishScript).toContain("require_release_workflow_on_default_branch");
    expect(publishScript).toContain('--target "$head_sha"');
    expect(publishScript).toContain("--draft");
    expect(publishScript).toContain('--draft=false');
    expect(publishScript).not.toContain("--target main");
  });

  test("builds GitHub releases from the selected public source ref", () => {
    const workflow = readRepositoryFile(".github/workflows/release.yml");

    expect(workflow).toContain("types: [published]");
    expect(workflow).toContain("SOURCE_REF:");
    expect(workflow).toContain("ref: ${{ env.SOURCE_REF }}");
    expect(workflow).toContain(
      "releaseCommitish: ${{ steps.release_source.outputs.sha }}",
    );
    expect(workflow).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(workflow).not.toContain("PUBLIC_RELEASE_TOKEN");
    expect(workflow).not.toContain("releaseCommitish: main");
  });
});
