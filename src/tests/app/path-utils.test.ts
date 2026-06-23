import { getDirectoryPath } from "@/app/path-utils";

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
