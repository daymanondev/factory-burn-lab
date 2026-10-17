/**
 * The one `<BurnLabShell />` every Paseo surface entry renders:
 * global screen and workspace panel.
 * 100% UI-driven: Project selector + Pet Project initializer, 1-click
 * `Open Supervisor` bridge, 1-click `Scout Free Models`, 5 Burn Playbook
 * launchers (`OSS Lab`, `Proto Arena`, `Night Shift`, `Self-Evolve`,
 * `Scout Pool`), live Burn Runs + 3-tier Verification Fence Detail Modal,
 * OpenCode Free Pool matrix, and Factory Upstream Issues drawer.
 *
 * Strictly function components — zero class syntax for Hermes compatibility.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  burnDetail,
  burnPreflight,
  burnProjectAdd,
  burnScout,
  burnSnapshot,
  burnStart,
  burnSupervisorOpen,
  burnUpstreamFile,
} from "../../shared/rpc.ts";
import type {
  BurnLabView,
  BurnPlaybookView,
  BurnRunDetailView,
  BurnRunSummaryView,
  FreeModelView,
  UpstreamIssueView,
} from "../../shared/view.ts";
import { Btn, BurnTabBar, type BurnTabId, Card, Chip, Pill } from "../kit/pill.tsx";
import { GRACE_MS, pollEvery, useNow, usePoll } from "../kit/poll.ts";
import {
  type Colour,
  CONTROL_SM,
  DOT,
  hoveredOf,
  RADIUS,
  SPACING,
  text,
  tint,
} from "../kit/theme.ts";

export interface Navigation {
  openAgent(input: { agentId: string; serverId?: string }): void;
}

export interface PlaybookDraft {
  brief: string;
  targetRepo: string;
  gateCommand: string;
}

export interface UpstreamIssueDraft {
  title: string;
  slug: string;
  problem: string;
  proposedChange: string;
}

interface PlaybookMeta {
  id: BurnPlaybookView;
  title: string;
  subtitle: string;
  icon: string;
  defaultPrompt: string;
  fenceBadge: string;
}

const PLAYBOOKS: PlaybookMeta[] = [
  {
    id: "oss-lab",
    title: "OSS Lab",
    subtitle:
      "Clone or inspect an open-source repo with reader-1m Free models under strict [path:start-end] Citation gate + cross-family Council + PoC Gate.",
    icon: "BookOpen",
    defaultPrompt:
      "Audit core architecture, entry points, and verification boundaries with exact [path:startLine-endLine] citations.",
    fenceBadge: "Citation Gate + Council + PoC Gate",
  },
  {
    id: "proto-arena",
    title: "Proto Arena",
    subtitle:
      "Supervisor defines a deterministic Gate and races coder Free models from distinct families in isolated worktrees (Best-of-N tournament).",
    icon: "Swords",
    defaultPrompt:
      "Build a minimal, self-tested prototype module and verify it passes the deterministic Gate command.",
    fenceBadge: "Best-of-N Worktrees + Gate + Council",
  },
  {
    id: "night-shift",
    title: "Night Shift",
    subtitle:
      "Unattended bug-hunting, edge-case test strengthening, and metric optimization in isolated worktrees of the active Project.",
    icon: "Moon",
    defaultPrompt:
      "Hunt edge-case bugs, strengthen boundary tests, and surface only Gate-green and Council-cleared diffs.",
    fenceBadge: "Isolated Worktree + Gate + Council",
  },
  {
    id: "self-evolve",
    title: "Self-Evolve",
    subtitle:
      "Target factory-burn-lab itself under npm test && npm run check:bundle, filing needs-triage Upstream issues when paseo-factory hooks are needed.",
    icon: "Sparkles",
    defaultPrompt:
      "Audit factory-burn-lab swarm capabilities under npm test && npm run check:bundle and propose verified improvements.",
    fenceBadge: "Bundle Check + Unit Tests + Upstream Protocol",
  },
  {
    id: "scout-pool",
    title: "Scout Pool",
    subtitle:
      "Discover all current OpenCode $0 / -free models and run the liveness, code-fix Gate, and Citation gate micro-battery.",
    icon: "Radar",
    defaultPrompt:
      "Discover all OpenCode -free models and benchmark speed, code-fix Gate, and Citation gate accuracy.",
    fenceBadge: "Liveness + Code Gate + Citation Probe",
  },
];

function readAgo(seconds: number): string {
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function statusTone(status: string): Colour {
  if (status === "completed") return "statusSuccess";
  if (status === "failed") return "statusDanger";
  if (status === "queued") return "foregroundMuted";
  return "accent";
}

function StatTile({
  theme,
  n,
  label,
  colour,
  icon,
  highlight = false,
}: {
  theme: PluginTheme;
  n: number | string;
  label: string;
  colour: string;
  icon: string;
  highlight?: boolean;
}) {
  const lit = highlight || (typeof n === "number" && n > 0);
  return (
    <View
      accessibilityLabel={`${label}: ${n}`}
      style={{
        flex: 1,
        flexBasis: 130,
        minWidth: 130,
        paddingHorizontal: SPACING[3],
        paddingVertical: SPACING[2.5],
        borderRadius: RADIUS.lg,
        borderWidth: 1,
        borderColor: lit ? tint(colour, "66") : theme.colors.border,
        backgroundColor: lit ? tint(colour, "12") : theme.colors.surface1,
        gap: SPACING[1],
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: SPACING[1.5],
        }}
      >
        <Text style={text(theme, "label")} numberOfLines={1}>
          {label}
        </Text>
        <Icon name={icon} size={13} color={lit ? colour : theme.colors.foregroundMuted} />
      </View>
      <Text
        style={{
          ...text(theme, "stat"),
          fontSize: 20,
          lineHeight: 24,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
          color: lit ? colour : theme.colors.foreground,
        }}
        numberOfLines={1}
      >
        {n}
      </Text>
    </View>
  );
}

type DetailModalState = {
  runId: string;
  loading: boolean;
  detail: BurnRunDetailView | null;
  error: string | null;
};

export function BurnLabShell({
  theme,
  dir,
  navigation,
  serverId,
  initialTab = "playbooks",
}: {
  theme: PluginTheme;
  dir?: string;
  navigation?: Navigation;
  serverId?: string;
  initialTab?: BurnTabId;
}) {
  const toast = useToast();
  const snapshotCall = useRpc(burnSnapshot);
  const preflightCall = useRpc(burnPreflight);
  const scoutCall = useRpc(burnScout);
  const startCall = useRpc(burnStart);
  const detailCall = useRpc(burnDetail);
  const upstreamFileCall = useRpc(burnUpstreamFile);
  const projectAddCall = useRpc(burnProjectAdd);
  const supervisorOpenCall = useRpc(burnSupervisorOpen);

  const [tab, setTab] = useState<BurnTabId>(initialTab);
  const [bump, setBump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | undefined>(undefined);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [detailModal, setDetailModal] = useState<DetailModalState | null>(null);

  // Project add inline form state
  const [addingProject, setAddingProject] = useState(false);
  const [newRepoPath, setNewRepoPath] = useState("");
  const [newRepoName, setNewRepoName] = useState("");
  const [initGitFlag, setInitGitFlag] = useState(true);

  // Supervisor quick dispatch input
  const [supervisorMsg, setSupervisorMsg] = useState("");

  // Playbook launcher state
  const [selectedPlaybook, setSelectedPlaybook] = useState<BurnPlaybookView>("oss-lab");
  const [playbookDraft, setPlaybookDraft] = useState<PlaybookDraft>({
    brief: PLAYBOOKS[0]!.defaultPrompt,
    targetRepo: "",
    gateCommand: "",
  });
  const [runFilter, setRunFilter] = useState<"all" | "active" | "completed" | "failed">("all");

  // Upstream issue form state
  const [issueDraft, setIssueDraft] = useState<UpstreamIssueDraft>({
    title: "",
    slug: "",
    problem: "",
    proposedChange: "",
  });
  const [expandedIssueId, setExpandedIssueId] = useState<string | null>(null);

  const refresh = () => setBump((n) => n + 1);

  const poll = usePoll(
    async () => {
      const r = await snapshotCall({
        projectSlug: selectedSlug,
        projectRoot: selectedSlug === undefined ? dir : undefined,
      });
      if (!r.ok) return { ok: false as const, code: r.code, error: r.error };
      return { ok: true as const, value: r.view };
    },
    `burn-lab:${selectedSlug ?? dir ?? "default"}:${bump}`,
    (view) => pollEvery((view?.kpis.activeRuns ?? 0) > 0),
  );

  const view = poll.value;
  const now = useNow(1000);

  const runAction = async (
    label: string,
    fn: () => Promise<{ ok: boolean; error?: string | null }>,
  ): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) {
        toast.error(`${label}: ${res.error ?? "failed"}`);
        return false;
      }
      return true;
    } catch (err) {
      toast.error(`${label}: ${String(err)}`);
      return false;
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const openRunDetail = (runId: string) => {
    setDetailModal({ runId, loading: true, detail: null, error: null });
    void (async () => {
      const res = await detailCall({ runId });
      setDetailModal({
        runId,
        loading: false,
        detail: res.ok ? res.detail : null,
        error: res.ok ? null : res.error,
      });
    })();
  };

  if (view === null) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.surface0,
          padding: SPACING[4],
          gap: SPACING[2],
        }}
      >
        <Text style={text(theme, "section")}>factory-burn-lab</Text>
        {poll.error !== null ? (
          <Text style={text(theme, "label", "statusWarning")}>{poll.error.message}</Text>
        ) : (
          <Text style={text(theme, "meta")}>Loading Burn Lab…</Text>
        )}
      </View>
    );
  }

  const activeProject = view.activeProject;
  const isBusyPolling = view.kpis.activeRuns > 0;
  const fresh = poll.at !== null && now - poll.at <= pollEvery(isBusyPolling) + GRACE_MS;

  const handleSelectPlaybook = (pb: PlaybookMeta) => {
    setSelectedPlaybook(pb.id);
    setPlaybookDraft((prev) => ({
      ...prev,
      brief: pb.defaultPrompt,
      gateCommand:
        pb.id === "self-evolve" && !prev.gateCommand
          ? "npm test && npm run check:bundle"
          : prev.gateCommand,
    }));
  };

  const handleScoutFreeModels = () => {
    setStatusNote("Scouting OpenCode Free Pool models…");
    void runAction("Scout Free Pool", async () => {
      const res = await scoutCall({});
      if (res.ok) {
        setStatusNote(
          `Scouted ${res.totalModels} OpenCode free models (${res.healthyModels} healthy)`,
        );
      }
      return res;
    });
  };

  const handleStartBurnRun = () => {
    const prompt = playbookDraft.brief.trim();
    if (!prompt) {
      toast.error("Enter a brief or goal for the Burn run");
      return;
    }
    setStatusNote(`Running ${selectedPlaybook} on ${activeProject?.name ?? "project"}…`);
    void runAction("Start Burn Run", async () => {
      const res = await startCall({
        playbook: selectedPlaybook,
        prompt,
        projectSlug: activeProject?.slug,
        targetRepo: playbookDraft.targetRepo.trim() || undefined,
        gateCommand: playbookDraft.gateCommand.trim() || undefined,
        awaitCompletion: true,
      });
      if (res.ok) {
        setStatusNote(
          `Burn run ${res.run.id} (${res.run.playbook}) → ${res.run.status} (${res.run.acceptedCount}/${res.run.attemptCount} verified)`,
        );
        openRunDetail(res.run.id);
      }
      return res;
    });
  };

  const handleAddProject = () => {
    const repoPath = newRepoPath.trim();
    if (!repoPath) return;
    void runAction("Add Project", async () => {
      const res = await projectAddCall({
        repoPath,
        initGit: initGitFlag,
        name: newRepoName.trim() || undefined,
      });
      if (res.ok) {
        setSelectedSlug(res.project.slug);
        setAddingProject(false);
        setNewRepoPath("");
        setNewRepoName("");
        setStatusNote(`Selected project ${res.project.name} (${res.project.slug})`);
      }
      return res;
    });
  };

  const handleOpenSupervisor = () => {
    void runAction("Open Supervisor", async () => {
      const res = await supervisorOpenCall({
        projectSlug: activeProject?.slug,
        projectRoot: activeProject?.root,
        message: supervisorMsg.trim() || undefined,
      });
      if (res.ok) {
        setSupervisorMsg("");
        navigation?.openAgent({ agentId: res.agentId, serverId });
        setStatusNote(
          `Opened Supervisor (${res.supervisorLane}) for ${res.slug}`,
        );
      }
      return res;
    });
  };

  const handleWarmupPermissions = () => {
    setStatusNote("Running Unattended Preflight warm-up (folders, network, OpenCode --auto)…");
    void runAction("Warm Up Permissions", async () => {
      const res = await preflightCall({
        mode: "warmup",
        projectSlug: activeProject?.slug,
        projectRoot: activeProject?.root,
      });
      if (res.ok) {
        const msg = res.preflight.ready
          ? `Unattended preflight ready (${res.preflight.responsibleBundle})`
          : `Preflight completed with ${res.preflight.issues.length} warning(s)`;
        setStatusNote(msg);
      }
      return res;
    });
  };

  const handleOpenSecuritySettings = () => {
    void runAction("Open OS Security Settings", async () => {
      const res = await preflightCall({
        mode: "open-settings",
        projectSlug: activeProject?.slug,
        projectRoot: activeProject?.root,
      });
      if (res.ok) {
        setStatusNote(
          `Opened OS security settings (${(res.opened ?? []).join(", ") || res.preflight.platform})`,
        );
      }
      return res;
    });
  };

  const handleFileUpstreamIssue = () => {
    const title = issueDraft.title.trim();
    const problem = issueDraft.problem.trim();
    const proposedChange = issueDraft.proposedChange.trim();
    if (!title || !problem || !proposedChange) {
      toast.error("Provide title, problem, and proposed change for the Upstream issue");
      return;
    }
    void runAction("File Upstream Issue", async () => {
      const res = await upstreamFileCall({
        slug: issueDraft.slug.trim() || title,
        title,
        problem,
        proposedChange,
      });
      if (res.ok) {
        setIssueDraft({ title: "", slug: "", problem: "", proposedChange: "" });
        setStatusNote(
          `Filed upstream issue ${res.issue.id} (Status: ${res.issue.status}) in paseo-factory`,
        );
      }
      return res;
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: SPACING[4],
          paddingBottom: SPACING[6],
          gap: SPACING[4],
        }}
      >
        {/* Top Headline & Freshness Bar */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: SPACING[2],
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexShrink: 1 }}>
            <Icon name="Flame" size={18} color={theme.colors.accent} />
            <Text
              accessibilityRole="header"
              style={{
                ...text(theme, "detailTitle"),
                fontSize: 18,
                lineHeight: 24,
                fontWeight: "600",
              }}
            >
              Burn Lab — Supervised OpenCode Free Swarm
            </Text>
            <Pill
              theme={theme}
              label={`Supervisor: ${view.supervisorLane}`}
              tone="accent"
              lit
              icon="Shield"
              mono
            />
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2] }}>
            <Btn
              theme={theme}
              small
              icon="Radar"
              label="Scout Free Models"
              tone="accent"
              disabled={busy}
              onPress={handleScoutFreeModels}
            />
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: SPACING[1.5],
                paddingHorizontal: SPACING[2.5],
                paddingVertical: 3,
                borderRadius: RADIUS.md,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
              }}
            >
              {poll.at !== null ? (
                <View
                  style={{
                    width: DOT - 2,
                    height: DOT - 2,
                    borderRadius: DOT,
                    backgroundColor: fresh
                      ? theme.colors.statusSuccess
                      : theme.colors.statusWarning,
                  }}
                />
              ) : null}
              <Text style={{ ...text(theme, "badge"), fontVariant: ["tabular-nums"] }}>
                {poll.at !== null
                  ? `updated ${readAgo(Math.max(0, Math.round((now - poll.at) / 1000)))}`
                  : "loading"}
              </Text>
            </View>
          </View>
        </View>

        {/* 5 KPI Stat Tiles */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] }}>
          <StatTile
            theme={theme}
            n={`${view.kpis.healthyFreeModels}/${view.kpis.totalFreeModels}`}
            label="Free Models ($0)"
            colour={theme.colors.statusSuccess}
            icon="Cpu"
            highlight={view.kpis.healthyFreeModels > 0}
          />
          <StatTile
            theme={theme}
            n={`${view.kpis.coderModels} / ${view.kpis.reader1mModels} / ${view.kpis.reviewerModels}`}
            label="Coder / 1M / Reviewer"
            colour={theme.colors.accent}
            icon="Layers"
            highlight={view.kpis.coderModels + view.kpis.reader1mModels > 0}
          />
          <StatTile
            theme={theme}
            n={view.kpis.totalRuns}
            label="Burn Runs"
            colour={theme.colors.accent}
            icon="Flame"
          />
          <StatTile
            theme={theme}
            n={view.kpis.verifiedWins}
            label="Verified Wins"
            colour={theme.colors.statusSuccess}
            icon="CheckCircle2"
          />
          <StatTile
            theme={theme}
            n={view.kpis.upstreamIssues}
            label="Upstream Issues"
            colour={theme.colors.statusWarning}
            icon="GitPullRequest"
          />
        </View>

        {/* Unattended Preflight & Permission Readiness Strip */}
        {view.preflight ? (
          <Card theme={theme} gap={SPACING[2]}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexWrap: "wrap",
                gap: SPACING[1.5],
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: SPACING[1],
                  paddingRight: SPACING[1],
                }}
              >
                <Icon
                  name={view.preflight.ready ? "ShieldCheck" : "AlertTriangle"}
                  size={13}
                  color={
                    view.preflight.ready
                      ? theme.colors.statusSuccess
                      : theme.colors.statusWarning
                  }
                />
                <Text style={text(theme, "badge")}>UNATTENDED PREFLIGHT</Text>
              </View>

              <Pill
                theme={theme}
                label={`Host: ${view.preflight.responsibleBundle}`}
                tone={view.preflight.shipItStaleBinary ? "statusDanger" : "accent"}
                lit
                mono
              />

              {view.preflight.fullDiskAccessGranted !== null ? (
                <Pill
                  theme={theme}
                  label={
                    view.preflight.platform === "darwin"
                      ? view.preflight.fullDiskAccessGranted
                        ? "Full Disk Access: Granted"
                        : "Full Disk Access: Off"
                      : view.preflight.fullDiskAccessGranted
                        ? "Folder Protection: Clear"
                        : "Protected Folder"
                  }
                  tone={
                    view.preflight.fullDiskAccessGranted
                      ? "statusSuccess"
                      : "statusWarning"
                  }
                  lit
                />
              ) : null}

              <Pill
                theme={theme}
                label={
                  view.preflight.openCodeAutoReady
                    ? "OpenCode --auto: Ready"
                    : "OpenCode --auto: Missing"
                }
                tone={view.preflight.openCodeAutoReady ? "statusSuccess" : "statusWarning"}
                lit
              />

              <Pill
                theme={theme}
                label={
                  view.preflight.sleepAssertionActive
                    ? "Sleep Assertion: Active"
                    : "Sleep Assertion: On-Run"
                }
                tone={view.preflight.sleepAssertionActive ? "statusSuccess" : "foregroundMuted"}
                lit={view.preflight.sleepAssertionActive}
              />

              <View
                style={{
                  marginLeft: "auto",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: SPACING[1.5],
                  flexWrap: "wrap",
                }}
              >
                <Btn
                  theme={theme}
                  small
                  icon="Zap"
                  label="Warm Up Permissions"
                  tone="accent"
                  disabled={busy}
                  onPress={handleWarmupPermissions}
                />
                {view.preflight.platform === "darwin" ||
                view.preflight.platform === "win32" ? (
                  <Btn
                    theme={theme}
                    small
                    icon="Settings"
                    label={
                      view.preflight.platform === "darwin"
                        ? "Grant Full Disk Access"
                        : "Open Windows Security"
                    }
                    tone="foregroundMuted"
                    disabled={busy}
                    onPress={handleOpenSecuritySettings}
                  />
                ) : null}
              </View>
            </View>

            {view.preflight.issues.length > 0 ? (
              <View style={{ gap: SPACING[1] }}>
                {view.preflight.issues.map((issue, idx) => (
                  <Text
                    key={`preflight-issue-${idx}`}
                    style={text(
                      theme,
                      "meta",
                      view.preflight?.shipItStaleBinary ? "statusDanger" : "statusWarning",
                    )}
                  >
                    • {issue}
                  </Text>
                ))}
              </View>
            ) : null}
          </Card>
        ) : null}

        {/* Project Selector + 1-Click Open Supervisor Bridge */}
        <Card theme={theme} gap={SPACING[2.5]}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: SPACING[1.5],
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: SPACING[1],
                paddingRight: SPACING[1],
              }}
            >
              <Icon name="FolderGit2" size={13} color={theme.colors.foregroundMuted} />
              <Text style={text(theme, "badge")}>PROJECT</Text>
            </View>
            {view.projects.map((proj) => (
              <Chip
                key={proj.slug}
                theme={theme}
                label={proj.name}
                active={activeProject?.slug === proj.slug}
                onPress={() => setSelectedSlug(proj.slug)}
              />
            ))}
            <Btn
              theme={theme}
              small
              icon={addingProject ? "X" : "FolderPlus"}
              label={addingProject ? "Cancel" : "Add / Init Pet Project"}
              tone="foregroundMuted"
              onPress={() => setAddingProject((v) => !v)}
            />
            {activeProject !== null ? (
              <View
                style={{
                  marginLeft: "auto",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: SPACING[1.5],
                  flexWrap: "wrap",
                }}
              >
                <Pill theme={theme} label={activeProject.slug} mono />
                <Pill theme={theme} label={activeProject.root} mono />
              </View>
            ) : null}
          </View>

          {addingProject ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexWrap: "wrap",
                gap: SPACING[2],
                paddingTop: SPACING[1],
              }}
            >
              <View
                style={{
                  flexBasis: 240,
                  flexGrow: 1,
                  minHeight: CONTROL_SM,
                  justifyContent: "center",
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderRadius: RADIUS.md,
                  backgroundColor: theme.colors.surface0,
                }}
              >
                <TextInput
                  value={newRepoPath}
                  onChangeText={setNewRepoPath}
                  placeholder="/absolute/path/to/pet-project-or-repo"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={{
                    paddingHorizontal: SPACING[2.5],
                    paddingVertical: 4,
                    color: theme.colors.foreground,
                    fontSize: 12,
                  }}
                />
              </View>
              <View
                style={{
                  flexBasis: 140,
                  minHeight: CONTROL_SM,
                  justifyContent: "center",
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderRadius: RADIUS.md,
                  backgroundColor: theme.colors.surface0,
                }}
              >
                <TextInput
                  value={newRepoName}
                  onChangeText={setNewRepoName}
                  placeholder="Optional Name"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={{
                    paddingHorizontal: SPACING[2.5],
                    paddingVertical: 4,
                    color: theme.colors.foreground,
                    fontSize: 12,
                  }}
                />
              </View>
              <Chip
                theme={theme}
                label="git init if new"
                active={initGitFlag}
                icon="GitBranch"
                onPress={() => setInitGitFlag((v) => !v)}
              />
              <Btn
                theme={theme}
                small
                solid
                icon="Check"
                label="Save Project"
                tone="accent"
                disabled={busy || newRepoPath.trim() === ""}
                onPress={handleAddProject}
              />
            </View>
          ) : null}

          {/* Supervisor 1-Click Bridge Row */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: SPACING[2],
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              paddingTop: SPACING[2],
            }}
          >
            <Pill
              theme={theme}
              label={view.supervisorLive ? "Supervisor Seat: Live" : "Supervisor Seat: Ready"}
              tone={view.supervisorLive ? "statusSuccess" : "foregroundMuted"}
              lit={view.supervisorLive}
              icon="Shield"
            />
            <View
              style={{
                flexBasis: 220,
                flexGrow: 1,
                minHeight: CONTROL_SM,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: RADIUS.md,
                backgroundColor: theme.colors.surface0,
              }}
            >
              <TextInput
                value={supervisorMsg}
                onChangeText={setSupervisorMsg}
                placeholder="Optional message to dispatch when opening Project Supervisor…"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  paddingHorizontal: SPACING[2.5],
                  paddingVertical: 4,
                  color: theme.colors.foreground,
                  fontSize: 12,
                }}
                onSubmitEditing={handleOpenSupervisor}
              />
            </View>
            <Btn
              theme={theme}
              small
              icon="Shield"
              label="Open Supervisor"
              tone="accent"
              disabled={busy || activeProject === null}
              onPress={handleOpenSupervisor}
            />
          </View>
        </Card>

        {statusNote !== null ? (
          <Card
            theme={theme}
            style={{
              borderColor: tint(theme.colors.accent, "66"),
              backgroundColor: tint(theme.colors.accent, "10"),
            }}
          >
            <Text style={text(theme, "label", "accent")}>{statusNote}</Text>
          </Card>
        ) : null}

        {/* Navigation Tabs */}
        <BurnTabBar
          theme={theme}
          active={tab}
          onPick={setTab}
          counts={{
            playbooks: view.runs.length,
            pool: view.freeModels.length,
            upstream: view.upstreamIssues.length,
          }}
        />

        {tab === "playbooks" ? (
          <PlaybooksAndRunsPane
            theme={theme}
            view={view}
            busy={busy}
            selectedPlaybook={selectedPlaybook}
            onSelectPlaybook={handleSelectPlaybook}
            draft={playbookDraft}
            onChangeDraft={setPlaybookDraft}
            onStartBurnRun={handleStartBurnRun}
            runFilter={runFilter}
            onChangeRunFilter={setRunFilter}
            onOpenDetail={openRunDetail}
          />
        ) : null}

        {tab === "pool" ? (
          <FreePoolPane
            theme={theme}
            view={view}
            busy={busy}
            onScout={handleScoutFreeModels}
          />
        ) : null}

        {tab === "upstream" ? (
          <UpstreamIssuesPane
            theme={theme}
            issues={view.upstreamIssues}
            busy={busy}
            draft={issueDraft}
            onChangeDraft={setIssueDraft}
            onSubmitIssue={handleFileUpstreamIssue}
            expandedIssueId={expandedIssueId}
            onToggleExpand={(id) => setExpandedIssueId((prev) => (prev === id ? null : id))}
          />
        ) : null}
      </ScrollView>

      {/* Run Detail Modal */}
      <Modal
        open={detailModal !== null}
        onOpenChange={(open) => (open ? undefined : setDetailModal(null))}
        title={detailModal === null ? "" : `Burn Run ${detailModal.runId}`}
        icon={undefined}
      >
        <Modal.Content>
          {detailModal === null || detailModal.loading ? (
            <Text style={text(theme, "meta")}>Loading Burn Run verification details…</Text>
          ) : detailModal.error !== null ? (
            <Text style={text(theme, "label", "statusWarning")}>{detailModal.error}</Text>
          ) : detailModal.detail === null ? null : (
            <BurnRunDetailBody theme={theme} detail={detailModal.detail} />
          )}
          <View style={{ paddingTop: SPACING[2] }}>
            <Btn
              theme={theme}
              small
              label="Close"
              tone="foregroundMuted"
              onPress={() => setDetailModal(null)}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function PlaybooksAndRunsPane({
  theme,
  view,
  busy,
  selectedPlaybook,
  onSelectPlaybook,
  draft,
  onChangeDraft,
  onStartBurnRun,
  runFilter,
  onChangeRunFilter,
  onOpenDetail,
}: {
  theme: PluginTheme;
  view: BurnLabView;
  busy: boolean;
  selectedPlaybook: BurnPlaybookView;
  onSelectPlaybook: (pb: PlaybookMeta) => void;
  draft: PlaybookDraft;
  onChangeDraft: (updater: (prev: PlaybookDraft) => PlaybookDraft) => void;
  onStartBurnRun: () => void;
  runFilter: "all" | "active" | "completed" | "failed";
  onChangeRunFilter: (f: "all" | "active" | "completed" | "failed") => void;
  onOpenDetail: (runId: string) => void;
}) {
  const currentMeta = PLAYBOOKS.find((p) => p.id === selectedPlaybook) ?? PLAYBOOKS[0]!;
  const filteredRuns = view.runs.filter((r) => {
    if (runFilter === "all") return true;
    if (runFilter === "completed") return r.status === "completed";
    if (runFilter === "failed") return r.status === "failed";
    return r.status !== "completed" && r.status !== "failed";
  });

  return (
    <View style={{ gap: SPACING[3] }}>
      {/* 5 Playbook Selector & 1-Click Launcher */}
      <Card theme={theme} gap={SPACING[3]}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: SPACING[2],
          }}
        >
          <Text style={text(theme, "section")}>
            1. Select a Burn Playbook (3-Tier Anti-Hallucination Swarm)
          </Text>
          <Pill theme={theme} label={currentMeta.fenceBadge} tone="accent" lit icon="ShieldCheck" />
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] }}>
          {PLAYBOOKS.map((pb) => {
            const active = pb.id === selectedPlaybook;
            return (
              <Pressable
                key={pb.id}
                accessibilityRole="button"
                onPress={() => onSelectPlaybook(pb)}
                style={(state) => ({
                  flex: 1,
                  flexBasis: 190,
                  minWidth: 180,
                  padding: SPACING[2.5],
                  borderRadius: RADIUS.md,
                  borderWidth: 1,
                  borderColor: active
                    ? tint(theme.colors.accent, "99")
                    : hoveredOf(state)
                      ? theme.colors.foregroundMuted
                      : theme.colors.border,
                  backgroundColor: active
                    ? tint(theme.colors.accent, "16")
                    : theme.colors.surface0,
                  gap: SPACING[1],
                })}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
                  <Icon
                    name={pb.icon}
                    size={14}
                    color={active ? theme.colors.accent : theme.colors.foreground}
                  />
                  <Text
                    style={{
                      ...text(theme, "rowTitle"),
                      color: active ? theme.colors.accent : theme.colors.foreground,
                    }}
                  >
                    {pb.title}
                  </Text>
                </View>
                <Text style={text(theme, "meta")} numberOfLines={3}>
                  {pb.subtitle}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Brief & Parameters */}
        <View style={{ gap: SPACING[2] }}>
          <Text style={text(theme, "label")}>
            Brief for {currentMeta.title} (framed & synthesized by {view.supervisorLane}):
          </Text>
          <View
            style={{
              minHeight: 54,
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: RADIUS.md,
              backgroundColor: theme.colors.surface0,
            }}
          >
            <TextInput
              value={draft.brief}
              onChangeText={(val) => onChangeDraft((prev) => ({ ...prev, brief: val }))}
              multiline
              placeholder="Describe the research question, prototype specification, or codebase goal…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                paddingHorizontal: SPACING[2.5],
                paddingVertical: SPACING[2],
                color: theme.colors.foreground,
                fontSize: 13,
              }}
            />
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] }}>
            <View
              style={{
                flex: 1,
                flexBasis: 240,
                minHeight: CONTROL_SM,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: RADIUS.md,
                backgroundColor: theme.colors.surface0,
              }}
            >
              <TextInput
                value={draft.targetRepo}
                onChangeText={(val) => onChangeDraft((prev) => ({ ...prev, targetRepo: val }))}
                placeholder="Optional Target Repo Path or GitHub URL (defaults to active Project)"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  paddingHorizontal: SPACING[2.5],
                  paddingVertical: 4,
                  color: theme.colors.foreground,
                  fontSize: 12,
                }}
              />
            </View>
            <View
              style={{
                flex: 1,
                flexBasis: 220,
                minHeight: CONTROL_SM,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: RADIUS.md,
                backgroundColor: theme.colors.surface0,
              }}
            >
              <TextInput
                value={draft.gateCommand}
                onChangeText={(val) => onChangeDraft((prev) => ({ ...prev, gateCommand: val }))}
                placeholder="Optional Gate Command override (e.g. npm test)"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  paddingHorizontal: SPACING[2.5],
                  paddingVertical: 4,
                  color: theme.colors.foreground,
                  fontSize: 12,
                }}
              />
            </View>
            <Btn
              theme={theme}
              solid
              icon="Flame"
              label={busy ? "Running Swarm…" : `Start ${currentMeta.title} Run`}
              tone="accent"
              disabled={busy || draft.brief.trim() === ""}
              onPress={onStartBurnRun}
            />
          </View>
        </View>
      </Card>

      {/* Burn Runs & Deliverables List */}
      <Card theme={theme} gap={SPACING[2.5]}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: SPACING[2],
          }}
        >
          <Text style={text(theme, "section")}>Burn Runs & Verified Deliverables</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Chip
              theme={theme}
              label="All"
              active={runFilter === "all"}
              count={view.runs.length}
              onPress={() => onChangeRunFilter("all")}
            />
            <Chip
              theme={theme}
              label="Active"
              active={runFilter === "active"}
              count={view.kpis.activeRuns}
              onPress={() => onChangeRunFilter("active")}
            />
            <Chip
              theme={theme}
              label="Completed"
              active={runFilter === "completed"}
              count={view.runs.filter((r) => r.status === "completed").length}
              onPress={() => onChangeRunFilter("completed")}
            />
            <Chip
              theme={theme}
              label="Failed"
              active={runFilter === "failed"}
              count={view.runs.filter((r) => r.status === "failed").length}
              onPress={() => onChangeRunFilter("failed")}
            />
          </View>
        </View>

        {filteredRuns.length === 0 ? (
          <Text style={text(theme, "meta")}>
            No Burn runs recorded yet for this filter. Pick a Playbook above and click Start!
          </Text>
        ) : (
          filteredRuns.map((run) => (
            <BurnRunRow
              key={run.id}
              theme={theme}
              run={run}
              onInspect={() => onOpenDetail(run.id)}
            />
          ))
        )}
      </Card>
    </View>
  );
}

