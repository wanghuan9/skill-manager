import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslate } from "@/app/i18n";
import type { SkillSourceViewStyle, ToolConfig } from "@/features/skills/state/skill-store";
import { getMonogramLabel } from "@/features/skills/utils/monogram";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";
import {
  MANAGED_SKILL_SOURCE_ID,
  type SkillSourceId,
} from "@/features/skills/utils/skill-source-view";

const MAX_VISIBLE_TOOL_SOURCES = 5;

type SkillSourceSwitcherProps = {
  activeSourceId: SkillSourceId;
  managedCount: number;
  sourceStyle: SkillSourceViewStyle;
  tools: ToolConfig[];
  toolCounts: Map<string, number>;
  onSourceChange: (sourceId: SkillSourceId) => void;
};

function ManagedLibraryIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="m10 2.7 1.25 4.05L15.3 8l-4.05 1.25L10 13.3 8.75 9.25 4.7 8l4.05-1.25L10 2.7Z" fill="currentColor" />
      <path d="m15.2 12.2.65 2.05 2.05.65-2.05.65-.65 2.05-.65-2.05-2.05-.65 2.05-.65.65-2.05Z" fill="currentColor" />
    </svg>
  );
}

function ToolSourceLogo({ tool }: { tool: ToolConfig }) {
  const [hasLoadError, setHasLoadError] = useState(false);
  const logoUrl = getToolLogoUrl(tool.id);

  return (
    <span className="skills-source-tab__logo" aria-hidden="true">
      {logoUrl && !hasLoadError ? (
        <img src={logoUrl} alt="" loading="lazy" onError={() => setHasLoadError(true)} />
      ) : (
        getMonogramLabel(tool.name)
      )}
    </span>
  );
}

function resolveVisibleTools(tools: ToolConfig[], activeSourceId: SkillSourceId) {
  const visibleTools = tools.slice(0, MAX_VISIBLE_TOOL_SOURCES);
  const activeTool = tools.find((tool) => tool.id === activeSourceId);
  if (!activeTool || visibleTools.some((tool) => tool.id === activeTool.id)) {
    return visibleTools;
  }

  return [...visibleTools.slice(0, MAX_VISIBLE_TOOL_SOURCES - 1), activeTool];
}

export function SkillSourceSwitcher(props: SkillSourceSwitcherProps) {
  const { activeSourceId, managedCount, onSourceChange, sourceStyle, toolCounts, tools } = props;
  const { t } = useTranslate();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const visibleTools = useMemo(
    () => resolveVisibleTools(tools, activeSourceId),
    [activeSourceId, tools],
  );
  const visibleToolIds = useMemo(() => new Set(visibleTools.map((tool) => tool.id)), [visibleTools]);
  const hiddenTools = tools.filter((tool) => !visibleToolIds.has(tool.id));
  const activeTool = tools.find((tool) => tool.id === activeSourceId) ?? null;
  const activeCount = activeTool ? toolCounts.get(activeTool.id) ?? 0 : managedCount;

  useEffect(() => {
    setIsMenuOpen(false);
  }, [activeSourceId, sourceStyle]);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMenuOpen]);

  function handleSourceChange(sourceId: SkillSourceId) {
    setIsMenuOpen(false);
    onSourceChange(sourceId);
  }

  function renderManagedSourceButton(className = "skills-source-tab") {
    const isSelected = activeSourceId === MANAGED_SKILL_SOURCE_ID;
    const isMenuItem = className.includes("menu-item");
    return (
      <button
        className={`${className}${isSelected ? " is-selected" : ""}`}
        type="button"
        role={isMenuItem ? "menuitem" : "tab"}
        aria-selected={isMenuItem ? undefined : isSelected}
        onClick={() => handleSourceChange(MANAGED_SKILL_SOURCE_ID)}
      >
        <span className="skills-source-tab__logo skills-source-tab__logo--managed" aria-hidden="true">
          <ManagedLibraryIcon />
        </span>
        <span>{t("skills.source.managedLibrary")}</span>
        <span className="skills-source-tab__count">{managedCount}</span>
      </button>
    );
  }

  function renderToolSourceButton(tool: ToolConfig, className = "skills-source-tab") {
    const isSelected = tool.id === activeSourceId;
    const isMenuItem = className.includes("menu-item");
    const count = toolCounts.get(tool.id) ?? 0;
    return (
      <button
        key={tool.id}
        className={`${className}${isSelected ? " is-selected" : ""}`}
        type="button"
        role={isMenuItem ? "menuitem" : "tab"}
        aria-selected={isMenuItem ? undefined : isSelected}
        aria-label={`${tool.name} ${count}`}
        onClick={() => handleSourceChange(tool.id)}
      >
        <ToolSourceLogo tool={tool} />
        {isMenuItem ? <span>{tool.name}</span> : null}
        <span className="skills-source-tab__count">{count}</span>
      </button>
    );
  }

  if (sourceStyle === "select") {
    return (
      <div className="skills-source-select-row">
        <div className="skills-source-menu" ref={menuRef}>
          <button
            className="skills-source-select-trigger"
            type="button"
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            onClick={() => setIsMenuOpen((current) => !current)}
          >
            {activeTool ? <ToolSourceLogo tool={activeTool} /> : (
              <span className="skills-source-tab__logo skills-source-tab__logo--managed" aria-hidden="true">
                <ManagedLibraryIcon />
              </span>
            )}
            <span>{activeTool?.name ?? t("skills.source.managedLibrary")}</span>
            <span className="skills-source-tab__count">{activeCount}</span>
            <span className="skills-source-select-trigger__chevron" aria-hidden="true">⌄</span>
          </button>
          {isMenuOpen ? (
            <div className="skills-source-menu__popover" role="menu">
              {renderManagedSourceButton("skills-source-menu-item")}
              {tools.map((tool) => renderToolSourceButton(tool, "skills-source-menu-item"))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`skills-source-tabs-row skills-source-tabs-row--${sourceStyle}`}>
      <div className="skills-source-tabs" role="tablist" aria-label={t("skills.source.tabs.aria")}>
        {renderManagedSourceButton()}
        {visibleTools.map((tool) => renderToolSourceButton(tool))}
        {hiddenTools.length > 0 ? (
          <div className="skills-source-menu" ref={menuRef}>
            <button
              className="skills-source-more-button"
              type="button"
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              onClick={() => setIsMenuOpen((current) => !current)}
            >
              {t("skills.source.more", { count: hiddenTools.length })}
              <span aria-hidden="true">⌄</span>
            </button>
            {isMenuOpen ? (
              <div className="skills-source-menu__popover skills-source-menu__popover--right" role="menu">
                {hiddenTools.map((tool) => renderToolSourceButton(tool, "skills-source-menu-item"))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
