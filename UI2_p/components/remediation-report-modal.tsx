"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle,
  ShieldCheck,
  X,
  ArrowRight,
  Table,
  Database,
  ArrowSquareOut,
  Lightning,
  Clock,
  WarningCircle,
  Sparkle,
} from "@phosphor-icons/react";

export type RemediationRecord = {
  id: string;
  title: string;
  operation?: string;
  table?: string;
  sysId?: string;
  status?: "success" | "error" | "pending";
  error?: string;
};

export type LiveLogEntry = {
  timestamp: string;
  type: "info" | "success" | "error" | "snapshot" | "rest";
  message: string;
};

export type ExecutionReport = {
  status?: "executing" | "completed" | "error";
  groupId?: string;
  groupTitle: string;
  strategy: string;
  appliedCount: number;
  failedCount: number;
  total: number;
  recordsApplied: RemediationRecord[];
  targetTable?: string;
  instanceUrl?: string;
  logs?: LiveLogEntry[];
  errorMessage?: string;
  agentTrace?: {
    selfHealed?: boolean;
    attempts?: {
      attemptNumber: number;
      methodName: string;
      status: string;
      adaptationReason?: string;
    }[];
  };
  fixPreview?: {
    whatWasMissing?: string;
    whatIsAdded?: string;
    rootCause?: string;
    fixActions?: {
      operation: string;
      table: string;
      sysId?: string;
      description?: string;
    }[];
  };
};

export function getServiceNowRecordUrl(
  instanceUrl?: string,
  table?: string,
  sysId?: string,
): string | null {
  if (!instanceUrl) return null;
  const baseUrl = instanceUrl.replace(/\/$/, "");
  let cleanId = (sysId || "").trim();
  let cleanTable = (table || "").trim();

  // If cleanId contains colon like 'cmdb_ci_server:4a8b7c6d' or 'incident:abc123'
  if (cleanId.includes(":") && !cleanId.includes("-")) {
    const parts = cleanId.split(":");
    if (!cleanTable && parts.length >= 2) {
      cleanTable = parts[0];
    }
    cleanId = parts[parts.length - 1];
  }

  if (!cleanId && !cleanTable) return baseUrl;

  // Relationship table
  if (cleanTable === "cmdb_rel_ci") {
    if (cleanId && cleanId.length === 32) {
      return `${baseUrl}/cmdb_rel_ci.do?sys_id=${encodeURIComponent(cleanId)}`;
    }
    return `${baseUrl}/cmdb_rel_ci_list.do?sysparm_query=sys_id%3D${encodeURIComponent(cleanId)}`;
  }

  // Incident or Task by number (e.g. INC0010042, CHG0001234)
  if (/^[A-Z]{2,4}\d{4,9}$/i.test(cleanId)) {
    const taskTable = cleanTable || "task";
    return `${baseUrl}/${encodeURIComponent(taskTable)}.do?sysparm_query=number%3D${encodeURIComponent(cleanId)}`;
  }

  if (cleanTable && cleanId) {
    return `${baseUrl}/${encodeURIComponent(cleanTable)}.do?sys_id=${encodeURIComponent(cleanId)}`;
  }

  if (cleanId) {
    return `${baseUrl}/nav_to.do?uri=${encodeURIComponent(`cmdb_ci.do?sys_id=${encodeURIComponent(cleanId)}`)}`;
  }

  if (cleanTable) {
    return `${baseUrl}/${encodeURIComponent(cleanTable)}_list.do`;
  }

  return baseUrl;
}

