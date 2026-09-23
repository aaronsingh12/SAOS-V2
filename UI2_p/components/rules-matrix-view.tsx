"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ShieldCheck,
  WarningCircle,
  CheckCircle,
  Clock,
  MagnifyingGlass,
  FileCode,
  DownloadSimple,
  CaretRight,
  X,
  Sliders,
  Database,
  Cpu,
  ArrowsLeftRight,
  GitBranch,
  Table,
  Info,
} from "@phosphor-icons/react";
import type { MasterRule, RuleDomain, RuleSeverity } from "@/lib/rules/catalog";

const DOMAINS: (RuleDomain | "All")[] = [
  "All",
  "CMDB",
  "ITSM",
  "ITOM",
  "Platform",
  "Data Quality",
];

const SEVERITIES: (RuleSeverity | "All")[] = [
  "All",
  "Systemic",
  "Critical",
  "High",
  "Moderate",
  "Low",
];

export function RulesMatrixView() {
  const [rules, setRules] = useState<MasterRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDomain, setSelectedDomain] = useState<RuleDomain | "All">("All");
  const [selectedSeverity, setSelectedSeverity] = useState<RuleSeverity | "All">("All");
  const [selectedLane, setSelectedLane] = useState<number | "All">("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [inspectingRule, setInspectingRule] = useState<MasterRule | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/rules", { signal: controller.signal, cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        setRules(data.rules || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const domainCounts = useMemo(() => {
    const counts: Record<string, number> = { All: rules.length };
    for (const r of rules) {
      counts[r.domain] = (counts[r.domain] || 0) + 1;
    }
    return counts;
  }, [rules]);

  const filteredRules = useMemo(() => {
    return rules.filter((rule) => {
      if (selectedDomain !== "All" && rule.domain !== selectedDomain) return false;
      if (selectedSeverity !== "All" && rule.baseSeverity !== selectedSeverity) return false;
      if (selectedLane !== "All" && rule.remediationLane !== selectedLane) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          rule.id.toLowerCase().includes(q) ||
          rule.title.toLowerCase().includes(q) ||
          rule.group.toLowerCase().includes(q) ||
          rule.sourceTables.toLowerCase().includes(q) ||
          rule.whatItMeans.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [rules, selectedDomain, selectedSeverity, selectedLane, searchQuery]);

  const severityBadge = (sev: RuleSeverity) => {
    switch (sev) {
      case "Systemic":
        return "bg-purple-950/40 text-purple-400 border-purple-800/60";
      case "Critical":
        return "bg-rose-950/40 text-rose-400 border-rose-800/60";
      case "High":
        return "bg-amber-950/40 text-amber-400 border-amber-800/60";
      case "Moderate":
        return "bg-blue-950/40 text-blue-400 border-blue-800/60";
      case "Low":
        return "bg-neutral-800/60 text-neutral-400 border-neutral-700/60";
    }
  };

  const laneBadge = (lane: number) => {
    switch (lane) {
      case 1:
        return "bg-emerald-950/40 text-emerald-400 border-emerald-800/60";
      case 2:
        return "bg-cyan-950/40 text-cyan-400 border-cyan-800/60";
      case 3:
        return "bg-amber-950/40 text-amber-400 border-amber-800/60";
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 backdrop-blur-xl relative overflow-hidden">
        <div className="absolute -right-16 -top-16 h-64 w-64 rounded-full bg-cyan-500/5 blur-3xl pointer-events-none" />
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
              <span className="text-xs font-mono font-semibold tracking-wider text-cyan-400 uppercase">
                Enterprise Health Rules Matrix
              </span>
            </div>
            <h2 className="text-2xl font-bold text-white mt-1">
              755 Operational Governance Rules
            </h2>
            <p className="text-sm text-neutral-400 mt-1 max-w-2xl">
              Deterministic, mathematical rule articulation schema spanning CMDB, ITSM, ITOM,
              Platform, and Data Quality with complete provenance, false-positive guards, and remediation lanes.
            </p>
          </div>

          <div className="flex items-center gap-2 font-mono text-xs">
            <div className="rounded-xl border border-neutral-800 bg-black/40 px-3 py-2 text-center">
              <div className="text-neutral-500 text-[10px] uppercase">Catalog Rules</div>
              <div className="text-lg font-bold text-white">{rules.length || "755"}</div>
            </div>
            <div className="rounded-xl border border-neutral-800 bg-black/40 px-3 py-2 text-center">
              <div className="text-neutral-500 text-[10px] uppercase">Active Filter</div>
              <div className="text-lg font-bold text-cyan-400">{filteredRules.length}</div>
            </div>
          </div>
        </div>

        {/* Domain Filter Tabs */}
        <div className="mt-6 flex flex-wrap gap-2 border-t border-neutral-800/60 pt-4">
          {DOMAINS.map((domain) => {
            const count = domainCounts[domain] ?? 0;
            const active = selectedDomain === domain;
            return (
              <button
                key={domain}
                onClick={() => setSelectedDomain(domain)}
                className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                  active
                    ? "bg-cyan-500/10 text-cyan-300 border border-cyan-500/40 shadow-sm"
                    : "bg-neutral-800/40 text-neutral-400 border border-neutral-800 hover:text-neutral-200 hover:bg-neutral-800"
                }`}
              >
                <span>{domain}</span>
                <span
                  className={`rounded-full px-1.5 py-0.2 text-[10px] font-mono ${
                    active ? "bg-cyan-500/20 text-cyan-300" : "bg-neutral-800 text-neutral-500"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Control Bar: Search & Sub-Filters */}
      <div className="flex flex-col md:flex-row gap-3 items-center justify-between">
        <div className="relative w-full md:w-96">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <input
            type="text"
            placeholder="Search by ID (e.g. DQ-001), Title, Table, or Keyword..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-neutral-800 bg-neutral-900/60 pl-9 pr-8 py-2 text-xs text-white placeholder-neutral-500 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          {/* Severity filter */}
          <div className="flex items-center gap-1 text-xs">
            <span className="text-neutral-500 font-mono text-[11px]">Severity:</span>
            <select
              value={selectedSeverity}
              onChange={(e) => setSelectedSeverity(e.target.value as any)}
              className="rounded-lg border border-neutral-800 bg-neutral-900/80 px-2.5 py-1.5 text-xs text-neutral-300 focus:border-cyan-500/50 focus:outline-none"
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {/* Lane filter */}
          <div className="flex items-center gap-1 text-xs">
            <span className="text-neutral-500 font-mono text-[11px]">Lane:</span>
            <select
              value={selectedLane}
              onChange={(e) =>
                setSelectedLane(e.target.value === "All" ? "All" : parseInt(e.target.value, 10))
              }
              className="rounded-lg border border-neutral-800 bg-neutral-900/80 px-2.5 py-1.5 text-xs text-neutral-300 focus:border-cyan-500/50 focus:outline-none"
            >
              <option value="All">All Lanes</option>
              <option value="1">Lane 1 (Direct Auto-Fix)</option>
              <option value="2">Lane 2 (Update Set XML / Config)</option>
              <option value="3">Lane 3 (Guided Decision)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Rules Table / Cards */}
      {loading ? (
        <div className="flex flex-col items-center justify-center p-16 text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-500 border-t-transparent" />
          <p className="mt-4 text-xs font-mono text-neutral-400">
            Loading 755 Master Rules & Articulation Schema...
          </p>
        </div>
      ) : filteredRules.length === 0 ? (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-12 text-center">
          <WarningCircle size={32} className="mx-auto text-neutral-600 mb-2" />
          <p className="text-sm font-medium text-neutral-400">No matching rules found</p>
          <p className="text-xs text-neutral-600 mt-1">Try clearing your search query or filters.</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 overflow-hidden shadow-2xl">
          <div className="divide-y divide-neutral-800/60">
            {filteredRules.slice(0, 100).map((rule) => (
              <div
                key={rule.id}
                onClick={() => setInspectingRule(rule)}
                className="group flex flex-col md:flex-row md:items-center justify-between p-4 gap-4 hover:bg-neutral-800/30 transition-colors cursor-pointer"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div className="mt-0.5">
                    <span
                      className={`inline-block font-mono text-[11px] font-bold px-2 py-0.5 rounded border ${severityBadge(
                        rule.baseSeverity
                      )}`}
                    >
                      {rule.id}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-neutral-400 font-mono">
                        {rule.domain} · {rule.group}
                      </span>
                    </div>
                    <h4 className="text-sm font-semibold text-white group-hover:text-cyan-300 transition-colors truncate mt-0.5">
                      {rule.title}
                    </h4>
                    <p className="text-xs text-neutral-400 line-clamp-1 mt-0.5">
                      {rule.whatItMeans}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0 self-end md:self-center font-mono text-xs">
                  <span
                    className={`px-2 py-0.5 rounded border text-[11px] font-medium ${laneBadge(
                      rule.remediationLane
                    )}`}
                  >
                    Lane {rule.remediationLane}
                  </span>
                  <span className="text-neutral-500 text-[11px] hidden lg:inline max-w-40 truncate">
                    {rule.sourceTables}
                  </span>
                  <CaretRight
                    size={16}
                    className="text-neutral-600 group-hover:text-cyan-400 group-hover:translate-x-0.5 transition-all"
                  />
                </div>
              </div>
            ))}
          </div>

          {filteredRules.length > 100 && (
            <div className="p-4 bg-neutral-900/80 border-t border-neutral-800 text-center text-xs font-mono text-neutral-500">
              Showing first 100 of {filteredRules.length} matching rules. Use the search bar above to
              narrow down specific rules.
            </div>
          )}
        </div>
      )}

      {/* Slide-out Deep Dive Dossier Drawer */}
      {inspectingRule && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm transition-opacity">
          <div className="w-full max-w-2xl bg-neutral-950 border-l border-neutral-800 h-full overflow-y-auto flex flex-col shadow-2xl p-6 space-y-6">
            {/* Drawer Header */}
            <div className="flex items-start justify-between border-b border-neutral-800 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className={`font-mono text-xs font-bold px-2 py-0.5 rounded border ${severityBadge(
                      inspectingRule.baseSeverity
                    )}`}
                  >
                    {inspectingRule.id}
                  </span>
                  <span className="text-xs font-mono text-neutral-400 uppercase">
                    {inspectingRule.domain} · {inspectingRule.group}
                  </span>
                </div>
                <h3 className="text-lg font-bold text-white mt-2 leading-snug">
                  {inspectingRule.title}
                </h3>
              </div>
              <button
                onClick={() => setInspectingRule(null)}
                className="rounded-lg p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Core Explanation Dossier */}
            <div className="space-y-4 text-xs leading-relaxed">
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
                <div className="flex items-center gap-1.5 text-cyan-400 font-mono text-[11px] uppercase font-semibold mb-1">
                  <Info size={14} />
                  What It Means (Mechanism)
                </div>
                <p className="text-neutral-300">{inspectingRule.whatItMeans}</p>
              </div>

              <div className="rounded-xl border border-rose-950/40 bg-rose-950/10 p-4">
                <div className="flex items-center gap-1.5 text-rose-400 font-mono text-[11px] uppercase font-semibold mb-1">
                  <WarningCircle size={14} />
                  Why It Matters (Operational Damage)
                </div>
                <p className="text-neutral-300">{inspectingRule.whyItMatters}</p>
              </div>

              <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
                <div className="flex items-center gap-1.5 text-amber-400 font-mono text-[11px] uppercase font-semibold mb-1">
                  <ShieldCheck size={14} />
                  False Positive Guard (Authenticity)
                </div>
                <p className="text-neutral-300">{inspectingRule.falsePositiveGuard}</p>
              </div>

              {/* Technical Provenance Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-3">
                  <div className="text-[10px] font-mono uppercase text-neutral-500 flex items-center gap-1 mb-1">
                    <Table size={12} /> Source Tables / Fields
                  </div>
                  <div className="font-mono text-neutral-300 break-all text-[11px]">
                    {inspectingRule.sourceTables || "N/A"}
                  </div>
                </div>

                <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-3">
                  <div className="text-[10px] font-mono uppercase text-neutral-500 flex items-center gap-1 mb-1">
                    <Sliders size={12} /> Threshold / Parameter
                  </div>
                  <div className="font-mono text-neutral-300 text-[11px]">
                    {inspectingRule.threshold || "Standard"}
                  </div>
                </div>
              </div>

              {/* Confidence & Detection Query */}
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
                <div className="text-[10px] font-mono uppercase text-neutral-500 flex items-center gap-1 mb-1">
                  <Cpu size={12} /> Detection Query Logic
                </div>
                <div className="font-mono text-[11px] bg-black/50 p-2.5 rounded border border-neutral-800 text-neutral-300 overflow-x-auto">
                  {inspectingRule.detectionLogic}
                </div>
                <div className="mt-2 text-[11px] text-neutral-400">
                  <strong className="text-neutral-300 font-mono">Confidence Basis:</strong>{" "}
                  {inspectingRule.confidenceBasis}
                </div>
              </div>

              {/* Cross-Domain Link */}
              {inspectingRule.crossDomainLink && (
                <div className="rounded-xl border border-cyan-950/40 bg-cyan-950/10 p-4">
                  <div className="flex items-center gap-1.5 text-cyan-400 font-mono text-[11px] uppercase font-semibold mb-1">
                    <GitBranch size={14} />
                    Cross-Domain Causal Chain
                  </div>
                  <p className="text-neutral-300 font-mono text-[11px]">
                    {inspectingRule.crossDomainLink}
                  </p>
                </div>
              )}

              {/* Remediation Pathway */}
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[10px] font-mono uppercase text-neutral-500">
                      Remediation Pathway
                    </div>
                    <div className="font-bold text-white text-sm mt-0.5">
                      Lane {inspectingRule.remediationLane} Execution
                    </div>
                  </div>
                  <span
                    className={`px-2.5 py-1 rounded border font-mono text-xs font-medium ${laneBadge(
                      inspectingRule.remediationLane
                    )}`}
                  >
                    {inspectingRule.rawRemediationLane || `Lane ${inspectingRule.remediationLane}`}
                  </span>
                </div>
                <p className="text-neutral-400 text-xs mt-2">
                  {inspectingRule.remediationLane === 1
                    ? "Direct 1-Click Reversible Patch / Delete executed through the Self-Healing Harness with pre-image snapshots."
                    : inspectingRule.remediationLane === 2
                    ? "System configuration update. Supports live agent patch with human approval, or 1-click export as a ready-to-commit ServiceNow Update Set XML."
                    : "High-impact architectural or policy decision requiring human review and guided stakeholder consultation."}
                </p>
              </div>
            </div>

            {/* Footer Close */}
            <div className="mt-auto border-t border-neutral-800 pt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setInspectingRule(null)}
                className="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs font-semibold text-neutral-300 hover:bg-neutral-800 transition-colors"
              >
                Close Dossier
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
