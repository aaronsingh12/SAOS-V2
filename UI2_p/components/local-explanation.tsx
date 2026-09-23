"use client";

import { useEffect, useState } from "react";
import { Sparkle, ShieldCheck, WarningCircle, ArrowClockwise } from "@phosphor-icons/react";
import type { FixPlan } from "@/lib/ai/prompts";

type Status = { available: boolean; model: string; message: string };

export function LocalExplanation({
  planId,
  planStatus,
  approvedBy,
  onPlanUpdated,
}: {
  planId: string;
  planStatus?: string;
  approvedBy?: string | null;
  onPlanUpdated?: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [fixPlan, setFixPlan] = useState<FixPlan | null>(null);
  const [explanation, setExplanation] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/ai/status", { cache: "no-store" })
        .then((response) => response.json())
        .then((value: Status) => setStatus(value))
        .catch(() =>
          setStatus({
            available: false,
            model: "",
            message: "Local model unavailable",
          }),
        );
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function generateFix() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/plans/${planId}/suggest`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Fix generation failed");
      setFixPlan(data.fixPlan);
      onPlanUpdated?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Fix generation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 border-t-2 border-[#0d2f3f] pt-4 min-w-0 max-w-full overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] font-bold tracking-wider text-[#476371] uppercase truncate">
          AI AGENTIC FIX & EXPLANATION
        </p>
        <span className="text-[10px] font-mono font-bold text-[#476371] shrink-0">
          {status?.model ? `Model: ${status.model}` : "Ollama"}
        </span>
      </div>

      <p className="mt-1 text-xs text-[#3a5966] font-medium break-words [overflow-wrap:anywhere]">
        Formulate an exact, reversible REST fix plan targeting this record in ServiceNow.
      </p>

      {!fixPlan && (
        <button
          disabled={!status?.available || busy}
          onClick={() => void generateFix()}
          type="button"
          className="mt-3 flex w-full items-center justify-center gap-2 border-2 border-[#0d2f3f] bg-[#5edc56] px-3 py-2 text-xs font-black text-[#0d2f3f] hover:bg-[#4ecd46] transition-colors disabled:opacity-40 shadow-[2px_2px_0_#0d2f3f]"
        >
          <Sparkle size={16} weight="bold" />
          {busy ? "Analyzing & Generating Fix Plan…" : "Generate Fix Plan by LLM"}
        </button>
      )}

      {!status?.available && (
        <p className="mt-2 text-xs text-[#476371] break-words">
          {status?.message ?? "Checking local model…"} Set up Ollama in Settings to enable agentic fixes.
        </p>
      )}

      {fixPlan && (
        <div className="mt-3 border-2 border-[#0d2f3f] bg-[#f4f8fa] p-3 text-xs space-y-2.5 min-w-0 max-w-full overflow-hidden break-words [overflow-wrap:anywhere]">
          <div className="flex items-center justify-between border-b border-neutral-300 pb-2">
            <div className="break-words [overflow-wrap:anywhere] break-all">
              <span className="text-[#476371] font-bold">Action: </span>
              <span className="text-[#0d2f3f] font-black">{fixPlan.summary}</span>
            </div>
            <button
              disabled={busy}
              onClick={() => void generateFix()}
              className="text-[10px] font-mono font-bold text-neutral-600 hover:text-neutral-900 border border-neutral-300 bg-white px-1.5 py-0.5 shrink-0 ml-2 shadow-[1px_1px_0_#0d2f3f]"
              title="Re-run LLM prompt for alternative remediation"
            >
              {busy ? "…" : "Regenerate"}
            </button>
          </div>

          <div className="break-words [overflow-wrap:anywhere] break-all">
            <span className="text-[#476371] font-bold">Root Cause: </span>
            <span className="text-[#0d2f3f] font-medium">{fixPlan.rootCause}</span>
          </div>

          <div className="break-words [overflow-wrap:anywhere] break-all">
            <span className="text-[#476371] font-bold">Risk if Ignored: </span>
            <span className="text-rose-700 font-bold">{fixPlan.impactIfIgnored}</span>
          </div>

          {fixPlan.fixActions.length > 0 && (
            <div className="space-y-1.5 pt-1 min-w-0 max-w-full">
              <span className="font-mono text-[10px] text-[#476371] font-bold uppercase tracking-wider">
                Planned ServiceNow Operations
              </span>
              {fixPlan.fixActions.map((act, idx) => (
                <div
                  key={idx}
                  className="border border-[#0d2f3f] bg-white p-2 font-mono text-[11px] flex items-center justify-between gap-2 min-w-0 max-w-full shadow-[1px_1px_0_#0d2f3f]"
                >
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="bg-[#0d2f3f] text-[#5edc56] px-1.5 py-0.5 text-[10px] uppercase font-black">
                      {act.operation}
                    </span>
                    <span className="text-[#0d2f3f] font-bold">{act.table}</span>
                  </div>
                  <span className="text-[#476371] truncate min-w-0 max-w-[170px] text-right font-medium" title={act.description}>
                    {act.description}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="pt-2 flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200">
            <span className="text-[11px] text-[#476371] font-bold flex items-center gap-1">
              <ShieldCheck size={14} weight="bold" className="text-emerald-700 shrink-0" />
              Reversible via rollback snapshot
            </span>

            {planStatus === "Applied" ? (
              <span className="text-xs font-black text-emerald-800 bg-emerald-100 border border-emerald-300 px-2.5 py-0.5">
                ✓ Fix Applied in ServiceNow
              </span>
            ) : (
              <span className="text-[10px] font-mono font-bold text-[#0d2f3f] bg-emerald-100 border border-emerald-300 px-2 py-0.5">
                Review &amp; Apply in Controls Below ↓
              </span>
            )}
          </div>
        </div>
      )}

      {error && planStatus !== "Approved" && (
        <p role="alert" className="mt-2 text-xs font-bold text-rose-700 flex items-center gap-1 break-words [overflow-wrap:anywhere] break-all border border-rose-300 bg-rose-50 p-2">
          <WarningCircle size={14} weight="bold" className="shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
