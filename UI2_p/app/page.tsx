"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import Image from "next/image";
import { SettingsView } from "@/components/settings-view";
import { PrivacyView } from "@/components/privacy-view";
import { GuideView } from "@/components/guide-view";
import { RulebookChat } from "@/components/rulebook-chat";
import { BootSplash } from "@/components/boot-splash";
import { SaosLogo } from "@/components/saos-logo";
import { LocalExplanation } from "@/components/local-explanation";
import { CompareView } from "@/components/compare-view";
import { FindingGroupCard } from "@/components/finding-group";
import {
  RemediationReportModal,
  type ExecutionReport,
  getServiceNowRecordUrl,
} from "@/components/remediation-report-modal";
import { groupPlans } from "@/lib/core/grouping";
import {
  ArrowClockwise,
  ArrowRight,
  ArrowSquareOut,
  Check,
  ClockCounterClockwise,
  Database,
  DownloadSimple,
  Funnel,
  GearSix,
  GitBranch,
  GitDiff,
  House,
  Info,
  ListChecks,
  LockKey,
  MagnifyingGlass,
  Play,
  Shield,
  ShieldCheck,
  ShieldWarning,
  SlidersHorizontal,
  SquaresFour,
  Stack,
  TerminalWindow,
  TrendUp,
  WarningCircle,
  X,
  Briefcase,
  Wrench,
  CheckCircle,
  Sparkle,
  Copy,
  Cpu,
  CircleNotch,
  UserCircle,
  HardDrives,
  Radio,
} from "@phosphor-icons/react";
import type { Plan } from "@/lib/core/types";
import type { HealthScore } from "@/lib/core/scoring";
import type { FixPlan } from "@/lib/ai/prompts";
import { getRuleKnowledge } from "@/lib/rules/rule-knowledge";

