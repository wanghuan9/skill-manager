import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { alignExpandedRowIntoView } from "@/app/utils/align-expanded-row";

type RowAction = {
  key: string;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  icon?: ReactNode;
  tooltip?: string;
  content?: ReactNode;
};

type RowBadge = {
  key?: string;
  label: ReactNode;
  tone?: "neutral" | "positive" | "info" | "warning";
};

type ToolListRowProps = {
  rowId?: string;
  name: string;
  subtitle: string;
  leading?: ReactNode;
  meta?: ReactNode;
  badges?: RowBadge[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean, summaryElement?: HTMLButtonElement | null) => void;
  details: ReactNode;
  actions?: RowAction[];
  expandLabel?: string;
  collapseLabel?: string;
};

export function ToolListRow(props: ToolListRowProps) {
  const {
    actions = [],
    badges = [],
    details,
    expanded,
    leading,
    meta,
    name,
    rowId,
    onExpandedChange,
    subtitle,
    expandLabel = "展开",
    collapseLabel = "收起",
  } = props;

  return (
    <article
      className={`tool-list-row${expanded ? " is-expanded" : ""}`}
      data-tool-list-row-id={rowId}
    >
      <div className="tool-list-row__header">
        <button
          className="tool-list-row__summary"
          type="button"
          onClick={(event) => onExpandedChange(!expanded, event.currentTarget)}
          aria-expanded={expanded}
          aria-label={`${expanded ? collapseLabel : expandLabel} ${name}`}
        >
          {leading ? <span className="tool-list-row__leading">{leading}</span> : null}
          <div className="tool-list-row__title-stack">
            <div className="tool-list-row__title-row">
              <strong>{name}</strong>
              {badges.map((badge, badgeIndex) => (
                <span
                  key={badge.key ?? `${badge.tone ?? "neutral"}:${typeof badge.label === "string" ? badge.label : badgeIndex}`}
                  className={`status-badge tone-${badge.tone ?? "neutral"}`}
                >
                  {badge.label}
                </span>
              ))}
            </div>
            <p className="tool-list-row__subtitle">{subtitle}</p>
          </div>
        </button>
        {meta ? <div className="tool-list-row__meta">{meta}</div> : null}
        {actions.length > 0 ? (
          <div className="tool-list-row__actions">
            {actions.map((action) => {
              if (action.content) {
                return (
                  <span
                    key={action.key}
                    className={action.className}
                  >
                    {action.content}
                  </span>
                );
              }

              const isIconAction = Boolean(action.icon);

              return (
                <button
                  key={action.key}
                  className={
                    action.className ??
                    (isIconAction ? "skill-card__icon-button" : "secondary-button secondary-button--compact")
                  }
                  type="button"
                  onClick={action.onClick}
                  disabled={action.disabled}
                  aria-label={action.ariaLabel ?? action.label}
                  data-tooltip={action.tooltip}
                >
                  {action.icon ?? action.label}
                </button>
              );
            })}
          </div>
        ) : null}
        <span className="tool-list-row__chevron" aria-hidden="true">
          {expanded ? "⌄" : "›"}
        </span>
      </div>
      {expanded ? <div className="tool-list-row__details">{details}</div> : null}
    </article>
  );
}

type ToolListPageShellProps = {
  isLoading: boolean;
  isRefreshing: boolean;
  emptyTitle: string;
  emptyDescription: string;
  errorMessage: string;
  itemsCount: number;
  loadingText: string;
  refreshLabel: string;
  refreshBusyLabel: string;
  toolbarAriaLabel: string;
  onRefresh: () => void | Promise<void>;
  searchValue?: string;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  onSearchChange?: (value: string) => void;
  toolbarActions?: ReactNode;
  toolbarSlotId?: string;
  children: ReactNode;
};

export function RefreshIcon({ isSpinning = false }: { isSpinning?: boolean }) {
  return (
    <svg
      className={isSpinning ? "skills-toolbar-button__svg is-spinning" : "skills-toolbar-button__svg"}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M15.833 5.833A6.667 6.667 0 0 0 4.644 7.68M4.167 4.167v3.75h3.75M4.167 14.167A6.667 6.667 0 0 0 15.356 12.32M15.833 15.833v-3.75h-3.75"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ToolListPageShell(props: ToolListPageShellProps) {
  const {
    children,
    emptyDescription,
    emptyTitle,
    errorMessage,
    isLoading,
    isRefreshing,
    itemsCount,
    loadingText,
    onRefresh,
    refreshBusyLabel,
    refreshLabel,
    searchAriaLabel,
    searchPlaceholder,
    searchValue,
    onSearchChange,
    toolbarActions,
    toolbarSlotId,
    toolbarAriaLabel,
  } = props;
  const [toolbarContainer, setToolbarContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!toolbarSlotId) {
      setToolbarContainer(null);
      return;
    }

    setToolbarContainer(document.getElementById(toolbarSlotId));
  }, [toolbarSlotId]);

  if (isLoading) {
    return <p>{loadingText}</p>;
  }

  const toolbar = (
    <section className="mcp-toolbar skills-header-bar__tools" aria-label={toolbarAriaLabel}>
      {onSearchChange ? (
        <label className="search-field search-field--header mcp-toolbar__search">
          <span className="sr-only">{searchAriaLabel || searchPlaceholder || "搜索"}</span>
          <input
            type="search"
            placeholder={searchPlaceholder || ""}
            value={searchValue || ""}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
      ) : null}
      <button
        className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--refresh${isRefreshing ? " is-loading" : ""}`}
        type="button"
        onClick={() => void onRefresh()}
        disabled={isRefreshing}
      >
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          <RefreshIcon isSpinning={isRefreshing} />
        </span>
        <span>{isRefreshing ? refreshBusyLabel : refreshLabel}</span>
      </button>
      {toolbarActions}
    </section>
  );

  return (
    <div className="skills-page">
      {toolbarContainer ? createPortal(toolbar, toolbarContainer) : toolbar}
      <div className="card-list">
        {errorMessage ? (
          <div className="panel-card empty-state">
            <p>{errorMessage}</p>
          </div>
        ) : null}
        {itemsCount === 0 ? (
          <div className="panel-card empty-state">
            <h3>{emptyTitle}</h3>
            <p>{emptyDescription}</p>
          </div>
        ) : children}
      </div>
    </div>
  );
}

export function useSingleExpandedRow() {
  const [expandedId, setExpandedId] = useState("");

  async function handleExpandedChange(
    id: string,
    expanded: boolean,
    summaryElement?: HTMLButtonElement | null,
  ) {
    const previousExpandedId = expandedId;
    setExpandedId(expanded ? id : "");

    const isSwitchingExpandedRow = expanded && previousExpandedId !== "" && previousExpandedId !== id;
    if (!isSwitchingExpandedRow || !summaryElement) {
      return;
    }
    const rowElement = summaryElement.closest(".tool-list-row");
    await alignExpandedRowIntoView(rowElement instanceof HTMLElement ? rowElement : null);
  }

  return {
    expandedId,
    handleExpandedChange,
  };
}
