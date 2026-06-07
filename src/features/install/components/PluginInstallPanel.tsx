import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { useFailureReporter } from "@/app/failure-feedback";
import { useTranslate } from "@/app/i18n";
import { useNotifications } from "@/app/notifications";
import {
  fetchInstalledPlugins,
  fetchGitRepoBranches,
  installSelectedPluginProbes,
  probePluginSourceCandidates,
} from "@/features/skills/api/skill-client";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { formatSkillDescription } from "@/features/skills/utils/skill-description";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";
import { isToolInstalledStatus } from "@/features/skills/utils/tool-status";
import type {
  GitBranchOption,
  PluginAssetType,
  PluginComponentSummary,
  PluginHostTool,
  PluginProbeResult,
  PluginSummary,
  ToolConfig,
} from "@/features/skills/state/skill-store";

const PROBING_MIN_DURATION_MS = 450;

const pluginHostOptions: { key: PluginHostTool; label: string }[] = [
  { key: "codex", label: "Codex" },
  { key: "claude-code", label: "Claude Code" },
  { key: "cursor", label: "Cursor" },
];
const componentSummaryTypes: { key: PluginAssetType; label: string }[] = [
  { key: "skill", label: "skill" },
  { key: "mcp", label: "mcp" },
  { key: "subagent", label: "agents" },
  { key: "command", label: "command" },
  { key: "rule", label: "rule" },
  { key: "hook", label: "hook" },
];

function wait(duration: number) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function hostLabel(hostTool: PluginHostTool) {
  return pluginHostOptions.find((option) => option.key === hostTool)?.label ?? hostTool;
}

function PluginHostIcon({
  hostTool,
  isSelected,
  isInstalled,
}: {
  hostTool: PluginHostTool;
  isSelected: boolean;
  isInstalled: boolean;
}) {
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const label = hostLabel(hostTool);
  const logoUrl = getToolLogoUrl(hostTool);

  return (
    <span
      className="plugin-install-preview__host-icon"
      aria-hidden="true"
    >
      {logoUrl && !logoLoadFailed ? (
        <img
          src={logoUrl}
          alt=""
          aria-hidden="true"
          onError={() => setLogoLoadFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>
      )}
      {isSelected || isInstalled ? (
        <span className="plugin-install-preview__host-check" aria-hidden="true">
          <svg viewBox="0 0 12 12" focusable="false">
            <path d="M3 6.2 5.1 8.3 9 3.8" />
          </svg>
        </span>
      ) : null}
    </span>
  );
}

function pluginKindLabel(probe: PluginProbeResult) {
  if (probe.kind === "plugin-repo") {
    return "Plugin repo";
  }
  if (probe.kind === "marketplace-root") {
    return "Marketplace root";
  }
  if (probe.kind === "standalone-assets") {
    return "Asset pack";
  }
  return "Unknown";
}

function probeSubtitle(probe: PluginProbeResult) {
  return formatSkillDescription(probe.description) || pluginKindLabel(probe);
}

function probeTitle(probe: PluginProbeResult) {
  return probe.name.trim() || probe.pluginRoot.split("/").filter(Boolean).at(-1) || "Plugin";
}

function hostInstallTargetTooltip(
  hostTool: PluginHostTool,
  isHostAppInstalled: boolean,
  isPluginInstalled: boolean,
  isSelected: boolean,
) {
  const label = hostLabel(hostTool);
  if (!isHostAppInstalled) {
    return `${label} · 宿主未安装`;
  }
  if (isPluginInstalled) {
    return `${label} · 已安装`;
  }
  return isSelected ? `${label} · 取消选择` : `${label} · 选中安装`;
}

function handleButtonLikeKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  onActivate: () => void,
) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  onActivate();
}

function toggleHost(current: PluginHostTool[], hostTool: PluginHostTool) {
  return current.includes(hostTool)
    ? current.filter((item) => item !== hostTool)
    : [...current, hostTool];
}

