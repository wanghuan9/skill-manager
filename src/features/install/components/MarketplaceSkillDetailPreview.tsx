import { useEffect, useMemo, useState } from "react";
import { useTranslate } from "@/app/i18n";
import {
  fetchMarketplaceSkillFileBrowser,
  fetchMarketplaceSkillFileContent,
} from "@/features/skills/api/skill-client";
import {
  buildInitialCollapsedDirectories,
  collectAncestorDirectoryPaths,
  SkillFileContentSurface,
  SkillFileTreeSidebar,
} from "@/features/skills/components/SkillFileDialog";
import type {
  MarketplaceSkill,
  SkillFileBrowserSnapshot,
  SkillFileDocument,
} from "@/features/skills/state/skill-store";

type MarketplaceSkillDetailPreviewProps = {
  skill: MarketplaceSkill;
};

const MARKETPLACE_FILE_TREE_CACHE_LIMIT = 24;
const MARKETPLACE_FILE_CONTENT_CACHE_LIMIT = 60;
const marketplaceFileTreeCache = new Map<string, SkillFileBrowserSnapshot>();
const marketplaceFileContentCache = new Map<string, SkillFileDocument>();

function setBoundedCache<Value>(
  cache: Map<string, Value>,
  key: string,
  value: Value,
  limit: number,
) {
  if (!cache.has(key) && cache.size >= limit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, value);
}

function marketplaceFileTreeCacheKey(skill: MarketplaceSkill) {
  return `${skill.sourceUrl}#${skill.skillPath ?? ""}`;
}

function marketplaceFileContentCacheKey(skill: MarketplaceSkill, relativePath: string) {
  return `${marketplaceFileTreeCacheKey(skill)}#${relativePath}`;
}

function previewErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