export function RemediationReportModal({
  report,
  onClose,
  onViewRollbackVault,
}: {
  report: ExecutionReport | null;
  onClose: () => void;
  onViewRollbackVault?: () => void;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!report) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [report]);

  if (!mounted || !report) return null;

  const isExecuting = report.status === "executing";
  const isError = report.status === "error";
  const progressPercent = Math.min(
    100,
    Math.round(((report.appliedCount + report.failedCount) / Math.max(1, report.total)) * 100),
  );

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs animate-saos-page-enter"
      onClick={() => {
        if (!isExecuting) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl border-[3px] border-[#0d2f3f] bg-white shadow-[8px_8px_0_#0d2f3f] overflow-hidden flex flex-col max-h-[92vh] my-auto"
      >
        {/* Header */}
        <div className="border-b-[3px] border-[#0d2f3f] bg-[#0d2f3f] p-4 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            {isExecuting ? (
              <span className="inline-flex items-center gap-1.5 border-2 border-[#ffd166] bg-[#ffd166] px-2.5 py-0.5 font-mono text-[10px] font-black text-[#0d2f3f] uppercase shadow-[1px_1px_0_#ffd166]">
                <span className="size-2 rounded-full bg-[#0d2f3f] animate-ping" />
                EXECUTING LIVE WRITES
              </span>
            ) : isError ? (
              <span className="inline-flex items-center gap-1 border-2 border-[#ff4d4d] bg-[#ff4d4d] px-2.5 py-0.5 font-mono text-[10px] font-black text-white uppercase shadow-[1px_1px_0_#ff4d4d]">
                <WarningCircle size={13} weight="bold" /> EXECUTION FAILED
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 border-2 border-[#5edc56] bg-[#5edc56] px-2.5 py-0.5 font-mono text-[10px] font-black text-[#0d2f3f] uppercase shadow-[1px_1px_0_#5edc56]">
                <CheckCircle size={13} weight="bold" /> REMEDIATION APPLIED
              </span>
            )}
            <h3 className="font-display text-base font-black truncate text-white">
              {report.groupTitle}
            </h3>
          </div>
          {!isExecuting && (
            <button
              onClick={onClose}
              className="grid size-7 place-items-center border border-white/30 text-white hover:bg-white/20 transition-colors brutal-btn shrink-0"
              title="Close modal"
            >
              <X size={16} weight="bold" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1 saos-scroll bg-[#f4f8f9]">
          {/* Target Instance Banner */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-2 border-[#0d2f3f] bg-[#eef7fa] px-3.5 py-2 text-xs font-mono shadow-[2px_2px_0_#0d2f3f]">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-[#5edc56] animate-pulse" />
              <span className="font-bold text-[#476371]">TARGET INSTANCE:</span>
              <span className="font-black text-[#0d2f3f]">
                {report.instanceUrl || "Configured ServiceNow Instance"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-[#476371]">STRATEGY:</span>
              <span className="border border-[#0d2f3f] bg-white px-2 py-0.5 font-black uppercase text-[#0d2f3f]">
                {report.strategy}
              </span>
            </div>
          </div>

          {/* Quick Verification Callout (When Applied) */}
          {report.status === "completed" && report.recordsApplied.length > 0 && (
            <div className="border-2 border-[#0d2f3f] bg-[#ffd166] p-3 shadow-[2px_2px_0_#0d2f3f] flex flex-wrap items-center justify-between gap-2.5 animate-saos-page-enter">
              <div className="flex items-center gap-2">
                <ShieldCheck size={22} weight="bold" className="text-[#0d2f3f] shrink-0" />
                <div>
                  <p className="font-mono text-xs font-black text-[#0d2f3f] uppercase">
                    Live Mutation Applied to ServiceNow
                  </p>
                  <p className="text-[11px] font-bold text-[#0d2f3f]/80">
                    Verify this fix directly on your live ServiceNow instance with 1-click:
                  </p>
                </div>
              </div>
              {(() => {
                const firstRec = report.recordsApplied[0];
                const targetTable = firstRec?.table || report.targetTable || "cmdb_rel_ci";
                const directUrl = getServiceNowRecordUrl(report.instanceUrl, targetTable, firstRec?.sysId);
                if (!directUrl) return null;
                return (
                  <a
                    href={directUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-white px-3 py-1.5 font-mono text-xs font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#eef7fa] shrink-0"
                  >
                    <ArrowSquareOut size={14} weight="bold" />
                    Verify on ServiceNow ↗
                  </a>
                );
              })()}
            </div>
          )}

          {/* Self-Healing Agentic Loop Banner */}
          {(report.agentTrace?.selfHealed ||
            (report.logs &&
              report.logs.some((l) => l.message.includes("Self-healed") || l.message.includes("ADAPTED")))) && (
            <div className="border-2 border-[#0d2f3f] bg-[#e0f2fe] p-3 shadow-[2px_2px_0_#0d2f3f] flex items-center justify-between gap-3 animate-saos-page-enter">
              <div className="flex items-center gap-2.5">
                <Sparkle size={20} weight="fill" className="text-[#0284c7] shrink-0" />
                <div>
                  <p className="font-mono text-xs font-black text-[#0369a1] uppercase">
                    Self-Healing Agentic Loop Succeeded
                  </p>
                  <p className="text-[11px] font-bold text-[#0369a1]/85">
                    Initial method encountered a ServiceNow constraint. The AI agent autonomously formulated an alternative method that succeeded and was verified on your instance.
                  </p>
                </div>
              </div>
              <span className="border border-[#0284c7] bg-white px-2 py-0.5 font-mono text-[10px] font-black uppercase text-[#0369a1] shrink-0">
                Self-Healed
              </span>
            </div>
          )}

          {/* Progress Bar (Always visible during execution and shows 100% on complete) */}
          <div className="space-y-1.5 border-2 border-[#0d2f3f] bg-white p-3.5 shadow-[2px_2px_0_#0d2f3f]">
            <div className="flex items-center justify-between text-xs font-mono font-black text-[#0d2f3f]">
              <span className="flex items-center gap-1.5">
                <Lightning size={15} weight="fill" className="text-amber-500" />
                {isExecuting
                  ? `Remediating Records (${report.appliedCount + report.failedCount} of ${report.total})...`
                  : `Remediation Complete: ${report.appliedCount} of ${report.total} records updated`}
              </span>
              <span className="border border-[#0d2f3f] bg-[#ffd166] px-2 py-0.2">
                {isExecuting ? `${progressPercent}%` : "100% COMPLETE"}
              </span>
            </div>
            <div className="h-4 w-full border-2 border-[#0d2f3f] bg-[#eef7fa] overflow-hidden p-[2px] shadow-[inset_1px_1px_0_#0d2f3f]">
              <div
                className={`h-full border-r-2 border-[#0d2f3f] transition-all duration-300 ${
                  isError ? "bg-[#ff4d4d]" : "bg-[#5edc56]"
                }`}
                style={{
                  width: `${Math.max(4, isExecuting ? progressPercent : 100)}%`,
                }}
              />
            </div>
          </div>

          {/* AI Agentic Fix Preview Card */}
          {report.fixPreview && (
            <div className="space-y-2 border-2 border-[#0d2f3f] bg-[#f4f8f9] p-3 shadow-[2px_2px_0_#0d2f3f]">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] font-black uppercase text-[#0d2f3f] flex items-center gap-1.5">
                  <Sparkle size={13} weight="fill" className="text-amber-500" />
                  AI Remediation Plan &amp; Target Operations
                </span>
                <span className="font-mono text-[9px] font-black uppercase border border-[#0d2f3f] bg-white px-1.5 py-0.5 text-[#0d2f3f]">
                  Live REST Write
                </span>
              </div>

              {report.fixPreview.whatWasMissing && (
                <div className="border border-[#0d2f3f] bg-[#fee2e2] p-2 text-xs">
                  <span className="font-mono text-[9px] font-black uppercase text-[#991b1b]">
                    🔴 What is Broken on ServiceNow:
                  </span>
                  <p className="font-bold text-[#991b1b] text-[11px] mt-0.5 leading-snug">
                    {report.fixPreview.whatWasMissing}
                  </p>
                </div>
              )}

              {report.fixPreview.whatIsAdded && (
                <div className="border border-[#0d2f3f] bg-[#e5f9e4] p-2 text-xs">
                  <span className="font-mono text-[9px] font-black uppercase text-[#0d2f3f]">
                    🟢 Live Remediation on ServiceNow:
                  </span>
                  <p className="font-black text-[#0d2f3f] text-[11px] mt-0.5 leading-snug">
                    {report.fixPreview.whatIsAdded}
                  </p>
                </div>
              )}

              {report.fixPreview.fixActions && report.fixPreview.fixActions.length > 0 && (
                <div className="space-y-1">
                  {report.fixPreview.fixActions.map((act, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between border border-[#0d2f3f] bg-white px-2 py-1 font-mono text-[10px]"
                    >
                      <span className="font-black text-[#0d2f3f] uppercase">
                        [{act.operation.toUpperCase()}] {act.table}
                      </span>
                      <span className="text-[#55707d] truncate max-w-[300px] text-right font-bold">
                        {act.description || act.sysId}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Summary Stat Grid */}
          <div className="grid grid-cols-3 gap-3">
            <div className="border-2 border-[#0d2f3f] bg-white p-3 text-center shadow-[2px_2px_0_#0d2f3f]">
              <p className="font-display text-3xl font-black text-[#1a7f37]">
                {report.appliedCount}
              </p>
              <p className="font-mono text-[10px] font-black uppercase text-[#476371] mt-0.5">
                RECORDS MODIFIED
              </p>
            </div>
            <div className="border-2 border-[#0d2f3f] bg-white p-3 text-center shadow-[2px_2px_0_#0d2f3f]">
              <p className="font-display text-xl font-black text-[#0d2f3f] truncate">
                {report.targetTable || report.recordsApplied[0]?.table || "cmdb_rel_ci"}
              </p>
              <p className="font-mono text-[10px] font-black uppercase text-[#476371] mt-0.5">
                TARGET TABLE
              </p>
            </div>
            <div className="border-2 border-[#0d2f3f] bg-white p-3 text-center shadow-[2px_2px_0_#0d2f3f]">
              <p className="font-display text-3xl font-black text-[#0d2f3f]">
                {report.appliedCount}
              </p>
              <p className="font-mono text-[10px] font-black uppercase text-[#476371] mt-0.5">
                ROLLBACK SNAPSHOTS
              </p>
            </div>
          </div>

          {/* Live Execution Console Terminal */}
          <div className="border-2 border-[#0d2f3f] bg-[#0d2f3f] text-[#a4e2a1] p-3.5 font-mono text-[11px] leading-relaxed shadow-[inset_2px_2px_0_#000]">
            <div className="text-white/60 mb-2 border-b border-white/20 pb-1.5 flex items-center justify-between text-[10px]">
              <span className="flex items-center gap-1.5 font-bold">
                <Clock size={12} weight="bold" /> LIVE REST EXECUTION &amp; SNAPSHOT LOG
              </span>
              <span className="text-[#5edc56] font-bold">
                {isExecuting ? "● STREAMING LIVE" : "✓ FINISHED"}
              </span>
            </div>
            <div className="h-40 overflow-y-auto saos-scroll space-y-1 select-text">
              {(!report.logs || report.logs.length === 0) ? (
                <div className="text-neutral-400 py-4 text-center">
                  Connecting to ServiceNow Table REST API...
                </div>
              ) : (
                report.logs.map((log, idx) => (
                  <div key={idx} className="flex items-start gap-2">
                    <span className="text-neutral-400 shrink-0 select-none">
                      [{log.timestamp}]
                    </span>
                    <span
                      className={
                        log.type === "error"
                          ? "text-rose-400 font-bold"
                          : log.type === "success"
                            ? "text-[#5edc56] font-bold"
                            : log.type === "snapshot"
                              ? "text-cyan-300 font-semibold"
                              : log.type === "rest"
                                ? "text-amber-300 font-semibold"
                                : "text-white"
                      }
                    >
                      {log.message}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Reversibility Assurance Banner */}
          <div className="flex items-start gap-2.5 border-2 border-[#0d2f3f] bg-[#e5f9e4] p-3 text-xs text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f]">
            <ShieldCheck size={22} weight="bold" className="text-[#1a7f37] shrink-0 mt-0.5" />
            <div>
              <p className="font-black text-[#0d2f3f]">Pre-Change Rollback Captured in Local Vault</p>
              <p className="mt-0.5 text-[11px] font-bold text-[#35525e] leading-relaxed">
                Prior to updating ServiceNow, each original record state was captured in local PostgreSQL. You can revert this entire batch with 1-click at any time from the Rollback Vault.
              </p>
            </div>
          </div>

          {/* Detailed Records List with Direct ServiceNow Verify Links */}
          <div className="border-2 border-[#0d2f3f] bg-white p-3.5 shadow-[2px_2px_0_#0d2f3f] overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#0d2f3f] pb-2 mb-2.5">
              <span className="font-mono text-[11px] font-black text-[#0d2f3f] uppercase flex items-center gap-1.5 shrink-0">
                <Table size={14} weight="bold" />
                Updated Records &amp; Live Verification Links ({report.recordsApplied.length})
              </span>
              <span
                className="font-mono text-[10px] font-bold text-[#476371] max-w-[280px] sm:max-w-[360px] truncate"
                title={report.strategy}
              >
                Strategy: {report.strategy.toUpperCase()}
              </span>
            </div>

            <div className="max-h-56 overflow-y-auto overflow-x-hidden space-y-2 p-1 saos-scroll">
              {report.recordsApplied.length === 0 ? (
                <p className="text-xs text-neutral-500 py-4 text-center font-medium">
                  {isExecuting ? "Executing initial records..." : "No individual records modified."}
                </p>
              ) : (
                report.recordsApplied.map((rec, idx) => {
                  const targetTable = rec.table || report.targetTable || "cmdb_rel_ci";
                  const verifyUrl = getServiceNowRecordUrl(
                    report.instanceUrl,
                    targetTable,
                    rec.sysId,
                  );

                  return (
                    <div
                      key={rec.id || idx}
                      className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 border-2 border-[#0d2f3f] bg-[#f8fafb] px-3 py-2 text-xs font-mono shadow-[2px_2px_0_#0d2f3f] max-w-full overflow-hidden"
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <CheckCircle size={16} weight="bold" className="text-[#1a7f37] shrink-0" />
                        <div className="min-w-0 flex-1">
                          <span
                            className="font-black text-[#0d2f3f] block truncate"
                            title={rec.sysId || rec.title}
                          >
                            {rec.sysId || rec.title}
                          </span>
                          {rec.title && rec.sysId && rec.title !== rec.sysId && (
                            <span
                              className="text-[10px] text-neutral-500 truncate block"
                              title={rec.title}
                            >
                              {rec.title}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {targetTable && (
                          <span className="border border-[#0d2f3f] bg-white px-1.5 py-0.5 text-[10px] font-bold text-[#0d2f3f]">
                            {targetTable}
                          </span>
                        )}
                        <span
                          className="border border-[#0d2f3f] bg-[#0d2f3f] text-[#5edc56] px-1.5 py-0.5 text-[9px] uppercase font-black max-w-[180px] truncate block"
                          title={rec.operation || "REMEDIATED"}
                        >
                          {rec.operation || "REMEDIATED"}
                        </span>

                        {/* Direct Clickable Verification Link to ServiceNow */}
                        {verifyUrl && (
                          <a
                            href={verifyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 border-2 border-[#0d2f3f] bg-[#ffd166] px-2.5 py-1 text-[10px] font-black text-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f] brutal-btn hover:bg-[#ffc233] transition-colors shrink-0"
                            title="Open live record directly in ServiceNow to verify fix"
                          >
                            <ArrowSquareOut size={12} weight="bold" />
                            Verify in ServiceNow
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t-[3px] border-[#0d2f3f] bg-white p-4 flex flex-wrap items-center justify-between gap-3">
          <button
            disabled={isExecuting}
            onClick={onClose}
            className="border-2 border-[#0d2f3f] bg-white px-4 py-2 text-xs font-black text-[#0d2f3f] hover:bg-[#f4f8f9] transition-colors shadow-[2px_2px_0_#0d2f3f] brutal-btn disabled:opacity-50"
          >
            {isExecuting ? "Executing…" : "Close"}
          </button>

          <div className="flex items-center gap-2">
            {report.instanceUrl && (
              <a
                href={report.instanceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-white px-3.5 py-2 text-xs font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#ffd166] transition-colors"
              >
                <ArrowSquareOut size={15} weight="bold" />
                Open ServiceNow Instance
              </a>
            )}

            {onViewRollbackVault && (
              <button
                disabled={isExecuting}
                onClick={() => {
                  onClose();
                  onViewRollbackVault();
                }}
                className="flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-[#5edc56] px-4 py-2 text-xs font-black text-[#0d2f3f] hover:bg-[#4ecd46] transition-colors shadow-[2px_2px_0_#0d2f3f] brutal-btn disabled:opacity-50"
              >
                <Database size={16} weight="bold" />
                View in Rollback Vault <ArrowRight size={14} weight="bold" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