function BurnRunRow({
  theme,
  run,
  onInspect,
}: {
  theme: PluginTheme;
  run: BurnRunSummaryView;
  onInspect: () => void;
}) {
  return (
    <View
      style={{
        padding: SPACING[2.5],
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        gap: SPACING[1.5],
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: SPACING[1.5],
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Pill theme={theme} label={run.playbook} tone="accent" lit icon="Flame" />
          <Pill
            theme={theme}
            label={run.status}
            tone={statusTone(run.status)}
            lit={run.status === "completed" || run.status === "failed"}
          />
          <Pill theme={theme} label={run.projectSlug} mono />
          <Pill theme={theme} label={`Supervisor: ${run.supervisorLane}`} mono />
        </View>
        <Btn
          theme={theme}
          small
          icon="FileText"
          label="Inspect Report & Fence"
          tone="accent"
          onPress={onInspect}
        />
      </View>

      <Text style={text(theme, "rowTitle")} numberOfLines={2}>
        {run.prompt}
      </Text>

      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
        <Pill
          theme={theme}
          label={`Verified Attempts: ${run.acceptedCount}/${run.attemptCount}`}
          tone={run.acceptedCount > 0 ? "statusSuccess" : "foregroundMuted"}
          lit={run.acceptedCount > 0}
        />
        <Pill theme={theme} label={`Council Checks: ${run.councilCount}`} />
        {run.winningModel !== null ? (
          <Pill theme={theme} label={`Winner: ${run.winningModel}`} tone="statusSuccess" lit mono />
        ) : null}
        {run.gateCommand !== null ? (
          <Pill theme={theme} label={`Gate: ${run.gateCommand}`} mono />
        ) : null}
      </View>
    </View>
  );
}

function FreePoolPane({
  theme,
  view,
  busy,
  onScout,
}: {
  theme: PluginTheme;
  view: BurnLabView;
  busy: boolean;
  onScout: () => void;
}) {
  return (
    <Card theme={theme} gap={SPACING[2.5]}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: SPACING[2],
        }}
      >
        <View style={{ gap: 2 }}>
          <Text style={text(theme, "section")}>
            OpenCode Dynamic Free Pool ($0 / -free Models)
          </Text>
          <Text style={text(theme, "meta")}>
            Invoked via opencode run --standalone -m opencode/&lt;model&gt; to satisfy OpenCode&apos;s
            free-tier harness boundary.
          </Text>
        </View>
        <Btn
          theme={theme}
          solid
          icon="Radar"
          label={busy ? "Scouting…" : "Scout Free Models Now"}
          tone="accent"
          disabled={busy}
          onPress={onScout}
        />
      </View>

      {view.freeModels.length === 0 ? (
        <Text style={text(theme, "meta")}>
          No Free Pool snapshot recorded yet. Click &quot;Scout Free Models Now&quot; to discover and
          benchmark all current OpenCode -free models.
        </Text>
      ) : (
        view.freeModels.map((model) => (
          <FreeModelRow key={model.id} theme={theme} model={model} />
        ))
      )}
    </Card>
  );
}