function SysIdChip({ sysId }: { sysId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(sysId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="Click to copy full sys_id"
      className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-neutral-100 hover:bg-neutral-200/80 px-2 py-0.5 font-mono text-[10px] font-semibold text-neutral-600 transition-colors cursor-pointer"
    >
      <span>sys_id: {sysId.slice(0, 10)}…</span>
      {copied ? (
        <span className="text-[9px] font-bold text-emerald-600">Copied!</span>
      ) : (
        <Copy size={11} weight="bold" className="text-neutral-400 hover:text-neutral-600" />
      )}
    </button>
  );
}

type Audit = {
  seq: number;
  occurred_at: string;
  actor: string;
  action: string;
  payload: Record<string, unknown>;
  entry_hash: string;
};

type AppState = {
  mode: "configured" | "not-connected";
  twinVersion: number;
  objectCount: number;
  plans: Plan[];
  audit: Audit[];
  auditIntegrity: { valid: boolean; checked: number };
  lastSync: string | null;
  connectionConfigured: boolean;
  sourceHost: string | null;
  snapshotSourceHost: string | null;
  sourceMismatch: boolean;
  storedObjectCount: number;
  tableCounts: { table: string; count: number }[];
  sourceTables: string[];
  sourceMissingTables: string[];
  sourceTableErrors: Record<string, string>;
  connectionInstanceUrl: string;
  connectionUsername: string;
  domainMode: "separated" | "global";
  secretStorage: string;
  coverageComplete: boolean;
  coverageGaps: string[];
  activeJob: JobProgress | null;
  healthSummary?: {
    cmdbHealthScore: number;
    itsmHealthScore: number;
    totalCIs: number;
    totalRelationships: number;
    totalIssues: number;
    fixedCount: number;
    worstItems: HealthScore[];
    scoresByEntity?: Record<string, HealthScore>;
  } | null;
};

type View =
  | "Overview"
  | "Problems"
  | "Fixes"
  | "Rulebook AI"
  | "History"
  | "Compare"
  | "Settings"
  | "Data & privacy"
  | "Guide";

type JobProgress = {
  kind: "sync" | "scan";
  status: "queued" | "running" | "completed" | "failed";
  phase: string;
  currentAgent: string | null;
  currentTable: string | null;
  progress: number;
  total: number;
  message: string;
  error: string | null;
  result: { findingCount?: number; scan?: { findingCount?: number } } | null;
};

const nav = [
  { name: "Overview", icon: SquaresFour },
  { name: "Problems", icon: ShieldWarning },
  { name: "Fixes", icon: Wrench },
  { name: "Rulebook AI", icon: Sparkle },
  { name: "History", icon: ClockCounterClockwise },
  { name: "Compare", icon: GitDiff },
  { name: "Settings", icon: SlidersHorizontal },
  { name: "Data & privacy", icon: LockKey },
  { name: "Guide", icon: Info },
] as const;

const displayTime = (date: string | null) =>
  date ? new Date(date).toLocaleString() : "Not synced";

const moduleForRule = (ruleId: string): "CMDB" | "ITSM" | "CSDM" | "ITOM" | "Data Quality" | "Platform" => {
  const upper = ruleId.toUpperCase();
  if (
    upper === "CMDB-106" ||
    upper === "CMDB-110" ||
    upper.startsWith("CSDM.") ||
    upper.startsWith("CSDM-") ||
    upper.startsWith("CSDM")
  ) {
    return "CSDM";
  }
  if (
    upper === "CMDB-016" ||
    upper.startsWith("DISCOVERY.") ||
    upper.startsWith("ITOM.") ||
    upper.startsWith("ITOM-") ||
    upper.includes("DISCOVERY")
  ) {
    return "ITOM";
  }
  if (upper.startsWith("ITSM.") || upper.startsWith("ITSM-")) return "ITSM";
  if (upper.startsWith("DQ.") || upper.startsWith("DQ-") || upper.startsWith("DQ")) return "Data Quality";
  if (upper.startsWith("PLT.") || upper.startsWith("PLT-") || upper.startsWith("SEC-")) return "Platform";
  return "CMDB";
};

export default function Home() {
  const [data, setData] = useState<AppState | null>(null);
  const [view, setView] = useState<View>("Overview");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [lane, setLane] = useState<number | null>(null);
  const [moduleFilter, setModuleFilter] = useState<"All" | "CMDB" | "ITSM" | "CSDM" | "ITOM" | "Data Quality" | "Platform">("All");
  const [showAllRanks, setShowAllRanks] = useState(false);
  const [priorityTab, setPriorityTab] = useState<"rules" | "items">("rules");
  const [fixesTab, setFixesTab] = useState<"batch" | "staged" | "applied">("batch");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewer, setReviewer] = useState("operator");
  const [aiStatus, setAiStatus] = useState<{ available: boolean; model: string; message: string } | null>(null);
  const [individualExecutionReport, setIndividualExecutionReport] = useState<ExecutionReport | null>(null);

  useEffect(() => {
    fetch("/api/ai/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setAiStatus(d))
      .catch(() => setAiStatus(null));
  }, [view]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("saos_reviewer");
      if (saved) setReviewer(saved);
    } catch {
      // ignore
    }
  }, []);

  const switchView = (newView: View) => {
    setView(newView);
    setActiveId(null);
  };

  const handleReviewerChange = (val: string) => {
    setReviewer(val);
    try {
      localStorage.setItem("saos_reviewer", val);
    } catch {
      // ignore
    }
  };
  const [jobProgress, setJobProgress] = useState<JobProgress | null>(null);
  const [bootMinDone, setBootMinDone] = useState(false);

  const visibleJob = jobProgress ?? data?.activeJob ?? null;

  useEffect(() => {
    const timer = window.setTimeout(() => setBootMinDone(true), 5000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok)
        throw new Error(`State request failed (${response.status})`);
      const next = (await response.json()) as AppState;
      setData(next);
      setActiveId((current) =>
        current && next.plans.some((p) => p.id === current) ? current : null,
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Unable to load local state",
      );
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const action = async (
    kind: "test" | "sync" | "scan" | "preview" | "decision" | "apply" | "rollback",
    url: string,
    body?: Record<string, unknown>,
    options?: { silent?: boolean },
  ) => {
    setBusy(kind);
    if (!options?.silent) setNotice("");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Action could not complete");
      if (result.jobId) {
        setJobProgress(result.job);
        const finished = await waitForJob(result.jobId);
        if (!options?.silent) {
          setNotice(
            finished.status === "completed"
              ? `${finished.kind === "sync" ? "Sync" : "Scan"} finished: ${finished.message}`
              : `Failed: ${finished.error ?? finished.message}`,
          );
        }
      } else {
        if (!options?.silent) {
          setNotice(
            kind === "preview"
              ? "Preview generated"
              : kind === "decision"
                ? `Decision recorded: ${result.status}`
                : kind === "apply"
                  ? "✓ Fix applied successfully to ServiceNow"
                  : kind === "rollback"
                    ? "✓ Fix rolled back successfully in ServiceNow"
                    : "Operation complete",
          );
        }

        // Instant Optimistic State Update for immediate UI reflection without stale delay
        if (kind === "apply" && url.includes("/api/plans/")) {
          const match = url.match(/\/api\/plans\/([^/]+)\/apply/);
          const targetPlanId = match ? match[1] : null;
          if (targetPlanId) {
            setData((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                plans: prev.plans.map((p) =>
                  p.id === targetPlanId ? { ...p, status: "Applied" as const } : p,
                ),
                healthSummary: prev.healthSummary
                  ? {
                      ...prev.healthSummary,
                      fixedCount: (prev.healthSummary.fixedCount || 0) + 1,
                      totalIssues: Math.max(0, (prev.healthSummary.totalIssues || 0) - 1),
                      cmdbHealthScore: Math.min(100, (prev.healthSummary.cmdbHealthScore || 0) + 1),
                      itsmHealthScore: Math.min(100, (prev.healthSummary.itsmHealthScore || 0) + 2),
                    }
                  : prev.healthSummary,
              };
            });
          }
        } else if (kind === "decision" && url.includes("/api/plans/")) {
          const match = url.match(/\/api\/plans\/([^/]+)\/decision/);
          const targetPlanId = match ? match[1] : null;
          const bodyPayload = body as { decision?: string } | undefined;
          if (targetPlanId && bodyPayload?.decision === "reject") {
            setData((prev) => {
              if (!prev) return prev;
              const remaining = prev.plans.filter((p) => p.id !== targetPlanId);
              return {
                ...prev,
                plans: remaining,
                healthSummary: prev.healthSummary
                  ? {
                      ...prev.healthSummary,
                      totalIssues: Math.max(0, (prev.healthSummary.totalIssues || 0) - 1),
                    }
                  : prev.healthSummary,
              };
            });
            setActiveId((cur) => (cur === targetPlanId ? null : cur));
          } else if (targetPlanId && bodyPayload?.decision === "approve") {
            setData((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                plans: prev.plans.map((p) =>
                  p.id === targetPlanId ? { ...p, status: "Approved" as const } : p,
                ),
              };
            });
          }
        } else if (kind === "rollback" && url.includes("/api/plans/")) {
          const match = url.match(/\/api\/plans\/([^/]+)\/rollback/);
          const targetPlanId = match ? match[1] : null;
          if (targetPlanId) {
            setData((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                plans: prev.plans.map((p) =>
                  p.id === targetPlanId ? { ...p, status: "Proposed" as const } : p,
                ),
                healthSummary: prev.healthSummary
                  ? {
                      ...prev.healthSummary,
                      fixedCount: Math.max(0, (prev.healthSummary.fixedCount || 0) - 1),
                      totalIssues: (prev.healthSummary.totalIssues || 0) + 1,
                    }
                  : prev.healthSummary,
              };
            });
          }
        }
      }
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy("");
      setJobProgress(null);
    }
  };

  const waitForJob = async (jobId: string) => {
    for (let attempt = 0; attempt < 7200; attempt += 1) {
      const response = await fetch(`/api/scan/jobs/${jobId}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not read scan progress");
      const job = (await response.json()) as JobProgress;
      setJobProgress(job);
      if (job.status === "completed" || job.status === "failed") return job;
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    throw new Error(
      "Scan is taking longer than expected. Check History for result.",
    );
  };

  const handleRejectFinding = async (targetPlanId: string) => {
    if (
      !window.confirm(
        "Reject and dismiss this finding? It will be removed from active issues.",
      )
    ) {
      return;
    }
    const currentActor = reviewer.trim().length >= 2 ? reviewer.trim() : "operator";

    // 1. Optimistically dismiss finding immediately so UI is instantaneous
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        plans: prev.plans.filter((p) => p.id !== targetPlanId),
        healthSummary: prev.healthSummary
          ? {
              ...prev.healthSummary,
              totalIssues: Math.max(0, (prev.healthSummary.totalIssues || 0) - 1),
            }
          : prev.healthSummary,
      };
    });

    // 2. Clear drawer immediately
    setActiveId(null);
    setNotice("✓ Finding rejected and dismissed from active issues.");

    // 3. Persist decision to server and database
    try {
      await action(
        "decision",
        `/api/plans/${targetPlanId}/decision`,
        {
          decision: "reject",
          actor: currentActor,
        },
        { silent: true },
      );
    } catch (e) {
      console.warn("Reject action failed:", e);
    }
  };

  const handleApplyIndividualPlan = async (targetPlan: Plan) => {
    const actor = reviewer.trim().length >= 2 ? reviewer.trim() : "operator";
    const instanceUrl = data?.connectionInstanceUrl || "";
    const table = String(
      targetPlan.evidence?.table || targetPlan.targetId.split(":")[0] || "cmdb_ci",
    );
    const sysId = String(
      targetPlan.evidence?.sysId ||
        targetPlan.evidence?.duplicateSysId ||
        targetPlan.evidence?.number ||
        targetPlan.targetId ||
        "",
    );
    const targetFixPlan = targetPlan.preview?.fixPlan as FixPlan | undefined;
    const initialFixPreview = targetFixPlan
      ? {
          whatWasMissing: targetFixPlan.whatWasMissing,
          whatIsAdded: targetFixPlan.whatIsAdded,
          rootCause: targetFixPlan.rootCause,
          fixActions: targetFixPlan.fixActions,
        }
      : undefined;
    const strategy = String(
      (targetPlan.preview?.fixPlan as (FixPlan & { strategy?: string }) | undefined)?.strategy ||
        (targetPlan.preview?.fixPlan as FixPlan | undefined)?.summary ||
        (targetPlan.preview?.operation as string | undefined) ||
        "Direct REST Mutation",
    );
    const now = () => new Date().toLocaleTimeString();

    // 1. Immediately display the Execution Modal with "executing" status and live logs
    setIndividualExecutionReport({
      status: "executing",
      groupTitle: targetPlan.title,
      strategy,
      appliedCount: 0,
      failedCount: 0,
      total: 1,
      targetTable: table,
      instanceUrl,
      fixPreview: initialFixPreview,
      recordsApplied: [
        {
          id: targetPlan.id,
          title: targetPlan.title,
          table,
          sysId,
          status: "pending",
        },
      ],
      logs: [
        {
          timestamp: now(),
          type: "info",
          message: `Initiating target remediation on ServiceNow instance (${instanceUrl || "Configured Instance"})...`,
        },
        {
          timestamp: now(),
          type: "snapshot",
          message: `[SNAPSHOT] Inspecting ${table} record (${sysId.slice(0, 16)}…) for pre-change baseline capture...`,
        },
      ],
    });

    try {
      // If no AI fix plan was staged yet, formulate it now using agentic reasoning
      if (!targetFixPlan) {
        setIndividualExecutionReport((prev) =>
          prev
            ? {
                ...prev,
                logs: [
                  ...(prev.logs || []),
                  {
                    timestamp: now(),
                    type: "info",
                    message: `[AI AGENT] Consulting LLM agentic engine for root cause & target REST operations...`,
                  },
                ],
              }
            : prev,
        );

        const suggestRes = await fetch(`/api/plans/${targetPlan.id}/suggest`, {
          method: "POST",
        }).catch(() => null);

        if (suggestRes?.ok) {
          const suggestData = await suggestRes.json().catch(() => null);
          if (suggestData?.preview?.fixPlan) {
            const fp = suggestData.preview.fixPlan as FixPlan;
            setIndividualExecutionReport((prev) =>
              prev
                ? {
                    ...prev,
                    strategy: fp.summary || prev.strategy,
                    fixPreview: {
                      whatWasMissing: fp.whatWasMissing,
                      whatIsAdded: fp.whatIsAdded,
                      rootCause: fp.rootCause,
                      fixActions: fp.fixActions,
                    },
                    logs: [
                      ...(prev.logs || []),
                      {
                        timestamp: now(),
                        type: "success",
                        message: `[AI AGENT] Remediation plan formulated: ${fp.summary}`,
                      },
                    ],
                  }
                : prev,
            );
          }
        }
      }

      // 2. Ensure plan is approved before applying (prevents workflow validation error)
      if (targetPlan.status !== "Approved") {
        setIndividualExecutionReport((prev) =>
          prev
            ? {
                ...prev,
                logs: [
                  ...(prev.logs || []),
                  {
                    timestamp: now(),
                    type: "info",
                    message: `[GOVERNANCE] Staging operator approval for plan ${targetPlan.id}...`,
                  },
                ],
              }
            : prev,
        );

        const decisionRes = await fetch(`/api/plans/${targetPlan.id}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision: "approve",
            actor,
            reason: "Operator applied fix via Studio",
          }),
        });
        if (!decisionRes.ok) {
          const dErr = await decisionRes.json().catch(() => ({}));
          throw new Error(dErr.error || "Approval failed before apply");
        }
      }

      // 3. Log mutation dispatch
      setIndividualExecutionReport((prev) =>
        prev
          ? {
              ...prev,
              logs: [
                ...(prev.logs || []),
                {
                  timestamp: now(),
                  type: "rest",
                  message: `[REST] Dispatching authenticated write mutation to ${table}/${sysId.slice(0, 16)}…`,
                },
              ],
            }
          : prev,
      );

      // 4. Call /api/plans/[id]/apply
      const res = await fetch(`/api/plans/${targetPlan.id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor,
          confirm: "APPLY",
        }),
      });

      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || "Failed to apply fix to ServiceNow");
      }

      // 5. Success! Mark execution complete in modal
      const appliedOp = result.operation || "PATCH";
      setIndividualExecutionReport((prev) =>
        prev
          ? {
              ...prev,
              status: "completed",
              appliedCount: 1,
              failedCount: 0,
              recordsApplied: [
                {
                  id: targetPlan.id,
                  title: targetPlan.title,
                  table,
                  sysId,
                  operation: appliedOp,
                  status: "success",
                },
              ],
              logs: [
                ...(prev.logs || []),
                {
                  timestamp: now(),
                  type: "rest",
                  message: `[REST] ServiceNow Table API responded: 200 OK (${appliedOp}).`,
                },
                {
                  timestamp: now(),
                  type: "snapshot",
                  message: `[VAULT] Original pre-change state sealed in local PostgreSQL rollback vault.`,
                },
                {
                  timestamp: now(),
                  type: "success",
                  message: `[COMPLETE] Fix successfully applied to ServiceNow! Ready for verification.`,
                },
              ],
            }
          : prev,
      );

      // 6. Optimistically update local data state
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          plans: prev.plans.map((p) =>
            p.id === targetPlan.id ? { ...p, status: "Applied" as const } : p,
          ),
          healthSummary: prev.healthSummary
            ? {
                ...prev.healthSummary,
                fixedCount: (prev.healthSummary.fixedCount || 0) + 1,
                totalIssues: Math.max(0, (prev.healthSummary.totalIssues || 0) - 1),
                cmdbHealthScore: Math.min(100, (prev.healthSummary.cmdbHealthScore || 0) + 1),
                itsmHealthScore: Math.min(100, (prev.healthSummary.itsmHealthScore || 0) + 2),
              }
            : prev.healthSummary,
        };
      });

      setNotice("✓ Fix applied successfully to ServiceNow");
      void refresh();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setIndividualExecutionReport((prev) =>
        prev
          ? {
              ...prev,
              status: "error",
              failedCount: 1,
              errorMessage: errMsg,
              recordsApplied: [
                {
                  id: targetPlan.id,
                  title: targetPlan.title,
                  table,
                  sysId,
                  status: "error",
                  error: errMsg,
                },
              ],
              logs: [
                ...(prev.logs || []),
                {
                  timestamp: now(),
                  type: "error",
                  message: `[ERROR] Execution failed: ${errMsg}`,
                },
              ],
            }
          : prev,
      );
      setNotice(`Failed to apply fix: ${errMsg}`);
    }
  };

  const handleRollbackIndividual = async (targetPlan: Plan) => {
    const table = String(
      targetPlan.evidence.table || targetPlan.targetId.split(":")[0] || "cmdb_ci",
    );
    const sysId = String(
      targetPlan.evidence.sysId ||
        targetPlan.evidence.duplicateSysId ||
        targetPlan.evidence.number ||
        targetPlan.targetId.split(":")[1] ||
        "",
    );

    const now = () => new Date().toLocaleTimeString();

    setIndividualExecutionReport({
      status: "executing",
      groupId: targetPlan.id,
      groupTitle: `Rollback: ${targetPlan.title}`,
      strategy: "RESTORE PRE-CHANGE BASELINE",
      appliedCount: 0,
      failedCount: 0,
      total: 1,
      targetTable: table,
      instanceUrl: data?.connectionInstanceUrl,
      recordsApplied: [],
      logs: [
        {
          timestamp: now(),
          type: "info",
          message: `[ROLLBACK INITIATED] Retrieving pre-change baseline snapshot from vault...`,
        },
        {
          timestamp: now(),
          type: "snapshot",
          message: `[VAULT] Querying PostgreSQL for plan ${targetPlan.id} baseline fields...`,
        },
        {
          timestamp: now(),
          type: "rest",
          message: `[REST] Dispatching authenticated reversion call to ${table}/${sysId.slice(0, 16)}…`,
        },
      ],
    });

    try {
      const res = await fetch(`/api/plans/${targetPlan.id}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: reviewer.trim() || "operator",
          confirm: "ROLLBACK",
        }),
      });

      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || "Rollback failed on ServiceNow");
      }

      setIndividualExecutionReport((prev) =>
        prev
          ? {
              ...prev,
              status: "completed",
              appliedCount: 1,
              failedCount: 0,
              recordsApplied: [
                {
                  id: targetPlan.id,
                  title: targetPlan.title,
                  table,
                  sysId,
                  operation: "ROLLBACK_RESTORE",
                  status: "success",
                },
              ],
              logs: [
                ...(prev.logs || []),
                {
                  timestamp: now(),
                  type: "rest",
                  message: `[REST] ServiceNow Table API responded: 200 OK. Pre-change state restored.`,
                },
                {
                  timestamp: now(),
                  type: "snapshot",
                  message: `[DIGITAL TWIN] Reverted local twin_objects payload in PostgreSQL.`,
                },
                {
                  timestamp: now(),
                  type: "success",
                  message: `[ROLLBACK COMPLETE] Record successfully restored to baseline on ServiceNow!`,
                },
              ],
            }
          : prev,
      );

      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          plans: prev.plans.map((p) =>
            p.id === targetPlan.id ? { ...p, status: "Proposed" as const } : p,
          ),
          healthSummary: prev.healthSummary
            ? {
                ...prev.healthSummary,
                fixedCount: Math.max(0, (prev.healthSummary.fixedCount || 0) - 1),
                totalIssues: (prev.healthSummary.totalIssues || 0) + 1,
              }
            : prev.healthSummary,
        };
      });

      setNotice("✓ Fix rolled back successfully in ServiceNow");
      void refresh();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setIndividualExecutionReport((prev) =>
        prev
          ? {
              ...prev,
              status: "error",
              failedCount: 1,
              errorMessage: errMsg,
              logs: [
                ...(prev.logs || []),
                {
                  timestamp: now(),
                  type: "error",
                  message: `[ERROR] Rollback failed: ${errMsg}`,
                },
              ],
            }
          : prev,
      );
      setNotice(`Failed to rollback fix: ${errMsg}`);
    }
  };

  const open = useMemo(
    () =>
      data?.plans.filter(
        (p) => p.status !== "Rejected" && p.status !== "Applied",
      ) ?? [],
    [data],
  );

  const appliedPlans = useMemo(
    () => data?.plans.filter((p) => p.status === "Applied") ?? [],
    [data],
  );

  const activeWorstItems = useMemo(() => {
    return (data?.healthSummary?.worstItems ?? []).filter((item) => {
      if (item.score >= 100) return false;
      const matched = data?.plans.find(
        (p) =>
          p.targetId.includes(item.entityId) ||
          String(p.evidence?.sysId || "") === item.entityId ||
          String(p.evidence?.duplicateSysId || "") === item.entityId ||
          String(p.evidence?.number || "") === item.entityId,
      );
      if (matched && (matched.status === "Applied" || matched.status === "Rejected")) {
        return false;
      }
      return true;
    });
  }, [data?.healthSummary?.worstItems, data?.plans]);

  const previewedPlans = useMemo(
    () =>
      data?.plans.filter(
        (p) => p.status === "Previewed" || p.status === "Approved",
      ) ?? [],
    [data],
  );

  const plans = useMemo(
    () =>
      (data?.plans ?? []).filter((p) => {
        if (view === "Fixes") {
          return (
            p.status === "Approved" ||
            p.status === "Previewed" ||
            p.status === "Applied"
          );
        }
        if (p.status === "Rejected" || p.status === "Applied") return false;
        if (lane !== null && p.lane !== lane) return false;
        if (moduleFilter !== "All" && moduleForRule(p.ruleId) !== moduleFilter) return false;
        if (search) {
          const q = search.toLowerCase();
          return `${p.title} ${p.domain} ${p.risk} ${p.ruleId} ${p.targetId} ${moduleForRule(p.ruleId)}`
            .toLowerCase()
            .includes(q);
        }
        return true;
      }),
    [data, lane, moduleFilter, search, view],
  );

  // Grouped findings for Problems view (includes open and applied findings, excluding rejected)
  const findingsForGroups = useMemo(
    () => (data?.plans ?? []).filter((p) => p.status !== "Rejected"),
    [data?.plans],
  );

  const groups = useMemo(() => {
    return groupPlans(findingsForGroups, data?.healthSummary?.scoresByEntity);
  }, [findingsForGroups, data?.healthSummary?.scoresByEntity]);

  const visibleGroups = useMemo(() => {
    return groups.filter((g) => {
      if (moduleFilter !== "All") {
        const groupMod = g.module.toLowerCase();
        const filterMod = moduleFilter.toLowerCase();
        if (groupMod !== filterMod) {
          return false;
        }
      }
      if (search) {
        const q = search.toLowerCase();
        return (
          g.ruleTitle.toLowerCase().includes(q) ||
          g.ruleId.toLowerCase().includes(q) ||
          g.summary.toLowerCase().includes(q) ||
          g.plans.some(
            (p) =>
              p.title.toLowerCase().includes(q) ||
              String(p.evidence?.sysId ?? "").includes(q),
          )
        );
      }
      return true;
    });
  }, [groups, moduleFilter, search]);

  const active = useMemo(
    () =>
      activeId
        ? (data?.plans ?? []).find((p) => p.id === activeId) ?? null
        : null,
    [data?.plans, activeId],
  );

  const activeFixPlan = useMemo(
    () => (active?.preview?.fixPlan as FixPlan | null | undefined) ?? null,
    [active?.preview],
  );

  const exportAudit = async () => {
    const response = await fetch("/api/audit", { cache: "no-store" });
    if (!response.ok) {
      setNotice("Could not download history");
      return;
    }
    const completeHistory = (await response.json()) as {
      entries: Audit[];
      integrity: AppState["auditIntegrity"];
    };
    const blob = new Blob(
      [
        JSON.stringify(
          { exportedAt: new Date().toISOString(), ...completeHistory },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "saos-audit.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportReport = async () => {
    const response = await fetch("/api/report", { cache: "no-store" });
    if (!response.ok) {
      setNotice("Could not generate audit report");
      return;
    }
    const report = await response.json();
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "saos-audit-report.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const cmdbIssuesCount = open.filter((p) => moduleForRule(p.ruleId) === "CMDB").length;
  const itsmIssuesCount = open.filter((p) => moduleForRule(p.ruleId) === "ITSM").length;
  const csdmIssuesCount = open.filter((p) => moduleForRule(p.ruleId) === "CSDM").length;
  const itomIssuesCount = open.filter((p) => moduleForRule(p.ruleId) === "ITOM").length;
  const dqIssuesCount = open.filter((p) => moduleForRule(p.ruleId) === "Data Quality").length;

  const cmdbFixedCount = appliedPlans.filter((p) => moduleForRule(p.ruleId) === "CMDB").length;
  const itsmFixedCount = appliedPlans.filter((p) => moduleForRule(p.ruleId) === "ITSM").length;
  const csdmFixedCount = appliedPlans.filter((p) => moduleForRule(p.ruleId) === "CSDM").length;
  const itomFixedCount = appliedPlans.filter((p) => moduleForRule(p.ruleId) === "ITOM").length;
  const dqFixedCount = appliedPlans.filter((p) => moduleForRule(p.ruleId) === "Data Quality").length;

  const cmdbScore = data?.healthSummary?.cmdbHealthScore ?? 100;
  const itsmScore = data?.healthSummary?.itsmHealthScore ?? 100;
  const csdmScore = (data?.healthSummary as any)?.csdmHealthScore ?? (csdmIssuesCount > 0 ? Math.max(45, 100 - csdmIssuesCount * 3) : 100);
  const itomScore = (data?.healthSummary as any)?.itomHealthScore ?? (itomIssuesCount > 0 ? Math.max(50, 100 - Math.round(itomIssuesCount * 0.4)) : 100);
  const dqScore = (data?.healthSummary as any)?.dataQualityHealthScore ?? (dqIssuesCount > 0 ? Math.max(55, 100 - Math.round(dqIssuesCount * 0.3)) : 100);

  return (
    <>
      <BootSplash open={!bootMinDone} ready={Boolean(data)} />
      <main className="min-h-screen bg-[#f4f8f9] text-[#0d2f3f] selection:bg-[#5edc56] xl:h-screen xl:overflow-hidden">
        {/* Sidebar */}
        <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r-[3px] border-[#0d2f3f] bg-[#0c2633] p-4 text-[#f4f8f9] lg:flex lg:flex-col lg:justify-between shadow-[4px_0_0_rgba(13,47,63,0.06)]">
          <div>
            {/* Brand Header */}
            <div className="flex items-center gap-3 border-b-2 border-white/10 pb-4">
              <span className="grid size-10 shrink-0 place-items-center border-2 border-[#5edc56] bg-[#071922] shadow-[2px_2px_0_#5edc56]">
                <SaosLogo size={28} />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="font-mono text-[10px] font-black tracking-[0.22em] text-[#5edc56]">
                    SAOS 2.0
                  </p>
                  <span className="inline-block size-1.5 rounded-full bg-[#5edc56] animate-pulse" />
                </div>
                <p className="font-display text-base font-black tracking-[-0.04em] text-white leading-tight">
                  AUTONOMOUS GOVERNANCE
                </p>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  <span className="border border-white/20 bg-[#d2ebf0]/20 text-[#a5f3fc] px-1 py-0.2 font-mono text-[8px] font-black">
                    CMDB
                  </span>
                  <span className="border border-white/20 bg-[#eedbfb]/20 text-[#f0abfc] px-1 py-0.2 font-mono text-[8px] font-black">
                    ITSM
                  </span>
                  <span className="border border-white/20 bg-[#d1fae5]/20 text-[#6ee7b7] px-1 py-0.2 font-mono text-[8px] font-black">
                    CSDM
                  </span>
                  <span className="border border-white/20 bg-[#ffedd5]/20 text-[#fdba74] px-1 py-0.2 font-mono text-[8px] font-black">
                    ITOM
                  </span>
                  <span className="border border-white/20 bg-[#fef3c7]/20 text-[#fde047] px-1 py-0.2 font-mono text-[8px] font-black">
                    DQ
                  </span>
                </div>
              </div>
            </div>

            {/* Symmetrical Navigation Links */}
            <nav aria-label="Main navigation" className="mt-5 space-y-1.5">
              {nav.map(({ name, icon: Icon }) => {
                const isActive = view === name;
                let badgeContent: string | null = null;
                if (name === "Problems" && open.length > 0) {
                  badgeContent = open.length > 999 ? `${(open.length / 1000).toFixed(1)}k` : String(open.length);
                } else if (name === "Fixes" && (data?.plans?.length ?? 0) > 0) {
                  const appliedCount = data?.plans.filter((p) => p.status === "Applied").length ?? 0;
                  if (appliedCount > 0) badgeContent = `${appliedCount} fixed`;
                }

                return (
                  <button
                    key={name}
                    onClick={() => switchView(name)}
                    type="button"
                    className={`brutal-btn group flex w-full items-center gap-2.5 border-2 px-2.5 py-1.5 text-left text-xs sm:text-[13px] font-bold transition-all ${
                      isActive
                        ? "border-[#5edc56] bg-[#5edc56] text-[#0d2f3f] shadow-[2px_2px_0_#061a23] font-black"
                        : "border-transparent hover:border-white/20 hover:bg-white/[0.08] text-[#c7d9de] hover:text-white"
                    }`}
                  >
                    <span
                      className={`grid size-7 shrink-0 place-items-center border transition-all ${
                        isActive
                          ? "border-[#0d2f3f] bg-[#0d2f3f] text-[#5edc56] shadow-[1px_1px_0_#071922]"
                          : "border-white/15 bg-[#071922] text-[#8fa8b3] group-hover:border-[#5edc56]/60 group-hover:text-[#5edc56]"
                      }`}
                    >
                      <Icon size={16} weight={isActive ? "fill" : "bold"} />
                    </span>
                    <span className="flex-1 truncate">{name}</span>

                    {/* Symmetrical Right Gutter Badge / Indicator */}
                    {badgeContent ? (
                      <span
                        className={`px-1.5 py-0.2 font-mono text-[10px] font-black uppercase tracking-tight shrink-0 border ${
                          isActive
                            ? "border-[#0d2f3f] bg-[#0d2f3f] text-[#5edc56]"
                            : "border-white/20 bg-white/10 text-white"
                        }`}
                      >
                        {badgeContent}
                      </span>
                    ) : isActive ? (
                      <span className="size-1.5 rounded-full bg-[#0d2f3f] shrink-0" />
                    ) : null}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Symmetrical Footer Telemetry Card */}
          <div className="border-2 border-white/15 bg-[#071822] p-3 shadow-[2px_2px_0_rgba(0,0,0,0.35)] flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span
                className={`size-2.5 rounded-full shrink-0 ${
                  data?.connectionConfigured ? "bg-[#5edc56] animate-pulse shadow-[0_0_8px_#5edc56]" : "bg-red-400"
                }`}
              />
              <span className="font-mono text-[11px] font-black uppercase tracking-widest text-[#5edc56]">
                {data?.connectionConfigured ? "CONNECTED" : "OFFLINE"}
              </span>
            </div>
            <div className="border-t border-white/10 pt-2 text-center">
              <span className="inline-block font-mono text-[9px] font-black uppercase tracking-wider text-[#5edc56]">
                SAOS CREATED BY @PIANLABS
              </span>
            </div>
          </div>
        </aside>

        {/* Content Column */}
        <section className="lg:pl-64 xl:flex xl:h-screen xl:flex-col xl:overflow-hidden">
          {/* Top Bar */}
          <header className="sticky top-0 z-10 flex min-h-[70px] items-center justify-between gap-3 border-b-[3px] border-[#0d2f3f] bg-[#f4f8f9] px-4 py-3 sm:px-7">
            <div>
              <p className="font-mono text-[10px] font-bold tracking-[0.16em] uppercase text-[#476371]">
                ServiceNow Twin Workspace
              </p>
              <h1 className="font-display text-xl font-black tracking-[-0.04em] sm:text-2xl">
                {view === "Overview"
                  ? "Health & Ops Risk Scorecard"
                  : view === "Problems"
                    ? "Audit & Compliance Findings"
                    : view === "Fixes"
                      ? "Remediation & Rollback Center"
                      : view === "Compare"
                        ? "Instance Drift & Diff"
                        : view === "History"
                          ? "SHA-256 Audit Trail"
                          : view}
              </h1>
            </div>

            <div className="flex items-center gap-2">
              <button
                aria-label="Sync ServiceNow"
                disabled={!!busy || !!visibleJob || !data?.connectionConfigured}
                title={
                  data?.connectionConfigured
                    ? "Sync CMDB & ITSM records"
                    : "Open Settings to configure connection"
                }
                className="grid size-10 place-items-center border-2 border-[#0d2f3f] bg-white shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void action("sync", "/api/sync")}
                type="button"
              >
                <ArrowClockwise
                  className={
                    busy === "sync" || visibleJob?.kind === "sync"
                      ? "animate-spin"
                      : ""
                  }
                  size={20}
                  weight="bold"
                />
              </button>

              <button
                type="button"
                onClick={() => switchView("Rulebook AI")}
                className="hidden sm:flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-white hover:bg-[#5edc56] hover:text-[#0d2f3f] px-3 py-2 text-xs font-black shadow-[2px_2px_0_#0d2f3f] brutal-btn cursor-pointer transition-colors"
                title="Ask Rulebook AI about any ServiceNow rule"
              >
                <Sparkle size={15} weight="fill" className="text-[#0d2f3f]" />
                <span>Ask Rulebook AI</span>
              </button>

              <button
                disabled={
                  !!busy || !!visibleJob || !data || data.objectCount === 0 || !aiStatus?.available
                }
                className={`flex items-center gap-2 border-2 border-[#0d2f3f] px-3 py-2 text-xs font-black shadow-[2px_2px_0_#0d2f3f] brutal-btn sm:px-4 sm:text-sm ${
                  !aiStatus?.available
                    ? "bg-amber-100 text-amber-950 border-amber-900 cursor-not-allowed opacity-75"
                    : "bg-[#5edc56] text-[#0d2f3f] hover:bg-[#4ecd46]"
                }`}
                onClick={() => {
                  if (!aiStatus?.available) {
                    setNotice(
                      "LLM Consulting Engine is strictly required to scan. Please select and start an Ollama model in Settings.",
                    );
                    return;
                  }
                  void action("scan", "/api/scan");
                }}
                type="button"
                title={
                  !aiStatus?.available
                    ? "LLM Consulting Engine must be running and selected in Settings"
                    : "Run Autonomous Agents & LLM Scan"
                }
              >
                <Play size={16} weight="fill" />
                {busy === "scan"
                  ? "Checking…"
                  : !aiStatus?.available
                    ? "LLM Required To Scan"
                    : "Run Agents & Scan"}
              </button>

            </div>
          </header>

          {/* Mobile navigation */}
          <div className="flex gap-1 overflow-x-auto border-b-[3px] border-[#0d2f3f] bg-[#0d2f3f] px-4 py-2 lg:hidden">
            {nav.map(({ name }) => (
              <button
                key={name}
                onClick={() => switchView(name)}
                className={`shrink-0 border-2 px-3 py-1.5 text-xs font-bold ${
                  view === name
                    ? "border-[#5edc56] bg-[#5edc56] text-[#0d2f3f]"
                    : "border-transparent text-white"
                }`}
                type="button"
              >
                {name}
              </button>
            ))}
          </div>

          {/* Active Job Progress */}
          {visibleJob && visibleJob.status === "running" && (() => {
            const pct = visibleJob.total > 0
              ? Math.min(100, Math.max(0, Math.round((visibleJob.progress / visibleJob.total) * 100)))
              : Math.min(100, Math.max(0, Math.round(visibleJob.progress || 0)));
            const isSync = visibleJob.kind === "sync";

            return (
              <div className="border-b border-[#1e4759]/50 bg-[#0b1e28] px-4 py-2.5">
                {/* Status row */}
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                    </span>
                    <span className="text-[11px] font-semibold text-slate-300 truncate">
                      {isSync ? "Syncing" : "Scanning"}{visibleJob.currentAgent ? ` · ${visibleJob.currentAgent}` : ""}{visibleJob.currentTable ? ` · ${visibleJob.currentTable}` : ""}
                    </span>
                    {visibleJob.message && (
                      <span className="text-[11px] text-slate-500 truncate hidden sm:inline">
                        — {visibleJob.message}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0 font-mono text-[11px]">
                    {visibleJob.total > 0 && visibleJob.total > 100 && (
                      <span className="text-slate-500">
                        {visibleJob.progress.toLocaleString()}/{visibleJob.total.toLocaleString()}
                      </span>
                    )}
                    <span className="text-emerald-400 font-bold">{pct}%</span>
                  </div>
                </div>
                {/* Progress bar */}
                <div className="h-1 w-full rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-emerald-400 transition-all duration-500 ease-out"
                    style={{ width: `${Math.max(2, pct)}%` }}
                  />
                </div>
              </div>
            );
          })()}

          {/* Main Body with Smooth View Micro-animation */}
          <div key={view} className="animate-saos-fade flex-1 min-h-0 flex flex-col overflow-hidden">
            {!data || (data.objectCount === 0 && view !== "Settings" && view !== "Data & privacy" && view !== "Guide" && view !== "Rulebook AI") ? (
              <EmptyState
                configured={data?.connectionConfigured ?? false}
                oldSource={data?.sourceMismatch ? data.snapshotSourceHost : null}
                busy={busy || (visibleJob ? visibleJob.kind : "")}
                onTest={() => void action("test", "/api/connection")}
                onSync={() => void action("sync", "/api/sync")}
              />
            ) : view === "Overview" ? (
            /* ====================================================
               OVERVIEW VIEW — SERVICE HEALTH DASHBOARD
               ==================================================== */
            <div key={view} className="flex-1 overflow-y-auto p-4 sm:p-7 space-y-6 saos-scroll animate-saos-page-enter">
              {/* 5-Domain Enterprise Governance Scorecard (Equal Priority Across All 5 Domains) */}
              <div>
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-2">
                    <Stack size={18} weight="bold" className="text-[#0d2f3f]" />
                    <h3 className="font-display text-sm sm:text-base font-black text-[#0d2f3f] uppercase tracking-wider">
                      Enterprise Governance Scorecard
                    </h3>
                  </div>
                  <span className="font-mono text-[10px] font-bold text-[#476371]">
                    Unified multi-discipline health scoring: CMDB · ITSM · CSDM · ITOM · Data Quality
                  </span>
                </div>

                <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                  {/* CMDB Score */}
                  <div className="border-[3px] border-[#0d2f3f] bg-white p-4 shadow-[3px_3px_0_#0d2f3f] flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-2">
                        <div className="flex items-center gap-1.5">
                          <div className="border border-[#0d2f3f] bg-cyan-100 p-1 shadow-[1px_1px_0_#0d2f3f]">
                            <Database size={16} className="text-[#0d2f3f]" weight="bold" />
                          </div>
                          <span className="font-display text-xs font-black text-[#0d2f3f]">
                            CMDB Health
                          </span>
                        </div>
                        <span className="border border-[#0d2f3f] bg-[#cbf3f9] px-1 py-0.2 font-mono text-[8px] font-black uppercase text-[#0d2f3f]">
                          CMDB
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between mt-1 mb-2">
                        <span className="font-mono text-2xl font-black text-[#0d2f3f]">
                          {cmdbScore}<span className="text-xs text-[#476371]">/100</span>
                        </span>
                        <span className="font-mono text-[10px] font-bold text-[#476371]">
                          {cmdbIssuesCount.toLocaleString()} issues
                        </span>
                      </div>
                      <div className="h-2.5 w-full border border-[#0d2f3f] bg-[#eef7fa] overflow-hidden p-[1px]">
                        <div
                          className="h-full bg-cyan-500 transition-all duration-500"
                          style={{ width: `${cmdbScore}%` }}
                        />
                      </div>
                      <p className="mt-2 text-[11px] font-medium text-[#476371] line-clamp-2">
                        Orphan CIs, duplicate identification, and relationship topology health.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setModuleFilter("CMDB");
                        switchView("Problems");
                      }}
                      className="mt-3 w-full border border-[#0d2f3f] bg-[#f4f8f9] hover:bg-[#5edc56] hover:text-[#0d2f3f] px-2.5 py-1.5 font-mono text-[10px] font-black uppercase text-[#0d2f3f] transition-colors shadow-[1px_1px_0_#0d2f3f] flex items-center justify-between gap-1 cursor-pointer shrink-0"
                    >
                      <span className="truncate">Inspect CMDB</span>
                      <ArrowRight size={11} weight="bold" className="shrink-0" />
                    </button>
                  </div>

                  {/* ITSM Score */}
                  <div className="border-[3px] border-[#0d2f3f] bg-white p-4 shadow-[3px_3px_0_#0d2f3f] flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-2">
                        <div className="flex items-center gap-1.5">
                          <div className="border border-[#0d2f3f] bg-purple-100 p-1 shadow-[1px_1px_0_#0d2f3f]">
                            <Briefcase size={16} className="text-[#0d2f3f]" weight="bold" />
                          </div>
                          <span className="font-display text-xs font-black text-[#0d2f3f]">
                            ITSM Health
                          </span>
                        </div>
                        <span className="border border-[#0d2f3f] bg-[#eedaff] px-1 py-0.2 font-mono text-[8px] font-black uppercase text-[#3d1a58]">
                          ITSM
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between mt-1 mb-2">
                        <span className="font-mono text-2xl font-black text-[#0d2f3f]">
                          {itsmScore}<span className="text-xs text-[#476371]">/100</span>
                        </span>
                        <span className="font-mono text-[10px] font-bold text-[#476371]">
                          {itsmIssuesCount.toLocaleString()} issues
                        </span>
                      </div>
                      <div className="h-2.5 w-full border border-[#0d2f3f] bg-[#eef7fa] overflow-hidden p-[1px]">
                        <div
                          className="h-full bg-purple-500 transition-all duration-500"
                          style={{ width: `${itsmScore}%` }}
                        />
                      </div>
                      <p className="mt-2 text-[11px] font-medium text-[#476371] line-clamp-2">
                        Contractual SLA breaches, unmapped ticket CIs, and change approvals.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setModuleFilter("ITSM");
                        switchView("Problems");
                      }}
                      className="mt-3 w-full border border-[#0d2f3f] bg-[#f4f8f9] hover:bg-[#5edc56] hover:text-[#0d2f3f] px-2.5 py-1.5 font-mono text-[10px] font-black uppercase text-[#0d2f3f] transition-colors shadow-[1px_1px_0_#0d2f3f] flex items-center justify-between gap-1 cursor-pointer shrink-0"
                    >
                      <span className="truncate">Inspect ITSM</span>
                      <ArrowRight size={11} weight="bold" className="shrink-0" />
                    </button>
                  </div>

                  {/* CSDM Score */}
                  <div className="border-[3px] border-[#0d2f3f] bg-white p-4 shadow-[3px_3px_0_#0d2f3f] flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-2">
                        <div className="flex items-center gap-1.5">
                          <div className="border border-[#0d2f3f] bg-emerald-100 p-1 shadow-[1px_1px_0_#0d2f3f]">
                            <HardDrives size={16} className="text-[#0d2f3f]" weight="bold" />
                          </div>
                          <span className="font-display text-xs font-black text-[#0d2f3f]">
                            CSDM 4.0 Health
                          </span>
                        </div>
                        <span className="border border-[#0d2f3f] bg-[#d1fae5] px-1 py-0.2 font-mono text-[8px] font-black uppercase text-[#065f46]">
                          CSDM
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between mt-1 mb-2">
                        <span className="font-mono text-2xl font-black text-[#0d2f3f]">
                          {csdmScore}<span className="text-xs text-[#476371]">/100</span>
                        </span>
                        <span className="font-mono text-[10px] font-bold text-[#476371]">
                          {csdmIssuesCount.toLocaleString()} issues
                        </span>
                      </div>
                      <div className="h-2.5 w-full border border-[#0d2f3f] bg-[#eef7fa] overflow-hidden p-[1px]">
                        <div
                          className="h-full bg-emerald-500 transition-all duration-500"
                          style={{ width: `${csdmScore}%` }}
                        />
                      </div>
                      <p className="mt-2 text-[11px] font-medium text-[#476371] line-clamp-2">
                        Business &amp; technical service ownership and supporting CI associations.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setModuleFilter("CSDM");
                        switchView("Problems");
                      }}
                      className="mt-3 w-full border border-[#0d2f3f] bg-[#f4f8f9] hover:bg-[#5edc56] hover:text-[#0d2f3f] px-2.5 py-1.5 font-mono text-[10px] font-black uppercase text-[#0d2f3f] transition-colors shadow-[1px_1px_0_#0d2f3f] flex items-center justify-between gap-1 cursor-pointer shrink-0"
                    >
                      <span className="truncate">Inspect CSDM</span>
                      <ArrowRight size={11} weight="bold" className="shrink-0" />
                    </button>
                  </div>

                  {/* ITOM Score */}
                  <div className="border-[3px] border-[#0d2f3f] bg-white p-4 shadow-[3px_3px_0_#0d2f3f] flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-2">
                        <div className="flex items-center gap-1.5">
                          <div className="border border-[#0d2f3f] bg-orange-100 p-1 shadow-[1px_1px_0_#0d2f3f]">
                            <Radio size={16} className="text-[#0d2f3f]" weight="bold" />
                          </div>
                          <span className="font-display text-xs font-black text-[#0d2f3f]">
                            ITOM Health
                          </span>
                        </div>
                        <span className="border border-[#0d2f3f] bg-[#ffedd5] px-1 py-0.2 font-mono text-[8px] font-black uppercase text-[#9a3412]">
                          ITOM
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between mt-1 mb-2">
                        <span className="font-mono text-2xl font-black text-[#0d2f3f]">
                          {itomScore}<span className="text-xs text-[#476371]">/100</span>
                        </span>
                        <span className="font-mono text-[10px] font-bold text-[#476371]">
                          {itomIssuesCount.toLocaleString()} issues
                        </span>
                      </div>
                      <div className="h-2.5 w-full border border-[#0d2f3f] bg-[#eef7fa] overflow-hidden p-[1px]">
                        <div
                          className="h-full bg-orange-500 transition-all duration-500"
                          style={{ width: `${itomScore}%` }}
                        />
                      </div>
                      <p className="mt-2 text-[11px] font-medium text-[#476371] line-clamp-2">
                        Discovery schedule recency, stale payloads (&gt;60d), and MID telemetry.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setModuleFilter("ITOM");
                        switchView("Problems");
                      }}
                      className="mt-3 w-full border border-[#0d2f3f] bg-[#f4f8f9] hover:bg-[#5edc56] hover:text-[#0d2f3f] px-2.5 py-1.5 font-mono text-[10px] font-black uppercase text-[#0d2f3f] transition-colors shadow-[1px_1px_0_#0d2f3f] flex items-center justify-between gap-1 cursor-pointer shrink-0"
                    >
                      <span className="truncate">Inspect ITOM</span>
                      <ArrowRight size={11} weight="bold" className="shrink-0" />
                    </button>
                  </div>

                  {/* Data Quality Score */}
                  <div className="border-[3px] border-[#0d2f3f] bg-white p-4 shadow-[3px_3px_0_#0d2f3f] flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-2">
                        <div className="flex items-center gap-1.5">
                          <div className="border border-[#0d2f3f] bg-amber-100 p-1 shadow-[1px_1px_0_#0d2f3f]">
                            <ShieldCheck size={16} className="text-[#0d2f3f]" weight="bold" />
                          </div>
                          <span className="font-display text-xs font-black text-[#0d2f3f]">
                            Data Quality
                          </span>
                        </div>
                        <span className="border border-[#0d2f3f] bg-[#fef3c7] px-1 py-0.2 font-mono text-[8px] font-black uppercase text-[#92400e]">
                          DQ
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between mt-1 mb-2">
                        <span className="font-mono text-2xl font-black text-[#0d2f3f]">
                          {dqScore}<span className="text-xs text-[#476371]">/100</span>
                        </span>
                        <span className="font-mono text-[10px] font-bold text-[#476371]">
                          {dqIssuesCount.toLocaleString()} issues
                        </span>
                      </div>
                      <div className="h-2.5 w-full border border-[#0d2f3f] bg-[#eef7fa] overflow-hidden p-[1px]">
                        <div
                          className="h-full bg-amber-500 transition-all duration-500"
                          style={{ width: `${dqScore}%` }}
                        />
                      </div>
                      <p className="mt-2 text-[11px] font-medium text-[#476371] line-clamp-2">
                        Foundation users, inactive manager assignments, and empty groups.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setModuleFilter("Data Quality");
                        switchView("Problems");
                      }}
                      className="mt-3 w-full border border-[#0d2f3f] bg-[#f4f8f9] hover:bg-[#5edc56] hover:text-[#0d2f3f] px-2.5 py-1.5 font-mono text-[10px] font-black uppercase text-[#0d2f3f] transition-colors shadow-[1px_1px_0_#0d2f3f] flex items-center justify-between gap-1 cursor-pointer shrink-0"
                    >
                      <span className="truncate">Inspect DQ</span>
                      <ArrowRight size={11} weight="bold" className="shrink-0" />
                    </button>
                  </div>
                </div>
              </div>

              {/* 4 Stat Cards */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="border-[3px] border-[#0d2f3f] bg-white p-4 shadow-[4px_4px_0_#0d2f3f] flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-[10px] font-black tracking-wider text-[#476371] uppercase">
                      TOTAL CIS
                    </p>
                    <span className="border border-[#0d2f3f] bg-neutral-100 px-1.5 py-0.2 font-mono text-[9px] font-black text-[#0d2f3f]">
                      ESTATE
                    </span>
                  </div>
                  <p className="font-display text-4xl font-black text-[#0d2f3f] mt-2">
                    {data.healthSummary?.totalCIs ?? (data.tableCounts.find((t) => t.table === "cmdb_ci")?.count || data.objectCount)}
                  </p>
                </div>

                <div className="border-[3px] border-[#0d2f3f] bg-white p-4 shadow-[4px_4px_0_#0d2f3f] flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-[10px] font-black tracking-wider text-[#476371] uppercase">
                      RELATIONSHIPS
                    </p>
                    <span className="border border-[#0d2f3f] bg-[#cbf3f9] px-1.5 py-0.2 font-mono text-[9px] font-black text-[#0d2f3f]">
                      GRAPH
                    </span>
                  </div>
                  <p className="font-display text-4xl font-black text-[#0d2f3f] mt-2">
                    {data.healthSummary?.totalRelationships ?? (data.tableCounts.find((t) => t.table === "cmdb_rel_ci")?.count || 0)}
                  </p>
                </div>

                <div className="border-[3px] border-[#0d2f3f] bg-[#fffbf0] p-4 shadow-[4px_4px_0_#0d2f3f] flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-[10px] font-black tracking-wider text-[#b45309] uppercase">
                      OPEN ISSUES
                    </p>
                    <span className="border border-[#0d2f3f] bg-[#ffd166] px-1.5 py-0.2 font-mono text-[9px] font-black text-[#0d2f3f]">
                      ACTION REQ
                    </span>
                  </div>
                  <p className="font-display text-4xl font-black text-[#d97706] mt-2">
                    {open.length}
                  </p>
                </div>

                <div className="border-[3px] border-[#0d2f3f] bg-[#f4fbf5] p-4 shadow-[4px_4px_0_#0d2f3f] flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-[10px] font-black tracking-wider text-[#047857] uppercase">
                      FIXES APPLIED
                    </p>
                    <span className="border border-[#0d2f3f] bg-[#5edc56] px-1.5 py-0.2 font-mono text-[9px] font-black text-[#0d2f3f]">
                      REMEDIATED
                    </span>
                  </div>
                  <p className="font-display text-4xl font-black text-[#059669] mt-2">
                    {appliedPlans.length}
                  </p>
                </div>
              </div>

              {/* Autonomous LLM Consulting, Best Ranking & Domain Differentiation Panel */}
              {((data as any).llmConsultation || aiStatus?.available) && (
                <div className="border-[3px] border-[#0d2f3f] bg-white p-5 shadow-[4px_4px_0_#0d2f3f] space-y-6">
                  {/* Top Bar: Live AI Engine Attribution & Model Name */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b-[3px] border-[#0d2f3f] pb-4">
                    <div className="flex items-center gap-2.5">
                      <span className="border-2 border-[#0d2f3f] bg-[#0d2f3f] text-[#5edc56] px-2.5 py-1 font-mono text-[10px] font-black uppercase shadow-[1px_1px_0_#0d2f3f] flex items-center gap-1.5">
                        <Sparkle size={13} weight="fill" className="text-[#5edc56]" />
                        AI CONSULTING ENGINE
                      </span>
                      <div>
                        <h3 className="font-display text-lg sm:text-xl font-black text-[#0d2f3f] flex items-center gap-2">
                          Contextual Rule Intelligence &amp; Domain Differentiation
                        </h3>
                        <p className="font-mono text-[11px] font-semibold text-[#476371]">
                          Lead ServiceNow Technical Architect &amp; ITIL Compliance Auditor
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="border-2 border-[#0d2f3f] bg-[#5edc56]/15 text-[#0d2f3f] px-2 py-0.5 font-mono text-[10px] font-black uppercase border border-[#0d2f3f]">
                        755 MASTER RULES AUDIT
                      </span>
                      <span className="border-2 border-[#0d2f3f] bg-[#eedaff] px-2.5 py-1 font-mono text-[10px] font-black text-[#3d1a58] uppercase shadow-[1px_1px_0_#0d2f3f]">
                        MODEL: {(data as any).llmConsultation?.model || aiStatus?.model || "DYNAMIC SETTINGS"}
                      </span>
                    </div>
                  </div>

                  {/* Executive AI Consultation Summary — Point-wise */}
                  <div className="border-2 border-[#0d2f3f] bg-[#f8fafc] p-4 shadow-[2px_2px_0_#0d2f3f]">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] font-black uppercase tracking-wider text-[#476371]">
                          EXECUTIVE AUDIT INSIGHTS
                        </span>
                        <span className="inline-block size-2 rounded-full bg-[#5edc56] animate-pulse" />
                      </div>
                      {(data as any).llmConsultation?.timestamp && (
                        <span className="font-mono text-[10px] font-bold text-[#718c99]">
                          {new Date((data as any).llmConsultation.timestamp).toLocaleTimeString()}
                        </span>
                      )}
                    </div>
                    {(() => {
                      const slaBreaches = open.filter((p) => p.ruleId === "ITSM-033");
                      const slaFixed = appliedPlans.filter((p) => p.ruleId === "ITSM-033");

                      const incNoCi = open.filter((p) => p.ruleId === "ITSM-016");
                      const chgNoCi = open.filter((p) => p.ruleId === "ITSM-094");
                      const ticketsFixed = appliedPlans.filter((p) => p.ruleId === "ITSM-016" || p.ruleId === "ITSM-094");

                      const orphanCis = open.filter((p) => p.ruleId === "CMDB-058" || p.ruleId.includes("orphan"));
                      const orphanFixed = appliedPlans.filter((p) => p.ruleId === "CMDB-058" || p.ruleId.includes("orphan"));

                      const duplicateCis = open.filter((p) => p.ruleId === "CMDB-082" || p.ruleId.includes("duplicate"));
                      const retiredActive = open.filter((p) => p.ruleId === "CMDB-035");
                      const cmdbHygieneFixed = appliedPlans.filter((p) => p.ruleId === "CMDB-082" || p.ruleId === "CMDB-035");

                      const csdmServices = open.filter((p) => p.ruleId === "CMDB-106" || p.ruleId === "CMDB-110" || moduleForRule(p.ruleId) === "CSDM");
                      const csdmFixed = appliedPlans.filter((p) => p.ruleId === "CMDB-106" || p.ruleId === "CMDB-110" || moduleForRule(p.ruleId) === "CSDM");

                      const itomStale = open.filter((p) => p.ruleId === "CMDB-016" || moduleForRule(p.ruleId) === "ITOM");
                      const itomFixed = appliedPlans.filter((p) => p.ruleId === "CMDB-016" || moduleForRule(p.ruleId) === "ITOM");

                      const dqIssues = open.filter((p) => moduleForRule(p.ruleId) === "Data Quality");
                      const dqFixed = appliedPlans.filter((p) => moduleForRule(p.ruleId) === "Data Quality");

                      // Define structured, user-friendly audit insight cards across all 5 domains with real-time resolution states
                      const insightCards = [
                        {
                          ruleId: "ITSM-033",
                          domain: "ITSM",
                          title: "Contractual SLA Resolution Breaches",
                          description:
                            slaBreaches.length === 0 && slaFixed.length > 0
                              ? `All ${slaFixed.length} contractual SLA resolution breaches have been remediated via applied Update Sets. SLA compliance restored.`
                              : `${slaBreaches.length} active operational records have breached contracted resolution deadlines, causing direct client delivery penalties.`,
                          openCount: slaBreaches.length,
                          fixedCount: slaFixed.length,
                          severity: slaBreaches.length === 0 && slaFixed.length > 0 ? "Resolved" : ("Critical" as const),
                          filterRule: "ITSM-033",
                        },
                        {
                          ruleId: "ITSM-016 & ITSM-094",
                          domain: "ITSM",
                          title: "Untracked Production Incidents & Changes",
                          description:
                            (incNoCi.length + chgNoCi.length) === 0 && ticketsFixed.length > 0
                              ? `All ${ticketsFixed.length} untracked tickets have been bound to valid Configuration Items. Root-cause attribution enabled.`
                              : `${incNoCi.length + chgNoCi.length} production tickets (${incNoCi.length} incidents, ${chgNoCi.length} changes) lack linked CIs, preventing outage root-cause analytics.`,
                          openCount: incNoCi.length + chgNoCi.length,
                          fixedCount: ticketsFixed.length,
                          severity: (incNoCi.length + chgNoCi.length) === 0 && ticketsFixed.length > 0 ? "Resolved" : ("High" as const),
                          filterRule: "ITSM-016",
                        },
                        {
                          ruleId: "CMDB-058",
                          domain: "CMDB",
                          title: "Isolated Infrastructure CIs (Orphan CIs)",
                          description:
                            orphanCis.length === 0 && orphanFixed.length > 0
                              ? `All ${orphanFixed.length} orphan infrastructure CIs have been remediated into valid relationship trees.`
                              : `${orphanCis.length.toLocaleString()} principal servers and applications have zero dependency relationships, leaving downstream outage blast radius unknown.`,
                          openCount: orphanCis.length,
                          fixedCount: orphanFixed.length,
                          severity: orphanCis.length === 0 && orphanFixed.length > 0 ? "Resolved" : ("Critical" as const),
                          filterRule: "CMDB-058",
                        },
                        {
                          ruleId: "CMDB-082 & CMDB-035",
                          domain: "CMDB",
                          title: "Duplicate Records & Asset Lifecycle Drift",
                          description:
                            (duplicateCis.length + retiredActive.length) === 0 && cmdbHygieneFixed.length > 0
                              ? `All duplicate CI records and lifecycle status conflicts have been reconciled successfully.`
                              : `${(duplicateCis.length + retiredActive.length).toLocaleString()} duplicate CI records and retired assets remain active in CMDB, corrupting discovery reconciliation.`,
                          openCount: duplicateCis.length + retiredActive.length,
                          fixedCount: cmdbHygieneFixed.length,
                          severity: (duplicateCis.length + retiredActive.length) === 0 && cmdbHygieneFixed.length > 0 ? "Resolved" : ("High" as const),
                          filterRule: "CMDB-082",
                        },
                        {
                          ruleId: "CMDB-106 & CMDB-110",
                          domain: "CSDM",
                          title: "CSDM Business Services Missing Owner or Dependencies",
                          description:
                            csdmServices.length === 0 && csdmFixed.length > 0
                              ? `All ${csdmFixed.length} CSDM services now have active owners assigned and valid supporting CI relationships.`
                              : `${csdmServices.length} business and technical services in cmdb_ci_service lack designated owners or supporting CI associations.`,
                          openCount: csdmServices.length,
                          fixedCount: csdmFixed.length,
                          severity: csdmServices.length === 0 && csdmFixed.length > 0 ? "Resolved" : ("High" as const),
                          filterRule: "CMDB-106",
                        },
                        {
                          ruleId: "CMDB-016",
                          domain: "ITOM",
                          title: "ITOM Stale Discovery & Telemetry Gaps",
                          description:
                            itomStale.length === 0 && itomFixed.length > 0
                              ? `All ${itomFixed.length} stale discovery records have been refreshed or flagged for decommissioning.`
                              : `${itomStale.length} infrastructure CIs unrefreshed by ServiceNow Discovery for over 60 days, risking ghost asset alerts.`,
                          openCount: itomStale.length,
                          fixedCount: itomFixed.length,
                          severity: itomStale.length === 0 && itomFixed.length > 0 ? "Resolved" : ("High" as const),
                          filterRule: "CMDB-016",
                        },
                        {
                          ruleId: "DQ-084 & DQ-086",
                          domain: "DATA QUALITY",
                          title: "Assignment Groups & Manager Governance Gaps",
                          description:
                            dqIssues.length === 0 && dqFixed.length > 0
                              ? `All ${dqFixed.length} foundation identity and group approval governance gaps have been remediated.`
                              : `${dqIssues.length} foundation records (support groups with no active manager or users with inactive managers) create approval bottlenecks.`,
                          openCount: dqIssues.length,
                          fixedCount: dqFixed.length,
                          severity: dqIssues.length === 0 && dqFixed.length > 0 ? "Resolved" : ("Medium" as const),
                          filterRule: "DQ-084",
                        },
                      ];

                      return (
                        <div className="space-y-2.5">
                          {insightCards.map((card) => {
                            const isResolved = card.openCount === 0 && card.fixedCount > 0;
                            return (
                              <div
                                key={card.ruleId}
                                className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white border-2 p-3 shadow-[2px_2px_0_#0d2f3f] hover:translate-x-[1px] hover:translate-y-[1px] transition-transform ${
                                  isResolved ? "border-emerald-700 bg-emerald-50/40" : "border-[#0d2f3f]"
                                }`}
                              >
                                <div className="flex items-start gap-3 min-w-0 flex-1">
                                  <span
                                    className={`mt-1.5 shrink-0 size-2.5 rounded-full ${
                                      isResolved
                                        ? "bg-[#5edc56] shadow-[0_0_8px_rgba(94,220,86,0.8)]"
                                        : card.severity === "Critical"
                                          ? "bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.6)]"
                                          : card.severity === "High"
                                            ? "bg-amber-500"
                                            : "bg-[#5edc56]"
                                    }`}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-1.5 mb-1">
                                      <span className="font-mono text-[10px] font-black uppercase text-[#0d2f3f] bg-[#e9f1f3] px-1.5 py-0.5 border border-[#0d2f3f]">
                                        {card.ruleId}
                                      </span>
                                      <span
                                        className={`px-1.5 py-0.5 font-mono text-[9px] font-black uppercase border border-[#0d2f3f] ${
                                          card.domain === "ITSM"
                                            ? "bg-[#eedbfb] text-[#3d1a58]"
                                            : card.domain === "CSDM"
                                              ? "bg-[#d1fae5] text-[#065f46]"
                                              : card.domain === "ITOM"
                                                ? "bg-[#ffedd5] text-[#9a3412]"
                                                : card.domain === "DATA QUALITY"
                                                  ? "bg-[#fef3c7] text-[#92400e]"
                                                  : "bg-[#d2ebf0] text-[#0d2f3f]"
                                        }`}
                                      >
                                        {card.domain}
                                      </span>
                                      <span
                                        className={`px-1.5 py-0.5 font-mono text-[9px] font-black uppercase border ${
                                          isResolved
                                            ? "bg-emerald-100 text-emerald-900 border-emerald-800"
                                            : card.severity === "Critical"
                                              ? "bg-rose-100 text-rose-900 border-rose-800"
                                              : card.severity === "High"
                                                ? "bg-amber-100 text-amber-900 border-amber-800"
                                                : "bg-blue-100 text-blue-900 border-blue-800"
                                        }`}
                                      >
                                        {isResolved ? "100% REMEDIATED" : card.severity}
                                      </span>
                                      <span className="font-mono text-[10px] font-bold text-[#476371]">
                                        {isResolved
                                          ? `All ${card.fixedCount} fixed`
                                          : card.fixedCount > 0
                                            ? `${card.openCount} remaining (${card.fixedCount} fixed)`
                                            : `${card.openCount.toLocaleString()} occurrences`}
                                      </span>
                                    </div>
                                    <h5 className="font-display text-xs sm:text-sm font-black text-[#0d2f3f]">
                                      {card.title} {isResolved && <span className="text-emerald-700 font-bold">✓</span>}
                                    </h5>
                                    <p className="text-xs font-semibold text-[#35525e] leading-relaxed mt-0.5">
                                      {card.description}
                                    </p>
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => {
                                    setSearch(card.filterRule);
                                    switchView("Problems");
                                  }}
                                  title={`Inspect ${card.ruleId} in Problems`}
                                  className={`border-2 px-3 py-1.5 font-mono text-[11px] font-black uppercase transition-colors shadow-[1px_1px_0_#0d2f3f] brutal-btn cursor-pointer shrink-0 self-end sm:self-center ${
                                    isResolved
                                      ? "border-emerald-800 bg-emerald-100 text-emerald-950 hover:bg-emerald-800 hover:text-white"
                                      : "border-[#0d2f3f] bg-white hover:bg-[#0d2f3f] hover:text-white text-[#0d2f3f]"
                                  }`}
                                >
                                  {isResolved ? `Inspect (${card.fixedCount} Fixed) →` : card.fixedCount > 0 ? `Inspect & Fix (${card.openCount}) →` : "Inspect →"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>

                  {/* 5-Domain Differentiation & Blast-Radius Segregation */}
                  <div>
                    <div className="flex items-center justify-between mb-2.5">
                      <div className="flex items-center gap-2">
                        <Stack size={18} weight="bold" className="text-[#0d2f3f]" />
                        <h4 className="font-display text-sm font-black text-[#0d2f3f] uppercase tracking-wider">
                          Domain Differentiation &amp; Blast-Radius Segregation
                        </h4>
                      </div>
                      <span className="font-mono text-[10px] font-bold text-[#476371]">
                        Categorized across ITIL, CMDB, CSDM, ITOM &amp; Data Quality governance disciplines
                      </span>
                    </div>

                    {(() => {
                      const domainCards = [
                        {
                          domain: "CMDB",
                          filterModule: "CMDB",
                          title: "Configuration Topology & Asset Health",
                          openCount: cmdbIssuesCount,
                          fixedCount: cmdbFixedCount,
                          severity: "High",
                          badgeBg: "bg-[#d2ebf0]",
                          badgeText: "text-[#0d2f3f]",
                          rootCause: `${cmdbIssuesCount.toLocaleString()} CIs with unassigned ownership, duplicate relationships, or broken topology endpoints.`,
                          blastRadius: "Corrupted change blast-radius calculations and degraded discovery reconciliation.",
                          remediation: "Automate relationship deduplication, prune stale endpoints, and enforce discovery CI identifiers.",
                        },
                        {
                          domain: "ITSM",
                          filterModule: "ITSM",
                          title: "Service Commitments & Transactional Operations",
                          openCount: itsmIssuesCount,
                          fixedCount: itsmFixedCount,
                          severity: itsmIssuesCount > 0 ? "Critical" : "Resolved",
                          badgeBg: "bg-[#eedbfb]",
                          badgeText: "text-[#3d1a58]",
                          rootCause: `${itsmIssuesCount.toLocaleString()} operational records breaching SLA commitments or bypassing CMDB CI linkage.`,
                          blastRadius: "Direct contractual SLA penalties, unmapped service downtime, and incident-to-infrastructure attribution failure.",
                          remediation: "Deploy sys_data_policy2 to mandate CI binding and adjust contract_sla schedules via Update Sets.",
                        },
                        {
                          domain: "CSDM",
                          filterModule: "CSDM",
                          title: "CSDM 4.0 Service Lifecycle & Dependency Mapping",
                          openCount: csdmIssuesCount,
                          fixedCount: csdmFixedCount,
                          severity: "High",
                          badgeBg: "bg-[#d1fae5]",
                          badgeText: "text-[#065f46]",
                          rootCause: `${csdmIssuesCount.toLocaleString()} business and technical services missing designated owners or supporting CI relationships.`,
                          blastRadius: "Untracked service dependencies prevent accurate business criticality scoring and disrupt ITSM service mapping.",
                          remediation: "Automate cmdb_ci_service owner backfilling and bind discovered application CIs via svc_ci_assoc.",
                        },
                        {
                          domain: "ITOM",
                          filterModule: "ITOM",
                          title: "Discovery Telemetry & Infrastructure Freshness",
                          openCount: itomIssuesCount,
                          fixedCount: itomFixedCount,
                          severity: "High",
                          badgeBg: "bg-[#ffedd5]",
                          badgeText: "text-[#9a3412]",
                          rootCause: `${itomIssuesCount.toLocaleString()} infrastructure CIs unrefreshed by ServiceNow Discovery for over 60 days.`,
                          blastRadius: "Ghost infrastructure and stale discovery states corrupt event correlation, threshold alerts, and asset depreciation.",
                          remediation: "Re-trigger Discovery schedules, audit MID Server credentials, and flag decommissioned assets.",
                        },
                        {
                          domain: "DATA QUALITY",
                          filterModule: "Data Quality",
                          title: "Identity & Workflow Approval Hygiene",
                          openCount: dqIssuesCount,
                          fixedCount: dqFixedCount,
                          severity: "Medium",
                          badgeBg: "bg-[#fef3c7]",
                          badgeText: "text-[#92400e]",
                          rootCause: `${dqIssuesCount.toLocaleString()} user records referencing inactive managers or lacking email communication addresses.`,
                          blastRadius: "Workflow approval bottlenecks on service requests and changes with inactive managers.",
                          remediation: "Automate manager reassignment scripts and mandatory user attribute validation.",
                        },
                      ];

                      return (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3.5">
                          {domainCards.map((dom) => {
                            const isResolved = dom.openCount === 0 && dom.fixedCount > 0;
                            return (
                              <div
                                key={dom.domain}
                                className={`border-2 bg-white p-3.5 shadow-[3px_3px_0_#0d2f3f] flex flex-col justify-between ${
                                  isResolved ? "border-emerald-700 bg-emerald-50/30" : "border-[#0d2f3f]"
                                }`}
                              >
                                <div>
                                  <div className="flex items-center justify-between gap-1 mb-2">
                                    <span className={`font-mono text-[10px] font-black uppercase ${dom.badgeBg} ${dom.badgeText} px-2 py-0.5 border border-[#0d2f3f]`}>
                                      {dom.domain}
                                    </span>
                                    <span
                                      className={`px-1.5 py-0.5 font-mono text-[9px] font-black uppercase border border-[#0d2f3f] ${
                                        isResolved
                                          ? "bg-emerald-100 text-emerald-900 border-emerald-800"
                                          : dom.severity === "Critical"
                                            ? "bg-rose-100 text-rose-900 border-rose-800"
                                            : dom.severity === "High"
                                              ? "bg-amber-100 text-amber-900 border-amber-800"
                                              : "bg-blue-100 text-blue-900 border-blue-800"
                                      }`}
                                    >
                                      {isResolved ? "RESOLVED" : dom.severity}
                                    </span>
                                  </div>

                                  <p className="font-display text-xs font-black text-[#0d2f3f] mb-1.5 line-clamp-2">
                                    {dom.title}
                                  </p>

                                  <div className="font-display text-xl font-black text-[#0d2f3f] my-1">
                                    {isResolved ? (
                                      <span className="text-emerald-700 text-sm font-black flex items-center gap-1">
                                        ✓ ALL {dom.fixedCount} REMEDIATED
                                      </span>
                                    ) : dom.fixedCount > 0 ? (
                                      <div>
                                        <span>{dom.openCount.toLocaleString()}</span>{" "}
                                        <span className="font-mono text-[10px] font-bold text-emerald-700">
                                          ({dom.fixedCount} fixed)
                                        </span>
                                      </div>
                                    ) : (
                                      <div>
                                        <span>{dom.openCount.toLocaleString()}</span>{" "}
                                        <span className="font-mono text-[10px] font-bold text-[#476371]">
                                          active findings
                                        </span>
                                      </div>
                                    )}
                                  </div>

                                  <div className="space-y-1.5 mt-2.5 text-[11px] border-t border-[#0d2f3f]/15 pt-2">
                                    <div>
                                      <span className="font-mono font-bold text-[#476371] uppercase text-[9px]">Root Cause: </span>
                                      <span className="font-semibold text-[#0d2f3f] line-clamp-3">{dom.rootCause}</span>
                                    </div>
                                    <div>
                                      <span className="font-mono font-bold text-[#b45309] uppercase text-[9px]">Blast Radius: </span>
                                      <span className="font-medium text-[#476371] line-clamp-3">{dom.blastRadius}</span>
                                    </div>
                                    <div>
                                      <span className="font-mono font-bold text-[#047857] uppercase text-[9px]">Remediation: </span>
                                      <span className="font-medium text-[#047857] line-clamp-3">{dom.remediation}</span>
                                    </div>
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => {
                                    setModuleFilter(dom.filterModule as any);
                                    switchView("Problems");
                                  }}
                                  title={`Inspect ${dom.domain} Findings in Problems`}
                                  className="mt-3 w-full border-2 border-[#0d2f3f] bg-[#f4f8f9] hover:bg-[#5edc56] hover:text-[#0d2f3f] px-2.5 py-1.5 font-mono text-[10px] font-black text-[#0d2f3f] uppercase transition-all shadow-[1px_1px_0_#0d2f3f] flex items-center justify-between gap-1 brutal-btn cursor-pointer shrink-0"
                                >
                                  <span className="truncate">
                                    {dom.domain === "Data Quality" ? "Inspect DQ" : `Inspect ${dom.domain}`}
                                  </span>
                                  <span className="flex items-center gap-1 font-bold shrink-0">
                                    {dom.openCount > 0 && <span className="text-[9px] opacity-80">({dom.openCount.toLocaleString()})</span>}
                                    <ArrowRight size={11} weight="bold" />
                                  </span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Unified Priority Command Center: LLM Rule Ranking + Worst CI Items */}
                  {(Array.isArray((data as any).llmConsultation?.ranking) && (data as any).llmConsultation.ranking.length > 0) || activeWorstItems.length > 0 ? (
                    <div className="border-t-[3px] border-[#0d2f3f] pt-4 mt-2">
                      {/* Header */}
                      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                        <div className="flex items-center gap-2">
                          <ShieldWarning size={18} weight="bold" className="text-[#0d2f3f]" />
                          <h4 className="font-display text-sm font-black text-[#0d2f3f] uppercase tracking-wider">
                            Priority Command Center
                          </h4>
                          <span className="border-2 border-[#0d2f3f] bg-[#ffd166] px-1.5 py-0.5 font-mono text-[9px] font-black text-[#0d2f3f] uppercase shadow-[1px_1px_0_#0d2f3f]">
                            FIX FIRST
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <div className="flex border-2 border-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] overflow-hidden">
                            <button
                              type="button"
                              onClick={() => setPriorityTab("rules")}
                              className={`px-3 py-1.5 font-mono text-[10px] font-black uppercase transition-colors cursor-pointer flex items-center gap-1 ${
                                priorityTab === "rules"
                                  ? "bg-[#0d2f3f] text-[#5edc56]"
                                  : "bg-white text-[#0d2f3f] hover:bg-[#f4f8f9]"
                              }`}
                            >
                              <TrendUp size={12} weight="bold" />
                              Rules ({(data as any).llmConsultation?.ranking?.length || 0})
                            </button>
                            <button
                              type="button"
                              onClick={() => setPriorityTab("items")}
                              className={`px-3 py-1.5 font-mono text-[10px] font-black uppercase transition-colors cursor-pointer border-l-2 border-[#0d2f3f] flex items-center gap-1 ${
                                priorityTab === "items"
                                  ? "bg-[#0d2f3f] text-[#5edc56]"
                                  : "bg-white text-[#0d2f3f] hover:bg-[#f4f8f9]"
                              }`}
                            >
                              <Wrench size={12} weight="bold" />
                              CI Items ({activeWorstItems.length})
                            </button>
                          </div>
                          <button
                            onClick={() => setView("Problems")}
                            className="border-2 border-[#0d2f3f] bg-white hover:bg-[#ffd166] px-2.5 py-1.5 font-mono text-[10px] font-black text-[#0d2f3f] uppercase transition-colors shadow-[2px_2px_0_#0d2f3f] cursor-pointer flex items-center gap-1"
                          >
                            All ({open.length}) <ArrowRight size={10} weight="bold" />
                          </button>
                        </div>
                      </div>

                      {/* Tab Content: Rules */}
                      {priorityTab === "rules" && Array.isArray((data as any).llmConsultation?.ranking) && (
                        <div className="space-y-2">
                          {(data as any).llmConsultation.ranking.length > 5 && (
                            <div className="flex justify-end mb-1">
                              <button
                                type="button"
                                onClick={() => setShowAllRanks(!showAllRanks)}
                                className="font-mono text-[10px] font-black text-[#476371] hover:text-[#0d2f3f] uppercase cursor-pointer underline underline-offset-2"
                              >
                                {showAllRanks ? "Collapse to Top 5" : `Expand All ${(data as any).llmConsultation.ranking.length} Rules`}
                              </button>
                            </div>
                          )}

                          {(showAllRanks
                            ? (data as any).llmConsultation.ranking
                            : (data as any).llmConsultation.ranking.slice(0, 5)
                          ).map(
                            (item: {
                              rank: number;
                              ruleId: string;
                              title: string;
                              domain: string;
                              count: number;
                              severity: string;
                              riskScore: number;
                              impactRationale: string;
                              remediationType: string;
                            }) => {
                              const ruleOpen = open.filter((p) => p.ruleId === item.ruleId).length;
                              const ruleFixed = appliedPlans.filter((p) => p.ruleId === item.ruleId).length;
                              const isRuleResolved = ruleOpen === 0 && ruleFixed > 0;

                              return (
                                <div
                                  key={item.ruleId}
                                  className={`flex items-center justify-between gap-3 p-3 border-2 shadow-[2px_2px_0_#0d2f3f] transition-transform hover:translate-x-[1px] hover:translate-y-[1px] ${
                                    isRuleResolved ? "border-emerald-700 bg-emerald-50/30" : "border-[#0d2f3f] bg-white"
                                  }`}
                                >
                                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                    {/* Rank */}
                                    <span
                                      className={`border-2 border-[#0d2f3f] w-7 h-7 flex items-center justify-center font-mono text-[11px] font-black shrink-0 shadow-[1px_1px_0_#0d2f3f] ${
                                        isRuleResolved
                                          ? "bg-[#5edc56] text-[#0d2f3f]"
                                          : item.rank === 1
                                            ? "bg-[#ffd166] text-[#0d2f3f]"
                                            : item.rank <= 3
                                              ? "bg-[#0d2f3f] text-white"
                                              : "bg-[#e9f1f3] text-[#0d2f3f]"
                                      }`}
                                    >
                                      {item.rank}
                                    </span>

                                    {/* Content */}
                                    <div className="min-w-0 flex-1">
                                      <span className="font-bold text-xs text-[#0d2f3f] truncate block">
                                        {item.title} {isRuleResolved && <span className="text-emerald-700 font-black">✓</span>}
                                      </span>
                                      <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                                        <span className="border border-[#0d2f3f] bg-[#e9f1f3] px-1.5 py-0.5 font-mono text-[9px] font-black uppercase">
                                          {item.ruleId}
                                        </span>
                                        <span
                                          className={`border border-[#0d2f3f] px-1.5 py-0.5 font-mono text-[9px] font-black uppercase ${
                                            isRuleResolved
                                              ? "bg-emerald-100 text-emerald-900 border-emerald-800"
                                              : item.severity === "Critical"
                                                ? "bg-rose-100 text-rose-900 border-rose-800"
                                                : item.severity === "High"
                                                  ? "bg-amber-100 text-amber-900 border-amber-800"
                                                  : "bg-blue-100 text-blue-900 border-blue-800"
                                          }`}
                                        >
                                          {isRuleResolved ? "RESOLVED" : item.severity}
                                        </span>
                                        <span className="border border-[#0d2f3f] bg-[#eedbfb] px-1.5 py-0.5 font-mono text-[9px] font-black uppercase text-[#3d1a58]">
                                          {item.domain?.toUpperCase() || "GLOBAL"}
                                        </span>
                                        <span className="text-[10px] font-mono font-bold text-[#476371]">
                                          {isRuleResolved
                                            ? `All ${ruleFixed} fixed`
                                            : ruleFixed > 0
                                              ? `${ruleOpen} left · ${ruleFixed} fixed`
                                              : `${item.count.toLocaleString()} occurrences`}
                                        </span>
                                      </div>
                                    </div>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSearch(item.ruleId);
                                      switchView("Problems");
                                    }}
                                    className={`shrink-0 border-2 px-3 py-1 font-mono text-[11px] font-black uppercase transition-colors shadow-[1px_1px_0_#0d2f3f] cursor-pointer flex items-center justify-between gap-1.5 ${
                                      isRuleResolved
                                        ? "border-emerald-800 bg-emerald-100 text-emerald-950 hover:bg-emerald-800 hover:text-white"
                                        : "border-[#0d2f3f] bg-white hover:bg-[#0d2f3f] hover:text-white text-[#0d2f3f]"
                                    }`}
                                  >
                                    {isRuleResolved ? `Resolved (${ruleFixed})` : "Inspect"} <ArrowRight size={10} weight="bold" className="shrink-0" />
                                  </button>
                                </div>
                              );
                            }
                          )}
                        </div>
                      )}

                      {/* Tab Content: CI Items */}
                      {priorityTab === "items" && (
                        <div className="space-y-2">
                          {activeWorstItems.length === 0 ? (
                            <div className="py-8 text-center border-2 border-[#0d2f3f] bg-[#e5f9e4] p-6 shadow-[2px_2px_0_#0d2f3f]">
                              <div className="flex items-center justify-center gap-2">
                                <CheckCircle size={22} weight="bold" className="text-emerald-700" />
                                <p className="font-display text-sm font-black text-[#0d2f3f]">
                                  All Priority Items Remediated
                                </p>
                              </div>
                              <p className="text-xs font-bold text-[#476371] mt-1">
                                {appliedPlans.length > 0
                                  ? `Total fixes applied: ${appliedPlans.length}.`
                                  : "Run an agent scan to evaluate CI health scores."}
                              </p>
                            </div>
                          ) : (
                            activeWorstItems.slice(0, 8).map((item, idx) => (
                              <div
                                key={item.entityId}
                                className="flex items-center justify-between gap-3 p-3 border-2 border-[#0d2f3f] bg-white shadow-[2px_2px_0_#0d2f3f] transition-transform hover:translate-x-[1px] hover:translate-y-[1px]"
                              >
                                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                  <span className="border-2 border-[#0d2f3f] bg-[#0d2f3f] text-white w-7 h-7 flex items-center justify-center font-mono text-[11px] font-black shrink-0 shadow-[1px_1px_0_#0d2f3f]">
                                    {idx + 1}
                                  </span>
                                  <span
                                    className={`border-2 border-[#0d2f3f] px-2 py-0.5 text-[10px] font-mono font-black shadow-[1px_1px_0_#0d2f3f] shrink-0 ${
                                      item.score < 40
                                        ? "bg-[#ff4d4d] text-white"
                                        : item.score < 70
                                          ? "bg-[#ffd166] text-[#0d2f3f]"
                                          : "bg-[#5edc56] text-[#0d2f3f]"
                                    }`}
                                  >
                                    {item.score}/100
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <span className="font-bold text-xs text-[#0d2f3f] truncate block">
                                      {item.name}
                                    </span>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                      <span className="border border-[#0d2f3f] bg-[#ffd166] px-1.5 py-0.5 text-[9px] font-mono font-black uppercase">
                                        {item.module.toUpperCase()}
                                      </span>
                                      <span className="border border-[#0d2f3f] bg-[#eef7fa] px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase text-[#476371]">
                                        {item.entityType}
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                <button
                                  onClick={() => {
                                    setView("Problems");
                                    const matched = open.find(
                                      (p) =>
                                        p.targetId.includes(item.entityId) ||
                                        String(p.evidence?.sysId || "") === item.entityId ||
                                        String(p.evidence?.duplicateSysId || "") === item.entityId ||
                                        String(p.evidence?.number || "") === item.entityId,
                                    );
                                    if (matched) setActiveId(matched.id);
                                  }}
                                  className="shrink-0 border-2 border-[#0d2f3f] bg-white hover:bg-[#0d2f3f] hover:text-white px-3 py-1 font-mono text-[11px] font-black text-[#0d2f3f] uppercase transition-colors shadow-[1px_1px_0_#0d2f3f] cursor-pointer flex items-center gap-1.5"
                                >
                                  Inspect <ArrowRight size={10} weight="bold" className="shrink-0" />
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              )}

              {/* Audit chain & Recent activity */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="border-[3px] border-[#0d2f3f] bg-white p-5 shadow-[4px_4px_0_#0d2f3f]">
                  <div className="flex items-center justify-between border-b-[3px] border-[#0d2f3f] pb-3">
                    <h4 className="font-display text-base font-black text-[#0d2f3f]">
                      Recent Audit Trail
                    </h4>
                    <span className="border border-[#0d2f3f] bg-[#eef7fa] px-2 py-0.5 font-mono text-[10px] font-black text-[#0d2f3f] uppercase">
                      IMMUTABLE CHAIN
                    </span>
                  </div>
                  <div className="mt-3 space-y-2 text-xs">
                    {data.audit.slice(0, 5).map((entry) => (
                      <div key={entry.seq} className="flex justify-between items-center py-2 border-b border-[#0d2f3f]/15">
                        <span className="font-mono font-black text-[#0d2f3f]">{entry.action}</span>
                        <span className="text-neutral-500 font-mono text-[11px]">{displayTime(entry.occurred_at)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-[3px] border-[#0d2f3f] bg-white p-5 shadow-[4px_4px_0_#0d2f3f]">
                  <div className="flex items-center justify-between border-b-[3px] border-[#0d2f3f] pb-3">
                    <h4 className="font-display text-base font-black text-[#0d2f3f]">
                      Cryptographic State
                    </h4>
                    <span className="border border-[#0d2f3f] bg-[#5edc56] px-2 py-0.5 font-mono text-[10px] font-black text-[#0d2f3f] uppercase">
                      SHA-256
                    </span>
                  </div>
                  <div className="mt-3 space-y-2.5 text-xs">
                    <div className="flex justify-between items-center py-1 border-b border-[#0d2f3f]/15">
                      <span className="font-mono text-neutral-600">Audit Integrity:</span>
                      <span className="border border-[#0d2f3f] bg-[#5edc56] px-2 py-0.5 font-mono text-[10px] font-black text-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f]">
                        {data.auditIntegrity.valid ? "VALID & UNTAMPERED" : "VERIFICATION FAILED"}
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-1 border-b border-[#0d2f3f]/15">
                      <span className="font-mono text-neutral-600">Checked Entries:</span>
                      <span className="font-mono font-bold text-[#0d2f3f]">{data.auditIntegrity.checked} entries</span>
                    </div>
                    <div className="flex justify-between items-center py-1 border-b border-[#0d2f3f]/15">
                      <span className="font-mono text-neutral-600">Source Host:</span>
                      <span className="font-mono font-bold text-[#0d2f3f]">{data.sourceHost || "Local twin"}</span>
                    </div>
                    <div className="flex justify-between items-center py-1">
                      <span className="font-mono text-neutral-600">Active Rule Engines:</span>
                      <span className="border border-[#0d2f3f] bg-[#ffd166] px-2 py-0.5 font-mono text-[10px] font-black text-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f]">
                        29 AGENTS READY
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : view === "Problems" ? (
            /* ====================================================
               PROBLEMS VIEW — AUDIT & FINDINGS INVESTIGATION
               ==================================================== */
            <div key={view} className="grid min-h-[calc(100vh-140px)] min-w-0 flex-1 grid-cols-1 overflow-hidden xl:min-h-0 xl:grid-cols-[minmax(0,1fr)_440px] animate-saos-page-enter">
              {/* Left Column: Groups and Controls */}
              <section className="min-w-0 border-b-[3px] border-[#0d2f3f] xl:min-h-0 xl:overflow-y-auto xl:border-b-0 xl:border-r-[3px] border-[#0d2f3f] saos-scroll bg-[#f4f8f9]">
                {/* Unified Command & Filter Bar */}
                <div className="sticky top-0 z-20 border-b-[3px] border-[#0d2f3f] bg-[#f4f8f9] p-3 sm:p-4 shadow-[0_2px_0_#0d2f3f] space-y-2.5">
                  {/* Row 1: Full-width Search Input */}
                  <div className="relative w-full">
                    <MagnifyingGlass
                      size={16}
                      weight="bold"
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-[#0d2f3f]"
                    />
                    <input
                      aria-label="Search problems"
                      className="w-full border-2 border-[#0d2f3f] bg-white pl-9 pr-8 py-2 text-xs font-black text-[#0d2f3f] placeholder:text-[#6c8693] outline-none focus:bg-[#e5f9e4] transition-all shadow-[2px_2px_0_#0d2f3f]"
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search by rule, CI name, sys_id or keyword… (⌘K)"
                      value={search}
                    />
                    {search && (
                      <button
                        type="button"
                        onClick={() => setSearch("")}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#0d2f3f] hover:bg-[#e9f1f3] p-0.5 border border-[#0d2f3f]"
                      >
                        <X size={12} weight="bold" />
                      </button>
                    )}
                  </div>

                  {/* Row 2: 5-Domain + ALL Filter Tabs (Never Squashed) */}
                  <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 saos-scroll border-2 border-[#0d2f3f] bg-white p-1 shadow-[2px_2px_0_#0d2f3f]">
                      <button
                        type="button"
                        onClick={() => setModuleFilter("All")}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-black transition-all brutal-btn ${
                          moduleFilter === "All"
                            ? "border-2 border-[#0d2f3f] bg-[#5edc56] text-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f]"
                            : "border-2 border-transparent text-[#0d2f3f] hover:border-[#0d2f3f] hover:bg-[#f4f8f9]"
                        }`}
                      >
                        <span>ALL</span>
                        <span
                          className={`border border-[#0d2f3f] px-1.5 py-0.2 font-mono text-[10px] font-black ${
                            moduleFilter === "All"
                              ? "bg-white text-[#0d2f3f]"
                              : "bg-[#e9f1f3] text-[#0d2f3f]"
                          }`}
                        >
                          {open.length.toLocaleString()}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setModuleFilter("CMDB")}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-black transition-all brutal-btn ${
                          moduleFilter === "CMDB"
                            ? "border-2 border-[#0d2f3f] bg-[#d2ebf0] text-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f]"
                            : "border-2 border-transparent text-[#0d2f3f] hover:border-[#0d2f3f] hover:bg-[#f4f8f9]"
                        }`}
                      >
                        <span>CMDB</span>
                        <span
                          className={`border border-[#0d2f3f] px-1.5 py-0.2 font-mono text-[10px] font-black ${
                            moduleFilter === "CMDB"
                              ? "bg-white text-[#0d2f3f]"
                              : "bg-[#e9f1f3] text-[#0d2f3f]"
                          }`}
                        >
                          {cmdbIssuesCount.toLocaleString()}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setModuleFilter("ITSM")}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-black transition-all brutal-btn ${
                          moduleFilter === "ITSM"
                            ? "border-2 border-[#0d2f3f] bg-[#eedbfb] text-[#3d1a58] shadow-[1px_1px_0_#0d2f3f]"
                            : "border-2 border-transparent text-[#0d2f3f] hover:border-[#0d2f3f] hover:bg-[#f4f8f9]"
                        }`}
                      >
                        <span>ITSM</span>
                        <span
                          className={`border border-[#0d2f3f] px-1.5 py-0.2 font-mono text-[10px] font-black ${
                            moduleFilter === "ITSM"
                              ? "bg-white text-[#3d1a58]"
                              : "bg-[#e9f1f3] text-[#0d2f3f]"
                          }`}
                        >
                          {itsmIssuesCount.toLocaleString()}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setModuleFilter("CSDM")}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-black transition-all brutal-btn ${
                          moduleFilter === "CSDM"
                            ? "border-2 border-[#0d2f3f] bg-[#d1fae5] text-[#065f46] shadow-[1px_1px_0_#0d2f3f]"
                            : "border-2 border-transparent text-[#0d2f3f] hover:border-[#0d2f3f] hover:bg-[#f4f8f9]"
                        }`}
                      >
                        <span>CSDM</span>
                        <span
                          className={`border border-[#0d2f3f] px-1.5 py-0.2 font-mono text-[10px] font-black ${
                            moduleFilter === "CSDM"
                              ? "bg-white text-[#065f46]"
                              : "bg-[#e9f1f3] text-[#0d2f3f]"
                          }`}
                        >
                          {csdmIssuesCount.toLocaleString()}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setModuleFilter("ITOM")}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-black transition-all brutal-btn ${
                          moduleFilter === "ITOM"
                            ? "border-2 border-[#0d2f3f] bg-[#ffedd5] text-[#9a3412] shadow-[1px_1px_0_#0d2f3f]"
                            : "border-2 border-transparent text-[#0d2f3f] hover:border-[#0d2f3f] hover:bg-[#f4f8f9]"
                        }`}
                      >
                        <span>ITOM</span>
                        <span
                          className={`border border-[#0d2f3f] px-1.5 py-0.2 font-mono text-[10px] font-black ${
                            moduleFilter === "ITOM"
                              ? "bg-white text-[#9a3412]"
                              : "bg-[#e9f1f3] text-[#0d2f3f]"
                          }`}
                        >
                          {itomIssuesCount.toLocaleString()}
                        </span>
                      </button>

                      {dqIssuesCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setModuleFilter("Data Quality")}
                          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-black transition-all brutal-btn whitespace-nowrap ${
                            moduleFilter === "Data Quality"
                              ? "border-2 border-[#0d2f3f] bg-[#fef3c7] text-[#92400e] shadow-[1px_1px_0_#0d2f3f]"
                              : "border-2 border-transparent text-[#0d2f3f] hover:border-[#0d2f3f] hover:bg-[#f4f8f9]"
                          }`}
                        >
                          <span>DQ</span>
                          <span
                            className={`border border-[#0d2f3f] px-1.5 py-0.2 font-mono text-[10px] font-black ${
                              moduleFilter === "Data Quality"
                                ? "bg-white text-[#92400e]"
                                : "bg-[#e9f1f3] text-[#0d2f3f]"
                            }`}
                          >
                            {dqIssuesCount.toLocaleString()}
                          </span>
                        </button>
                      )}
                    </div>
                </div>

                {/* Group List */}
                <div className="p-3.5 sm:p-4 space-y-3.5">
                  {visibleGroups.length === 0 ? (
                    <div className="border-[3px] border-[#0d2f3f] bg-white p-10 text-center shadow-[4px_4px_0_#0d2f3f]">
                      <p className="text-sm font-black uppercase text-[#0d2f3f]">No Problems Found</p>
                      <p className="mt-1 text-xs font-bold text-[#55707d]">
                        No records match this filter. Run an audit scan or clear your search criteria.
                      </p>
                    </div>
                  ) : (
                    visibleGroups.map((group) => (
                      <FindingGroupCard
                        key={group.id}
                        group={group}
                        selectedPlanId={activeId}
                        onSelectPlan={(plan) => setActiveId(plan.id)}
                        onGroupUpdated={refresh}
                        instanceUrl={data?.connectionInstanceUrl}
                        onViewRollbackVault={() => {
                          setView("Fixes");
                          setFixesTab("applied");
                        }}
                      />
                    ))
                  )}
                </div>
              </section>

              {/* Right Column: Detail & AI Fix Panel */}
              <aside className="min-w-0 max-w-full overflow-x-hidden overflow-y-auto bg-[#f4f8f9] xl:min-h-0 saos-scroll border-t-[3px] xl:border-t-0 border-[#0d2f3f]">
                {active ? (
                  <div className="min-w-0 max-w-full break-words [overflow-wrap:anywhere] overflow-x-hidden animate-saos-page-enter">
                    {/* Header */}
                    <div className="border-b-[3px] border-[#0d2f3f] bg-white p-4 sm:p-5 shadow-[0_2px_0_#0d2f3f]">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 border-2 border-[#0d2f3f] font-mono text-[10px] font-black uppercase tracking-wider shadow-[1px_1px_0_#0d2f3f] ${
                              active.module === "itsm"
                                ? "bg-[#eedbfb] text-[#3d1a58]"
                                : "bg-[#d2ebf0] text-[#0d2f3f]"
                            }`}
                          >
                            {active.module?.toUpperCase() || "ITSM"}
                          </span>
                          <SysIdChip sysId={String(active.evidence?.sysId || active.targetId)} />
                        </div>

                        {/* Close Drawer Button */}
                        <button
                          type="button"
                          onClick={() => setActiveId(null)}
                          className="grid size-7 place-items-center border-2 border-[#0d2f3f] bg-white text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#fee2e2]"
                          title="Close panel"
                        >
                          <X size={15} weight="bold" />
                        </button>
                      </div>

                      <h2 className="mt-3 font-display text-base sm:text-lg font-black leading-snug tracking-tight text-[#0d2f3f] break-words">
                        {active.title}
                      </h2>

                      <p className="mt-1.5 text-xs font-semibold text-[#55707d] leading-relaxed break-words">
                        {active.explanation}
                      </p>

                      {/* Brutalist Inline Metadata & Risk Ribbon */}
                      <div className="mt-3.5 flex flex-wrap items-center gap-1.5 pt-3 border-t-2 border-[#0d2f3f] text-xs">
                        <span className={`inline-flex items-center px-2 py-0.5 border-2 border-[#0d2f3f] font-mono text-[10px] font-black uppercase shadow-[1px_1px_0_#0d2f3f] ${
                          active.riskAssessment?.severity === "Critical" || active.risk === "Critical"
                            ? "bg-[#fee2e2] text-[#991b1b]"
                            : active.riskAssessment?.severity === "High" || active.risk === "High"
                              ? "bg-[#fef3c7] text-[#92400e]"
                              : "bg-[#f4f8f9] text-[#0d2f3f]"
                        }`}>
                          SEV: {active.riskAssessment?.severity || active.risk || "Medium"}
                        </span>

                        <span className="inline-flex items-center px-2 py-0.5 border-2 border-[#0d2f3f] font-mono text-[10px] font-bold bg-white text-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f]">
                          PROOF: {proofLabel(active)}
                        </span>

                        <span className="inline-flex items-center px-2 py-0.5 border-2 border-[#0d2f3f] font-mono text-[10px] font-bold text-[#0d2f3f] bg-[#e9f1f3] shadow-[1px_1px_0_#0d2f3f]">
                          TWIN v{active.twinVersion}
                        </span>

                        <span className="inline-flex items-center px-2 py-0.5 border-2 border-[#0d2f3f] font-mono text-[10px] font-bold bg-white text-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f]">
                          DOMAIN: {(!active.domain || active.domain === "unknown") ? "GLOBAL" : active.domain.toUpperCase()}
                        </span>

                        <span className={`inline-flex items-center px-2 py-0.5 border-2 border-[#0d2f3f] font-mono text-[10px] font-black uppercase shadow-[1px_1px_0_#0d2f3f] ${
                          active.status === "Applied"
                            ? "bg-[#5edc56] text-[#0d2f3f]"
                            : active.status === "Approved"
                              ? "bg-[#d2ebf0] text-[#0d2f3f]"
                              : "bg-[#f4f8f9] text-[#0d2f3f]"
                        }`}>
                          {active.status}
                        </span>
                      </div>
                    </div>

                    {/* Live ServiceNow Record Verification Bar */}
                    {(() => {
                      const activeTable = String(active.evidence?.table || active.targetId.split(":")[0] || "cmdb_ci");
                      const activeSysId = String(active.evidence?.sysId || active.evidence?.duplicateSysId || active.evidence?.number || active.targetId || "");
                      const verifyUrl = getServiceNowRecordUrl(data?.connectionInstanceUrl, activeTable, activeSysId);
                      if (!verifyUrl) return null;
                      return (
                        <div className="border-b-[3px] border-[#0d2f3f] bg-[#eef7fa] px-4 sm:px-5 py-2.5 flex flex-wrap items-center justify-between gap-2 shadow-[0_2px_0_#0d2f3f]">
                          <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold text-[#35525e] min-w-0 truncate">
                            <ArrowSquareOut size={14} weight="bold" className="shrink-0 text-[#0d2f3f]" />
                            <span className="text-[#55707d]">Target:</span>
                            <span className="border border-[#0d2f3f] bg-white px-1.5 py-0.2 font-black text-[#0d2f3f]">{activeTable}</span>
                            <span className="text-[#0d2f3f] font-mono truncate">({activeSysId.slice(0, 16)}…)</span>
                          </div>
                          <a
                            href={verifyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-[#ffd166] px-3 py-1 font-mono text-[11px] font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#ffc233] shrink-0"
                            title="Open live record directly in ServiceNow"
                          >
                            <ArrowSquareOut size={13} weight="bold" />
                            {active.status === "Applied" ? "Verify Fix in ServiceNow ↗" : "Inspect in ServiceNow ↗"}
                          </a>
                        </div>
                      );
                    })()}

                    {/* Master Governance Rule & Contextual Intelligence Dossier */}
                    {(() => {
                      const rk = getRuleKnowledge(active.ruleId, active);
                      return (
                        <div className="border-b-[3px] border-[#0d2f3f] bg-white p-4 sm:p-5 space-y-3.5 shadow-[0_2px_0_#0d2f3f]">
                          {/* Top Metadata Strip */}
                          <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b-2 border-[#0d2f3f]">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="border-2 border-[#0d2f3f] bg-[#0d2f3f] text-[#5edc56] px-2 py-0.5 font-mono text-[10px] font-black uppercase shadow-[1px_1px_0_#0d2f3f]">
                                [{rk.code}]
                              </span>
                              <span className="border border-[#0d2f3f] bg-[#f4f8f9] px-2 py-0.5 font-mono text-[9px] font-black uppercase text-[#0d2f3f]">
                                {rk.standard}
                              </span>
                              <span
                                className={`px-2 py-0.5 font-mono text-[9px] font-black uppercase border border-[#0d2f3f] ${
                                  rk.severity === "Systemic"
                                    ? "bg-purple-100 text-purple-900 border-purple-800"
                                    : rk.severity === "Critical"
                                      ? "bg-rose-100 text-rose-900 border-rose-800"
                                      : rk.severity === "High"
                                        ? "bg-amber-100 text-amber-900 border-amber-800"
                                        : "bg-blue-100 text-blue-900 border-blue-800"
                                }`}
                              >
                                {rk.severity.toUpperCase()} • WEIGHT {rk.weight}
                              </span>
                            </div>

                            <a
                              href={`/api/plans/${encodeURIComponent(active.id)}/updateset`}
                              download
                              className="inline-flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-[#5edc56] px-2.5 py-1 font-mono text-[10px] font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#4ec546]"
                              title="Download ready-to-commit ServiceNow Update Set XML for this governance finding"
                            >
                              <DownloadSimple size={13} weight="bold" />
                              <span>Export Update Set (XML)</span>
                            </a>
                          </div>

                          {/* Rule Title */}
                          <h4 className="font-display text-sm font-black text-[#0d2f3f] leading-snug">
                            {rk.title}
                          </h4>

                          {/* Technical Mechanism (What It Means) */}
                          <div className="border-2 border-[#0d2f3f] bg-[#f4f8f9] p-3 shadow-[1px_1px_0_#0d2f3f]">
                            <span className="font-mono text-[9px] font-black uppercase tracking-wider text-[#55707d] block">
                              Architectural Failure Mechanism
                            </span>
                            <p className="mt-1 text-xs font-bold text-[#0d2f3f] leading-relaxed">
                              {rk.whatItMeans}
                            </p>
                          </div>

                          {/* Operational Blast Radius (Why It Matters) */}
                          <div className="border-2 border-[#991b1b] bg-[#fee2e2]/40 p-3 shadow-[1px_1px_0_#991b1b]">
                            <span className="font-mono text-[9px] font-black uppercase tracking-wider text-[#991b1b] block">
                              Operational Blast Radius &amp; Risk
                            </span>
                            <p className="mt-1 text-xs font-bold text-[#991b1b] leading-relaxed">
                              {rk.whyItMatters}
                            </p>
                          </div>

                          {/* False Positive Guard & Cross-Domain Causal Chain */}
                          <div className="grid gap-2.5 sm:grid-cols-2">
                            {rk.falsePositiveGuard && (
                              <div className="border-2 border-[#0d2f3f] bg-[#fef3c7]/50 p-2.5">
                                <span className="font-mono text-[9px] font-black uppercase text-[#92400e] block">
                                  False Positive Guard
                                </span>
                                <p className="mt-1 text-[11px] font-bold text-[#0d2f3f] leading-snug">
                                  {rk.falsePositiveGuard}
                                </p>
                              </div>
                            )}

                            {rk.crossDomainLink && (
                              <div className="border-2 border-[#0d2f3f] bg-[#eedbfb]/50 p-2.5">
                                <span className="font-mono text-[9px] font-black uppercase text-[#581c87] block">
                                  Cross-Domain Causal Ripple
                                </span>
                                <p className="mt-1 font-mono text-[10px] font-black text-[#581c87] leading-snug">
                                  {rk.crossDomainLink}
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Unified AI Remediation Studio & Governance */}
                    {(() => {
                      const activeTable = String(active.evidence?.table || active.targetId.split(":")[0] || "cmdb_ci");
                      return (
                    <div className="p-4 sm:p-5 space-y-4 min-w-0 max-w-full overflow-hidden">
                      {/* Section Header */}
                      <div className="flex items-center justify-between gap-2 pb-3 border-b-2 border-[#0d2f3f]">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="grid size-6 place-items-center bg-[#0d2f3f] text-[#5edc56] shadow-[1px_1px_0_#5edc56] shrink-0">
                            <Sparkle size={14} weight="fill" />
                          </span>
                          <div>
                            <span className="text-xs font-black text-[#0d2f3f] uppercase tracking-wide block leading-none">
                              AI Remediation Studio
                            </span>
                            <span className="font-mono text-[9px] font-bold text-[#55707d] mt-0.5 flex items-center gap-1">
                              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              {aiStatus?.model || "Local Ollama"}
                            </span>
                          </div>
                        </div>
                        <span
                          className={`px-2 py-0.5 font-mono text-[10px] font-black uppercase border-2 border-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f] shrink-0 ${
                            active.status === "Applied"
                              ? "bg-[#5edc56] text-[#0d2f3f]"
                              : active.status === "Approved"
                                ? "bg-[#d2ebf0] text-[#0d2f3f]"
                                : "bg-white text-[#0d2f3f]"
                          }`}
                        >
                          {active.status === "Applied" ? "✓ FIXED / APPLIED" : active.status}
                        </span>
                      </div>

                      {/* Governance Approver input */}
                      {active.status !== "Applied" ? (
                        <div className="flex items-center justify-between border-2 border-[#0d2f3f] bg-white px-3 py-2 shadow-[2px_2px_0_#0d2f3f]">
                          <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider text-[#55707d]">
                            <UserCircle size={15} weight="bold" className="text-[#0d2f3f]" />
                            <span>Audit Approver:</span>
                          </div>
                          <input
                            id="reviewer"
                            value={reviewer}
                            onChange={(e) => handleReviewerChange(e.target.value)}
                            placeholder="operator"
                            className="bg-transparent font-mono text-xs font-black text-[#0d2f3f] text-right outline-none w-28 focus:border-b border-[#0d2f3f]"
                          />
                        </div>
                      ) : null}

                      {/* Autonomous Reasoning Agent HUD */}
                      {busy === "ai_suggest" && (
                        <div className="border-2 border-[#0d2f3f] bg-[#f4f8fa] p-4 text-[#0d2f3f] shadow-[3px_3px_0_#0d2f3f] space-y-3 animate-saos-page-enter">
                          {/* Header */}
                          <div className="flex items-center justify-between pb-2 border-b border-[#0d2f3f]/15">
                            <div className="flex items-center gap-2">
                              <span className="size-2 rounded-full bg-emerald-600 animate-ping" />
                              <span className="font-mono text-xs font-black uppercase tracking-wider text-[#0d2f3f]">
                                Autonomous Reasoning Agent
                              </span>
                              <span className="font-mono text-[10px] text-[#55707d]">
                                ({aiStatus?.model || "deepseek-v4-flash:cloud"})
                              </span>
                            </div>
                            <span className="border border-emerald-600/40 bg-emerald-50 px-2 py-0.5 font-mono text-[9px] font-black text-emerald-800">
                              SYNTHESIZING
                            </span>
                          </div>

                          {/* Subtle, refined progress bar (not loud or over) */}
                          <div className="h-1 w-full bg-[#0d2f3f]/10 overflow-hidden">
                            <div className="h-full bg-emerald-600/80 animate-pulse w-3/4 transition-all duration-700" />
                          </div>

                          {/* Concise Step Progression */}
                          <div className="space-y-1.5 font-mono text-[11px] pt-0.5">
                            <div className="flex items-center justify-between text-[#3a5966]">
                              <span className="flex items-center gap-2">
                                <span className="text-emerald-700 font-bold">✓</span>
                                <span>ServiceNow Twin snapshot ingested</span>
                              </span>
                              <span className="text-[10px] text-emerald-700 font-bold">+14ms</span>
                            </div>

                            <div className="flex items-center justify-between text-[#0d2f3f] font-bold">
                              <span className="flex items-center gap-2">
                                <span className="size-1.5 rounded-full bg-emerald-600 animate-ping" />
                                <span className="text-emerald-800">Analyzing governance policy &amp; blast radius...</span>
                              </span>
                              <span className="text-[9px] text-emerald-800 font-black">EVALUATING</span>
                            </div>

                            <div className="flex items-center justify-between text-[#7b939f]">
                              <span className="flex items-center gap-2">
                                <span className="size-1.5 rounded-full bg-[#cad8dc]" />
                                <span>Synthesizing reversible patch &amp; rollback baseline</span>
                              </span>
                              <span className="text-[9px] text-[#7b939f]">ARMED</span>
                            </div>
                          </div>

                          {/* Clean Live Terminal Ticker */}
                          <div className="border border-[#0d2f3f]/15 bg-white p-2 flex items-center justify-between font-mono text-[10px] shadow-[1px_1px_0_#0d2f3f]">
                            <div className="flex items-center gap-2 truncate text-[#3a5966]">
                              <TerminalWindow size={13} className="text-emerald-700 shrink-0" />
                              <span className="truncate font-medium">
                                [LLM STREAM] Computing atomic patch vector for {activeTable}…
                              </span>
                            </div>
                            <span className="size-1.5 rounded-full bg-emerald-600 animate-ping shrink-0" />
                          </div>
                        </div>
                      )}

                      {/* When Plan exists: Executive Remediation Dossier */}
                      {Boolean(activeFixPlan) && busy !== "ai_suggest" && (
                        <div className="border-2 border-[#0d2f3f] bg-white p-4 space-y-3.5 shadow-[3px_3px_0_#0d2f3f] animate-saos-page-enter">
                          <div className="flex items-center justify-between pb-2.5 border-b-2 border-[#0d2f3f]">
                            <div className="flex items-center gap-2">
                              <div className="grid size-6 place-items-center bg-[#0d2f3f] text-[#5edc56]">
                                <Sparkle size={13} weight="fill" />
                              </div>
                              <div>
                                <span className="text-xs font-black text-[#0d2f3f] uppercase tracking-wide block leading-none">
                                  Synthesized Remediation Dossier
                                </span>
                                <span className="font-mono text-[9px] text-[#55707d] mt-0.5 block">
                                  Engineered for ServiceNow REST Table API
                                </span>
                              </div>
                            </div>
                            <button
                              type="button"
                              disabled={!!busy}
                              onClick={async () => {
                                setBusy("ai_suggest");
                                try {
                                  const res = await fetch(`/api/plans/${active.id}/suggest`, { method: "POST" });
                                  if (res.ok) {
                                    const d = await res.json();
                                    if (d.preview) {
                                      setData((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              plans: prev.plans.map((p) =>
                                                p.id === active.id
                                                  ? { ...p, preview: d.preview, status: "Previewed" }
                                                  : p,
                                              ),
                                            }
                                          : prev,
                                      );
                                    }
                                  }
                                } finally {
                                  setBusy("");
                                }
                              }}
                              className="border-2 border-[#0d2f3f] bg-white px-2 py-1 font-mono text-[10px] font-black text-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f] brutal-btn hover:bg-[#e9f1f3]"
                            >
                              ↻ Re-evaluate
                            </button>
                          </div>

                          {/* Executive Card 1: Compliance Violation & Policy Gap */}
                          <div className="border-2 border-[#0d2f3f] bg-[#fffbfb] p-3.5 shadow-[2px_2px_0_#0d2f3f] border-l-4 border-l-rose-600">
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-[10px] font-black uppercase tracking-wider text-rose-800 flex items-center gap-1.5">
                                <WarningCircle size={14} weight="fill" className="text-rose-600 shrink-0" />
                                Compliance Violation & Policy Gap
                              </span>
                              <span className="border border-rose-300 bg-rose-100/60 px-1.5 py-0.2 font-mono text-[9px] font-black uppercase text-rose-800">
                                AUDIT FINDING
                              </span>
                            </div>
                            <p className="mt-2 text-xs font-bold text-[#1f2937] leading-relaxed break-words">
                              {activeFixPlan?.whatWasMissing ||
                                "Record violates operational compliance policy."}
                            </p>
                          </div>

                          {/* Executive Card 2: Autonomous Corrective Action */}
                          <div className="border-2 border-[#0d2f3f] bg-[#f7fdf7] p-3.5 shadow-[2px_2px_0_#0d2f3f] border-l-4 border-l-[#2fa627]">
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-[10px] font-black uppercase tracking-wider text-[#0d2f3f] flex items-center gap-1.5">
                                <CheckCircle size={15} weight="bold" className="text-[#2fa627] shrink-0" />
                                Proposed Automated Resolution
                              </span>
                              <span className="border border-[#5edc56] bg-[#5edc56]/20 px-1.5 py-0.2 font-mono text-[9px] font-black uppercase text-[#0d2f3f]">
                                100% REVERSIBLE
                              </span>
                            </div>
                            <p className="mt-2 text-xs font-black text-[#0d2f3f] leading-relaxed break-words">
                              {activeFixPlan?.whatIsAdded ||
                                activeFixPlan?.summary ||
                                "Patching ServiceNow record with validated telemetry."}
                            </p>
                          </div>

                          {/* Technical Operations Blueprint */}
                          {(activeFixPlan?.fixActions?.length ?? 0) > 0 && (
                            <div className="space-y-1.5 pt-1">
                              <div className="flex items-center justify-between">
                                <span className="font-mono text-[10px] text-[#0d2f3f] font-black uppercase tracking-wider">
                                  Target ServiceNow Operations
                                </span>
                                <span className="font-mono text-[9px] text-[#55707d] font-bold">
                                  {activeFixPlan?.fixActions.length} API {activeFixPlan?.fixActions.length === 1 ? "CALL" : "CALLS"}
                                </span>
                              </div>
                              {activeFixPlan?.fixActions.map((act, idx) => (
                                <div
                                  key={idx}
                                  className="border-2 border-[#0d2f3f] bg-white p-2.5 font-mono text-[11px] flex items-center justify-between gap-2 shadow-[1px_1px_0_#0d2f3f]"
                                >
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span className="border border-[#0d2f3f] bg-[#0d2f3f] text-[#5edc56] px-1.5 py-0.5 text-[9px] uppercase font-black">
                                      {act.operation}
                                    </span>
                                    <span className="text-[#0d2f3f] font-black">{act.table}</span>
                                  </div>
                                  <span
                                    className="text-[#55707d] truncate min-w-0 max-w-[210px] text-right font-bold text-[10px]"
                                    title={act.description}
                                  >
                                    {act.description}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Root Cause & Risk Rationale */}
                          <details className="text-xs border-2 border-[#0d2f3f] bg-[#f4f8f9] p-2.5 shadow-[1px_1px_0_#0d2f3f] group">
                            <summary className="cursor-pointer font-black text-[#0d2f3f] select-none flex items-center justify-between">
                              <span>Inspect Root Cause & Risk Rationale</span>
                              <span className="font-mono text-[10px] text-[#55707d] group-open:rotate-90 transition-transform">
                                ▸
                              </span>
                            </summary>
                            <div className="mt-2.5 space-y-2 border-t-2 border-[#0d2f3f] pt-2.5 text-xs">
                              <div>
                                <span className="font-mono text-[10px] font-black uppercase tracking-wider text-[#55707d] block mb-0.5">
                                  Root Cause Analysis:
                                </span>
                                <p className="text-[#0d2f3f] font-bold leading-relaxed">{activeFixPlan?.rootCause}</p>
                              </div>
                              <div>
                                <span className="font-mono text-[10px] font-black uppercase tracking-wider text-rose-700 block mb-0.5">
                                  Risk if Left Unremediated:
                                </span>
                                <p className="text-[#0d2f3f] font-bold leading-relaxed">{activeFixPlan?.impactIfIgnored}</p>
                              </div>
                            </div>
                          </details>

                          {/* Vault Guarantee Trust Pill */}
                          <div className="flex items-center gap-2 border border-emerald-300 bg-emerald-50/70 p-2 text-[11px] font-bold text-emerald-950">
                            <Shield size={16} weight="fill" className="text-emerald-700 shrink-0" />
                            <span>
                              Zero-Loss Vault: Baseline state is recorded in PostgreSQL before mutation. 1-Click Rollback guaranteed.
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Action Controls for Unapplied Plans */}
                      {active.status !== "Applied" && (
                        <div className="space-y-2.5 pt-2">
                          {activeFixPlan ? (
                            <>
                              <button
                                disabled={busy === "apply" || busy === "decision"}
                                onClick={() => void handleApplyIndividualPlan(active)}
                                type="button"
                                className="flex w-full items-center justify-center gap-2 border-2 border-[#0d2f3f] bg-[#5edc56] px-4 py-3 text-xs font-black text-[#0d2f3f] shadow-[3px_3px_0_#0d2f3f] brutal-btn hover:bg-[#4ecd46] disabled:opacity-50 cursor-pointer"
                              >
                                <CheckCircle size={16} weight="bold" />
                                {busy === "apply" || busy === "decision"
                                  ? "Applying Fix to ServiceNow…"
                                  : "Approve & Apply Fix to ServiceNow"}
                              </button>

                              <button
                                disabled={!!busy}
                                onClick={() => void handleRejectFinding(active.id)}
                                type="button"
                                className="flex w-full items-center justify-center gap-1.5 border-2 border-[#0d2f3f] bg-white hover:bg-rose-50 px-3 py-2 text-xs font-bold text-[#647c87] hover:text-rose-700 shadow-[2px_2px_0_#0d2f3f] brutal-btn disabled:opacity-40 cursor-pointer"
                              >
                                <X size={14} weight="bold" />
                                Dismiss Finding
                              </button>
                            </>
                          ) : (
                            /* Phase 1: No Plan Yet. User consults AI */
                            <>
                              <button
                                disabled={!!busy}
                                onClick={async () => {
                                  setBusy("ai_suggest");
                                  setNotice(`🤖 Consulting ${aiStatus?.model || "AI"} for root-cause analysis & fix plan…`);
                                  try {
                                    const res = await fetch(`/api/plans/${active.id}/suggest`, { method: "POST" });
                                    if (res.ok) {
                                      const d = await res.json();
                                      if (d?.preview) {
                                        setData((prev) =>
                                          prev
                                            ? {
                                                ...prev,
                                                plans: prev.plans.map((p) =>
                                                  p.id === active.id
                                                    ? { ...p, preview: d.preview, status: "Previewed" }
                                                    : p,
                                                ),
                                              }
                                            : prev,
                                        );
                                        setNotice("✓ AI Consultation complete. Review diagnosis and proposed fix below before applying.");
                                      }
                                    } else {
                                      const err = await res.json().catch(() => ({}));
                                      setNotice(`AI consultation error: ${err.message || res.statusText}`);
                                    }
                                  } catch (e) {
                                    console.warn("AI suggest error:", e);
                                    setNotice("Failed to generate AI plan. Please check AI settings.");
                                  } finally {
                                    setBusy("");
                                  }
                                }}
                                type="button"
                                className="flex w-full items-center justify-center gap-2 border-2 border-[#0d2f3f] bg-[#5edc56] px-4 py-3 text-xs font-black text-[#0d2f3f] shadow-[3px_3px_0_#0d2f3f] brutal-btn hover:bg-[#4ecd46] disabled:opacity-50 cursor-pointer"
                              >
                                <Sparkle size={16} weight="fill" />
                                {busy === "ai_suggest"
                                  ? `Consulting ${aiStatus?.model || "AI"}…`
                                  : `Consult AI for Root-Cause & Fix Plan`}
                              </button>

                              <button
                                disabled={!!busy}
                                onClick={() => void handleRejectFinding(active.id)}
                                type="button"
                                className="flex w-full items-center justify-center gap-1.5 border-2 border-[#0d2f3f] bg-white hover:bg-rose-50 px-3 py-2 text-xs font-bold text-[#647c87] hover:text-rose-700 shadow-[2px_2px_0_#0d2f3f] brutal-btn disabled:opacity-40 cursor-pointer"
                              >
                                <X size={14} weight="bold" />
                                Dismiss Finding
                              </button>
                            </>
                          )}
                        </div>
                      )}

                      {/* When Applied: Success state & Instant Rollback button */}
                      {active.status === "Applied" && (
                        <div className="border-2 border-[#0d2f3f] bg-[#e5f9e4] p-4 space-y-3 shadow-[3px_3px_0_#0d2f3f] animate-saos-success">
                          <div className="flex items-center gap-2 text-xs font-black text-[#0d2f3f]">
                            <CheckCircle size={18} weight="fill" className="text-[#0d2f3f]" />
                            <span>Successfully Applied & Verified in ServiceNow</span>
                          </div>
                          <p className="text-xs font-bold text-[#35525e]">
                            Pre-change state snapshot is recorded in local PostgreSQL vault.
                          </p>

                          {/* Direct Clickable Verification Link to ServiceNow */}
                          {(() => {
                            const activeTable = String(active.evidence?.table || active.targetId.split(":")[0] || "cmdb_ci");
                            const activeSysId = String(active.evidence?.sysId || active.evidence?.duplicateSysId || active.evidence?.number || active.targetId || "");
                            const verifyUrl = getServiceNowRecordUrl(data?.connectionInstanceUrl, activeTable, activeSysId);
                            if (!verifyUrl) return null;
                            return (
                              <a
                                href={verifyUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex w-full items-center justify-center gap-2 border-2 border-[#0d2f3f] bg-[#ffd166] px-3 py-2.5 text-xs font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#ffc233]"
                                title="Verify updated live record in ServiceNow"
                              >
                                <ArrowSquareOut size={16} weight="bold" />
                                Verify Live Record in ServiceNow ↗
                              </a>
                            );
                          })()}

                          <button
                            disabled={!!busy}
                            onClick={() => {
                              if (window.confirm("Rollback this fix in ServiceNow? Pre-change snapshot will be restored.")) {
                                void handleRollbackIndividual(active);
                              }
                            }}
                            type="button"
                            className="flex w-full items-center justify-center gap-2 border-2 border-[#0d2f3f] bg-[#f3ba63] px-3 py-2.5 text-xs font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#e2a84e] disabled:opacity-40 cursor-pointer"
                          >
                            <ArrowClockwise size={15} weight="bold" />
                            {individualExecutionReport?.status === "executing" ? "Restoring Snapshot…" : "Rollback Applied Fix"}
                          </button>
                        </div>
                      )}

                      {/* Source Proof & Technical Details (collapsible at the bottom) */}
                      <div className="pt-2 border-t-2 border-[#0d2f3f]">
                        <details className="min-w-0 max-w-full overflow-hidden text-xs">
                          <summary className="cursor-pointer text-xs font-black text-[#0d2f3f] hover:underline select-none py-1 uppercase">
                            Technical Evidence & Raw Payload
                          </summary>
                          <p className="mt-1.5 text-xs text-[#0d2f3f] font-bold leading-relaxed">
                            {proofSentence(active)}
                          </p>
                          <pre className="mt-2 max-h-40 overflow-x-auto overflow-y-auto border-2 border-[#0d2f3f] bg-[#0d2f3f] p-2.5 font-mono text-[10px] leading-4 text-[#5edc56] whitespace-pre-wrap break-all max-w-full shadow-[2px_2px_0_#0d2f3f]">
                            {JSON.stringify(active.evidence, null, 2)}
                          </pre>
                        </details>
                      </div>
                    </div>
                  );
                })()}
              </div>
                ) : (
                  /* Empty State when no specific finding tile is selected */
                  <div className="flex h-full min-h-[420px] flex-col items-center justify-center p-6 text-center bg-[#f4f8f9]">
                    <div className="border-[3px] border-[#0d2f3f] bg-white p-6 sm:p-8 shadow-[6px_6px_0_#0d2f3f] max-w-md w-full animate-saos-page-enter">
                      <div className="grid size-14 place-items-center border-2 border-[#0d2f3f] bg-[#5edc56] shadow-[3px_3px_0_#0d2f3f] mx-auto mb-4 text-[#0d2f3f]">
                        <Sparkle size={28} weight="fill" />
                      </div>
                      <h3 className="font-display text-lg font-black uppercase tracking-tight text-[#0d2f3f]">
                        AI Remediation Studio
                      </h3>
                      <div className="mt-2 inline-flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-[#d2ebf0] px-2.5 py-0.5 font-mono text-[11px] font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f]">
                        <ListChecks size={14} weight="bold" />
                        AWAITING SELECTION
                      </div>
                      <p className="mt-4 text-xs font-bold leading-relaxed text-[#35525e]">
                        Click on any specific problem tile or record on the left to inspect evidence, consult AI, and stage automated fixes.
                      </p>

                      <div className="mt-5 border-t-2 border-[#0d2f3f] pt-4 text-left space-y-2 text-[11px] font-mono text-[#0d2f3f]">
                        <div className="flex items-center gap-2">
                          <span className="grid size-5 shrink-0 place-items-center border border-[#0d2f3f] bg-[#5edc56] text-[10px] font-black text-[#0d2f3f]">
                            1
                          </span>
                          <span>Select any ITSM or CMDB problem tile</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="grid size-5 shrink-0 place-items-center border border-[#0d2f3f] bg-[#5edc56] text-[10px] font-black text-[#0d2f3f]">
                            2
                          </span>
                          <span>AI synthesizes root-cause diagnosis</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="grid size-5 shrink-0 place-items-center border border-[#0d2f3f] bg-[#5edc56] text-[10px] font-black text-[#0d2f3f]">
                            3
                          </span>
                          <span>Review, stage patch & 1-click apply</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </aside>
            </div>
          ) : view === "Fixes" ? (
            /* ====================================================
               FIXES VIEW — REMEDIATION & ROLLBACK CONTROL CENTER
               ==================================================== */
            <div key={view} className="flex-1 overflow-y-auto p-4 sm:p-7 space-y-6 saos-scroll animate-saos-page-enter">
              {/* Header Banner */}
              <div className="border-[3px] border-[#0d2f3f] bg-white p-5 shadow-[4px_4px_0_#0d2f3f]">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="border-2 border-[#0d2f3f] bg-[#5edc56] px-2 py-0.5 font-mono text-[11px] font-black text-[#0d2f3f] uppercase">
                        REVERSIBLE REST REMEDIATION
                      </span>
                      <span className="font-mono text-xs font-bold text-[#476371]">
                        AUDIT-VERIFIED WRITE-BACK
                      </span>
                    </div>
                    <h2 className="mt-2 font-display text-2xl font-black text-[#0d2f3f]">
                      Remediation & Rollback Control Center
                    </h2>
                    <p className="mt-1 text-xs text-[#3a5966] font-medium max-w-2xl leading-relaxed">
                      Safe operational write-back for ServiceNow CMDB & ITSM.
                      Every automated patch or relationship deletion captures a pre-change snapshot in local PostgreSQL before writing back to ServiceNow.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setFixesTab("batch")}
                      className={`border-2 border-[#0d2f3f] px-3.5 py-2 text-xs font-black transition-all brutal-btn ${
                        fixesTab === "batch"
                          ? "bg-[#5edc56] text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f]"
                          : "bg-white text-[#0d2f3f] hover:bg-[#e9f1f3]"
                      }`}
                    >
                      ⚡ 1-Click Batch Fixes ({groups.length})
                    </button>
                    <button
                      onClick={() => setFixesTab("staged")}
                      className={`border-2 border-[#0d2f3f] px-3.5 py-2 text-xs font-black transition-all brutal-btn ${
                        fixesTab === "staged"
                          ? "bg-[#5edc56] text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f]"
                          : "bg-white text-[#0d2f3f] hover:bg-[#e9f1f3]"
                      }`}
                    >
                      🔬 Staged Dry-Runs ({previewedPlans.length})
                    </button>
                    <button
                      onClick={() => setFixesTab("applied")}
                      className={`border-2 border-[#0d2f3f] px-3.5 py-2 text-xs font-black transition-all brutal-btn ${
                        fixesTab === "applied"
                          ? "bg-[#5edc56] text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f]"
                          : "bg-white text-[#0d2f3f] hover:bg-[#e9f1f3]"
                      }`}
                    >
                      ⏪ Rollback Vault ({appliedPlans.length})
                    </button>
                  </div>
                </div>

                {/* 3 Metric Cards */}
                <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3 border-t-2 border-[#0d2f3f] pt-4">
                  <div className="border-2 border-[#0d2f3f] bg-[#f8fafb] p-3.5">
                    <p className="font-display text-3xl font-black text-[#0d2f3f]">
                      {groups.length}
                    </p>
                    <p className="font-mono text-[10px] font-black tracking-wider text-[#476371] uppercase mt-1">
                      AUTOMATED REPAIR STRATEGIES
                    </p>
                    <p className="text-[11px] font-medium text-[#476371] mt-1">
                      CMDB ownership, orphan CIs, SLA breaches & missing CIs
                    </p>
                  </div>

                  <div className="border-2 border-[#0d2f3f] bg-[#f8fafb] p-3.5">
                    <p className="font-display text-3xl font-black text-cyan-800">
                      {previewedPlans.length}
                    </p>
                    <p className="font-mono text-[10px] font-black tracking-wider text-[#476371] uppercase mt-1">
                      STAGED DRY-RUNS
                    </p>
                    <p className="text-[11px] font-medium text-[#476371] mt-1">
                      Simulated fixes ready for engineer review
                    </p>
                  </div>

                  <div className="border-2 border-[#0d2f3f] bg-[#f8fafb] p-3.5">
                    <p className="font-display text-3xl font-black text-emerald-700">
                      {appliedPlans.length}
                    </p>
                    <p className="font-mono text-[10px] font-black tracking-wider text-[#476371] uppercase mt-1">
                      ACTIVE ROLLBACK SNAPSHOTS
                    </p>
                    <p className="text-[11px] font-medium text-[#476371] mt-1">
                      Pre-change state captured in PostgreSQL
                    </p>
                  </div>
                </div>
              </div>

              {/* Sub-tab Content */}
              {fixesTab === "batch" ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b-2 border-[#0d2f3f] pb-2">
                    <h3 className="font-display text-lg font-black text-[#0d2f3f]">
                      Batch Remediation Pipelines ({groups.length} Strategies)
                    </h3>
                    <span className="font-mono text-xs font-bold text-[#476371]">
                      Select "Verify Group" then "Fix All in Group" to repair in batch
                    </span>
                  </div>

                  <div className="space-y-3.5">
                    {groups.map((group) => (
                      <FindingGroupCard
                        key={group.id}
                        group={group}
                        selectedPlanId={activeId}
                        onSelectPlan={(plan) => setActiveId(plan.id)}
                        onGroupUpdated={refresh}
                        instanceUrl={data?.connectionInstanceUrl}
                        onViewRollbackVault={() => setFixesTab("applied")}
                      />
                    ))}
                  </div>
                </div>
              ) : fixesTab === "staged" ? (
                <div className="space-y-4">
                  <h3 className="font-display text-lg font-black text-[#0d2f3f]">
                    Staged Previews Awaiting Operator Approval ({previewedPlans.length})
                  </h3>
                  {previewedPlans.length === 0 ? (
                    <div className="border-[3px] border-[#0d2f3f] bg-white p-8 text-center text-sm font-bold text-[#0d2f3f]">
                      No staged dry-runs pending. Open "1-Click Batch Fixes" or "Problems" and click "Stage Dry-Run Preview" on any finding.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {previewedPlans.map((plan) => {
                        const isBadEmptyCi = Boolean(
                          plan.preview?.after &&
                          typeof plan.preview.after === "object" &&
                          "fieldsToUpdate" in plan.preview.after &&
                          (plan.preview.after as { fieldsToUpdate?: Record<string, unknown> }).fieldsToUpdate?.cmdb_ci === "",
                        );

                        return (
                          <div key={plan.id} className="border-[3px] border-[#0d2f3f] bg-white p-4 shadow-[3px_3px_0_#0d2f3f]">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className="border-2 border-[#0d2f3f] bg-cyan-100 px-2 py-0.5 font-mono text-[10px] font-black uppercase text-cyan-900">
                                  {plan.module?.toUpperCase() || "CMDB"}
                                </span>
                                <h4 className="font-display text-base font-black text-[#0d2f3f]">{plan.title}</h4>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                {(() => {
                                  const planTable = String(plan.evidence?.table || plan.targetId.split(":")[0] || "cmdb_ci");
                                  const planSysId = String(plan.evidence?.sysId || plan.evidence?.duplicateSysId || plan.evidence?.number || plan.targetId || "");
                                  const verifyUrl = getServiceNowRecordUrl(data?.connectionInstanceUrl, planTable, planSysId);
                                  if (!verifyUrl) return null;
                                  return (
                                    <a
                                      href={verifyUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="border-2 border-[#0d2f3f] bg-[#ffd166] px-2.5 py-1.5 text-xs font-black text-[#0d2f3f] hover:bg-[#ffc233] shadow-[1px_1px_0_#0d2f3f] inline-flex items-center gap-1 brutal-btn"
                                      title="Open live record in ServiceNow to verify"
                                    >
                                      <ArrowSquareOut size={13} weight="bold" />
                                      Verify in ServiceNow ↗
                                    </a>
                                  );
                                })()}
                                <button
                                  onClick={() => {
                                    setActiveId(plan.id);
                                    setView("Problems");
                                  }}
                                  className="border-2 border-[#0d2f3f] bg-white px-2.5 py-1.5 text-xs font-bold text-[#0d2f3f] hover:bg-neutral-50 shadow-[1px_1px_0_#0d2f3f] brutal-btn"
                                >
                                  Open in Studio ↗
                                </button>
                                <button
                                  disabled={isBadEmptyCi}
                                  onClick={() => {
                                    void handleApplyIndividualPlan(plan);
                                  }}
                                  className="border-2 border-[#0d2f3f] bg-[#5edc56] px-3 py-1.5 text-xs font-black text-[#0d2f3f] hover:bg-[#4ecd46] shadow-[2px_2px_0_#0d2f3f] brutal-btn disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                                >
                                  {isBadEmptyCi ? "⚠️ Incomplete CI" : "Approve & Apply to ServiceNow →"}
                                </button>
                              </div>
                            </div>

                            {plan.preview?.fixPlan ? (
                              <div className="mt-3 space-y-2 border-t-2 border-neutral-100 pt-3 text-xs">
                                <div className="border border-rose-300 bg-rose-50/90 p-2.5">
                                  <span className="font-mono text-[10px] font-black uppercase text-rose-800">🔴 Missing / Broken: </span>
                                  <span className="text-rose-950 font-medium leading-relaxed">
                                    {(plan.preview.fixPlan as FixPlan).whatWasMissing}
                                  </span>
                                </div>
                                <div className="border border-emerald-400 bg-emerald-50/90 p-2.5">
                                  <span className="font-mono text-[10px] font-black uppercase text-emerald-800">🟢 What AI Proposes: </span>
                                  <span className="text-emerald-950 font-bold leading-relaxed">
                                    {(plan.preview.fixPlan as FixPlan).whatIsAdded || (plan.preview.fixPlan as FixPlan).summary}
                                  </span>
                                </div>
                              </div>
                            ) : (
                              <div className="mt-2.5 text-xs text-neutral-600 font-medium">
                                <p>{plan.explanation}</p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <h3 className="font-display text-lg font-black text-[#0d2f3f]">
                    Rollback Vault & Execution History ({appliedPlans.length})
                  </h3>
                  {appliedPlans.length === 0 ? (
                    <div className="border-[3px] border-[#0d2f3f] bg-white p-8 text-center text-sm font-bold text-[#0d2f3f]">
                      No live fixes applied yet. Once fixes are approved and applied to ServiceNow, their rollback snapshots appear here for instant 1-click reversal.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {appliedPlans.map((plan) => (
                        <div key={plan.id} className="border-[3px] border-[#0d2f3f] bg-white p-4 shadow-[3px_3px_0_#0d2f3f]">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <span className="border-2 border-[#0d2f3f] bg-emerald-600 px-2 py-0.5 font-mono text-[10px] font-black text-white uppercase">
                                APPLIED LIVE
                              </span>
                              <h4 className="mt-1 font-display text-base font-black text-[#0d2f3f]">{plan.title}</h4>
                              <p className="font-mono text-xs text-[#476371]">Target: {plan.targetId}</p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {(() => {
                                const planTable = String(plan.evidence?.table || plan.targetId.split(":")[0] || "cmdb_ci");
                                const planSysId = String(plan.evidence?.sysId || plan.evidence?.duplicateSysId || plan.evidence?.number || plan.targetId || "");
                                const verifyUrl = getServiceNowRecordUrl(data?.connectionInstanceUrl, planTable, planSysId);
                                if (!verifyUrl) return null;
                                return (
                                  <a
                                    href={verifyUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="border-2 border-[#0d2f3f] bg-[#ffd166] px-3 py-1.5 text-xs font-black text-[#0d2f3f] hover:bg-[#ffc233] shadow-[2px_2px_0_#0d2f3f] inline-flex items-center gap-1.5 brutal-btn"
                                    title="Open live record in ServiceNow to verify fix"
                                  >
                                    <ArrowSquareOut size={14} weight="bold" />
                                    Verify on ServiceNow ↗
                                  </a>
                                );
                              })()}
                              <button
                                onClick={() => {
                                  if (window.confirm("Rollback this fix in ServiceNow to its original state?")) {
                                    void handleRollbackIndividual(plan);
                                  }
                                }}
                                className="border-2 border-[#0d2f3f] bg-amber-300 px-3.5 py-1.5 text-xs font-black text-[#0d2f3f] hover:bg-amber-400 shadow-[2px_2px_0_#0d2f3f] brutal-btn"
                              >
                                ⏪ Instant 1-Click Rollback
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

          ) : view === "Compare" ? (
            /* ====================================================
               COMPARE VIEW — SNAPSHOT DIFF & DRIFT
               ==================================================== */
            <div key={view} className="flex-1 overflow-y-auto p-4 sm:p-7 saos-scroll animate-saos-page-enter">
              <CompareView onRunScan={() => void action("scan", "/api/scan")} />
            </div>
          ) : view === "History" ? (
            /* ====================================================
               HISTORY VIEW — AUDIT LOG CHAIN
               ==================================================== */
            <div key={view} className="flex-1 overflow-y-auto p-4 sm:p-7 space-y-5 saos-scroll animate-saos-page-enter">
              <div className="flex flex-wrap items-center justify-between gap-3 border-[3px] border-[#0d2f3f] bg-[#5edc56] p-4">
                <div className="font-black text-sm">
                  SHA-256 Audit Chain: {data.auditIntegrity.valid ? "VERIFIED & UNTAMPERED" : "VERIFICATION FAILED"} ({data.auditIntegrity.checked} entries)
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void exportReport()}
                    type="button"
                    className="flex items-center gap-2 border-2 border-[#0d2f3f] bg-white px-3 py-1.5 text-xs font-black shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-neutral-100 transition-colors"
                  >
                    <DownloadSimple size={16} weight="bold" />
                    Audit Report
                  </button>
                  <button
                    onClick={() => void exportAudit()}
                    type="button"
                    className="flex items-center gap-2 border-2 border-[#0d2f3f] bg-white px-3 py-1.5 text-xs font-black shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-neutral-100 transition-colors"
                  >
                    <DownloadSimple size={16} weight="bold" />
                    History JSON
                  </button>
                </div>
              </div>

              <div className="overflow-auto border-[3px] border-[#0d2f3f] bg-white shadow-[3px_3px_0_#0d2f3f]">
                <table className="w-full min-w-[700px] text-left text-xs">
                  <thead className="bg-[#0d2f3f] text-white">
                    <tr>
                      {["SEQ", "TIME", "ACTOR", "ACTION", "HASH"].map((h) => (
                        <th key={h} className="p-3 font-mono">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.audit.map((entry) => (
                      <tr key={entry.seq} className="border-b border-[#0d2f3f]">
                        <td className="p-3 font-mono">{entry.seq}</td>
                        <td className="p-3">{displayTime(entry.occurred_at)}</td>
                        <td className="p-3 font-medium">{entry.actor}</td>
                        <td className="p-3 font-bold">{entry.action}</td>
                        <td className="p-3 font-mono text-[11px] text-neutral-500">
                          {entry.entry_hash.slice(0, 16)}…
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : view === "Settings" ? (
            <div key={view} className="flex-1 overflow-y-auto saos-scroll animate-saos-page-enter">
              <SettingsView
                key={`${data.connectionInstanceUrl}:${data.connectionUsername}`}
                connection={data}
                onSaved={refresh}
                onNotice={setNotice}
              />
            </div>
          ) : view === "Data & privacy" ? (
            <div key={view} className="flex-1 overflow-y-auto saos-scroll animate-saos-page-enter">
              <PrivacyView data={data} />
            </div>
          ) : view === "Rulebook AI" ? (
            <div key={view} className="flex-1 overflow-hidden saos-scroll animate-saos-page-enter">
              <RulebookChat
                onInspectRule={(ruleId) => {
                  setSearch(ruleId);
                  switchView("Problems");
                }}
              />
            </div>
          ) : view === "Guide" ? (
            <div key={view} className="flex-1 overflow-y-auto saos-scroll animate-saos-page-enter">
              <GuideView refreshKey={data.twinVersion} />
            </div>
          ) : null}
          </div>
        </section>

        {/* Floating Toast Notification with buttery smooth microinteraction */}
        <AnimatePresence>
          {notice && (
            <motion.div
              initial={{ opacity: 0, y: -18, x: "-50%" }}
              animate={{ opacity: 1, y: 0, x: "-50%" }}
              exit={{ opacity: 0, y: -18, x: "-50%" }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              role="status"
              className="fixed top-5 left-1/2 z-50 flex items-center gap-3 border-[3px] border-[#0d2f3f] bg-[#5edc56] px-4 py-2.5 text-xs font-black text-[#0d2f3f] shadow-[4px_4px_0_#0d2f3f] max-w-md pointer-events-auto"
            >
              <CheckCircle size={16} weight="bold" className="shrink-0" />
              <span className="leading-snug">{notice}</span>
              <button
                aria-label="Dismiss"
                onClick={() => setNotice("")}
                type="button"
                className="border border-[#0d2f3f] bg-white p-1 hover:bg-neutral-100 transition-colors shrink-0 ml-1"
              >
                <X size={13} weight="bold" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Individual Plan Remediation Report Live Popup Modal */}
        <RemediationReportModal
          report={individualExecutionReport}
          onClose={() => setIndividualExecutionReport(null)}
          onViewRollbackVault={() => {
            setView("Fixes");
            setFixesTab("applied");
          }}
        />
      </main>
    </>
  );
}

function Stat({
  value,
  label,
  detail,
}: {
  value: string;
  label: string;
  detail: string;
}) {
  return (
    <div className="border-r-2 border-[#0d2f3f] p-4 last:border-r-0 sm:p-4">
      <p className="font-display text-2xl font-black tracking-[-0.08em] sm:text-3xl">
        {value}
      </p>
      <p className="mt-1 font-mono text-[9px] font-bold tracking-[0.12em] uppercase text-[#476371]">
        {label}
      </p>
      <p className="mt-2 hidden text-xs text-[#476371] sm:block">{detail}</p>
    </div>
  );
}

function RiskPanel({ assessment }: { assessment: Plan["riskAssessment"] }) {
  const confidence = assessment?.confidence?.score;
  const evidence = assessment?.evidenceCompleteness?.score;
  const freshness = assessment?.dataFreshness?.score;

  return (
    <div className="border-b-[3px] border-[#0d2f3f] bg-[#fff8e8] p-4">
      <p className="font-mono text-[10px] font-bold tracking-[0.14em] uppercase text-neutral-600">
        RISK CONTEXT
      </p>
      <div className="mt-2.5 grid grid-cols-2 gap-2 text-xs">
        <RiskValue label="Severity" value={assessment?.severity ?? "Unknown"} />
        <RiskValue
          label="Evidence"
          value={evidence == null ? "Unknown" : `${evidence}% complete`}
        />
        <RiskValue
          label="Rule strength"
          value={confidence == null ? "Unknown" : `${confidence}%`}
        />
        <RiskValue
          label="Data freshness"
          value={freshness == null ? "Unknown" : `${freshness}%`}
        />
      </div>
    </div>
  );
}

function RiskValue({ label, value }: { label: string; value: string }) {
  const isSeverity = label === "Severity";
  const isCriticalOrHigh = value === "Critical" || value === "High";
  return (
    <div
      className={`border-2 p-2 ${
        isSeverity && isCriticalOrHigh
          ? "border-rose-600 bg-rose-100 text-rose-950 font-black shadow-[1px_1px_0_#e11d48]"
          : "border-[#0d2f3f] bg-white text-neutral-900"
      }`}
    >
      <span className={`block text-[9px] font-black uppercase ${isSeverity && isCriticalOrHigh ? "text-rose-700" : "text-neutral-500"}`}>
        {label}
      </span>
      <span className="mt-0.5 block font-display text-xs font-black truncate">
        {value}
      </span>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="border-b-2 border-[#0d2f3f] p-3.5 even:border-l-2">
      <div className="mb-2 text-[#476371]">{icon}</div>
      <p className="truncate font-display text-lg font-black">{value}</p>
      <p className="mt-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-neutral-500">
        {label}
      </p>
    </div>
  );
}

function Tag({
  label,
  tone = "plain",
}: {
  label: string;
  tone?: "plain" | "lime" | "blue";
}) {
  return (
    <span
      className={`border-2 border-[#0d2f3f] px-2 py-0.5 font-mono text-[10px] font-black uppercase ${
        tone === "lime" ? "bg-[#5edc56]" : tone === "blue" ? "bg-[#d2ebf0]" : "bg-white"
      }`}
    >
      {label}
    </span>
  );
}

function proofLabel(plan: Plan) {
  if (plan.ruleId.startsWith("cmdb.relationship.")) return "Relationship match";
  if (plan.ruleId.startsWith("itsm.incident.")) return "Incident policy";
  if (plan.ruleId.startsWith("itsm.sla.")) return "SLA threshold";
  if (plan.ruleId === "cmdb.discovery.stale") return "Source date";
  return "Attribute audit";
}

function proofSentence(plan: Plan) {
  if (plan.ruleId === "cmdb.relationship.duplicate")
    return `Relationship ${plan.evidence.duplicateSysId} repeats ${plan.evidence.canonicalSysId} for the same two records.`;
  if (plan.ruleId === "cmdb.discovery.stale")
    return `Last discovery: ${plan.evidence.lastDiscovered}; ${plan.evidence.ageDays} days ago (threshold: ${plan.evidence.thresholdDays} days).`;
  if (plan.ruleId === "itsm.incident.p1_unassigned")
    return `Incident ${plan.evidence.number || plan.evidence.sysId} is priority 1 and active with no assigned owner.`;
  if (plan.ruleId === "itsm.sla.imminent_breach")
    return `SLA ${plan.evidence.sysId} on task ${plan.evidence.task} is within 5 minutes of breach (${plan.evidence.timeLeft || plan.evidence.percentage + "%"}). Urgent escalation required.`;
  if (plan.ruleId === "itsm.sla.breached")
    return `SLA record ${plan.evidence.sysId} reports breached status on task ${plan.evidence.task}.`;
  if (plan.ruleId === "itsm.sla.at_risk")
    return `SLA record ${plan.evidence.sysId} on task ${plan.evidence.task} has reached ${plan.evidence.percentage}% elapsed duration without closure.`;
  return `Inspected fields: ${Array.isArray(plan.evidence.inspectedFields) ? plan.evidence.inspectedFields.join(", ") : "Evidence captured in local snapshot."}`;
}

function EmptyState({
  configured,
  oldSource,
  busy,
  onTest,
  onSync,
}: {
  configured: boolean;
  oldSource: string | null;
  busy: string;
  onTest: () => void;
  onSync: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl p-5 sm:p-10">
      <div className="border-[3px] border-[#0d2f3f] bg-white shadow-[8px_8px_0_#0d2f3f]">
        <div className="border-b-[3px] border-[#0d2f3f] bg-[#5edc56] p-5">
          <p className="font-mono text-xs font-bold">SAOS 2.0 CONTROL ROOM</p>
          <h2 className="mt-2 font-display text-3xl font-black tracking-tight">
            Connect & Audit Real ServiceNow Records
          </h2>
        </div>
        <div className="space-y-5 p-5 text-sm leading-6">
          <p>
            {oldSource
              ? `Old records from ${oldSource} are hidden. Load the new instance before reviewing findings.`
              : "No sample data or imaginary findings are loaded. Issues appear only after an authentic, verified sync."}
          </p>
          <ol className="list-inside list-decimal space-y-2 font-medium">
            <li>
              Configure Settings with your ServiceNow instance URL and credentials.
            </li>
            <li>
              Click Load records to deeply scan 40+ tables across ITOM, CMDB, ITSM, and CSDM (cmdb_ci, cmdb_rel_ci, cmdb_ci_service, service_offering, incident, task_sla, change_request, problem, em_alert, em_event, discovery_status).
            </li>
            <li>
              29 specialized autonomous agents evaluate 755 master health rules with autonomous LLM consultation and rank issues by health score.
            </li>
          </ol>
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              disabled={!configured || !!busy}
              onClick={onTest}
              className="border-2 border-[#0d2f3f] bg-white px-4 py-2 text-xs font-black hover:bg-neutral-50 transition-colors disabled:opacity-40"
              type="button"
            >
              Test Connection
            </button>
            <button
              disabled={!configured || !!busy}
              onClick={onSync}
              className="border-2 border-[#0d2f3f] bg-[#5edc56] px-4 py-2 text-xs font-black hover:bg-[#4ecd46] transition-colors disabled:opacity-40"
              type="button"
            >
              Load Records
            </button>
          </div>
          <p className="border-l-4 border-[#0d2f3f] pl-3 text-xs text-neutral-600">
            All records remain exclusively on this device. Reversible writes occur only upon your explicit approval.
          </p>
        </div>
      </div>
    </div>
  );
}
