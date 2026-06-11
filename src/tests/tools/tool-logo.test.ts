import fs from "node:fs";
import path from "node:path";
import { toolConfigFixtures } from "@/features/skills/state/skill-fixtures";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";
import { buildSupportedAiToolCards } from "@/features/skills/utils/open-tools";

test("provides logo url for every supported AI tool", () => {
  for (const tool of buildSupportedAiToolCards(toolConfigFixtures)) {
    expect(getToolLogoUrl(tool.id)).toBeTruthy();
  }
});

test("uses local logo assets for every supported AI tool", () => {
  for (const tool of buildSupportedAiToolCards(toolConfigFixtures)) {
    const logoUrl = getToolLogoUrl(tool.id);
    expect(logoUrl).toBeTruthy();
    expect(logoUrl?.startsWith("/tool-logos/")).toBe(true);

    const publicPath = path.resolve(
      process.cwd(),
      "public",
      logoUrl!.replace("/tool-logos/", "tool-logos/"),
    );
    expect(fs.existsSync(publicPath)).toBe(true);
  }
});
