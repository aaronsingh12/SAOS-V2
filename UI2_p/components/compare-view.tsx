"use client";

import { useEffect, useState } from "react";
import {
  ArrowsLeftRight,
  PlusCircle,
  PencilSimple,
  Trash,
  CheckCircle,
  ArrowRight,
  ShieldCheck,
  Wrench,
  Database,
  ArrowClockwise,
  CheckSquareOffset,
} from "@phosphor-icons/react";

type DiffRecord = {
  id: string;
  tableName: string;
  sysId: string;
  name?: string;
  type: "added" | "modified" | "removed";
  changes?: { field: string; before: unknown; after: unknown }[];
  details?: Record<string, string>;
};

type CompareData = {
  currentVersion: number;
  availableVersions: number[];
  fromVersion: number;
  toVersion: number;
  hasBaseline: boolean;
  totalCurrent: number;
  totalPrevious: number;
  summary: {
    added: number;
    modified: number;
    unchanged: number;
    removed: number;
  };
  sampleDiffs: DiffRecord[];
};

type AppliedItem = {
  id: string;
  title: string;
  operation?: string;
  targetTable?: string;
  sysId?: string;
};

export function CompareView({
  onRunScan,
}: {
  onRunScan?: () => void;
}) {
  const [data, setData] = useState<CompareData | null>(null);
  const [fromVersion, setFromVersion] = useState<number>(1);
  const [toVersion, setToVersion] = useState<number>(2);
  const [appliedItems, setAppliedItems] = useState<AppliedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "added" | "modified" | "removed">("all");

  const loadData = (from?: number, to?: number) => {
    setLoading(true);
    const query = from && to ? `?from=${from}&to=${to}` : "";
    Promise.all([
      fetch(`/api/compare${query}`, { cache: "no-store" }).then((res) => res.json()),
      fetch("/api/state", { cache: "no-store" }).then((res) => res.json()).catch(() => ({})),
    ])
      .then(([compareData, stateData]) => {
        setData(compareData);
        if (compareData.fromVersion) setFromVersion(compareData.fromVersion);
        if (compareData.toVersion) setToVersion(compareData.toVersion);
        if (stateData?.plans) {
          const applied = (stateData.plans as Array<{
            id: string;
            title: string;
            status: string;
            evidence: Record<string, unknown>;
            targetId: string;
            preview?: { operation?: string };
          }>)
            .filter((p) => p.status === "Applied")
            .map((p) => ({
              id: p.id,
              title: p.title,
              operation: p.preview?.operation || "patch",
              targetTable: String(p.evidence?.table || p.targetId.split(":")[0] || ""),
              sysId: String(p.evidence?.sysId || p.evidence?.number || p.targetId),
            }));
          setAppliedItems(applied);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleVersionChange = (newFrom: number, newTo: number) => {
    setFromVersion(newFrom);
    setToVersion(newTo);
    loadData(newFrom, newTo);
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center border-[3px] border-[#0d2f3f] bg-white p-8 font-mono text-xs font-bold text-[#0d2f3f] shadow-[4px_4px_0_#0d2f3f]">
        <ArrowClockwise size={18} className="animate-spin mr-2" />
        Comparing Twin Version {fromVersion} → Version {toVersion}...
      </div>
    );
  }

  if (!data || !data.hasBaseline) {
    return (
      <div className="border-[3px] border-[#0d2f3f] bg-white p-8 text-center shadow-[4px_4px_0_#0d2f3f] space-y-4">
        <ArrowsLeftRight size={44} className="mx-auto text-[#0d2f3f]" weight="bold" />
        <h3 className="font-display text-xl font-black text-[#0d2f3f]">
          Baseline Snapshot Established (Version {data?.currentVersion ?? 1})
        </h3>
        <p className="mt-2 text-xs text-[#3a5966] font-medium max-w-md mx-auto leading-relaxed">
          Initial ServiceNow twin state has been indexed. Once fixes are applied or a new health scan is initiated via &ldquo;Run Agents &amp; Scan&rdquo;, SAOS will capture exact field-level deltas and drift right here.
        </p>
        {onRunScan && (
          <button
            onClick={onRunScan}
            className="inline-flex items-center gap-2 border-2 border-[#0d2f3f] bg-[#5edc56] px-4 py-2 text-xs font-black text-[#0d2f3f] hover:bg-[#4ecd46] transition-colors shadow-[2px_2px_0_#0d2f3f]"
          >
            <Wrench size={16} weight="bold" />
            Run Agents &amp; Scan to Create Next Snapshot
          </button>
        )}
      </div>
    );
  }

  const filteredDiffs = (data.sampleDiffs || []).filter((d) => {
    if (filter === "all") return true;
    return d.type === filter;
  });

  return (
    <div className="space-y-6">
      {/* Header Summary Banner */}
      <div className="border-[3px] border-[#0d2f3f] bg-white p-5 shadow-[4px_4px_0_#0d2f3f]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="border-2 border-[#0d2f3f] bg-[#5edc56] px-2 py-0.5 font-mono text-[10px] font-black text-[#0d2f3f] uppercase">
                AUTHENTIC TWIN DIFF
              </span>
              <span className="font-mono text-xs font-bold text-[#476371]">
                SNAPSHOT V{data.fromVersion} → SNAPSHOT V{data.toVersion}
              </span>
            </div>
            <h2 className="mt-2 font-display text-2xl font-black text-[#0d2f3f] flex items-center gap-2">
              <ArrowsLeftRight size={24} weight="bold" />
              Twin Snapshot Comparison &amp; Drift Matrix
            </h2>
            <p className="mt-1 text-xs text-[#3a5966] font-medium max-w-2xl leading-relaxed">
              Real-time delta comparison between historical twin snapshots. Shows exact configuration drift and remediation patches with zero artificial or mock entries.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="border-2 border-[#0d2f3f] bg-[#e9f1f3] px-3 py-1.5 font-mono text-xs font-black text-[#0d2f3f]">
              {data.totalCurrent} records in v{data.toVersion}
            </span>
            {onRunScan && (
              <button
                onClick={onRunScan}
                className="flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-[#5edc56] px-3.5 py-1.5 text-xs font-black text-[#0d2f3f] hover:bg-[#4ecd46] transition-colors shadow-[2px_2px_0_#0d2f3f]"
              >
                <Wrench size={14} weight="bold" />
                Scan &amp; Create v{data.currentVersion + 1}
              </button>
            )}
          </div>
        </div>

        {/* Interactive Version Selector Bar */}
        <div className="mt-5 border-2 border-[#0d2f3f] bg-[#eef7fa] p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-[2px_2px_0_#0d2f3f]">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] font-black uppercase text-[#476371]">
                Baseline (From):
              </span>
              <select
                value={fromVersion}
                onChange={(e) => handleVersionChange(Number(e.target.value), toVersion)}
                className="border-2 border-[#0d2f3f] bg-white px-3 py-1.5 text-xs font-black text-[#0d2f3f] outline-none shadow-[2px_2px_0_#0d2f3f] cursor-pointer"
              >
                {data.availableVersions.map((v) => (
                  <option key={v} value={v}>
                    Version {v} {v === 1 ? "(Initial Baseline)" : ""}
                  </option>
                ))}
              </select>
            </div>

            <ArrowRight size={18} weight="bold" className="text-[#0d2f3f] shrink-0" />

            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] font-black uppercase text-[#476371]">
                Target (To):
              </span>
              <select
                value={toVersion}
                onChange={(e) => handleVersionChange(fromVersion, Number(e.target.value))}
                className="border-2 border-[#0d2f3f] bg-white px-3 py-1.5 text-xs font-black text-[#0d2f3f] outline-none shadow-[2px_2px_0_#0d2f3f] cursor-pointer"
              >
                {data.availableVersions.map((v) => (
                  <option key={v} value={v}>
                    Version {v} {v === data.currentVersion ? "(Current Active)" : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Quick Comparison Presets */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] font-bold text-[#476371] uppercase">
              Quick Compare:
            </span>
            {data.availableVersions.length > 2 && (
              <button
                type="button"
                onClick={() => handleVersionChange(1, data.currentVersion)}
                className={`border-2 border-[#0d2f3f] px-2.5 py-1 text-xs font-black transition-all ${
                  fromVersion === 1 && toVersion === data.currentVersion
                    ? "bg-[#5edc56] text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f]"
                    : "bg-white text-[#0d2f3f] hover:bg-neutral-100"
                }`}
              >
                v1 → v{data.currentVersion} (Total Progress)
              </button>
            )}
            {data.currentVersion > 1 && (
              <button
                type="button"
                onClick={() => handleVersionChange(data.currentVersion - 1, data.currentVersion)}
                className={`border-2 border-[#0d2f3f] px-2.5 py-1 text-xs font-black transition-all ${
                  fromVersion === data.currentVersion - 1 && toVersion === data.currentVersion
                    ? "bg-[#5edc56] text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f]"
                    : "bg-white text-[#0d2f3f] hover:bg-neutral-100"
                }`}
              >
                v{data.currentVersion - 1} → v{data.currentVersion} (Latest Delta)
              </button>
            )}
          </div>
        </div>

        {/* 4 Brutalist Delta Metric Cards */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 border-t-2 border-[#0d2f3f] pt-4">
          <div className="border-2 border-[#0d2f3f] bg-[#f8fafb] p-3.5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-xs font-bold text-[#476371]">
                <span className="font-mono text-[10px] uppercase tracking-wider">Added</span>
                <PlusCircle size={16} weight="bold" className="text-emerald-600" />
              </div>
              <div className="mt-1 font-display text-2xl font-black text-emerald-700">
                +{data.summary.added}
              </div>
            </div>
            <p className="mt-2 text-[10px] font-mono text-[#55707d] border-t border-[#0d2f3f]/10 pt-1.5 leading-tight">
              New CIs &amp; tickets created in ServiceNow
            </p>
          </div>

          <div className="border-2 border-[#0d2f3f] bg-[#f8fafb] p-3.5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-xs font-bold text-[#476371]">
                <span className="font-mono text-[10px] uppercase tracking-wider">Modified</span>
                <PencilSimple size={16} weight="bold" className="text-amber-600" />
              </div>
              <div className="mt-1 font-display text-2xl font-black text-amber-700">
                ~{data.summary.modified}
              </div>
            </div>
            <p className="mt-2 text-[10px] font-mono text-[#55707d] border-t border-[#0d2f3f]/10 pt-1.5 leading-tight">
              Existing records with config or state drift
            </p>
          </div>

          <div className="border-2 border-[#0d2f3f] bg-[#f8fafb] p-3.5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-xs font-bold text-[#476371]">
                <span className="font-mono text-[10px] uppercase tracking-wider">Removed</span>
                <Trash size={16} weight="bold" className="text-rose-600" />
              </div>
              <div className="mt-1 font-display text-2xl font-black text-rose-700">
                -{data.summary.removed}
              </div>
            </div>
            <p className="mt-2 text-[10px] font-mono text-[#55707d] border-t border-[#0d2f3f]/10 pt-1.5 leading-tight">
              Records deleted or purged from instance
            </p>
          </div>

          <div className="border-2 border-[#0d2f3f] bg-[#f8fafb] p-3.5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-xs font-bold text-[#476371]">
                <span className="font-mono text-[10px] uppercase tracking-wider">Unchanged</span>
                <CheckCircle size={16} weight="bold" className="text-[#0d2f3f]" />
              </div>
              <div className="mt-1 font-display text-2xl font-black text-[#0d2f3f]">
                {data.summary.unchanged}
              </div>
            </div>
            <p className="mt-2 text-[10px] font-mono text-[#55707d] border-t border-[#0d2f3f]/10 pt-1.5 leading-tight">
              Records in identical operational alignment
            </p>
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-[#0d2f3f] pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setFilter("all")}
            className={`border-2 border-[#0d2f3f] px-3 py-1.5 text-xs font-black transition-colors ${
              filter === "all"
                ? "bg-[#0d2f3f] text-white"
                : "bg-white text-[#0d2f3f] hover:bg-[#e9f1f3]"
            }`}
          >
            All Deltas ({data.summary.added + data.summary.modified + data.summary.removed})
          </button>
          <button
            onClick={() => setFilter("modified")}
            className={`border-2 border-[#0d2f3f] px-3 py-1.5 text-xs font-black transition-colors ${
              filter === "modified"
                ? "bg-amber-600 text-white"
                : "bg-white text-[#0d2f3f] hover:bg-[#e9f1f3]"
            }`}
          >
            Functional Modifications ({data.summary.modified})
          </button>
          <button
            onClick={() => setFilter("added")}
            className={`border-2 border-[#0d2f3f] px-3 py-1.5 text-xs font-black transition-colors ${
              filter === "added"
                ? "bg-emerald-600 text-white"
                : "bg-white text-[#0d2f3f] hover:bg-[#e9f1f3]"
            }`}
          >
            Added ({data.summary.added})
          </button>
          <button
            onClick={() => setFilter("removed")}
            className={`border-2 border-[#0d2f3f] px-3 py-1.5 text-xs font-black transition-colors ${
              filter === "removed"
                ? "bg-rose-600 text-white"
                : "bg-white text-[#0d2f3f] hover:bg-[#e9f1f3]"
            }`}
          >
            Removed ({data.summary.removed})
          </button>
        </div>

        <div className="font-mono text-[11px] text-[#476371]">
          Filtered: <strong>{filteredDiffs.length}</strong> items displayed
        </div>
      </div>

      {/* Changes list */}
      <div className="space-y-3">
        {filteredDiffs.length === 0 ? (
          <div className="border-[3px] border-[#0d2f3f] bg-white p-8 text-center shadow-[4px_4px_0_#0d2f3f] space-y-2">
            <div className="flex items-center justify-center gap-2 text-emerald-700 font-display text-base font-black">
              <CheckCircle size={22} weight="bold" />
              <span>No Configuration Drift Detected</span>
            </div>
            <p className="text-xs text-[#3a5966] font-medium max-w-lg mx-auto">
              Zero functional discrepancies found between Snapshot v{data.fromVersion} and v{data.toVersion}.
              All {data.totalCurrent} tracked records are in identical operational alignment.
            </p>
            <p className="font-mono text-[10px] text-[#476371] uppercase tracking-wider">
              ✓ 100% Authentic Twin Comparison &bull; Background Clock Noise Filtered &bull; Zero Mock Data
            </p>
          </div>
        ) : (
          filteredDiffs.map((diff) => {
            const matchingApplied = appliedItems.find(
              (a) => Boolean(a.sysId && (a.sysId === diff.sysId || diff.id.includes(a.sysId)))
            );

            return (
              <div
                key={diff.id}
                className="border-2 border-[#0d2f3f] bg-white p-4 shadow-[2px_2px_0_#0d2f3f]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
                    <span
                      className={`border border-[#0d2f3f] px-2 py-0.5 font-mono text-[10px] font-black uppercase shrink-0 ${
                        diff.type === "added"
                          ? "bg-emerald-200 text-emerald-900"
                          : diff.type === "modified"
                            ? "bg-amber-200 text-amber-900"
                            : "bg-rose-200 text-rose-900"
                      }`}
                    >
                      {diff.type.toUpperCase()}
                    </span>
                    <span className="font-mono text-xs font-black text-[#0d2f3f] shrink-0 border border-[#0d2f3f]/30 px-1.5 py-0.5 bg-[#f0f4f6]">
                      {diff.tableName}
                    </span>
                    {diff.name && (
                      <span className="font-bold text-xs text-[#0d2f3f]">
                        {diff.name}
                      </span>
                    )}
                    {matchingApplied && (
                      <span className="inline-flex items-center gap-1 border border-emerald-600 bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-950">
                        <CheckSquareOffset size={12} weight="bold" className="text-emerald-700" />
                        REMEDIATED VIA SAOS: {matchingApplied.title}
                      </span>
                    )}
                  </div>

                  <span className="font-mono text-[11px] text-[#476371] select-all">
                    sys_id: {diff.sysId}
                  </span>
                </div>

                {/* Added Record Details */}
                {diff.type === "added" && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-xs border-t border-neutral-200 pt-2.5">
                    <span className="text-emerald-800 bg-emerald-100 border border-emerald-300 px-2 py-0.5 text-[10px] font-black">
                      + NEW RECORD DISCOVERED IN V{data.toVersion}
                    </span>
                    {diff.details &&
                      Object.entries(diff.details).map(([k, v]) =>
                        v ? (
                          <span
                            key={k}
                            className="text-neutral-700 bg-neutral-100 border border-neutral-200 px-2 py-0.5 text-[10px]"
                          >
                            {k}: <strong>{v}</strong>
                          </span>
                        ) : null,
                      )}
                  </div>
                )}

                {/* Removed Record Details */}
                {diff.type === "removed" && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-xs border-t border-neutral-200 pt-2.5">
                    <span className="text-rose-800 bg-rose-100 border border-rose-300 px-2 py-0.5 text-[10px] font-black">
                      - PURGED / REMOVED IN V{data.toVersion}
                    </span>
                    {diff.details &&
                      Object.entries(diff.details).map(([k, v]) =>
                        v ? (
                          <span
                            key={k}
                            className="text-neutral-700 bg-neutral-100 border border-neutral-200 px-2 py-0.5 text-[10px]"
                          >
                            {k}: <strong>{v}</strong>
                          </span>
                        ) : null,
                      )}
                  </div>
                )}

                {/* Field-level changes for modified */}
                {diff.type === "modified" && diff.changes && diff.changes.length > 0 && (
                  <div className="mt-3 space-y-2 border-t border-[#0d2f3f]/15 pt-3 font-mono text-xs">
                    {diff.changes.map((c, i) => (
                      <div
                        key={i}
                        className="flex flex-wrap items-center gap-2 p-2 bg-[#f8fafb] border border-[#0d2f3f]/10 text-xs"
                      >
                        <span className="font-bold text-[#0d2f3f] min-w-[130px]">{c.field}:</span>
                        <span className="text-rose-800 bg-rose-50 border border-rose-200 px-2 py-0.5 line-through break-all">
                          {String(c.before ?? "(empty)")}
                        </span>
                        <ArrowRight size={14} className="text-[#0d2f3f] shrink-0" weight="bold" />
                        <span className="text-emerald-800 bg-emerald-50 border border-emerald-300 px-2 py-0.5 font-bold break-all">
                          {String(c.after ?? "(empty)")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Live Remediation Write-Backs Section */}
      {appliedItems.length > 0 && (
        <div className="border-[3px] border-[#0d2f3f] bg-white p-5 shadow-[4px_4px_0_#0d2f3f] space-y-3">
          <div className="flex items-center justify-between border-b-2 border-[#0d2f3f] pb-2">
            <div className="flex items-center gap-2">
              <ShieldCheck size={20} weight="bold" className="text-emerald-600" />
              <h3 className="font-display text-base font-black text-[#0d2f3f]">
                Active Remediation Write-Backs ({appliedItems.length} Applied)
              </h3>
            </div>
            <span className="font-mono text-[11px] font-bold text-emerald-800 bg-emerald-100 border border-emerald-300 px-2 py-0.5">
              ✓ Captured in Rollback Vault
            </span>
          </div>

          <p className="text-xs text-[#3a5966] font-medium">
            These records have been patched or deleted in ServiceNow with rollback snapshots captured.
          </p>

          <div className="max-h-48 overflow-y-auto space-y-1.5 border border-neutral-300 p-2 bg-[#fdfdfd] saos-scroll">
            {appliedItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2 border border-neutral-200 bg-white px-3 py-1.5 text-xs font-mono"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <CheckCircle size={14} weight="bold" className="text-emerald-600 shrink-0" />
                  <span className="font-bold text-[#0d2f3f] truncate">{item.title}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="bg-[#0d2f3f] text-[#5edc56] px-1.5 py-0.5 text-[9px] uppercase font-black">
                    {item.operation}
                  </span>
                  <span className="text-[#476371] text-[11px] truncate max-w-[140px]">
                    {item.sysId}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* How It Works Explainer Box */}
      <div className="border-[3px] border-[#0d2f3f] bg-[#eef7fa] p-4 shadow-[4px_4px_0_#0d2f3f]">
        <div className="flex items-center gap-2">
          <Database size={18} weight="bold" className="text-[#0d2f3f]" />
          <h4 className="font-mono text-xs font-black text-[#0d2f3f] uppercase tracking-wider">
            HOW TWIN SNAPSHOT DIFF &amp; DRIFT WORKS
          </h4>
        </div>
        <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="border-2 border-[#0d2f3f] bg-white p-2.5">
            <p className="font-black text-[#0d2f3f]">1. Choose Baseline (From)</p>
            <p className="mt-1 text-[11px] text-[#476371]">
              Select Snapshot v{fromVersion} ({data.totalPrevious} records). Compare across any past scan in history.
            </p>
          </div>
          <div className="border-2 border-[#0d2f3f] bg-white p-2.5">
            <p className="font-black text-[#0d2f3f]">2. Choose Target (To)</p>
            <p className="mt-1 text-[11px] text-[#476371]">
              Select Snapshot v{toVersion} ({data.totalCurrent} records). Evaluates all additions, edits &amp; deletions.
            </p>
          </div>
          <div className="border-2 border-[#0d2f3f] bg-white p-2.5">
            <p className="font-black text-[#0d2f3f]">3. Field-Level Traceability</p>
            <p className="mt-1 text-[11px] text-[#476371]">
              Every attribute drift and verified fix is highlighted with Before ➔ After precision (excluding systemic background timestamps &amp; SLA clock counters).
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
