import { useEffect, useState } from "react";
import { fetchCliTools } from "@/features/skills/api/skill-client";
import {
  ToolListPageShell,
  ToolListRow,
  useSingleExpandedRow,
} from "@/features/skills/components/ToolListRows";
import type { CliToolSummary } from "@/features/skills/state/skill-store";

function ImportIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 4.167v7.5m0 0 3.333-3.333M10 11.667 6.667 8.334M4.167 15h11.666"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CliRoute() {
  const [cliTools, setCliTools] = useState<CliToolSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [query, setQuery] = useState("");
  const { expandedId, handleExpandedChange } = useSingleExpandedRow();

  async function loadCliTools(options?: { silent?: boolean }) {
    const isSilent = options?.silent ?? false;
    if (isSilent) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const nextCliTools = await fetchCliTools();
      setCliTools(nextCliTools);
      setErrorMessage("");
    } catch (error) {
      console.warn("Failed to load CLI tools", error);
      setErrorMessage("读取 CLI 列表失败，请稍后重试。");
    } finally {
      if (isSilent) {
        setIsRefreshing(false);
      } else {
        setIsLoading(false);
      }
    }
  }

  useEffect(() => {
    let shouldIgnore = false;

    void (async () => {
      try {
        const nextCliTools = await fetchCliTools();
        if (!shouldIgnore) {
          setCliTools(nextCliTools);
          setErrorMessage("");
        }
      } catch (error) {
        console.warn("Failed to load CLI tools", error);
        if (!shouldIgnore) {
          setErrorMessage("读取 CLI 列表失败，请稍后重试。");
        }
      } finally {
        if (!shouldIgnore) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      shouldIgnore = true;
    };
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredCliTools = cliTools.filter((cliTool) => {
    if (!normalizedQuery) {
      return true;
    }

    const searchContent = [
      cliTool.name,
      cliTool.command,
      cliTool.description,
      cliTool.executablePath,
      cliTool.updateCommand,
      ...cliTool.bundledSkills,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchContent.includes(normalizedQuery);
  });

  return (
    <ToolListPageShell
      isLoading={isLoading}
      isRefreshing={isRefreshing}
      emptyTitle="还没有检测到 CLI 包。"
      emptyDescription="这里只展示类似飞书 CLI 这种 CLI 本体和官方 skills 一起管理、一起更新的 CLI 包。"
      errorMessage={errorMessage}
      itemsCount={filteredCliTools.length}
      loadingText="正在加载 CLI..."
      refreshLabel="刷新"
      refreshBusyLabel="刷新中..."
      toolbarAriaLabel="CLI 工具栏"
      searchValue={query}
      searchPlaceholder="搜索 CLI、命令或 Skill"
      searchAriaLabel="搜索 CLI 包"
      onRefresh={() => loadCliTools({ silent: true })}
      onSearchChange={setQuery}
      toolbarSlotId="tool-list-header-toolbar-slot"
      toolbarActions={(
        <button
          className="secondary-button secondary-button--compact skills-toolbar-button"
          type="button"
          disabled
        >
          <span aria-hidden="true" className="skills-toolbar-button__icon">
            <ImportIcon />
          </span>
          <span>扫描导入</span>
        </button>
      )}
    >
      {filteredCliTools.map((cliTool) => (
        <ToolListRow
          key={cliTool.id}
          rowId={cliTool.id}
          name={cliTool.name}
          subtitle={`${cliTool.description || cliTool.command}${cliTool.bundledSkills.length > 0 ? ` · 绑定 ${cliTool.bundledSkills.length} 个 skills` : ""}`}
          badges={[{ label: cliTool.statusLabel || "已识别", tone: "neutral" }]}
          expanded={expandedId === cliTool.id}
          onExpandedChange={(expanded, summaryElement) => handleExpandedChange(cliTool.id, expanded, summaryElement)}
          details={(
            <div className="tool-list-row__detail-grid">
              <div>
                <dt>命令</dt>
                <dd>{cliTool.command || "未知"}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{cliTool.statusLabel || "未知"}</dd>
              </div>
              <div>
                <dt>可执行路径</dt>
                <dd title={cliTool.executablePath}>{cliTool.executablePath || "未知"}</dd>
              </div>
              <div>
                <dt>更新命令</dt>
                <dd>{cliTool.updateCommand || "未知"}</dd>
              </div>
              <div>
                <dt>更新策略</dt>
                <dd>{cliTool.updateStrategy === "self-only" ? "仅更新 CLI 本体" : "更新 CLI 时联动更新官方 skills"}</dd>
              </div>
              <div>
                <dt>绑定 skills</dt>
                <dd>{cliTool.bundledSkills.join(" · ") || "暂无识别结果"}</dd>
              </div>
              <div>
                <dt>描述</dt>
                <dd>{cliTool.description || "暂无描述"}</dd>
              </div>
            </div>
          )}
        />
      ))}
    </ToolListPageShell>
  );
}
