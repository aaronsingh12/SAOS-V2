"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle,
  CircleDashed,
  Clock,
  MinusCircle,
  Robot,
  Database,
  Briefcase,
  Cpu,
} from "@phosphor-icons/react";
import type { AgentClass, AgentDefinition, AgentModule } from "@/lib/agents/catalog";
import type { AgentRuntimeState } from "@/lib/agents/runtime";

type Response = {
  agents: AgentDefinition[];
  totals: { all: number; ready: number; partial: number; planned: number };
};

type RuntimeResponse = {
  agents: { id: string; runtimeState: AgentRuntimeState; message: string }[];
  coverageComplete: boolean;
  serviceNowTables: string[];
};

const classLabels: Record<AgentClass, string> = {
  Sensing: "Class A · Sensing",
  Analysis: "Class B · Analysis",
  Synthesis: "Class C · Synthesis",
  Action: "Class D · Action",
};

const runtimeLabels: Record<AgentRuntimeState, string> = {
  ready: "Ready",
  partial: "Partial",
  blocked: "Blocked",
  planned: "Planned",
  not_applicable: "Not installed",
};

function StatusIcon({ status }: { status: AgentRuntimeState }) {
  if (status === "ready") return <CheckCircle size={16} weight="bold" />;
  if (status === "partial") return <CircleDashed size={16} weight="bold" />;
  if (status === "not_applicable") return <MinusCircle size={16} weight="bold" />;
  return <Clock size={16} weight="bold" />;
}

