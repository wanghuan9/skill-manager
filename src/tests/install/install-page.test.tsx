import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("renders install-source and repository install panels", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  expect(screen.getByRole("heading", { name: "安装", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Skill" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "MCP" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "市场安装" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "skills.sh" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "skillsmp" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));
  expect(screen.getByRole("textbox", { name: "Git 仓库地址" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "识别仓库技能" })).toBeInTheDocument();
});

test("shows MCP marketplace separately from skill-only install methods", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("tab", { name: "Git 安装" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "本地安装" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "安装源", level: 2 })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "mcp.directory" })).toBeInTheDocument();
  expect(await screen.findByText("playwright")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "加载更多" })).toBeInTheDocument();
});

test("keeps MCP marketplace card and detail metadata consistent", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  const context7Heading = await screen.findByRole("heading", { name: "context7", level: 3 });
  const context7Card = context7Heading.closest("article");
  if (!context7Card) {
    throw new Error("context7 marketplace card was not rendered");
  }

  expect(within(context7Card).getByText("来源: mcp.directory")).toBeInTheDocument();
  expect(within(context7Card).getByText("作者: upstash")).toBeInTheDocument();
  expect(within(context7Card).getByText("下载量: 36.7K")).toBeInTheDocument();
  expect(within(context7Card).getByText("分类: AI/ML")).toBeInTheDocument();

  await userEvent.click(context7Heading);

  const detailDialog = screen.getByRole("dialog", { name: "context7 详情" });
  expect(within(detailDialog).getByText("来源: mcp.directory")).toBeInTheDocument();
  expect(within(detailDialog).getByText("作者: upstash")).toBeInTheDocument();
  expect(within(detailDialog).getByText("下载量: 36.7K")).toBeInTheDocument();
  expect(within(detailDialog).getByText("分类: AI/ML")).toBeInTheDocument();
});

test("installs MCP marketplace servers into the managed MCP list without enabling tools", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  const installButtons = await screen.findAllByRole("button", { name: "安装" });
  await userEvent.click(installButtons[0]);

  expect(await screen.findByRole("button", { name: "已加入" })).toBeDisabled();
});

test("searches MCP marketplace and restores browse pagination after clearing query", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  expect(await screen.findByText("context7")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "加载更多" })).toBeInTheDocument();

  const searchInput = screen.getByRole("searchbox", { name: "搜索 MCP" });
  await userEvent.type(searchInput, "playwright");

  await waitFor(() => {
    expect(screen.getByText("playwright")).toBeInTheDocument();
    expect(screen.queryByText("context7")).not.toBeInTheDocument();
  });
  expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();

  await userEvent.clear(searchInput);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "加载更多" })).toBeInTheDocument();
  });
});

test("discovers repo skills and allows multi-select install", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), "https://github.com/team/skill-repo");
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  expect(screen.getByRole("button", { name: "检查中..." })).toBeDisabled();
  expect(await screen.findByText("发现 2 个技能，请选择要安装的技能")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "安装选中技能" })).toBeInTheDocument();
  expect(screen.getByText("service-observer")).toBeInTheDocument();
  expect(screen.getByText("release-scribe")).toBeInTheDocument();
});

test("installs a local skill from a typed path", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  await userEvent.click(screen.getByRole("tab", { name: "本地安装" }));

  await userEvent.type(screen.getByRole("textbox", { name: "本地 skill 路径" }), "/Users/demo/skills/local-helper");
  await userEvent.type(screen.getByRole("textbox", { name: "技能名称（可选）" }), "local-helper");
  await userEvent.click(screen.getByRole("button", { name: "安装技能" }));

  expect(await screen.findByRole("status")).toHaveTextContent("本地技能已安装");
});

test("shows install errors in the global notification stack", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), "invalid-url");
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  expect(screen.getByRole("alert")).toHaveTextContent("请输入有效的 Git 仓库地址。");
});

test("marks already installed repo skills as unavailable", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(
    screen.getByRole("textbox", { name: "Git 仓库地址" }),
    "https://github.com/team/duplicate-skill-repo",
  );
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  expect(await screen.findByText("发现 2 个技能，请选择要安装的技能")).toBeInTheDocument();
  expect(screen.getByText("已安装")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /drawio-diagram/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /service-observer/i })).not.toBeDisabled();
});

test("searches marketplace skills across all supported sources", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));

  const searchInput = screen.getByRole("searchbox", { name: "搜索 skill" });
  await userEvent.type(searchInput, "guardian");

  expect(await screen.findByText("release-guardian")).toBeInTheDocument();
  expect(screen.getByText("repo-guardian")).toBeInTheDocument();
});

test("sorts marketplace search results by popularity across sources", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));

  await userEvent.type(screen.getByRole("searchbox", { name: "搜索 skill" }), "skills");

  await waitFor(() => {
    expect(screen.getAllByRole("heading", { level: 3 }).map((item) => item.textContent)).toEqual([
      "workflow-critic",
      "release-guardian",
      "design-system-reviewer",
      "repo-guardian",
    ]);
  });
});

test("keeps source results isolated and preserves the skills.sh display order", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));

  const skillsShCards = screen
    .getAllByRole("heading", { level: 3 })
    .map((item) => item.textContent);
  expect(skillsShCards).toEqual(["workflow-critic", "design-system-reviewer"]);

  await userEvent.click(screen.getByRole("tab", { name: "skillsmp" }));

  const skillsMpCards = await screen.findAllByRole("heading", { level: 3 });
  expect(skillsMpCards.map((item) => item.textContent)).toEqual(["release-guardian", "repo-guardian"]);
  expect(screen.queryByText("workflow-critic")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "skills.sh" }));
  expect(screen.getAllByRole("heading", { level: 3 }).map((item) => item.textContent)).toEqual([
    "workflow-critic",
    "design-system-reviewer",
  ]);
});
