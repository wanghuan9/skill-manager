import { useEffect, useRef, type ReactNode } from "react";

export type BatchAction = {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  isBusy?: boolean;
  tone?: "default" | "accent" | "success" | "warning" | "danger";
  icon?: ReactNode;
};

type BatchModeButtonProps = {
  isSelecting: boolean;
  label: string;
  onClick: () => void;
};

type BatchActionBarProps = {
  actions: BatchAction[];
  ariaLabel: string;
  cancelLabel: string;
  deselectAllLabel: string;
  hint: string;
  isAllVisibleSelected: boolean;
  isBusy: boolean;
  selectedLabel: string;
  selectAllDisabled: boolean;
  selectAllLabel: string;
  onCancel: () => void;
  onToggleSelectAll: () => void;
};

type BatchDeleteDialogProps = {
  cancelLabel: string;
  confirmLabel: string;
  description: string;
  isBusy: boolean;
  isOpen: boolean;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
};

function SelectionIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="2.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="m6.6 10 2.1 2.1 4.7-4.7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BatchSelectionMark({
  checked,
  indeterminate = false,
}: {
  checked: boolean;
  indeterminate?: boolean;
}) {
  return (
    <span
      className={`batch-selection-mark${checked ? " is-checked" : ""}${indeterminate ? " is-indeterminate" : ""}`}
      aria-hidden="true"
    >
      {indeterminate ? <span>−</span> : checked ? <span>✓</span> : null}
    </span>
  );
}

export function BatchModeButton(props: BatchModeButtonProps) {
  return (
    <button
      className={`secondary-button secondary-button--compact skills-toolbar-button batch-mode-button${props.isSelecting ? " is-selected" : ""}`}
      type="button"
      aria-label={props.label}
      aria-pressed={props.isSelecting}
      data-tooltip={props.label}
      onClick={props.onClick}
    >
      <span className="skills-toolbar-button__icon" aria-hidden="true">
        <SelectionIcon />
      </span>
    </button>
  );
}

export function BatchActionBar(props: BatchActionBarProps) {
  return (
    <section className="batch-action-bar" aria-label={props.ariaLabel}>
      <div className="batch-action-bar__actions">
        {props.actions.map((action) => (
          <button
            key={action.key}
            className={`batch-action-button tone-${action.tone ?? "default"}${action.isBusy ? " is-busy" : ""}`}
            type="button"
            disabled={props.isBusy || action.disabled}
            onClick={action.onClick}
          >
            {action.icon ? <span className="batch-action-button__icon" aria-hidden="true">{action.icon}</span> : null}
            <span>{action.label}</span>
          </button>
        ))}
        <span className={`batch-action-bar__selection-controls${props.actions.length > 0 ? " has-actions" : ""}`}>
          <button
            className="batch-action-button batch-selection-action batch-selection-action--toggle"
            type="button"
            disabled={props.isBusy || props.selectAllDisabled}
            onClick={props.onToggleSelectAll}
          >
            <span className="batch-action-button__icon" aria-hidden="true">
              <SelectionIcon />
            </span>
            <span>{props.isAllVisibleSelected ? props.deselectAllLabel : props.selectAllLabel}</span>
          </button>
          <button
            className="batch-action-button batch-selection-action"
            type="button"
            disabled={props.isBusy}
            onClick={props.onCancel}
          >
            {props.cancelLabel}
          </button>
        </span>
      </div>
      <span className="batch-action-bar__summary">
        {props.selectedLabel || props.hint}
      </span>
    </section>
  );
}

export function BatchDeleteDialog(props: BatchDeleteDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!props.isOpen) {
      return;
    }
    cancelButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !props.isBusy) {
        props.onCancel();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [props.isBusy, props.isOpen, props.onCancel]);

  if (!props.isOpen) {
    return null;
  }

  return (
    <div
      className="dialog-backdrop batch-delete-dialog__backdrop"
      role="presentation"
      onClick={() => {
        if (!props.isBusy) {
          props.onCancel();
        }
      }}
    >
      <section
        className="batch-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-delete-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="batch-delete-dialog__icon" aria-hidden="true">!</div>
        <div className="batch-delete-dialog__copy">
          <h3 id="batch-delete-dialog-title">{props.title}</h3>
          <p>{props.description}</p>
        </div>
        <div className="batch-delete-dialog__actions">
          <button
            ref={cancelButtonRef}
            className="secondary-button secondary-button--compact"
            type="button"
            disabled={props.isBusy}
            onClick={props.onCancel}
          >
            {props.cancelLabel}
          </button>
          <button
            className="batch-delete-dialog__confirm"
            type="button"
            disabled={props.isBusy}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
