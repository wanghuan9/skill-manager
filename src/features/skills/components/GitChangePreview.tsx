import { useEffect, useState } from "react";
import type { GitChangeFile } from "@/features/skills/state/skill-store";

type GitChangePreviewProps = {
  files: GitChangeFile[];
  emptyText: string;
};

function formatChangeStatus(status: string) {
  const normalized = status.trim().charAt(0);
  if (normalized === "A" || normalized === "?") {
    return "新增";
  }
  if (normalized === "D") {
    return "删除";
  }
  if (normalized === "R") {
    return "重命名";
  }
  return "修改";
}

export function GitChangePreview({ files, emptyText }: GitChangePreviewProps) {
  const [expandedPath, setExpandedPath] = useState<string | null>(files[0]?.path ?? null);

  useEffect(() => {
    if (!expandedPath || !files.some((file) => file.path === expandedPath)) {
      setExpandedPath(files[0]?.path ?? null);
    }
  }, [expandedPath, files]);

  if (files.length === 0) {
    return <p className="change-preview__empty">{emptyText}</p>;
  }

  return (
    <div className="change-preview">
      {files.map((file) => {
        const expanded = expandedPath === file.path;

        return (
          <div className="change-preview__item" key={`${file.status}-${file.path}`}>
            <button
              className="change-preview__row"
              type="button"
              onClick={() => setExpandedPath(expanded ? null : file.path)}
            >
              <span className={`change-preview__status change-preview__status--${file.status.charAt(0).toLowerCase()}`}>
                {formatChangeStatus(file.status)}
              </span>
              <span className="change-preview__path">{file.path}</span>
              <span className="change-preview__toggle">{expanded ? "收起" : "查看 diff"}</span>
            </button>
            {expanded ? (
              <pre className="change-preview__diff">
                {file.diff.trim() ? file.diff : "暂无可展示的文本差异。"}
              </pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
