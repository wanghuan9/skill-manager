import { expect, test } from "vitest";
import { BusinessError, classifyError } from "@/app/errors";

test("classifies BusinessError as business", () => {
  expect(classifyError(new BusinessError("MCP 配置必须是 JSON 对象"), "fallback")).toEqual({
    kind: "business",
    message: "MCP 配置必须是 JSON 对象",
  });
});

test("classifies user-facing string errors as business", () => {
  expect(classifyError("请输入有效的 Git 仓库地址。", "fallback")).toEqual({
    kind: "business",
    message: "请输入有效的 Git 仓库地址。",
  });
});

test("classifies system-like string errors as unknown", () => {
  expect(classifyError("删除现有符号链接失败: Operation not permitted (os error 1)", "fallback")).toEqual({
    kind: "unknown",
    message: "删除现有符号链接失败: Operation not permitted (os error 1)",
  });
});

test("keeps explicit business strings as business when they do not include known system markers", () => {
  expect(classifyError("Failed to install MCP server: 配置缺少 command 字段", "fallback")).toEqual({
    kind: "business",
    message: "Failed to install MCP server: 配置缺少 command 字段",
  });
});

test("normalizes plain objects with a message field", () => {
  expect(classifyError({ message: "Operation not permitted (os error 1)" }, "fallback")).toEqual({
    kind: "unknown",
    message: "Operation not permitted (os error 1)",
  });
});