export function MarketplaceSkillDetailPreview({ skill }: MarketplaceSkillDetailPreviewProps) {
  const { t } = useTranslate();
  const [entries, setEntries] = useState<SkillFileBrowserSnapshot["entries"]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("");
  const [isTreeLoading, setIsTreeLoading] = useState(true);
  const [isContentLoading, setIsContentLoading] = useState(false);
  const [treeErrorMessage, setTreeErrorMessage] = useState("");
  const [contentErrorMessage, setContentErrorMessage] = useState("");
  const [collapsedDirectories, setCollapsedDirectories] = useState<Record<string, boolean>>({});
  const fileEntries = useMemo(
    () => entries.filter((entry) => entry.entryType === "file"),
    [entries],
  );
  const treeEntries = useMemo(
    () =>
      entries.length > 0
        ? entries
        : [
            {
              path: "",
              name: skill.name,
              entryType: "directory" as const,
              depth: 0,
            },
          ],
    [entries, skill.name],
  );

  useEffect(() => {
    let active = true;
    const cacheKey = marketplaceFileTreeCacheKey(skill);
    const cachedSnapshot = marketplaceFileTreeCache.get(cacheKey);

    function applySnapshot(snapshot: SkillFileBrowserSnapshot) {
      if (snapshot.entries.length === 0 || !snapshot.initialFilePath) {
        throw new Error(t("install.market.detail.filesUnavailable"));
      }
      setEntries(snapshot.entries);
      setSelectedPath(snapshot.initialFilePath);
      setCollapsedDirectories(
        buildInitialCollapsedDirectories(snapshot.entries, snapshot.initialFilePath),
      );
    }

    setEntries([]);
    setSelectedPath("");
    setContent("");
    setTreeErrorMessage("");
    setContentErrorMessage("");
    setIsTreeLoading(true);

    if (cachedSnapshot) {
      try {
        applySnapshot(cachedSnapshot);
      } catch (error) {
        setTreeErrorMessage(
          previewErrorMessage(error, t("install.market.detail.filesUnavailable")),
        );
      } finally {
        setIsTreeLoading(false);
      }
      return () => {
        active = false;
      };
    }

    void fetchMarketplaceSkillFileBrowser({
      sourceUrl: skill.sourceUrl,
      skillPath: skill.skillPath ?? "",
      skillName: skill.name,
    })
      .then((snapshot) => {
        if (!active) {
          return;
        }
        applySnapshot(snapshot);
        setBoundedCache(
          marketplaceFileTreeCache,
          cacheKey,
          snapshot,
          MARKETPLACE_FILE_TREE_CACHE_LIMIT,
        );
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setTreeErrorMessage(
          previewErrorMessage(error, t("install.market.detail.filesUnavailable")),
        );
      })
      .finally(() => {
        if (active) {
          setIsTreeLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [skill, t]);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    let active = true;
    const cacheKey = marketplaceFileContentCacheKey(skill, selectedPath);
    const cachedDocument = marketplaceFileContentCache.get(cacheKey);
    setContentErrorMessage("");
    if (cachedDocument) {
      setContent(cachedDocument.content);
      setIsContentLoading(false);
      return () => {
        active = false;
      };
    }

    setContent("");
    setIsContentLoading(true);
    void fetchMarketplaceSkillFileContent({
      sourceUrl: skill.sourceUrl,
      skillPath: skill.skillPath ?? "",
      relativePath: selectedPath,
    })
      .then((document) => {
        if (!active) {
          return;
        }
        setBoundedCache(
          marketplaceFileContentCache,
          cacheKey,
          document,
          MARKETPLACE_FILE_CONTENT_CACHE_LIMIT,
        );
        setContent(document.content);
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setContentErrorMessage(previewErrorMessage(error, t("skill.files.error.load")));
      })
      .finally(() => {
        if (active) {
          setIsContentLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedPath, skill, t]);

  function handleSelectFile(path: string) {
    setSelectedPath(path);
    setCollapsedDirectories((current) => {
      const next = { ...current };
      for (const directoryPath of collectAncestorDirectoryPaths(path)) {
        next[directoryPath] = false;
      }
      return next;
    });
  }

  function handleToggleDirectory(path: string) {
    setCollapsedDirectories((current) => ({
      ...current,
      [path]: !current[path],
    }));
  }

  return (
    <div className="skill-file-dialog__body">
      <SkillFileTreeSidebar
        entries={treeEntries}
        selectedPath={selectedPath}
        collapsedDirectories={collapsedDirectories}
        onToggleDirectory={handleToggleDirectory}
        onSelectFile={handleSelectFile}
      />
      <section className="skill-file-dialog__editor marketplace-skill-file-dialog__editor">
        {isTreeLoading ? (
          <div className="marketplace-skill-file-dialog__state">
            <span className="loading-spinner" aria-hidden="true" />
            <span>{t("install.market.detail.loadingFiles")}</span>
          </div>
        ) : treeErrorMessage ? (
          <article className="marketplace-skill-file-dialog__state">
            <h4>{t("install.market.detail.intro")}</h4>
            <p className="dialog-warning">{treeErrorMessage}</p>
          </article>
        ) : (
          <>
            <SkillFileContentSurface
              selectedPath={selectedPath}
              content={content}
              viewMode="preview"
              fileEntries={fileEntries}
              isLoading={isContentLoading}
              isSaving={false}
              hasDirtyChanges={false}
              noEditableFileLabel={t("skill.files.noEditableFile")}
              unsavedLabel={t("skill.files.unsaved")}
              emptyLabel={t("skill.files.empty")}
              emptyMarkdownLabel={t("skill.files.emptyMarkdown")}
              onContentChange={() => undefined}
              onSelectFile={handleSelectFile}
            />
            {isContentLoading ? <p className="dialog-note">{t("skill.files.loading")}</p> : null}
            {contentErrorMessage ? <p className="dialog-error">{contentErrorMessage}</p> : null}
          </>
        )}
      </section>
    </div>
  );
}
