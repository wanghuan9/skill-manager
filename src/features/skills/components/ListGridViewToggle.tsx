import { useTranslate } from "@/app/i18n";

export type ListGridViewMode = "list" | "grid";

type ListGridViewToggleProps = {
  value: ListGridViewMode;
  onChange: (value: ListGridViewMode) => void;
  ariaLabel?: string;
};

function ListIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="2.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 7h8M6 10h8M6 13h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 4.25h4.5v4.5H4v-4.5ZM11.5 4.25H16v4.5h-4.5v-4.5ZM4 11.25h4.5v4.5H4v-4.5ZM11.5 11.25H16v4.5h-4.5v-4.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function ListGridViewToggle({ value, onChange, ariaLabel }: ListGridViewToggleProps) {
  const { t } = useTranslate();

  return (
    <div className="skills-view-toggle" role="group" aria-label={ariaLabel ?? t("skills.view.aria")}>
      <button
        className={`skills-view-toggle__button${value === "list" ? " is-active" : ""}`}
        type="button"
        aria-pressed={value === "list"}
        aria-label={t("skills.view.list")}
        data-tooltip={t("skills.view.list")}
        onClick={() => onChange("list")}
      >
        <ListIcon />
      </button>
      <button
        className={`skills-view-toggle__button${value === "grid" ? " is-active" : ""}`}
        type="button"
        aria-pressed={value === "grid"}
        aria-label={t("skills.view.grid")}
        data-tooltip={t("skills.view.grid")}
        onClick={() => onChange("grid")}
      >
        <GridIcon />
      </button>
    </div>
  );
}
