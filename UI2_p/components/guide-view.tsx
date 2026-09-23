"use client";

import {
  BookOpen,
  Check,
  Question,
  WarningCircle,
  Database,
  Briefcase,
  ShieldCheck,
  Lightning,
  Sparkle,
} from "@phosphor-icons/react";
import { AgentCoverage } from "@/components/agent-coverage";

export function GuideView({ refreshKey = 0 }: { refreshKey?: number }) {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-7 xl:overflow-y-auto">
      {/* Hero */}
      <div className="border-[3px] border-[#0d2f3f] bg-[#5edc56] p-5">
        <div className="flex items-center gap-2.5">
          <BookOpen size={26} weight="bold" />
          <h2 className="font-display text-2xl font-black">
            SAOS Operator Guide — 755 Master Rules & 29 Autonomous Agents
          </h2>
        </div>
        <p className="mt-2 text-sm font-medium text-neutral-900 leading-6">
          Autonomous operations platform for ServiceNow. 29 specialized agents continuously audit and evaluate 755 master health rules across CMDB, ITSM, ITOM, CSDM, and Platform Data Quality with autonomous LLM consulting, multi-signal health scoring, Update Set XML synthesis, and reversible REST apply.
        </p>
      </div>

      {/* Six Step Lifecycle */}
      <div className="space-y-3">
        <h3 className="font-display text-lg font-black text-[#0d2f3f]">
          Operational Lifecycle
        </h3>

        <Step
          number="01"
          title="Connect to ServiceNow"
          text="Open Settings. Enter your ServiceNow HTTPS instance URL and API credentials. SAOS communicates via read-by-default Table API requests with strict count integrity."
        />
        <Step
          number="02"
          title="Load Records Across All Domains (ITOM, CMDB, ITSM, CSDM, DQ)"
          text="Click 'Load records'. SAOS extracts 40+ ServiceNow tables across CMDB/CSDM (cmdb_ci, cmdb_rel_ci, cmdb_ci_service, service_offering, svc_ci_assoc, cmdb_model, alm_asset), ITSM (incident, task_sla, contract_sla, change_request, problem, sc_request), ITOM (em_event, em_alert, discovery_status, discovery_schedule, ecc_agent), and Platform/DQ (sys_user, sys_user_group, cmn_location, sys_script)."
        />
        <Step
          number="03"
          title="Run 29-Agent Scan & Autonomous LLM Consulting"
          text="Click 'Check records'. 29 autonomous agents execute evaluation across 755 master health rules. The Autonomous LLM Consulting Engine contextually verifies root-cause domains, computes a risk priority ranking, and synthesizes downloadable Update Set XMLs."
        />
        <Step
          number="04"
          title="Review AI Consulting Dossier & Best Ranking Matrix"
          text="Inspect the AI Consulting Panel for executive summaries, root cause segregation (CMDB, ITSM, ITOM, Data Quality, Platform), and the priority ranking queue sorted by actual business risk."
        />
        <Step
          number="05"
          title="Download Update Set XMLs or Verify Live REST Plans"
          text="For Lane 2 governance rules (Data Policies, SLA schedules, Business Rules), click 'Download XML' to export compliant sys_remote_update_set packages. For Lane 1/3 REST changes, review exact field diffs."
        />
        <Step
          number="06"
          title="Apply & Automated Rollback"
          text="Click 'Fix All in Group' or apply individually. The Agent applies changes via ServiceNow Table API (PATCH/DELETE) with live drift checks. Full rollback is captured and available at any time."
        />
      </div>

      {/* 755 Master Rules & Table Architecture Deep Dive */}
      <div className="border-[3px] border-[#0d2f3f] bg-white p-5">
        <div className="flex items-center justify-between border-b-[2px] border-neutral-200 pb-3">
          <div className="flex items-center gap-2 font-black text-base text-[#0d2f3f]">
            <Database size={22} weight="bold" className="text-cyan-700" />
            755 Master Rules & Complete Table Coverage Architecture
          </div>
          <span className="bg-[#0d2f3f] px-2.5 py-1 text-xs font-mono font-bold text-[#5edc56]">
            100% COVERED (ITOM · CMDB · ITSM · CSDM · PLATFORM)
          </span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-5 text-xs">
          <div className="border border-neutral-200 bg-neutral-50 p-3">
            <span className="font-mono text-cyan-800 font-bold text-sm block">CMDB</span>
            <span className="font-bold text-neutral-900 block mt-1">138 Master Rules</span>
            <p className="mt-1 text-[11px] text-neutral-600 leading-4">
              Ownership, duplicate relations, orphan CIs, lifecycle conflicts, stale updates, IRE identification collisions.
            </p>
          </div>
          <div className="border border-neutral-200 bg-neutral-50 p-3">
            <span className="font-mono text-purple-800 font-bold text-sm block">ITSM</span>
            <span className="font-bold text-neutral-900 block mt-1">139 Master Rules</span>
            <p className="mt-1 text-[11px] text-neutral-600 leading-4">
              Breached SLAs, imminent breaches, P1 unassigned, missing change CIs, unauthorized changes, problem root causes.
            </p>
          </div>
          <div className="border border-neutral-200 bg-neutral-50 p-3">
            <span className="font-mono text-amber-800 font-bold text-sm block">ITOM</span>
            <span className="font-bold text-neutral-900 block mt-1">156 Master Rules</span>
            <p className="mt-1 text-[11px] text-neutral-600 leading-4">
              Event CI binding, alerts on retired/orphan CIs, discovery schedule gaps, MID server health, impact calculation.
            </p>
          </div>
          <div className="border border-neutral-200 bg-neutral-50 p-3">
            <span className="font-mono text-emerald-800 font-bold text-sm block">CSDM</span>
            <span className="font-bold text-neutral-900 block mt-1">Full Service Model</span>
            <p className="mt-1 text-[11px] text-neutral-600 leading-4">
              Business & Technical Services, Service Offerings, svc_ci_assoc mappings, orphan application services.
            </p>
          </div>
          <div className="border border-neutral-200 bg-neutral-50 p-3">
            <span className="font-mono text-rose-800 font-bold text-sm block">Platform & DQ</span>
            <span className="font-bold text-neutral-900 block mt-1">322 Master Rules</span>
            <p className="mt-1 text-[11px] text-neutral-600 leading-4">
              Inactive manager approval chains, empty user groups, dictionary constraints, Data Policies, transform maps.
            </p>
          </div>
        </div>

        <div className="mt-4 border-t border-neutral-200 pt-3">
          <span className="text-xs font-bold text-neutral-700 block mb-2">
            Active Scanned Tables (40+ Curated Architecture):
          </span>
          <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
            {[
              "cmdb_ci", "cmdb_rel_ci", "cmdb_ci_service", "cmdb_ci_service_business", "cmdb_ci_service_technical",
              "service_offering", "svc_ci_assoc", "cmdb_model", "cmdb_ci_appl", "cmdb_rel_type", "cmdb_identifier",
              "cmdb_health_result", "alm_asset", "incident", "task_sla", "contract_sla", "change_request", "problem",
              "sc_request", "sc_req_item", "em_event", "em_alert", "discovery_status", "discovery_schedule", "ecc_agent",
              "sys_user", "sys_user_group", "sys_user_grmember", "cmn_location", "cmn_department", "kb_knowledge", "sys_script"
            ].map(tbl => (
              <span key={tbl} className="bg-neutral-100 border border-neutral-300 px-1.5 py-0.5 text-neutral-800">
                {tbl}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Scoring and Safety */}
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="border-[3px] border-[#0d2f3f] bg-[#f7fafc] p-4">
          <div className="flex items-center gap-2 font-black text-sm text-[#0d2f3f]">
            <Lightning size={18} weight="bold" className="text-amber-600" />
            Multi-Signal Health Scoring (0–100)
          </div>
          <p className="mt-2 text-xs leading-5 text-neutral-600">
            Health scores combine finding severity, business criticality, linked SLA breaches, active P1/P2 incidents, service graph blast radius, and data freshness. The worst items (score &lt; 40) are automatically ranked first.
          </p>
        </section>

        <section className="border-[3px] border-[#0d2f3f] bg-[#f7fafc] p-4">
          <div className="flex items-center gap-2 font-black text-sm text-[#0d2f3f]">
            <ShieldCheck size={18} weight="bold" className="text-emerald-600" />
            Update Set XML Export & Reversible REST Apply
          </div>
          <p className="mt-2 text-xs leading-5 text-neutral-600">
            Export standard ServiceNow sys_remote_update_set XMLs for instant change migration, or use atomic live-record validation with automated rollback for direct REST patching.
          </p>
        </section>
      </div>

      {/* 29-Agent Catalog embed */}
      <AgentCoverage refreshKey={refreshKey} />

      {/* FAQ / Troubleshooting */}
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="border-[3px] border-[#0d2f3f] bg-white p-4">
          <div className="flex items-center gap-2 font-black text-sm">
            <Question size={18} weight="bold" />
            Zero Findings or Missing Records
          </div>
          <p className="mt-2 text-xs leading-5 text-neutral-600">
            Verify Table API read permissions in ServiceNow for cmdb_ci, cmdb_rel_ci, incident, task_sla, change_request, and problem. Check Data & privacy to see verified vs skipped tables.
          </p>
        </section>

        <section className="border-[3px] border-[#0d2f3f] bg-white p-4">
          <div className="flex items-center gap-2 font-black text-sm">
            <WarningCircle size={18} weight="bold" />
            Local AI Setup
          </div>
          <p className="mt-2 text-xs leading-5 text-neutral-600">
            To generate AI fix plans, install Ollama locally with any standard model (e.g., llama3, mistral, deepseek-r1). Select your installed model in Settings.
          </p>
        </section>
      </div>

      <p className="flex items-start gap-2 text-xs leading-5 text-neutral-600">
        <Check size={16} weight="bold" className="shrink-0 text-emerald-600" />
        All operations and remediations are cryptographically recorded in an immutable audit hash chain.
      </p>
    </div>
  );
}

function Step({
  number,
  title,
  text,
}: {
  number: string;
  title: string;
  text: string;
}) {
  return (
    <section className="grid grid-cols-[56px_1fr] border-[3px] border-[#0d2f3f] bg-white">
      <span className="grid place-items-center border-r-[3px] border-[#0d2f3f] bg-[#0d2f3f] font-mono text-base font-black text-[#5edc56]">
        {number}
      </span>
      <div className="p-3.5">
        <h4 className="font-display text-base font-black text-[#0d2f3f]">{title}</h4>
        <p className="mt-1 text-xs leading-5 text-neutral-700">{text}</p>
      </div>
    </section>
  );
}
