import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type AppSelectOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

type AppSelectProps<T extends string> = {
  value: T;
  options: readonly AppSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  menuClassName?: string;
  minMenuWidth?: number;
  selectedLabel?: ReactNode;
  disabled?: boolean;
};

const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;
const MIN_MENU_HEIGHT = 96;
const DEFAULT_MIN_MENU_WIDTH = 144;

function nextEnabledIndex<T extends string>(
  options: readonly AppSelectOption<T>[],
  currentIndex: number,
  direction: 1 | -1,
) {
  if (options.length === 0) {
    return -1;
  }

  for (let offset = 1; offset <= options.length; offset += 1) {
    const candidateIndex = (currentIndex + direction * offset + options.length) % options.length;
    if (!options[candidateIndex]?.disabled) {
      return candidateIndex;
    }
  }

  return -1;
}

function boundaryEnabledIndex<T extends string>(options: readonly AppSelectOption<T>[], fromEnd: boolean) {
  if (fromEnd) {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index]?.disabled) {
        return index;
      }
    }
    return -1;
  }

  return options.findIndex((option) => !option.disabled);
}

export function AppSelect<T extends string>(props: AppSelectProps<T>) {
  const {
    ariaLabel,
    className = "",
    disabled = false,
    menuClassName = "",
    minMenuWidth = DEFAULT_MIN_MENU_WIDTH,
    onChange,
    options,
    selectedLabel,
    value,
  } = props;
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listboxId = `app-select-${useId().replace(/:/g, "")}`;
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = options[selectedIndex] ?? options[0];

  function updateMenuPosition() {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const width = Math.min(
      Math.max(rect.width, minMenuWidth),
      window.innerWidth - VIEWPORT_PADDING * 2,
    );
    const left = Math.min(
      Math.max(rect.left, VIEWPORT_PADDING),
      Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING),
    );
    const availableHeight = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_PADDING;
    setMenuStyle({
      top: rect.bottom + MENU_GAP,
      left,
      width,
      maxHeight: Math.max(MIN_MENU_HEIGHT, availableHeight),
    });
  }

  function openMenu() {
    if (disabled || options.length === 0) {
      return;
    }
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : boundaryEnabledIndex(options, false));
    updateMenuPosition();
    setIsOpen(true);
  }

  function closeMenu(restoreFocus = false) {
    setIsOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }

  function selectOption(index: number) {
    const option = options[index];
    if (!option || option.disabled) {
      return;
    }
    onChange(option.value);
    closeMenu(true);
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      if (isOpen) {
        event.preventDefault();
        closeMenu();
      }
      return;
    }

    if (event.key === "Tab") {
      closeMenu();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => nextEnabledIndex(options, current, direction));
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      if (!isOpen) {
        return;
      }
      event.preventDefault();
      setActiveIndex(boundaryEnabledIndex(options, event.key === "End"));
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (isOpen && activeIndex >= 0) {
        selectOption(activeIndex);
      } else {
        openMenu();
      }
    }
  }

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        closeMenu();
      }
    }

    function handleViewportChange() {
      updateMenuPosition();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

  const activeOptionId = activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;
  const rootClassName = `app-select${className ? ` ${className}` : ""}`;

  return (
    <div className={rootClassName}>
      <button
        ref={triggerRef}
        className="app-select__trigger"
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={listboxId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-activedescendant={isOpen ? activeOptionId : undefined}
        data-value={value}
        disabled={disabled}
        onClick={() => (isOpen ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="app-select__value">{selectedLabel ?? selectedOption?.label ?? ""}</span>
        <svg className="app-select__chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="m2.5 4.5 3.5 3 3.5-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {isOpen ? createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className={`app-select__popover${menuClassName ? ` ${menuClassName}` : ""}`}
          role="listbox"
          aria-label={ariaLabel}
          style={menuStyle}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            return (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                className={`app-select__option${isSelected ? " is-selected" : ""}${isActive ? " is-active" : ""}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={option.disabled}
                onPointerEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(index)}
              >
                <span className="app-select__check" aria-hidden="true">{isSelected ? "✓" : ""}</span>
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
