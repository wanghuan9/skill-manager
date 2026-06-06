import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { useFailureReporter } from "@/app/failure-feedback";
import { useTranslate } from "@/app/i18n";
import { useNotifications } from "@/app/notifications";
import {
  fetchGitRepoBranches,
  installSelectedPluginProbes,
  probePluginSourceCandidates,
} from "@/features/skills/api/skill-client";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { formatSkillDescription } from "@/features/skills/utils/skill-description";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";
import type {
  GitBranchOption,
  PluginAssetType,
  PluginComponentSummary,
  PluginHostTool,
  PluginProbeResult,
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

function PluginHostIcon({ hostTool }: { hostTool: PluginHostTool }) {
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const label = hostLabel(hostTool);
  const logoUrl = getToolLogoUrl(hostTool);

  return (
    <span
      className="plugin-install-preview__host-icon"
      title={label}
      data-tooltip={label}
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
    </span>
  );
}

function isHostCompatibleWithSelectedProbes(
  hostTool: PluginHostTool,
  selectedProbeRoots: string[],
  selectableProbes: PluginProbeResult[],
) {
  return selectableProbes.some((probe) =>
    selectedProbeRoots.includes(probe.pluginRoot) && probe.compatibleHostTools.includes(hostTool)
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
  return hostTools.length === 1 ? hostTools : [];
}

function defaultSelectedPluginRoots(probes: PluginProbeResult[]) {
  return probes.length === 1 ? [probes[0].pluginRoot] : [];
}

function defaultSelectedHostsByPluginRoot(probes: PluginProbeResult[]) {
  return Object.fromEntries(
    probes.map((probe) => [probe.pluginRoot, defaultSelectedHosts(uniqueHostTools([probe]))]),
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
  const { refreshWorkspace } = useSkillWorkspace();
  const [source, setSource] = useState("");
  const [branches, setBranches] = useState<GitBranchOption[]>([]);
  const [gitRef, setGitRef] = useState("");
  const [probes, setProbes] = useState<PluginProbeResult[]>([]);
  const [selectedPluginRoots, setSelectedPluginRoots] = useState<string[]>([]);
  const [selectedHostsByPluginRoot, setSelectedHostsByPluginRoot] = useState<Record<string, PluginHostTool[]>>({});
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isProbing, setIsProbing] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const selectableProbes = useMemo(
    () => probes.filter((probe) => probe.kind === "plugin-repo"),
    [probes],
  );
  const selectedProbes = useMemo(
    () => selectableProbes.filter((probe) => selectedPluginRoots.includes(probe.pluginRoot)),
    [selectableProbes, selectedPluginRoots],
  );
  const selectedProbeInstallTargets = useMemo(
    () => selectedProbes.map((probe) => ({
      probe,
      hostTools: (selectedHostsByPluginRoot[probe.pluginRoot] ?? [])
        .filter((hostTool) => probe.compatibleHostTools.includes(hostTool)),
    })),
    [selectedHostsByPluginRoot, selectedProbes],
  );
  const canInstall = selectedProbeInstallTargets.some((target) => target.hostTools.length > 0);
  const selectedGitRef = gitRef.trim() || undefined;

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
      setSelectedHostsByPluginRoot(defaultSelectedHostsByPluginRoot(nextSelectedProbes));
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
        const nextHosts = currentHosts.filter((hostTool) => compatibleHosts.includes(hostTool));
        if (nextHosts.length > 0 || compatibleHosts.length === 0) {
          return [probe.pluginRoot, nextHosts] as const;
        }
        return [probe.pluginRoot, defaultSelectedHosts(compatibleHosts)] as const;
      });
      return Object.fromEntries(nextEntries);
    });
  }, [probes.length, selectedProbes]);

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
      setSource("");
      setProbes([]);
      setSelectedPluginRoots([]);
      setSelectedHostsByPluginRoot({});
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

    setSelectedPluginRoots((currentRoots) => {
      const nextRoots = currentRoots.includes(probe.pluginRoot)
        ? currentRoots
        : [...currentRoots, probe.pluginRoot];
      setSelectedHostsByPluginRoot((currentHostsByRoot) => {
        if (!isHostCompatibleWithSelectedProbes(hostTool, nextRoots, selectableProbes)) {
          return currentHostsByRoot;
        }
        return {
          ...currentHostsByRoot,
          [probe.pluginRoot]: toggleHost(currentHostsByRoot[probe.pluginRoot] ?? [], hostTool),
        };
      });
      return nextRoots;
    });
  }

  function handleProbeToggle(probe: PluginProbeResult) {
    if (probe.kind !== "plugin-repo") {
      return;
    }

    setSelectedPluginRoots((current) => {
      const nextRoots = toggleSelection(current, probe.pluginRoot);
      if (nextRoots.includes(probe.pluginRoot)) {
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
                  placeholder="https://git.example.com/team/plugin-repo"
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
                <li>https://git.example.com/team/plugin-repo</li>
                <li>https://git.example.com/team/plugin-repo/-/tree/main/plugins/demo-plugin</li>
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

              return (
                <div
                  key={probe.pluginRoot}
                  className={`repo-install__option plugin-install-preview__item${selected ? " is-selected" : ""}`}
                  role="button"
                  tabIndex={probe.kind === "plugin-repo" ? 0 : -1}
                  aria-disabled={probe.kind !== "plugin-repo"}
                  aria-label={`选择插件 ${probeTitle(probe)}`}
                  onClick={() => handleProbeToggle(probe)}
                  onKeyDown={(event) => handleButtonLikeKeyDown(event, () => handleProbeToggle(probe))}
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
                        <div className="plugin-install-preview__host-icons" aria-label={`${probeTitle(probe)} 安装宿主`}>
                          {hostTools.map((hostTool) => {
                            const hostSelected = (selectedHostsByPluginRoot[probe.pluginRoot] ?? [])
                              .includes(hostTool);
                            return (
                              <button
                                key={hostTool}
                                className={`plugin-install-preview__host-toggle${
                                  hostSelected ? " is-selected" : ""
                                }`}
                                type="button"
                                title={hostLabel(hostTool)}
                                data-tooltip={hostLabel(hostTool)}
                                aria-pressed={hostSelected}
                                aria-label={`${hostSelected ? "取消选择" : "选择"} ${hostLabel(hostTool)} 作为 ${probeTitle(probe)} 安装宿主`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleProbeHostToggle(probe, hostTool);
                                }}
                              >
                                <PluginHostIcon hostTool={hostTool} />
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
