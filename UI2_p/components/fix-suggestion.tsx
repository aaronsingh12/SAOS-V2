"use client";

import { useState } from "react";
import {
  Sparkle,
  Wrench,
  CheckCircle,
  ArrowRight,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import type { FixPlan, FixAction } from "@/lib/ai/prompts";

export function FixSuggestion({
  planId,
  onPlanUpdated,
}: {
  planId: string;
  onPlanUpdated?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [fixPlan, setFixPlan] = useState<FixPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [applying, setApplying] = useState(false);

  const generateFix = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/plans/${planId}/suggest`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate fix plan");
      setFixPlan(data.fixPlan);
      onPlanUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fix generation failed");
    } finally {
      setLoading(false);
    }
  };

  const applySuggestedFix = async () => {
    setApplying(true);
    setError(null);
    try {
      // First approve
      const approveRes = await fetch(`/api/plans/${planId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approve",
          actor: "operator",
          reason: "AI Fix Plan Approved",
        }),
      });
      if (!approveRes.ok) {
        const approveData = await approveRes.json().catch(() => ({}));
        throw new Error(approveData.error || "Approval failed before apply");
      }

      // Then apply
      const res = await fetch(`/api/plans/${planId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: "operator", confirm: "APPLY" }),
      });
      const data = await res.json();
      if (!res.ok) {
        const errMsg = typeof data.error === "string" ? data.error : Array.isArray(data) ? data[0]?.message : "Failed to apply fix";
        throw new Error(errMsg);
      }
      setApplied(true);
      onPlanUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply fix");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-indigo-900/60 bg-indigo-950/20 p-4 min-w-0 max-w-full overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkle size={18} className="text-indigo-400 shrink-0" />
          <h4 className="text-xs font-semibold text-neutral-200 truncate">
            AI Remediation Engine
          </h4>
        </div>
        {!fixPlan && (
          <button
            onClick={generateFix}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-700 bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50 shrink-0"
          >
            <Sparkle size={14} />
            {loading ? "Analyzing & Planning..." : "Generate Fix Plan"}
          </button>
        )}
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-rose-800/80 bg-rose-950/40 p-2.5 text-xs text-rose-300 flex items-center gap-2 break-words [overflow-wrap:anywhere] break-all">
          <WarningCircle size={16} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {fixPlan && (
        <div className="mt-3 space-y-3 min-w-0 max-w-full overflow-hidden">
          {/* Summary & Root Cause */}
          <div className="rounded-lg bg-neutral-900/80 border border-neutral-800 p-3 text-xs space-y-1.5 min-w-0 max-w-full overflow-hidden break-words [overflow-wrap:anywhere] break-all">
            <div>
              <span className="text-neutral-400 font-medium">Proposed Fix: </span>
              <span className="text-neutral-200 font-medium">{fixPlan.summary}</span>
            </div>
            <div>
              <span className="text-neutral-400 font-medium">Root Cause: </span>
              <span className="text-neutral-300">{fixPlan.rootCause}</span>
            </div>
            <div>
              <span className="text-neutral-400 font-medium">Impact If Ignored: </span>
              <span className="text-rose-300/90">{fixPlan.impactIfIgnored}</span>
            </div>
          </div>

          {/* Action Table */}
          {fixPlan.fixActions.length > 0 && (
            <div className="space-y-1.5 min-w-0 max-w-full">
              <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                Planned ServiceNow Operations
              </span>
              {fixPlan.fixActions.map((act: FixAction, idx: number) => (
                <div
                  key={idx}
                  className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-2.5 font-mono text-xs flex items-center justify-between gap-2 min-w-0 max-w-full"
                >
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-300 uppercase">
                      {act.operation}
                    </span>
                    <span className="text-neutral-200">{act.table}</span>
                  </div>
                  <span className="text-neutral-400 text-[11px] truncate min-w-0 max-w-[170px] text-right" title={act.description}>
                    {act.description}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="text-[11px] text-neutral-400 flex items-center gap-1">
              <ShieldCheck size={14} className="text-emerald-400 shrink-0" />
              Pre-validated with rollback capture
            </span>

            {!applied ? (
              <button
                onClick={applySuggestedFix}
                disabled={applying}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-600 bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 transition-colors disabled:opacity-50"
              >
                <Wrench size={14} />
                {applying ? "Applying to ServiceNow..." : "Approve & Apply Fix"}
              </button>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400">
                <CheckCircle size={16} weight="bold" />
                Applied Successfully
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
