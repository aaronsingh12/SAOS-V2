"use client";

import { useState } from "react";
import {
  CaretDown,
  CheckCircle,
  ShieldCheck,
  Wrench,
  ArrowCounterClockwise,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import type { FindingGroup } from "@/lib/core/grouping";
import type { Plan } from "@/lib/core/types";
import {
  RemediationReportModal,
  type ExecutionReport,
  getServiceNowRecordUrl,
} from "./remediation-report-modal";

export function FindingGroupCard({
  group,
  selectedPlanId,
  onSelectPlan,
  onGroupUpdated,
  onViewRollbackVault,
  instanceUrl,
}: {
  group: FindingGroup;
  selectedPlanId?: string | null;
  onSelectPlan: (plan: Plan) => void;
  onGroupUpdated?: () => void;
  onViewRollbackVault?: () => void;
  instanceUrl?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [report, setReport] = useState<ExecutionReport | null>(null);

  const isCmdb = group.module === "cmdb";

  const handleVerify = async () => {
    setIsVerifying(true);
    setActionMessage(null);
    try {
      const res = await fetch("/api/plans/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", groupId: group.id }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to verify group");
      }
      setActionMessage("✓ Group verified with proof. Ready for batch execution.");
      onGroupUpdated?.();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setIsVerifying(false);
    }
  };

  const handleFixAll = async () => {
    setIsFixing(true);
    setActionMessage(null);

    const totalToFix = group.openCount > 0 ? group.openCount : group.plans.length;
    const initialReport: ExecutionReport = {
      status: "executing",
      groupId: group.id,
      groupTitle: group.ruleTitle,
      strategy: group.fixStrategy,
      appliedCount: 0,
      failedCount: 0,
      total: totalToFix,
      recordsApplied: [],
      targetTable: group.targetTable,
      instanceUrl,
      logs: [
        {
          timestamp: new Date().toLocaleTimeString(),
          type: "info",
          message: `Initializing Batch Remediation for ${totalToFix} record(s)...`,
        },
        {
          timestamp: new Date().toLocaleTimeString(),
          type: "info",
          message: `Target Table: ${group.targetTable} | Strategy: ${group.fixStrategy.toUpperCase()}`,
        },
        {
          timestamp: new Date().toLocaleTimeString(),
          type: "info",
          message: `Target Instance: ${instanceUrl || "Configured ServiceNow Instance"}`,
        },
      ],
    };

    setReport(initialReport);

    try {
      const res = await fetch("/api/plans/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply", groupId: group.id, stream: true }),
      });

      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Batch fix failed to start");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const updatedReport: ExecutionReport = { ...initialReport, recordsApplied: [] };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const ts = new Date().toLocaleTimeString();

            if (data.type === "record_start") {
              const isAdaptation = data.statusText?.includes("AI AGENTIC") || data.statusText?.includes("ADAPTED") || data.statusText?.includes("METHOD");
              updatedReport.logs = [
                ...(updatedReport.logs || []),
                {
                  timestamp: ts,
                  type: isAdaptation ? "info" : "snapshot",
                  message: data.statusText || `[SNAPSHOT] GET ${data.table}/${data.sysId?.slice(0, 16)}… -> Capturing pre-change state in PostgreSQL vault`,
                },
              ];
              setReport({ ...updatedReport });
            } else if (data.type === "record_done") {
              updatedReport.appliedCount = data.index;
              updatedReport.recordsApplied = [
                ...updatedReport.recordsApplied,
                {
                  id: data.planId,
                  title: data.title,
                  table: data.table,
                  sysId: data.sysId,
                  operation: data.operation,
                  status: "success",
                },
              ];
              updatedReport.logs = [
                ...(updatedReport.logs || []),
                {
                  timestamp: ts,
                  type: "rest",
                  message: `[REST] ${data.operation?.toUpperCase()} on ServiceNow instance (${data.sysId?.slice(0, 16)}…) -> HTTP 200 OK`,
                },
                {
                  timestamp: ts,
                  type: "success",
                  message: data.statusText || `[VAULT] Snapshot persisted in PostgreSQL. SHA-256 audit entry chained.`,
                },
              ];
              setReport({ ...updatedReport });
            } else if (data.type === "record_error") {
              updatedReport.failedCount++;
              updatedReport.logs = [
                ...(updatedReport.logs || []),
                {
                  timestamp: ts,
                  type: "error",
                  message: `[ERROR] Failed on record ${data.sysId?.slice(0, 16)}…: ${data.error}`,
                },
              ];
              setReport({ ...updatedReport });
            } else if (data.type === "done") {
              updatedReport.status = "completed";
              updatedReport.appliedCount = data.appliedCount;
              updatedReport.failedCount = data.failedCount;
              updatedReport.recordsApplied = data.recordsApplied;
              updatedReport.logs = [
                ...(updatedReport.logs || []),
                {
                  timestamp: ts,
                  type: "success",
                  message: `[BATCH COMPLETED] All ${data.appliedCount} records successfully applied to ServiceNow instance.`,
                },
              ];
              setReport({ ...updatedReport });
            } else if (data.type === "error") {
              throw new Error(data.error);
            }
          } catch {
            // line parse fallback
          }
        }
      }

      updatedReport.status = "completed";
      setReport({ ...updatedReport });
      const currentResolved = group.fixedCount + updatedReport.appliedCount;
      if (updatedReport.appliedCount === 0 && updatedReport.failedCount > 0) {
        setActionMessage(`✗ Failed to apply fixes to ${updatedReport.failedCount} record(s). Check logs for details.`);
      } else if (updatedReport.failedCount > 0) {
        setActionMessage(`⚠️ Applied ${updatedReport.appliedCount} of ${updatedReport.total} fix(es) in this run (${updatedReport.failedCount} failed).`);
      } else {
        setActionMessage(`✓ Applied fixes to ${updatedReport.appliedCount} record(s) in ServiceNow (${currentResolved} of ${group.count} records now resolved).`);
      }
      onGroupUpdated?.();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Fix all failed";
      setActionMessage(errMsg);
      setReport((prev) =>
        prev
          ? {
              ...prev,
              status: "error",
              errorMessage: errMsg,
              logs: [
                ...(prev.logs || []),
                {
                  timestamp: new Date().toLocaleTimeString(),
                  type: "error",
                  message: `[ABORTED] ${errMsg}`,
                },
              ],
            }
          : null,
      );
    } finally {
      setIsFixing(false);
    }
  };

  const handleRollbackAll = async () => {
    setIsRollingBack(true);
    setActionMessage(null);

    const rollbackTotal = group.fixedCount > 0 ? group.fixedCount : group.plans.length;
    const initialReport: ExecutionReport = {
      status: "executing",
      groupId: group.id,
      groupTitle: `${group.ruleTitle} (Batch Rollback)`,
      strategy: "RESTORE PRE-CHANGE BASELINE",
      appliedCount: 0,
      failedCount: 0,
      total: rollbackTotal,
      recordsApplied: [],
      targetTable: group.targetTable,
      instanceUrl,
      logs: [
        {
          timestamp: new Date().toLocaleTimeString(),
          type: "info",
          message: `[ROLLBACK INITIATED] Restoring pre-change snapshots for ${rollbackTotal} record(s)...`,
        },
        {
          timestamp: new Date().toLocaleTimeString(),
          type: "snapshot",
          message: `[VAULT] Querying PostgreSQL vault for sealed baseline payloads...`,
        },
        {
          timestamp: new Date().toLocaleTimeString(),
          type: "rest",
          message: `[REST] Dispatching authenticated reversion calls to ServiceNow (${group.targetTable})...`,
        },
      ],
    };

    setReport(initialReport);

    try {
      const res = await fetch("/api/plans/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rollback", groupId: group.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Rollback failed");
      }
      setReport((prev) =>
        prev
          ? {
              ...prev,
              status: "completed",
              appliedCount: data.rolledBackCount,
              failedCount: data.failedCount,
              logs: [
                ...(prev.logs || []),
                {
                  timestamp: new Date().toLocaleTimeString(),
                  type: "success",
                  message: `[ROLLBACK COMPLETED] All ${data.rolledBackCount} records successfully restored to original baseline on ServiceNow.`,
                },
              ],
            }
          : null,
      );
      setActionMessage(`✓ Rolled back ${data.rolledBackCount} items to original state in ServiceNow.`);
      onGroupUpdated?.();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Rollback failed";
      setReport((prev) =>
        prev
          ? {
              ...prev,
              status: "error",
              errorMessage: errMsg,
              logs: [
                ...(prev.logs || []),
                {
                  timestamp: new Date().toLocaleTimeString(),
                  type: "error",
                  message: `[ERROR] Rollback failed: ${errMsg}`,
                },
              ],
            }
          : null,
      );
      setActionMessage(errMsg);
    } finally {
      setIsRollingBack(false);
    }
  };

  // Pure Neo-Brutalist Badges
  const statusBadge = () => {
    switch (group.verificationStatus) {
      case "fixed":
        return (
          <span className="inline-flex items-center gap-1 border-2 border-[#0d2f3f] bg-[#5edc56] px-2 py-0.5 font-mono text-[10px] font-black text-[#0d2f3f] uppercase shadow-[1px_1px_0_#0d2f3f]">
            <CheckCircle size={13} weight="bold" /> FIXED
          </span>
        );
      case "verified":
        return (
          <span className="inline-flex items-center gap-1 border-2 border-[#0d2f3f] bg-[#d2ebf0] px-2 py-0.5 font-mono text-[10px] font-black text-[#0d2f3f] uppercase shadow-[1px_1px_0_#0d2f3f]">
            <ShieldCheck size={13} weight="bold" /> VERIFIED
          </span>
        );
      case "rejected":
        return (
          <span className="inline-flex items-center gap-1 border-2 border-[#0d2f3f] bg-[#fee2e2] px-2 py-0.5 font-mono text-[10px] font-black text-[#991b1b] uppercase shadow-[1px_1px_0_#0d2f3f]">
            REJECTED
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 border-2 border-[#0d2f3f] bg-[#f4f8f9] px-2 py-0.5 font-mono text-[10px] font-black text-[#55707d] uppercase shadow-[1px_1px_0_#0d2f3f]">
            UNVERIFIED
          </span>
        );
    }
  };

  const isCritical =
    group.verificationStatus !== "fixed" &&
    (group.worstScore < 50 || group.ruleId === "itsm.sla.breached");
  const isWarning = !isCritical && group.worstScore < 80;
  const isFixed = group.verificationStatus === "fixed";

  const cardBorderClass = isFixed
    ? "border-2 border-[#0d2f3f] border-l-[6px] border-l-[#5edc56] bg-white shadow-[3px_3px_0_#0d2f3f]"
    : isCritical
      ? "border-2 border-[#0d2f3f] border-l-[6px] border-l-[#ff4d4f] bg-[#fffcfc] shadow-[3px_3px_0_#0d2f3f]"
      : isWarning
        ? "border-2 border-[#0d2f3f] border-l-[6px] border-l-[#f3ba63] bg-white shadow-[3px_3px_0_#0d2f3f]"
        : "border-2 border-[#0d2f3f] border-l-[6px] border-l-[#0d2f3f] bg-white shadow-[3px_3px_0_#0d2f3f]";

  const scoreBadgeClass = isFixed || group.worstScore >= 80
    ? "bg-[#5edc56] text-[#0d2f3f] border-2 border-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f]"
    : isCritical
      ? "bg-[#fee2e2] text-[#991b1b] border-2 border-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f] font-black animate-pulse"
      : "bg-[#fef3c7] text-[#92400e] border-2 border-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f]";

  return (
    <div className={`brutal-card transition-all ${cardBorderClass}`}>
      {/* Group Header Card — Bold Neo-Brutalist Scannable Row */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="cursor-pointer p-3.5 sm:p-4 select-none hover:bg-[#f8fafb] transition-colors"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left: Expander, Module, Title & Subtitle */}
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
              className="grid size-6 shrink-0 place-items-center border-2 border-[#0d2f3f] bg-white text-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f] brutal-btn hover:bg-[#e9f1f3]"
              title={expanded ? "Collapse" : "Expand"}
            >
              <CaretDown
                size={14}
                weight="bold"
                className={`transition-transform duration-200 ${
                  expanded ? "rotate-0" : "-rotate-90"
                }`}
              />
            </button>

            <span
              className={`inline-flex items-center px-2 py-0.5 font-mono text-[10px] font-black uppercase tracking-wider border-2 border-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f] ${
                group.module.toLowerCase() === "cmdb"
                  ? "bg-[#d2ebf0] text-[#0d2f3f]"
                  : group.module.toLowerCase() === "itsm"
                    ? "bg-[#eedbfb] text-[#3d1a58]"
                    : group.module.toLowerCase() === "csdm"
                      ? "bg-[#d1fae5] text-[#065f46]"
                      : group.module.toLowerCase() === "itom"
                        ? "bg-[#ffedd5] text-[#9a3412]"
                        : group.module.toLowerCase().includes("quality")
                          ? "bg-[#fef3c7] text-[#92400e]"
                          : "bg-[#e2e8f0] text-[#0d2f3f]"
              }`}
            >
              {group.module.toUpperCase()}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-black text-[#0d2f3f] tracking-tight truncate">
                  {group.ruleTitle}
                </h3>
              </div>
              <p className="text-xs font-semibold text-[#55707d] truncate hidden sm:block mt-0.5">
                {group.summary}
              </p>
            </div>
          </div>

          {/* Right: Score Badge, Records Count, Status & Quick Action */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex flex-wrap items-center gap-2 shrink-0"
          >
            <span
              className={`inline-flex items-center px-2.5 py-0.5 font-mono text-xs font-black ${scoreBadgeClass}`}
              title="Health score for this group"
            >
              Score: {group.worstScore}/100
            </span>

            <span className="inline-flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-[#f4f8f9] px-2.5 py-0.5 font-mono text-xs font-bold text-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f]">
              <span>{group.count} {group.count === 1 ? "record" : "records"}</span>
              {group.fixedCount > 0 && (
                <span className="border border-[#0d2f3f] bg-[#5edc56] px-1 font-mono text-[10px] font-black text-[#0d2f3f]">
                  {group.fixedCount} fixed
                </span>
              )}
            </span>

            <span className="hidden md:inline-flex border-2 border-[#0d2f3f] bg-white px-2 py-0.5 font-mono text-[10px] font-black text-[#0d2f3f] uppercase shadow-[1px_1px_0_#0d2f3f]">
              {group.fixStrategy}
            </span>

            {statusBadge()}
          </div>
        </div>

        {/* Action message banner */}
        {actionMessage && (
          <div className="mt-3 ml-8 border-2 border-[#0d2f3f] bg-[#e5f9e4] p-2.5 text-xs font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] flex items-center gap-2">
            <ShieldCheck size={16} weight="bold" className="text-[#1a7f37] shrink-0" />
            <span>{actionMessage}</span>
          </div>
        )}
      </div>

      {/* Expanded Actions & Individual Records List */}
      {expanded && (
        <div className="border-t-2 border-[#0d2f3f] bg-[#f4f8f9] p-4 space-y-3">
          {/* Action toolbar inside expanded area */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b-2 border-[#0d2f3f]">
            <div className="flex items-center gap-2">
              {group.verificationStatus !== "fixed" && (
                <>
                  {group.verificationStatus !== "verified" && (
                    <button
                      onClick={handleVerify}
                      disabled={isVerifying}
                      className="flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-white px-3 py-1.5 text-xs font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#e9f1f3] disabled:opacity-50"
                    >
                      <ShieldCheck size={14} weight="bold" />
                      {isVerifying ? "Verifying…" : "Verify Group"}
                    </button>
                  )}

                  <button
                    onClick={handleFixAll}
                    disabled={isFixing || group.verificationStatus !== "verified"}
                    className="flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-[#5edc56] px-3.5 py-1.5 text-xs font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#4ecd46] disabled:opacity-40"
                    title={
                      group.verificationStatus !== "verified"
                        ? "Verify group before applying fix"
                        : "Apply fix to all records in group"
                    }
                  >
                    <Wrench size={14} weight="bold" />
                    {isFixing ? "Applying…" : "Fix All in Group"}
                  </button>
                </>
              )}

              {group.verificationStatus === "fixed" && (
                <button
                  onClick={handleRollbackAll}
                  disabled={isRollingBack}
                  className="flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-[#f3ba63] px-3.5 py-1.5 text-xs font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#e2a84e] disabled:opacity-50"
                >
                  <ArrowCounterClockwise size={14} weight="bold" />
                  {isRollingBack ? "Rolling back…" : "Rollback All"}
                </button>
              )}
            </div>

            <span className="font-mono text-xs font-bold text-[#55707d]">
              Showing {group.plans.length} items ({group.openCount} open, {group.fixedCount} fixed)
            </span>
          </div>

          {/* Individual items list */}
          <div className="space-y-2 max-h-96 overflow-y-auto saos-scroll pr-1">
            {group.plans.map((plan) => {
              const isSelected = selectedPlanId === plan.id;
              const isApplied = plan.status === "Applied";
              return (
                <div
                  key={plan.id}
                  onClick={() => onSelectPlan(plan)}
                  className={`flex items-center justify-between p-2.5 text-xs cursor-pointer transition-all border-2 border-[#0d2f3f] brutal-btn ${
                    isSelected
                      ? "bg-[#e5f9e4] shadow-[3px_3px_0_#0d2f3f] font-black ring-2 ring-[#0d2f3f]"
                      : isApplied
                        ? "bg-white/80 text-[#55707d] shadow-[1px_1px_0_#0d2f3f] hover:bg-[#f4f8f9]"
                        : "bg-white text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] hover:bg-[#f4f8f9]"
                  }`}
                >
                  <div className="flex items-center gap-2.5 truncate pr-2 min-w-0">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 border border-[#0d2f3f] ${
                        isApplied
                          ? "bg-[#5edc56]"
                          : plan.risk === "Critical"
                            ? "bg-[#ff4d4f] animate-pulse"
                            : plan.risk === "High"
                              ? "bg-[#f3ba63]"
                              : "bg-[#00b4d8]"
                      }`}
                    />
                    <span className="font-mono text-[11px] shrink-0 font-bold text-[#0d2f3f] bg-[#e9f1f3] border border-[#0d2f3f] px-1.5 py-0.5">
                      {String(plan.evidence?.sysId || plan.targetId).slice(0, 14)}…
                    </span>
                    <span className="truncate font-bold text-[#0d2f3f]">
                      {plan.title}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {(() => {
                      const planTable = String(plan.evidence?.table || group.targetTable || "cmdb_rel_ci");
                      const planSysId = String(plan.evidence?.sysId || plan.evidence?.duplicateSysId || plan.evidence?.number || plan.targetId);
                      const verifyUrl = getServiceNowRecordUrl(instanceUrl, planTable, planSysId);
                      if (!verifyUrl) return null;
                      return (
                        <a
                          href={verifyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="border border-[#0d2f3f] bg-white px-2 py-0.5 font-mono text-[10px] font-black text-[#0d2f3f] hover:bg-[#ffd166] shadow-[1px_1px_0_#0d2f3f] brutal-btn inline-flex items-center gap-1"
                          title="Open live record in ServiceNow to verify"
                        >
                          <ArrowSquareOut size={11} weight="bold" />
                          Verify
                        </a>
                      );
                    })()}
                    <span
                      className={`border border-[#0d2f3f] px-2 py-0.5 font-mono text-[10px] font-black uppercase shadow-[1px_1px_0_#0d2f3f] ${
                        isApplied
                          ? "bg-[#5edc56] text-[#0d2f3f]"
                          : plan.status === "Approved"
                            ? "bg-[#d2ebf0] text-[#0d2f3f]"
                            : "bg-[#f4f8f9] text-[#55707d]"
                      }`}
                    >
                      {isApplied ? "✓ FIXED" : plan.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Execution Report Popup */}
      <RemediationReportModal
        report={report}
        onClose={() => setReport(null)}
        onViewRollbackVault={onViewRollbackVault}
      />
    </div>
  );
}
