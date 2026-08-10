import {
  formatHomePathForDisplay,
  formatPathForDisplay,
  getDirectoryPath,
  getWorkspaceDirectoryPath,
} from "@/app/path-utils";

test("getDirectoryPath strips settings file on macOS paths", () => {
  expect(getDirectoryPath("/Users/demo/.skilldock/settings.json")).toBe("/Users/demo/.skilldock");
});

test("getDirectoryPath strips settings file on Windows paths", () => {
  expect(getDirectoryPath(String.raw`C:\Users\xinya.zhang.TRANSSION\.skilldock\settings.json`))
    .toBe(String.raw`C:\Users\xinya.zhang.TRANSSION\.skilldock`);
});

test("getDirectoryPath supports mixed separators", () => {
  expect(getDirectoryPath(String.raw`C:/Users/demo/.skilldock\settings.json`))
    .toBe(String.raw`C:/Users/demo/.skilldock`);
});

test.each([
  ["/Users/demo/.skilldock/config/settings.json", "/Users/demo/.skilldock"],
  [
    String.raw`C:\Users\demo\.skilldock\config\settings.json`,
    String.raw`C:\Users\demo\.skilldock`,
  ],
  ["/Users/demo/.skilldock/settings.json", "/Users/demo/.skilldock"],
])("getWorkspaceDirectoryPath resolves the SkillDock root for %s", (settingsPath, expected) => {
  expect(getWorkspaceDirectoryPath(settingsPath)).toBe(expected);
});

test("getWorkspaceDirectoryPath preserves empty and ordinary settings directories", () => {
  expect(getWorkspaceDirectoryPath("   ")).toBe("");
  expect(getWorkspaceDirectoryPath("/Users/demo/configuration/settings.json"))
    .toBe("/Users/demo/configuration");
});

test.each([
  ["/Users/demo/.skilldock/skills", "~/.skilldock/skills"],
  [String.raw`C:\Users\demo\.skilldock\skills`, "~/.skilldock/skills"],
  [String.raw`c:\users\demo\.agents\skills`, "~/.agents/skills"],
  [String.raw`\\?\C:\Users\demo\.agents\skills\analyze-project`, "~/.agents/skills/analyze-project"],
])("formatHomePathForDisplay abbreviates user directories", (filePath, expected) => {
  expect(formatHomePathForDisplay(filePath)).toBe(expected);
});

test("formatPathForDisplay only removes the Windows extended path prefix", () => {
  expect(formatPathForDisplay(String.raw`\\?\C:\Users\demo\.agents\skills`))
    .toBe(String.raw`C:\Users\demo\.agents\skills`);
  expect(formatPathForDisplay(String.raw`\\?\UNC\server\share\skills`))
    .toBe(String.raw`\\server\share\skills`);
});