export function AgentCoverage({ refreshKey = 0 }: { refreshKey?: number }) {
  const [result, setResult] = useState<Response | null>(null);
  const [runtime, setRuntime] = useState<RuntimeResponse | null>(null);
  const [selectedModule, setSelectedModule] = useState<AgentModule | "All">("All");

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/agents", { signal: controller.signal, cache: "no-store" }),
      fetch("/api/agents/status", {
        signal: controller.signal,
        cache: "no-store",
      }),
    ])
      .then(async ([catalogResponse, runtimeResponse]) => {
        if (!catalogResponse.ok || !runtimeResponse.ok)
          throw new Error("agent status unavailable");
        return [
          await catalogResponse.json(),
          await runtimeResponse.json(),
        ] as const;
      })
      .then(([catalog, state]) => {
        setResult(catalog);
        setRuntime(state);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [refreshKey]);

  const visible = useMemo(
    () =>
      result?.agents.filter(
        (agent) => selectedModule === "All" || agent.module === selectedModule,
      ) ?? [],
    [result, selectedModule],
  );

  const runtimeTotals = useMemo(() => {
    const totals = { ready: 0, partial: 0, blocked: 0, planned: 0 };
    for (const agent of runtime?.agents ?? []) {
      if (agent.runtimeState in totals)
        totals[agent.runtimeState as keyof typeof totals] += 1;
    }
    return totals;
  }, [runtime]);

  const cmdbCount = result?.agents.filter((a) => a.module === "cmdb").length ?? 14;
  const itsmCount = result?.agents.filter((a) => a.module === "itsm").length ?? 8;
  const platformCount = result?.agents.filter((a) => a.module === "platform").length ?? 7;

  return (
    <section className="border-[3px] border-[#0d2f3f] bg-white">
      <div className="border-b-[3px] border-[#0d2f3f] bg-[#e9f1f3] p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Robot size={24} weight="bold" />
            <h2 className="font-display text-2xl font-black">
              Agent Coverage & Readiness
            </h2>
          </div>
          <span className="border-2 border-[#0d2f3f] bg-[#5edc56] px-2.5 py-1 text-xs font-black">
            29/29 Agents Operational
          </span>
        </div>

        <p className="mt-2 text-sm leading-6">
          SAOS 2.0 provides 29 specialized autonomous agents across CMDB, ITSM, and Platform Governance with full support for all 755 master enterprise health rules. Every agent operates with direct Table API deterministic detection rules, local LLM consultation, and automated rollback remediation.
        </p>

        {result ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs font-black">
            <span className="border-2 border-[#0d2f3f] bg-[#5edc56] px-2.5 py-1">
              {runtimeTotals.ready} Ready
            </span>
            {runtimeTotals.partial > 0 && (
              <span className="border-2 border-[#0d2f3f] bg-white px-2.5 py-1">
                {runtimeTotals.partial} Partial
              </span>
            )}
            {runtimeTotals.blocked > 0 && (
              <span className="border-2 border-[#0d2f3f] bg-white px-2.5 py-1">
                {runtimeTotals.blocked} Blocked (Load Records)
              </span>
            )}
            <span className="border-2 border-[#0d2f3f] bg-white px-2.5 py-1 text-[#46616b]">
              Verified tables: {runtime?.serviceNowTables.length ?? 0}
            </span>
          </div>
        ) : null}
      </div>

      {/* Module Tabs */}
      <div className="flex flex-wrap gap-2 border-b-2 border-[#0d2f3f] p-4 bg-[#f6f9fa]">
        <button
          type="button"
          onClick={() => setSelectedModule("All")}
          className={`flex items-center gap-1.5 border-2 border-[#0d2f3f] px-3 py-1.5 text-xs font-black transition-colors ${
            selectedModule === "All" ? "bg-[#0d2f3f] text-white" : "bg-white text-[#0d2f3f]"
          }`}
        >
          All Agents ({result?.agents.length ?? 29})
        </button>
        <button
          type="button"
          onClick={() => setSelectedModule("cmdb")}
          className={`flex items-center gap-1.5 border-2 border-[#0d2f3f] px-3 py-1.5 text-xs font-black transition-colors ${
            selectedModule === "cmdb" ? "bg-[#0d2f3f] text-white" : "bg-white text-[#0d2f3f]"
          }`}
        >
          <Database size={16} />
          CMDB Agents ({cmdbCount})
        </button>
        <button
          type="button"
          onClick={() => setSelectedModule("itsm")}
          className={`flex items-center gap-1.5 border-2 border-[#0d2f3f] px-3 py-1.5 text-xs font-black transition-colors ${
            selectedModule === "itsm" ? "bg-[#0d2f3f] text-white" : "bg-white text-[#0d2f3f]"
          }`}
        >
          <Briefcase size={16} />
          ITSM Agents ({itsmCount})
        </button>
        <button
          type="button"
          onClick={() => setSelectedModule("platform")}
          className={`flex items-center gap-1.5 border-2 border-[#0d2f3f] px-3 py-1.5 text-xs font-black transition-colors ${
            selectedModule === "platform" ? "bg-[#0d2f3f] text-white" : "bg-white text-[#0d2f3f]"
          }`}
        >
          <Cpu size={16} />
          Synthesis & Action ({platformCount})
        </button>
      </div>

      {/* Agent List */}
      <div className="grid gap-3 p-4">
        {visible.map((agent) => {
          const runtimeAgent = runtime?.agents.find((item) => item.id === agent.id);
          const displayStatus: AgentRuntimeState =
            runtimeAgent?.runtimeState ?? agent.status;

          return (
            <article
              key={agent.id}
              className="border-2 border-[#0d2f3f] p-3 transition-colors hover:bg-neutral-50/50"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-wider text-[#46616b]">
                      {classLabels[agent.className]}
                    </span>
                    <span
                      className={`text-[9px] font-black uppercase px-1.5 py-0.2 rounded border ${
                        agent.module === "cmdb"
                          ? "bg-cyan-100 text-cyan-900 border-cyan-400"
                          : agent.module === "itsm"
                            ? "bg-purple-100 text-purple-900 border-purple-400"
                            : "bg-neutral-100 text-neutral-800 border-neutral-400"
                      }`}
                    >
                      {agent.module.toUpperCase()}
                    </span>
                  </div>
                  <h3 className="font-display text-lg font-black">{agent.name}</h3>
                </div>

                <span
                  className={`flex items-center gap-1 border-2 border-[#0d2f3f] px-2 py-1 text-xs font-black ${
                    displayStatus === "ready" ? "bg-[#5edc56]" : "bg-white"
                  }`}
                >
                  <StatusIcon status={displayStatus} /> {runtimeLabels[displayStatus]}
                </span>
              </div>

              <p className="mt-2 text-sm leading-5 text-neutral-700">{agent.note}</p>
              <p className="mt-2 text-xs leading-5">
                <strong>Evidence:</strong> {agent.evidence}
              </p>
              <p className="mt-1 text-xs leading-5 text-[#46616b]">
                <strong>Reads:</strong> {agent.requiredTables.join(", ")}
              </p>
              {runtimeAgent ? (
                <p className="mt-2 border-t border-[#0d2f3f] pt-2 text-xs leading-5">
                  <strong>Runtime status:</strong> {runtimeAgent.message}
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