function toggleSelection(current: string[], value: string) {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

function isPluginHostTool(value: string): value is PluginHostTool {
  return pluginHostOptions.some((option) => option.key === value);
}

function buildInstalledPluginHostSet(toolConfigs: ToolConfig[]): Set<PluginHostTool> {
  return new Set<PluginHostTool>(
    toolConfigs
      .filter((tool) => isToolInstalledStatus(tool.statusLabel))
      .flatMap((tool) => (isPluginHostTool(tool.id) ? [tool.id] : [])),
  );
}

function componentSummaryLabels(components: PluginComponentSummary[]) {
  if (components.length === 0) {
    return [];
  }

  const labels = componentSummaryTypes
    .map((summaryType) => {
      const count = components.filter((component) => component.assetType === summaryType.key).length;
      return count > 0 ? `${count} ${summaryType.label}` : "";
    })
    .filter(Boolean);
  return labels.length > 0 ? labels : [`${components.length} components`];
}

function uniqueHostTools(probes: PluginProbeResult[]) {
  return pluginHostOptions
    .map((option) => option.key)
    .filter((hostTool) => probes.some((probe) => probe.compatibleHostTools.includes(hostTool)));
}

function defaultSelectedHosts(hostTools: PluginHostTool[]) {
  return [...hostTools];
}

function selectableCompatibleHostTools(
  probe: PluginProbeResult,
  installedPluginHostsByProbeRoot: Record<string, Set<PluginHostTool>>,
  installedHostApps: Set<PluginHostTool>,
) {
  const installedPluginHosts = installedPluginHostsByProbeRoot[probe.pluginRoot] ?? new Set<PluginHostTool>();
  return uniqueHostTools([probe]).filter((hostTool) => (
    installedHostApps.has(hostTool) && !installedPluginHosts.has(hostTool)
  ));
}

function isProbeFullyInstalled(
  probe: PluginProbeResult,
  installedPluginHostsByProbeRoot: Record<string, Set<PluginHostTool>>,
) {
  const compatibleHostTools = uniqueHostTools([probe]);
  if (compatibleHostTools.length === 0) {
    return false;
  }
  const installedPluginHosts = installedPluginHostsByProbeRoot[probe.pluginRoot] ?? new Set<PluginHostTool>();
  return compatibleHostTools.every((hostTool) => installedPluginHosts.has(hostTool));
}

function defaultSelectedPluginRoots(probes: PluginProbeResult[]) {
  return probes.length === 1 ? [probes[0].pluginRoot] : [];
}

function defaultSelectedHostsByPluginRoot(
  probes: PluginProbeResult[],
  installedPluginHostsByProbeRoot: Record<string, Set<PluginHostTool>>,
  installedHostApps: Set<PluginHostTool>,
) {
  return Object.fromEntries(
    probes.map((probe) => [
      probe.pluginRoot,
      defaultSelectedHosts(selectableCompatibleHostTools(probe, installedPluginHostsByProbeRoot, installedHostApps)),
    ]),
  );
}

function normalizePluginAggregateIdentity(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return normalized
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
}

function normalizePluginAggregateName(value: string | undefined) {
  const normalized = normalizePluginAggregateIdentity(value);
  return normalized.replace(/\s+/gu, "-");
}

function relativePluginPath(probe: PluginProbeResult) {
  const pluginRelativePath = probe.pluginRelativePath?.trim() ?? "";
  if (pluginRelativePath) {
    return pluginRelativePath;
  }

  const root = probe.repoRoot?.trim() || probe.gitRoot.trim();
  const pluginRoot = probe.pluginRoot.trim();
  if (!root || !pluginRoot.startsWith(root)) {
    return "";
  }

  return pluginRoot.slice(root.length).replace(/^\/+/u, "");
}

function buildProbeAggregateKeys(probe: PluginProbeResult) {
  const keys = new Set<string>();
  const canonicalName = normalizePluginAggregateName(probe.name);
  const sourceIdentity = normalizePluginAggregateIdentity(probe.sourceUrl);
  const repoIdentity = normalizePluginAggregateIdentity(probe.repoRoot || probe.gitRoot);
  const relativePath = normalizePluginAggregateIdentity(relativePluginPath(probe));

  if (sourceIdentity && canonicalName) {
    keys.add(`source:${sourceIdentity}:name:${canonicalName}`);
  }
  if (repoIdentity && canonicalName) {
    keys.add(`repo:${repoIdentity}:name:${canonicalName}`);
  }
  if (relativePath && canonicalName) {
    keys.add(`path:${relativePath}:name:${canonicalName}`);
  }
  if (canonicalName) {
    keys.add(`name:${canonicalName}`);
  }

  return keys;
}

function buildInstalledPluginAggregateKeys(plugin: PluginSummary) {
  const keys = new Set<string>();
  const canonicalName = normalizePluginAggregateName(plugin.name);
  const sourceIdentity = normalizePluginAggregateIdentity(plugin.sourceUrl);
  const packageIdentity = normalizePluginAggregateIdentity(plugin.packageId);
  const repoIdentity = normalizePluginAggregateIdentity(plugin.repoRootPath);
  const sourceLabelIdentity = normalizePluginAggregateIdentity(plugin.sourceLabel);
  const relativePath = normalizePluginAggregateIdentity(plugin.pluginRelativePath);

  if (sourceIdentity && canonicalName) {
    keys.add(`source:${sourceIdentity}:name:${canonicalName}`);
  }
  if (packageIdentity && canonicalName) {
    keys.add(`package:${packageIdentity}:name:${canonicalName}`);
  }
  if (repoIdentity && canonicalName) {
    keys.add(`repo:${repoIdentity}:name:${canonicalName}`);
  }
  if (sourceLabelIdentity && canonicalName) {
    keys.add(`label:${sourceLabelIdentity}:name:${canonicalName}`);
  }
  if (relativePath && canonicalName) {
    keys.add(`path:${relativePath}:name:${canonicalName}`);
  }
  if (canonicalName) {
    keys.add(`name:${canonicalName}`);
  }

  return keys;
}

function keysIntersect(left: Set<string>, right: Set<string>) {
  for (const key of left) {
    if (right.has(key)) {
      return true;
    }
  }
  return false;
}

function hasStrongIdentityMatch(probe: PluginProbeResult, plugin: PluginSummary) {
  const probeSourceIdentity = normalizePluginAggregateIdentity(probe.sourceUrl);
  const pluginSourceIdentity = normalizePluginAggregateIdentity(plugin.sourceUrl);
  if (probeSourceIdentity && pluginSourceIdentity) {
    return probeSourceIdentity === pluginSourceIdentity;
  }

  const probeRelativePath = normalizePluginAggregateIdentity(relativePluginPath(probe));
  const pluginRelativePath = normalizePluginAggregateIdentity(plugin.pluginRelativePath);
  if (probeRelativePath && pluginRelativePath) {
    return probeRelativePath === pluginRelativePath;
  }

  const probeRepoIdentity = normalizePluginAggregateIdentity(probe.repoRoot || probe.gitRoot);
  const pluginRepoIdentity = normalizePluginAggregateIdentity(plugin.repoRootPath);
  return Boolean(probeRepoIdentity && pluginRepoIdentity && probeRepoIdentity === pluginRepoIdentity);
}

function buildInstalledPluginHostsByProbeRoot(
  probes: PluginProbeResult[],
  installedPlugins: PluginSummary[],
) {
  return Object.fromEntries(
    probes.map((probe) => {
      const probeKeys = buildProbeAggregateKeys(probe);
      const matchedHostTools = installedPlugins
        .filter((plugin) => probe.compatibleHostTools.includes(plugin.hostTool))
        .filter((plugin) => hasStrongIdentityMatch(probe, plugin))
        .filter((plugin) => keysIntersect(probeKeys, buildInstalledPluginAggregateKeys(plugin)))
        .map((plugin) => plugin.hostTool);
      return [probe.pluginRoot, new Set<PluginHostTool>(matchedHostTools)];
    }),
  );
}

function matchingTreeRelativePath(treeSegments: string[], gitRef: string | undefined) {
  const branchSegments = gitRef?.split("/").filter(Boolean) ?? [];
  if (branchSegments.length === 0 || treeSegments.length < branchSegments.length) {
    return undefined;
  }

  const isMatchingBranch = branchSegments.every((segment, index) => segment === treeSegments[index]);
  if (!isMatchingBranch) {
    return undefined;
  }

  const relativeSegments = treeSegments.slice(branchSegments.length);
  return relativeSegments.length > 0 ? relativeSegments.join("/") : undefined;
}

function parsePluginSourceInput(sourceInput: string, selectedGitRef: string | undefined) {
  const trimmedSource = sourceInput.trim();
  const gitRef = selectedGitRef?.trim() || undefined;
  try {
    const parsedUrl = new URL(trimmedSource);
    const segments = parsedUrl.pathname.split("/").filter(Boolean);
    const gitlabTreeIndex = segments.findIndex(
      (segment, index) => segment === "-" && segments[index + 1] === "tree",
    );
    const plainTreeIndex = segments.findIndex((segment) => segment === "tree");
    const treeIndex = gitlabTreeIndex >= 0 ? gitlabTreeIndex + 1 : plainTreeIndex;
    const repoEndIndex = gitlabTreeIndex >= 0 ? gitlabTreeIndex : treeIndex;
    if (treeIndex < 0 || repoEndIndex < 0 || treeIndex + 1 >= segments.length) {
      return { source: trimmedSource, gitRef };
    }

    const repoSegments = segments.slice(0, repoEndIndex);
    const treeSegments = segments.slice(treeIndex + 1);
    const inferredGitRef = gitRef ?? treeSegments[0];
    const sparsePath = matchingTreeRelativePath(treeSegments, inferredGitRef)
      ?? (gitRef ? undefined : treeSegments.slice(1).join("/") || undefined);
    return {
      source: `${parsedUrl.origin}/${repoSegments.join("/")}`,
      gitRef: inferredGitRef,
      sparsePath,
    };
  } catch {
    return { source: trimmedSource, gitRef };
  }
}

export function PluginInstallPanel() {
  const { t } = useTranslate();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const { refreshWorkspace, toolConfigs } = useSkillWorkspace();
  const [source, setSource] = useState("");
  const [branches, setBranches] = useState<GitBranchOption[]>([]);
  const [gitRef, setGitRef] = useState("");
  const [probes, setProbes] = useState<PluginProbeResult[]>([]);
  const [selectedPluginRoots, setSelectedPluginRoots] = useState<string[]>([]);
  const [selectedHostsByPluginRoot, setSelectedHostsByPluginRoot] = useState<Record<string, PluginHostTool[]>>({});
  const [installedPlugins, setInstalledPlugins] = useState<PluginSummary[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isProbing, setIsProbing] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const installedHostApps = useMemo(() => buildInstalledPluginHostSet(toolConfigs), [toolConfigs]);
  const selectableProbes = useMemo(
    () => probes.filter((probe) => probe.kind === "plugin-repo"),
    [probes],
  );
  const installedPluginHostsByProbeRoot = useMemo(
    () => buildInstalledPluginHostsByProbeRoot(selectableProbes, installedPlugins),
    [installedPlugins, selectableProbes],
  );
  const selectedProbes = useMemo(
    () => selectableProbes.filter((probe) => selectedPluginRoots.includes(probe.pluginRoot)),
    [selectableProbes, selectedPluginRoots],
  );
  const selectedProbeInstallTargets = useMemo(
    () => selectedProbes.map((probe) => ({
      probe,
      hostTools: (selectedHostsByPluginRoot[probe.pluginRoot] ?? [])
        .filter((hostTool) =>
          probe.compatibleHostTools.includes(hostTool)
          && installedHostApps.has(hostTool)
          && !(installedPluginHostsByProbeRoot[probe.pluginRoot] ?? new Set<PluginHostTool>()).has(hostTool)
        ),
    })),
    [installedHostApps, installedPluginHostsByProbeRoot, selectedHostsByPluginRoot, selectedProbes],
  );
  const canInstall = selectedProbeInstallTargets.some((target) => target.hostTools.length > 0);
  const selectedGitRef = gitRef.trim() || undefined;

  useEffect(() => {
    let active = true;

    void fetchInstalledPlugins()
      .then((plugins) => {
        if (active) {
          setInstalledPlugins(plugins);
        }
      })
      .catch(() => {
        if (active) {
          setInstalledPlugins([]);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const normalizedSource = source.trim();
    setBranches([]);
    setGitRef("");
    setProbes([]);
    setSelectedPluginRoots([]);
    setSelectedHostsByPluginRoot({});
    if (!normalizedSource || normalizedSource.length < 5) {
      setIsLoadingBranches(false);
      return;
    }

    let active = true;
    setIsLoadingBranches(true);
    const timer = window.setTimeout(() => {
      void fetchGitRepoBranches({ repoUrl: normalizedSource })
        .then((nextBranches) => {
          if (!active) {
            return;
          }
          setBranches(nextBranches);
          setGitRef(
            nextBranches.find((branch) => branch.isSelected)?.name
              ?? nextBranches.find((branch) => branch.isDefault)?.name
              ?? nextBranches[0]?.name
              ?? "",
          );
        })
        .catch(() => {
          if (active) {
            setBranches([]);
          }
        })
        .finally(() => {
          if (active) {
            setIsLoadingBranches(false);
          }
        });
    }, 350);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [source]);

  async function handleProbe(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!source.trim()) {
      notify({ message: t("install.plugin.error.sourceRequired"), tone: "error" });
      return;
    }

    flushSync(() => {
      setIsProbing(true);
    });
    await waitForNextPaint();

    try {
      const pluginSource = parsePluginSourceInput(source, selectedGitRef);
      const probeInput = {
        source: pluginSource.source,
        gitRef: pluginSource.gitRef,
        ...(pluginSource.sparsePath ? { sparsePath: pluginSource.sparsePath } : {}),
      };
      const [nextProbes] = await Promise.all([
        probePluginSourceCandidates(probeInput),
        wait(PROBING_MIN_DURATION_MS),
      ]);
      const nextSelectableProbes = nextProbes.filter((probe) => probe.kind === "plugin-repo");
      const nextSelectedPluginRoots = defaultSelectedPluginRoots(nextSelectableProbes);
      const nextSelectedProbes = nextSelectableProbes.filter((probe) =>
        nextSelectedPluginRoots.includes(probe.pluginRoot)
      );
      setProbes(nextProbes);
      setSelectedPluginRoots(nextSelectedPluginRoots);
      const nextInstalledHostsByProbeRoot = buildInstalledPluginHostsByProbeRoot(nextSelectableProbes, installedPlugins);
      setSelectedHostsByPluginRoot(defaultSelectedHostsByPluginRoot(
        nextSelectedProbes,
        nextInstalledHostsByProbeRoot,
        installedHostApps,
      ));
    } catch (error) {
      setProbes([]);
      setSelectedPluginRoots([]);
      setSelectedHostsByPluginRoot({});
      reportFailure(error, {
        operation: "probe_plugin_source_candidates",
        fallbackMessage: t("install.plugin.error.probeFailed"),
      });
    } finally {
      setIsProbing(false);
    }
  }

  useEffect(() => {
    if (probes.length === 0) {
      return;
    }

    setSelectedHostsByPluginRoot((current) => {
      const nextEntries = selectedProbes.map((probe) => {
        const compatibleHosts = uniqueHostTools([probe]);
        const currentHosts = current[probe.pluginRoot] ?? [];
        const installedPluginHosts = installedPluginHostsByProbeRoot[probe.pluginRoot] ?? new Set<PluginHostTool>();
        const nextHosts = currentHosts.filter((hostTool) =>
          compatibleHosts.includes(hostTool)
          && installedHostApps.has(hostTool)
          && !installedPluginHosts.has(hostTool)
        );
        if (nextHosts.length > 0 || compatibleHosts.length === 0) {
          return [probe.pluginRoot, nextHosts] as const;
        }
        return [
          probe.pluginRoot,
          defaultSelectedHosts(selectableCompatibleHostTools(probe, installedPluginHostsByProbeRoot, installedHostApps)),
        ] as const;
      });
      return Object.fromEntries(nextEntries);
    });
  }, [installedHostApps, installedPluginHostsByProbeRoot, probes.length, selectedProbes]);

  async function handleInstallSelected() {
    if (!canInstall) {
      return;
    }

    setIsInstalling(true);
    try {
      await Promise.all(
        selectedProbeInstallTargets
          .filter((target) => target.hostTools.length > 0)
          .map((target) => installSelectedPluginProbes({
            probes: [target.probe],
            hostTools: target.hostTools,
          })),
      );
      notify({ message: t("install.plugin.success.selectedInstalled"), tone: "success" });
      setSelectedPluginRoots([]);
      setSelectedHostsByPluginRoot({});
      setInstalledPlugins(await fetchInstalledPlugins());
      await refreshWorkspace({ showRefreshing: false });
    } catch (error) {
      reportFailure(error, {
        operation: "install_selected_plugin_probes",
        fallbackMessage: t("install.plugin.error.installFailed"),
      });
    } finally {
      setIsInstalling(false);
    }
  }

  function handleProbeHostToggle(probe: PluginProbeResult, hostTool: PluginHostTool) {
    if (probe.kind !== "plugin-repo") {
      return;
    }
    if (!installedHostApps.has(hostTool)) {
      notify({
        message: `${hostLabel(hostTool)} 软件未安装，无法勾选。`,
        tone: "info",
      });
      return;
    }
    if ((installedPluginHostsByProbeRoot[probe.pluginRoot] ?? new Set<PluginHostTool>()).has(hostTool)) {
      notify({
        message: `${probeTitle(probe)} 已安装到 ${hostLabel(hostTool)}。`,
        tone: "info",
      });
      return;
    }

    setSelectedPluginRoots((currentRoots) => {
      return currentRoots.includes(probe.pluginRoot) ? currentRoots : [...currentRoots, probe.pluginRoot];
    });
    setSelectedHostsByPluginRoot((currentHostsByRoot) => {
      return {
        ...currentHostsByRoot,
        [probe.pluginRoot]: toggleHost(currentHostsByRoot[probe.pluginRoot] ?? [], hostTool),
      };
    });
  }

  function handleProbeToggle(probe: PluginProbeResult) {
    if (probe.kind !== "plugin-repo") {
      return;
    }
    if (isProbeFullyInstalled(probe, installedPluginHostsByProbeRoot)) {
      notify({ message: t("install.plugin.success.selectedInstalled"), tone: "info" });
      return;
    }

    setSelectedPluginRoots((current) => {
      const nextRoots = toggleSelection(current, probe.pluginRoot);
      if (nextRoots.includes(probe.pluginRoot)) {
        setSelectedHostsByPluginRoot((currentHostsByRoot) => {
          const currentHosts = currentHostsByRoot[probe.pluginRoot] ?? [];
          if (currentHosts.length > 0) {
            return currentHostsByRoot;
          }
          return {
            ...currentHostsByRoot,
            [probe.pluginRoot]: defaultSelectedHosts(
              selectableCompatibleHostTools(probe, installedPluginHostsByProbeRoot, installedHostApps),
            ),
          };
        });
        return nextRoots;
      }
      setSelectedHostsByPluginRoot((currentHostsByRoot) => {
        const { [probe.pluginRoot]: _removedHosts, ...nextHostsByRoot } = currentHostsByRoot;
        return nextHostsByRoot;
      });
      return nextRoots;
    });
  }

  return (
    <section className="panel-card market-panel plugin-install-panel">
      {probes.length === 0 ? (
        <form className="repo-form plugin-install-form" onSubmit={(event) => void handleProbe(event)}>
          <div className="repo-form__section">
            <div className="repo-form__source-row">
              <label className="repo-form__field">
                <span className="repo-form__label">{t("install.plugin.source")}</span>
                <input
                  type="text"
                  placeholder="https://github.com/everyinc/compound-engineering-plugin"
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                />
              </label>
              {branches.length > 0 ? (
                <label className="repo-form__field repo-form__field--branch">
                  <span className="repo-form__label">{t("install.plugin.gitRef")}</span>
                  <select
                    disabled={isLoadingBranches}
                    value={gitRef}
                    onChange={(event) => {
                      setGitRef(event.target.value);
                      setProbes([]);
                      setSelectedPluginRoots([]);
                      setSelectedHostsByPluginRoot({});
                    }}
                  >
                    {branches.map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.isDefault ? t("install.plugin.defaultBranch", { branch: branch.name }) : branch.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <div className="repo-form__hint-block">
              <p className="repo-form__hint-title">{t("install.plugin.supported")}</p>
              <ul className="repo-form__hint-list">
                <li>https://github.com/everyinc/compound-engineering-plugin</li>
                <li>https://github.com/everyinc/compound-engineering-plugin/tree/main/plugins/compound-engineering</li>
              </ul>
            </div>
          </div>
          <div className="repo-form__actions">
            <button
              className={`primary-button repo-form__submit-button${isProbing ? " is-loading" : ""}`}
              type="submit"
              disabled={!source.trim() || isProbing}
            >
              {isProbing ? t("install.plugin.probing") : t("install.plugin.probe")}
            </button>
          </div>
        </form>
      ) : null}

      {probes.length > 0 ? (
        <div className="repo-install__selection plugin-install-preview">
          <p className="repo-install__notice">{t("install.plugin.found", { count: selectableProbes.length })}</p>
          <div className="repo-install__list">
            {probes.map((probe) => {
              const componentLabels = componentSummaryLabels(probe.components);
              const selected = selectedPluginRoots.includes(probe.pluginRoot);
              const hostTools = probe.compatibleHostTools;
              const fullyInstalled = isProbeFullyInstalled(probe, installedPluginHostsByProbeRoot);
              const canToggleCard = probe.kind === "plugin-repo" && !fullyInstalled;
              const cardAriaLabel = fullyInstalled
                ? `插件 ${probeTitle(probe)} 已安装`
                : `选择插件 ${probeTitle(probe)}`;

              return (
                <div
                  key={probe.pluginRoot}
                  className={`repo-install__option plugin-install-preview__item${
                    selected ? " is-selected" : ""
                  }${fullyInstalled ? " is-disabled" : ""}`}
                  role="button"
                  tabIndex={canToggleCard ? 0 : -1}
                  aria-disabled={!canToggleCard}
                  aria-label={cardAriaLabel}
                  onClick={() => {
                    if (canToggleCard) {
                      handleProbeToggle(probe);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (canToggleCard) {
                      handleButtonLikeKeyDown(event, () => handleProbeToggle(probe));
                    }
                  }}
                >
                  <div className="plugin-install-preview__summary">
                    <div className="plugin-install-preview__summary-main">
                      <div>
                        <h3>{probeTitle(probe)}</h3>
                        <span>{probeSubtitle(probe)}</span>
                      </div>
                      {componentLabels.length > 0 ? (
                        <div className="plugin-install-preview__components" aria-label={`${probeTitle(probe)} 插件组件数量`}>
                          {componentLabels.map((label) => (
                            <span key={label} className="plugin-install-preview__component-chip">{label}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    {hostTools.length > 0 ? (
                      <div className="plugin-install-preview__summary-side">
                        {fullyInstalled ? (
                          <span className="install-card__badge">{t("install.repo.badgeInstalled")}</span>
                        ) : null}
                        <div className="plugin-install-preview__host-icons" aria-label={`${probeTitle(probe)} 安装宿主`}>
                          {hostTools.map((hostTool) => {
                            const hostSelected = (selectedHostsByPluginRoot[probe.pluginRoot] ?? [])
                              .includes(hostTool);
                            const hostAppInstalled = installedHostApps.has(hostTool);
                            const pluginInstalled = (installedPluginHostsByProbeRoot[probe.pluginRoot] ?? new Set<PluginHostTool>())
                              .has(hostTool);
                            return (
                              <button
                                key={hostTool}
                                className={`plugin-install-preview__host-toggle${
                                  hostSelected ? " is-selected" : ""
                                }${hostAppInstalled ? "" : " is-unavailable"}${
                                  pluginInstalled ? " is-installed" : ""
                                }`}
                                type="button"
                                data-tooltip={hostInstallTargetTooltip(hostTool, hostAppInstalled, pluginInstalled, hostSelected)}
                                aria-pressed={hostSelected}
                                aria-disabled={!hostAppInstalled || pluginInstalled}
                                aria-label={
                                  !hostAppInstalled
                                    ? `${hostLabel(hostTool)} 未安装，无法作为 ${probeTitle(probe)} 安装宿主`
                                    : pluginInstalled
                                      ? `${probeTitle(probe)} 已安装到 ${hostLabel(hostTool)}`
                                      : `${hostSelected ? "取消选择" : "选择"} ${hostLabel(hostTool)} 作为 ${probeTitle(probe)} 安装宿主`
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleProbeHostToggle(probe, hostTool);
                                }}
                              >
                                <PluginHostIcon
                                  hostTool={hostTool}
                                  isSelected={hostSelected}
                                  isInstalled={pluginInstalled}
                                />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="repo-install__actions plugin-install-preview__actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setProbes([]);
                setSelectedPluginRoots([]);
                setSelectedHostsByPluginRoot({});
              }}
            >
              {t("install.repo.back")}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={!canInstall || isInstalling}
              onClick={() => void handleInstallSelected()}
            >
              {isInstalling ? t("install.plugin.installing") : t("install.plugin.install")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