function FreeModelRow({ theme, model }: { theme: PluginTheme; model: FreeModelView }) {
  const winRate =
    model.attempts > 0 ? `${Math.round((model.wins / model.attempts) * 100)}%` : "—";
  const ctxK = `${Math.round(model.contextWindow / 1000)}k`;

  return (
    <View
      style={{
        padding: SPACING[2.5],
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        gap: SPACING[1.5],
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: SPACING[1.5],
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Text style={text(theme, "rowTitle")}>{model.displayName}</Text>
          <Pill theme={theme} label={model.id} mono />
          <Pill theme={theme} label={`family: ${model.family}`} tone="accent" lit />
          <Pill theme={theme} label={`ctx: ${ctxK}`} mono />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
          <Pill
            theme={theme}
            label={model.healthy ? "healthy" : "offline"}
            tone={model.healthy ? "statusSuccess" : "statusDanger"}
            lit
          />
          {model.latencyMs !== null ? (
            <Pill theme={theme} label={`${model.latencyMs}ms`} mono />
          ) : null}
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
        {model.roles.map((role) => (
          <Pill key={role} theme={theme} label={`role: ${role}`} tone="accent" lit />
        ))}
        <Pill
          theme={theme}
          label={`Code Gate: ${model.gatePassed ? "PASS" : "FAIL"}`}
          tone={model.gatePassed ? "statusSuccess" : "foregroundMuted"}
          lit={model.gatePassed}
        />
        <Pill
          theme={theme}
          label={`Citation Gate: ${model.citationPassed ? "PASS" : "FAIL"}`}
          tone={model.citationPassed ? "statusSuccess" : "foregroundMuted"}
          lit={model.citationPassed}
        />
        <Pill
          theme={theme}
          label={`Wins: ${model.wins}/${model.attempts} (${winRate})`}
          mono
        />
      </View>
    </View>
  );
}

function UpstreamIssuesPane({
  theme,
  issues,
  busy,
  draft,
  onChangeDraft,
  onSubmitIssue,
  expandedIssueId,
  onToggleExpand,
}: {
  theme: PluginTheme;
  issues: UpstreamIssueView[];
  busy: boolean;
  draft: UpstreamIssueDraft;
  onChangeDraft: (updater: (prev: UpstreamIssueDraft) => UpstreamIssueDraft) => void;
  onSubmitIssue: () => void;
  expandedIssueId: string | null;
  onToggleExpand: (id: string) => void;
}) {
  return (
    <View style={{ gap: SPACING[3] }}>
      {/* File a new Upstream Issue */}
      <Card theme={theme} gap={SPACING[2]}>
        <Text style={text(theme, "section")}>
          File Upstream Issue to paseo-factory (Status: needs-triage)
        </Text>
        <Text style={text(theme, "meta")}>
          factory-burn-lab never modifies paseo-factory directly. File a markdown issue into
          paseo-factory/.scratch/burn-lab-upstream/issues/ for Supervisor / Owner evaluation.
        </Text>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] }}>
          <View
            style={{
              flex: 2,
              flexBasis: 240,
              minHeight: CONTROL_SM,
              justifyContent: "center",
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: RADIUS.md,
              backgroundColor: theme.colors.surface0,
            }}
          >
            <TextInput
              value={draft.title}
              onChangeText={(v) => onChangeDraft((prev) => ({ ...prev, title: v }))}
              placeholder="Issue Title (e.g. Expose worktree snapshot hook)"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                paddingHorizontal: SPACING[2.5],
                paddingVertical: 4,
                color: theme.colors.foreground,
                fontSize: 12,
              }}
            />
          </View>
          <View
            style={{
              flex: 1,
              flexBasis: 160,
              minHeight: CONTROL_SM,
              justifyContent: "center",
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: RADIUS.md,
              backgroundColor: theme.colors.surface0,
            }}
          >
            <TextInput
              value={draft.slug}
              onChangeText={(v) => onChangeDraft((prev) => ({ ...prev, slug: v }))}
              placeholder="Optional slug (e.g. worktree-hook)"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                paddingHorizontal: SPACING[2.5],
                paddingVertical: 4,
                color: theme.colors.foreground,
                fontSize: 12,
              }}
            />
          </View>
        </View>

        <View
          style={{
            minHeight: 44,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: RADIUS.md,
            backgroundColor: theme.colors.surface0,
          }}
        >
          <TextInput
            value={draft.problem}
            onChangeText={(v) => onChangeDraft((prev) => ({ ...prev, problem: v }))}
            multiline
            placeholder="Problem: What capability or primitive is missing in paseo-factory?"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              paddingHorizontal: SPACING[2.5],
              paddingVertical: SPACING[1.5],
              color: theme.colors.foreground,
              fontSize: 12,
            }}
          />
        </View>

        <View
          style={{
            minHeight: 44,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: RADIUS.md,
            backgroundColor: theme.colors.surface0,
          }}
        >
          <TextInput
            value={draft.proposedChange}
            onChangeText={(v) => onChangeDraft((prev) => ({ ...prev, proposedChange: v }))}
            multiline
            placeholder="Proposed Change: How should paseo-factory expose this cleanly?"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              paddingHorizontal: SPACING[2.5],
              paddingVertical: SPACING[1.5],
              color: theme.colors.foreground,
              fontSize: 12,
            }}
          />
        </View>

        <Btn
          theme={theme}
          solid
          icon="GitPullRequest"
          label="File Needs-Triage Upstream Issue"
          tone="accent"
          disabled={
            busy ||
            draft.title.trim() === "" ||
            draft.problem.trim() === "" ||
            draft.proposedChange.trim() === ""
          }
          onPress={onSubmitIssue}
        />
      </Card>

      {/* Upstream Issues List */}
      <Card theme={theme} gap={SPACING[2.5]}>
        <Text style={text(theme, "section")}>
          Filed Upstream Issues ({issues.length})
        </Text>
        {issues.length === 0 ? (
          <Text style={text(theme, "meta")}>
            No upstream issues filed in paseo-factory yet.
          </Text>
        ) : (
          issues.map((issue) => {
            const expanded = expandedIssueId === issue.id;
            return (
              <View
                key={issue.id}
                style={{
                  padding: SPACING[2.5],
                  borderRadius: RADIUS.md,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface0,
                  gap: SPACING[1.5],
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: SPACING[1.5],
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: SPACING[1.5],
                    }}
                  >
                    <Pill theme={theme} label={issue.id} mono />
                    <Pill
                      theme={theme}
                      label={`Status: ${issue.status}`}
                      tone="statusWarning"
                      lit
                    />
                    <Text style={text(theme, "rowTitle")}>{issue.title}</Text>
                  </View>
                  <Btn
                    theme={theme}
                    small
                    label={expanded ? "Hide Markdown" : "View Markdown"}
                    tone="foregroundMuted"
                    onPress={() => onToggleExpand(issue.id)}
                  />
                </View>
                <Text style={text(theme, "meta")}>{issue.summary}</Text>
                <Text style={text(theme, "code")}>{issue.path}</Text>
                {expanded ? (
                  <View
                    style={{
                      padding: SPACING[2],
                      borderRadius: RADIUS.sm,
                      backgroundColor: theme.colors.surface1,
                    }}
                  >
                    <Text style={text(theme, "code")}>{issue.body}</Text>
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </Card>
    </View>
  );
}

function BurnRunDetailBody({
  theme,
  detail,
}: {
  theme: PluginTheme;
  detail: BurnRunDetailView;
}) {
  return (
    <View style={{ gap: SPACING[3] }}>
      {/* Run Overview & Status Pipeline */}
      <View style={{ gap: SPACING[1] }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Pill theme={theme} label={detail.run.playbook} tone="accent" lit />
          <Pill
            theme={theme}
            label={detail.run.status}
            tone={statusTone(detail.run.status)}
            lit
          />
          <Pill theme={theme} label={`Supervisor: ${detail.run.supervisorLane}`} mono />
        </View>
        <Text style={text(theme, "code")}>
          Pipeline: {detail.statusHistory.join(" → ")}
        </Text>
      </View>

      {/* Tier 1: Supervisor Framing */}
      {detail.framing !== null ? (
        <View
          style={{
            gap: SPACING[1],
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            paddingTop: SPACING[2],
          }}
        >
          <Text style={text(theme, "section")}>Tier 1 — Strong Supervisor Framing</Text>
          <Text style={text(theme, "rowTitle")}>{detail.framing.goal}</Text>
          <Text style={text(theme, "code")}>Gate: {detail.framing.gateCommand}</Text>
          <Text style={text(theme, "code")}>
            Citation Gate Required: {detail.framing.citationRequired ? "yes" : "no"}
          </Text>
          {detail.framing.subtasks.map((st, idx) => (
            <Text key={idx} style={text(theme, "meta")}>
              • {st}
            </Text>
          ))}
        </View>
      ) : null}

      {/* Tier 2: Free Pool Swarm Attempts & Verification Fence */}
      <View
        style={{
          gap: SPACING[1.5],
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          paddingTop: SPACING[2],
        }}
      >
        <Text style={text(theme, "section")}>
          Tier 2 — Free Pool Swarm & Verification Fence ({detail.attempts.length} attempts)
        </Text>
        {detail.attempts.map((att) => (
          <View
            key={att.id}
            style={{
              padding: SPACING[2],
              borderRadius: RADIUS.md,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
              gap: SPACING[1],
            }}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
              <Pill
                theme={theme}
                label={att.accepted ? "ACCEPTED" : "REJECTED"}
                tone={att.accepted ? "statusSuccess" : "statusDanger"}
                lit
              />
              <Pill theme={theme} label={att.model} mono />
              <Pill theme={theme} label={`family: ${att.family}`} />
              <Pill theme={theme} label={`${att.latencyMs}ms`} mono />
              {att.gatePassed !== null ? (
                <Pill
                  theme={theme}
                  label={`Gate: ${att.gatePassed ? "GREEN" : `RED (exit ${att.gateExitCode ?? 1})`}`}
                  tone={att.gatePassed ? "statusSuccess" : "statusDanger"}
                  lit
                />
              ) : null}
              {att.citationPassed !== null ? (
                <Pill
                  theme={theme}
                  label={`Citations: ${att.validCitations ?? 0}/${att.totalCitations ?? 0} valid`}
                  tone={att.citationPassed ? "statusSuccess" : "statusDanger"}
                  lit
                />
              ) : null}
            </View>
            {att.rejectionReason !== null ? (
              <Text style={text(theme, "label", "statusWarning")}>
                Rejected: {att.rejectionReason}
              </Text>
            ) : null}
            <Text style={text(theme, "code")}>{att.output}</Text>
          </View>
        ))}
      </View>

      {/* Cross-Family Council Notes */}
      {detail.councilNotes.length > 0 ? (
        <View
          style={{
            gap: SPACING[1.5],
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            paddingTop: SPACING[2],
          }}
        >
          <Text style={text(theme, "section")}>Cross-Family Council Verdicts</Text>
          {detail.councilNotes.map((note, idx) => (
            <View key={idx} style={{ gap: 2 }}>
              <Text style={text(theme, "label")}>
                {note.reviewerModel} ({note.reviewerFamily}) reviewing {note.targetAttemptId} →{" "}
                {note.verdict.toUpperCase()}
              </Text>
              <Text style={text(theme, "code")}>{note.critique}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* Tier 3: Supervisor Synthesized Report */}
      {detail.reportMarkdown !== null ? (
        <View
          style={{
            gap: SPACING[1],
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            paddingTop: SPACING[2],
          }}
        >
          <Text style={text(theme, "section")}>
            Tier 3 — Supervisor Synthesized Deliverable (report.md)
          </Text>
          {detail.reportPath !== null ? (
            <Text style={text(theme, "code")}>File: {detail.reportPath}</Text>
          ) : null}
          <View
            style={{
              padding: SPACING[2.5],
              borderRadius: RADIUS.md,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <Text style={text(theme, "code")}>{detail.reportMarkdown}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
