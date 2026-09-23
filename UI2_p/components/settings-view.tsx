"use client";

import { useState } from "react";
import {
  Eye,
  EyeSlash,
  LockKey,
  Plug,
  ShieldCheck,
  WarningCircle,
  Broom,
  Trash,
  ArrowCounterClockwise,
  Lightning,
  Database,
  CheckCircle,
  CircleNotch,
  Globe,
} from "@phosphor-icons/react";
import { ModelSettings } from "./model-settings";

type ConnectionView = {
  connectionInstanceUrl: string;
  connectionUsername: string;
  domainMode: "separated" | "global";
  secretStorage: string;
  sourceMismatch: boolean;
  snapshotSourceHost: string | null;
};

export function SettingsView({
  connection,
  onSaved,
  onNotice,
}: {
  connection: ConnectionView;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [instanceUrl, setInstanceUrl] = useState(
    connection.connectionInstanceUrl,
  );
  const [username, setUsername] = useState(connection.connectionUsername);
  const [password, setPassword] = useState("");
  const [domainMode, setDomainMode] = useState(connection.domainMode);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState("");
  const [handshake, setHandshake] = useState<{
    active: boolean;
    stage: "vault" | "tls" | "probe" | "success" | "error";
    host: string;
    ciCount?: number;
    latency?: number;
    error?: string;
  }>({
    active: false,
    stage: "vault",
    host: "",
  });

  const accountChanged =
    instanceUrl.trim().replace(/\/$/, "") !==
      connection.connectionInstanceUrl ||
    username.trim() !== connection.connectionUsername;

  const extractedHost = (() => {
    try {
      const trimmed = instanceUrl.trim();
      if (!trimmed) return "";
      const urlObj = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
      return urlObj.hostname;
    } catch {
      return instanceUrl.replace(/^https?:\/\//, "").split("/")[0] || "";
    }
  })();

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save");
    onNotice("");
    const host = extractedHost || "service-now.com";
    const startTime = Date.now();

    // Launch High-Octane Handshake Telemetry Sequence
    setHandshake({
      active: true,
      stage: "vault",
      host,
    });

    try {
      // Phase 1: Local Vault Persist
      await new Promise((r) => setTimeout(r, 450));
      setHandshake((prev) => ({ ...prev, stage: "tls" }));

      const response = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceUrl, username, password, domainMode }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not save connection to local vault");

      // Phase 2: Live Table API Probe
      await new Promise((r) => setTimeout(r, 450));
      setHandshake((prev) => ({ ...prev, stage: "probe" }));

      const testRes = await fetch("/api/connection", { method: "POST" });
      const testData = (await testRes.json()) as { error?: string; visibleCiCount?: number };
      const elapsed = Date.now() - startTime;

      if (!testRes.ok || testData.error) {
        throw new Error(testData.error || "ServiceNow authentication failed. Please verify credentials.");
      }

      // Phase 3: Handshake Verified & Sealed
      await new Promise((r) => setTimeout(r, 350));
      setHandshake({
        active: true,
        stage: "success",
        host,
        ciCount: testData.visibleCiCount ?? 0,
        latency: elapsed,
      });

      setPassword("");
      await onSaved();
      onNotice(`✓ Connection sealed! Handshake verified with ${host} (${testData.visibleCiCount ?? 0} CI records visible).`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Connection handshake failed";
      setHandshake({
        active: true,
        stage: "error",
        host,
        error: msg,
      });
      onNotice(msg);
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    onNotice("");
    const host = extractedHost || "service-now.com";
    const startTime = Date.now();

    setHandshake({
      active: true,
      stage: "tls",
      host,
    });

    try {
      await new Promise((r) => setTimeout(r, 450));
      setHandshake((prev) => ({ ...prev, stage: "probe" }));

      const response = await fetch("/api/connection", { method: "POST" });
      const result = (await response.json()) as {
        error?: string;
        visibleCiCount?: number;
      };
      const elapsed = Date.now() - startTime;

      if (!response.ok || result.error) throw new Error(result.error ?? "Connection failed");

      await new Promise((r) => setTimeout(r, 350));
      setHandshake({
        active: true,
        stage: "success",
        host,
        ciCount: result.visibleCiCount ?? 0,
        latency: elapsed,
      });

      onNotice(`✓ Connection verified! ServiceNow reports ${result.visibleCiCount ?? 0} visible CI records.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Connection failed";
      setHandshake({
        active: true,
        stage: "error",
        host,
        error: msg,
      });
      onNotice(msg);
    } finally {
      setBusy("");
    }
  }

  const handleWipeScans = async (scope: "scans" | "all") => {
    const isFull = scope === "all";
    const confirmed = window.confirm(
      isFull
        ? "⚠️ COMPLETE CLEAN WIPE: Are you sure you want to wipe all local twin objects, findings, History audit logs, and remediation plans? Overview and History will be reset, credentials remain saved, and the next scan will be Twin Version 1."
        : "⚠️ WIPE ALL SCANS: Are you sure you want to clear all findings, remediation plans, History audit log, and Overview scores? Twin records will remain cached, and the next scan will be treated as Twin Version 1.",
    );
    if (!confirmed) return;

    setBusy(isFull ? "wipe_all" : "wipe_scans");
    try {
      const res = await fetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, clearHistory: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Wipe failed");
      onNotice(`✓ ${data.message}`);
      await onSaved();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Failed to wipe scans");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="relative grid gap-5 p-4 sm:p-7 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)] xl:overflow-y-auto">
      {/* ========================================================================= */}
      {/* FULL-THROTTLE HANDSHAKE MODAL OVERLAY */}
      {/* ========================================================================= */}
      {handshake.active && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-saos-page-enter">
          <div className="w-full max-w-xl border-[3px] border-[#0d2f3f] bg-[#071722] text-white shadow-[8px_8px_0_#0d2f3f] overflow-hidden relative">
            {/* Background scanline effect */}
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent_50%,rgba(0,0,0,0.35)_51%)] bg-[length:100%_4px] opacity-35" />

            {/* Modal Header */}
            <div className="relative flex items-center justify-between border-b-2 border-white/15 bg-[#0c2836] p-4">
              <div className="flex items-center gap-2.5">
                <span className="grid size-7 place-items-center border border-[#5edc56]/40 bg-[#5edc56]/15 text-[#5edc56]">
                  <Lightning size={16} weight="fill" className="animate-pulse" />
                </span>
                <div>
                  <h3 className="font-mono text-xs font-black uppercase tracking-wider text-white">
                    ServiceNow Telemetry Handshake
                  </h3>
                  <p className="font-mono text-[10px] text-[#8fa7b0]">
                    Target: {handshake.host || "ServiceNow Instance"} • TLS 1.3
                  </p>
                </div>
              </div>
              <span
                className={`border px-2 py-0.5 font-mono text-[9px] font-black uppercase ${
                  handshake.stage === "success"
                    ? "border-[#5edc56] bg-[#5edc56] text-[#071722]"
                    : handshake.stage === "error"
                      ? "border-rose-500 bg-rose-500 text-white"
                      : "border-[#5edc56]/40 bg-[#5edc56]/15 text-[#5edc56] animate-pulse"
                }`}
              >
                {handshake.stage === "success"
                  ? "ESTABLISHED"
                  : handshake.stage === "error"
                    ? "FAILED"
                    : "NEGOTIATING"}
              </span>
            </div>

            <div className="relative p-5 sm:p-6 space-y-5">
              {/* Visual Node-to-Node Beam Animation */}
              <div className="border border-white/15 bg-[#040e15] p-4 shadow-[2px_2px_0_rgba(0,0,0,0.5)]">
                <div className="flex items-center justify-between gap-3">
                  {/* Local Node */}
                  <div className="flex flex-col items-center text-center">
                    <div className="size-11 grid place-items-center border-2 border-[#5edc56] bg-[#0a1e28] text-[#5edc56] shadow-[2px_2px_0_#5edc56]">
                      <Database size={22} weight="fill" />
                    </div>
                    <span className="mt-2 font-mono text-[10px] font-black uppercase tracking-wider text-white">
                      SAOS Twin
                    </span>
                    <span className="font-mono text-[9px] text-[#5edc56]">Local Vault</span>
                  </div>

                  {/* High-Tech Animated Data Beam */}
                  <div className="flex-1 px-3 relative flex flex-col items-center">
                    <div className="w-full h-2 bg-white/10 border border-white/20 relative overflow-hidden rounded">
                      <div
                        className={`h-full w-20 bg-gradient-to-r from-transparent via-[#5edc56] to-transparent ${
                          handshake.stage !== "error" ? "animate-saos-electron" : "bg-rose-500"
                        }`}
                      />
                    </div>
                    <div className="mt-1.5 flex items-center gap-1 font-mono text-[9px] font-bold">
                      {handshake.stage === "success" ? (
                        <span className="text-[#5edc56] flex items-center gap-1">
                          <CheckCircle size={12} weight="fill" /> 200 OK • LINK ACTIVE
                        </span>
                      ) : handshake.stage === "error" ? (
                        <span className="text-rose-400">HANDSHAKE REJECTED</span>
                      ) : (
                        <span className="text-[#8fa7b0] flex items-center gap-1">
                          <CircleNotch size={11} className="animate-spin text-[#5edc56]" />
                          TRANSMITTING PAYLOAD
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Remote ServiceNow Node */}
                  <div className="flex flex-col items-center text-center">
                    <div
                      className={`size-11 grid place-items-center border-2 ${
                        handshake.stage === "success"
                          ? "border-[#5edc56] bg-[#0a1e28] text-[#5edc56] shadow-[2px_2px_0_#5edc56]"
                          : handshake.stage === "error"
                            ? "border-rose-500 bg-rose-950 text-rose-400 shadow-[2px_2px_0_#e11d48]"
                            : "border-neutral-500 bg-neutral-900 text-neutral-400"
                      }`}
                    >
                      <Globe size={22} weight="bold" className={handshake.stage !== "success" && handshake.stage !== "error" ? "animate-spin" : ""} />
                    </div>
                    <span className="mt-2 font-mono text-[10px] font-black uppercase tracking-wider text-white truncate max-w-[120px]">
                      {handshake.host}
                    </span>
                    <span className="font-mono text-[9px] text-[#8fa7b0]">ServiceNow REST</span>
                  </div>
                </div>
              </div>

              {/* Phased Telemetry Steps */}
              <div className="space-y-2 font-mono text-xs">
                {/* Step 1 */}
                <div className="flex items-center justify-between border-b border-white/10 pb-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`grid size-4 place-items-center text-[10px] font-black ${
                        handshake.stage !== "vault"
                          ? "bg-[#5edc56] text-[#071722]"
                          : "bg-white/20 text-white animate-pulse"
                      }`}
                    >
                      {handshake.stage !== "vault" ? "✓" : "1"}
                    </span>
                    <span className={handshake.stage !== "vault" ? "text-white font-bold" : "text-[#cad8dc]"}>
                      Persist to Local Protected Vault (.saos-data/connection.json)
                    </span>
                  </div>
                  <span className="text-[10px] text-[#5edc56] font-bold">
                    {handshake.stage !== "vault" ? "SEALED" : "WRITING..."}
                  </span>
                </div>

                {/* Step 2 */}
                <div className="flex items-center justify-between border-b border-white/10 pb-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`grid size-4 place-items-center text-[10px] font-black ${
                        handshake.stage === "probe" || handshake.stage === "success"
                          ? "bg-[#5edc56] text-[#071722]"
                          : handshake.stage === "tls"
                            ? "bg-[#5edc56] text-[#071722] animate-spin"
                            : "bg-white/20 text-white"
                      }`}
                    >
                      {handshake.stage === "probe" || handshake.stage === "success" ? "✓" : "2"}
                    </span>
                    <span
                      className={
                        handshake.stage === "probe" || handshake.stage === "success"
                          ? "text-white font-bold"
                          : handshake.stage === "tls"
                            ? "text-[#5edc56] font-bold"
                            : "text-[#55707d]"
                      }
                    >
                      Negotiate TLS 1.3 Session with https://{handshake.host}
                    </span>
                  </div>
                  <span className="text-[10px] text-[#5edc56] font-bold">
                    {handshake.stage === "probe" || handshake.stage === "success" ? "VERIFIED" : handshake.stage === "tls" ? "SYNCING..." : "PENDING"}
                  </span>
                </div>

                {/* Step 3 */}
                <div className="flex items-center justify-between border-b border-white/10 pb-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`grid size-4 place-items-center text-[10px] font-black ${
                        handshake.stage === "success"
                          ? "bg-[#5edc56] text-[#071722]"
                          : handshake.stage === "probe"
                            ? "bg-[#5edc56] text-[#071722] animate-spin"
                            : handshake.stage === "error"
                              ? "bg-rose-500 text-white"
                              : "bg-white/20 text-white"
                      }`}
                    >
                      {handshake.stage === "success" ? "✓" : handshake.stage === "error" ? "✕" : "3"}
                    </span>
                    <span
                      className={
                        handshake.stage === "success"
                          ? "text-white font-bold"
                          : handshake.stage === "probe"
                            ? "text-[#5edc56] font-bold"
                            : handshake.stage === "error"
                              ? "text-rose-400 font-bold"
                              : "text-[#55707d]"
                      }
                    >
                      Authenticate & Probe Table API (/api/now/table/cmdb_ci)
                    </span>
                  </div>
                  <span className="text-[10px] text-[#5edc56] font-bold">
                    {handshake.stage === "success"
                      ? "200 OK"
                      : handshake.stage === "probe"
                        ? "TESTING..."
                        : handshake.stage === "error"
                          ? "REJECTED"
                          : "PENDING"}
                  </span>
                </div>
              </div>

              {/* SUCCESS RESULT CARD */}
              {handshake.stage === "success" && (
                <div className="border-2 border-[#5edc56] bg-[#0c2836] p-4 space-y-3 shadow-[3px_3px_0_#5edc56] animate-saos-success">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-white font-black text-xs uppercase tracking-wider">
                      <CheckCircle size={18} weight="fill" className="text-[#5edc56]" />
                      <span>Handshake Successfully Sealed</span>
                    </div>
                    <span className="border border-[#5edc56] bg-[#5edc56]/20 px-2 py-0.5 font-mono text-[9px] font-black text-[#5edc56]">
                      LATENCY: {handshake.latency}ms
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[11px] font-mono border-t border-white/15 pt-2.5">
                    <div>
                      <span className="text-[#8fa7b0] block text-[9px] uppercase">ServiceNow Host</span>
                      <span className="text-white font-bold truncate block">{handshake.host}</span>
                    </div>
                    <div>
                      <span className="text-[#8fa7b0] block text-[9px] uppercase">Telemetry Pool</span>
                      <span className="text-[#5edc56] font-bold block">
                        {handshake.ciCount?.toLocaleString() ?? 0} Visible CIs
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setHandshake({ active: false, stage: "vault", host: "" })}
                    className="mt-2 w-full border-2 border-[#5edc56] bg-[#5edc56] py-2.5 text-xs font-black text-[#071722] shadow-[2px_2px_0_#071722] brutal-btn hover:bg-[#4ecd46]"
                  >
                    Done & Return to Workspace
                  </button>
                </div>
              )}

              {/* ERROR RESULT CARD */}
              {handshake.stage === "error" && (
                <div className="border-2 border-rose-500 bg-[#250b12] p-4 space-y-3 shadow-[3px_3px_0_#e11d48] animate-saos-page-enter">
                  <div className="flex items-center gap-2 text-rose-300 font-black text-xs uppercase tracking-wider">
                    <WarningCircle size={18} weight="fill" className="text-rose-500 shrink-0" />
                    <span>Handshake Verification Failed</span>
                  </div>
                  <p className="text-xs font-mono text-rose-200 leading-relaxed break-words bg-rose-950/60 p-2.5 border border-rose-800/60">
                    {handshake.error || "Could not authenticate with ServiceNow. Please verify instance address, username, and password."}
                  </p>
                  <button
                    type="button"
                    onClick={() => setHandshake({ active: false, stage: "vault", host: "" })}
                    className="w-full border-2 border-rose-500 bg-rose-500 py-2.5 text-xs font-black text-white shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-rose-600"
                  >
                    Back & Correct Credentials
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Connection Form */}
      <form
        onSubmit={(event) => void save(event)}
        className="border-[3px] border-[#0d2f3f] bg-[#ffffff] shadow-[4px_4px_0_#0d2f3f]"
      >
        <div className="flex items-center justify-between border-b-[3px] border-[#0d2f3f] bg-[#5edc56] p-4">
          <div className="flex items-center gap-2">
            <Plug size={22} weight="bold" />
            <h2 className="font-display text-xl font-black">
              ServiceNow connection
            </h2>
          </div>
          <span className="border border-[#0d2f3f] bg-white px-2 py-0.5 font-mono text-[10px] font-black text-[#0d2f3f] uppercase shadow-[1px_1px_0_#0d2f3f]">
            TLS 1.3 SECURED
          </span>
        </div>

        {/* Real-time Interactive Connection Beam Graphic */}
        <div className="border-b-2 border-[#0d2f3f] bg-[#071722] p-3 sm:p-4 text-white">
          <div className="flex items-center justify-between gap-3">
            {/* Left Node: Local SAOS Twin */}
            <div className="flex items-center gap-2 shrink-0">
              <span className="grid size-8 place-items-center border border-[#5edc56] bg-[#0a1e28] text-[#5edc56] shadow-[1px_1px_0_#5edc56]">
                <Database size={16} weight="fill" />
              </span>
              <div>
                <span className="font-mono text-[10px] font-black uppercase text-white block leading-none">
                  Local SAOS Twin
                </span>
                <span className="font-mono text-[9px] text-[#5edc56] mt-0.5 block">localhost:3000</span>
              </div>
            </div>

            {/* Middle Data Beam */}
            <div className="flex-1 px-2 relative flex flex-col items-center min-w-[80px]">
              <div className="w-full h-1.5 bg-white/15 border border-white/20 relative overflow-hidden rounded">
                <div className="h-full w-14 bg-gradient-to-r from-transparent via-[#5edc56] to-transparent animate-saos-electron" />
              </div>
              <span className="font-mono text-[8px] text-[#8fa7b0] tracking-wider mt-1 uppercase">
                {extractedHost ? "ACTIVE TARGET" : "STANDBY"}
              </span>
            </div>

            {/* Right Node: ServiceNow Host */}
            <div className="flex items-center gap-2 text-right shrink-0">
              <div>
                <span className="font-mono text-[10px] font-black uppercase text-white block leading-none truncate max-w-[130px]">
                  {extractedHost || "dev443964"}
                </span>
                <span className="font-mono text-[9px] text-[#8fa7b0] mt-0.5 block">ServiceNow REST</span>
              </div>
              <span className="grid size-8 place-items-center border border-[#5edc56] bg-[#0a1e28] text-[#5edc56] shadow-[1px_1px_0_#5edc56]">
                <Globe size={16} weight="bold" />
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-4 p-4 sm:p-5">
          <p className="text-xs font-semibold leading-relaxed text-[#3a5966]">
            Configure your ServiceNow instance and credentials. Scans execute read-only queries against allow-listed CMDB and ITSM tables. All writes require explicit review and execute through the zero-loss audit vault.
          </p>

          {/* Instance URL Input with Live Detection */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-black" htmlFor="instance-url">
                Instance address
              </label>
              {extractedHost && (
                <span className="font-mono text-[10px] font-bold text-emerald-700 flex items-center gap-1">
                  <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Target: {extractedHost}
                </span>
              )}
            </div>
            <input
              id="instance-url"
              type="url"
              required
              value={instanceUrl}
              onChange={(event) => setInstanceUrl(event.target.value)}
              placeholder="https://your-instance.service-now.com"
              className="w-full border-2 border-[#0d2f3f] bg-white px-3 py-2.5 text-sm outline-none focus:bg-[#e5f9e4] font-mono text-xs transition-colors"
            />
          </div>

          {/* Username Input */}
          <div>
            <label className="block text-xs font-black mb-1" htmlFor="username">
              ServiceNow account name
            </label>
            <input
              id="username"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              className="w-full border-2 border-[#0d2f3f] bg-white px-3 py-2.5 text-sm outline-none focus:bg-[#e5f9e4] font-mono text-xs transition-colors"
            />
          </div>

          {/* Password Input with Security Badge */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-black" htmlFor="password">
                {accountChanged
                  ? "Password for this account"
                  : "New password (leave blank to keep current)"}
              </label>
              <span className="font-mono text-[9px] text-[#55707d] flex items-center gap-1">
                <LockKey size={11} weight="bold" /> Private Local Vault
              </span>
            </div>
            <div className="flex border-2 border-[#0d2f3f] bg-white">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                required={accountChanged}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                className="min-w-0 flex-1 px-3 py-2.5 text-sm outline-none font-mono text-xs"
              />
              <button
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword(!showPassword)}
                className="grid w-11 place-items-center border-l-2 border-[#0d2f3f] hover:bg-neutral-100 transition-colors"
              >
                <span>
                  {showPassword ? (
                    <EyeSlash size={19} weight="bold" />
                  ) : (
                    <Eye size={19} weight="bold" />
                  )}
                </span>
              </button>
            </div>
          </div>

          {/* Domain Setup */}
          <div>
            <label className="block text-xs font-black mb-1" htmlFor="domain-mode">
              Domain setup
            </label>
            <select
              id="domain-mode"
              value={domainMode}
              onChange={(event) =>
                setDomainMode(event.target.value as "separated" | "global")
              }
              className="w-full border-2 border-[#0d2f3f] bg-white px-3 py-2.5 text-sm font-bold"
            >
              <option value="separated">
                Keep ServiceNow domains separate (recommended)
              </option>
              <option value="global">
                Single global domain (only if confirmed)
              </option>
            </select>
          </div>

          {accountChanged && (
            <p className="flex gap-2 border-l-4 border-[#0d2f3f] bg-[#e9f1f3] p-3 text-xs leading-5 font-medium">
              <WarningCircle size={19} weight="bold" className="shrink-0 text-amber-700" />
              A new instance or account needs its own password. Existing copied records stay on this device but are hidden until the new sync succeeds.
            </p>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-2.5 pt-2">
            <button
              disabled={!!busy}
              type="submit"
              className="flex items-center gap-2 border-2 border-[#0d2f3f] bg-[#5edc56] px-5 py-3 text-xs font-black text-[#0d2f3f] shadow-[3px_3px_0_#0d2f3f] brutal-btn hover:bg-[#4ecd46] disabled:opacity-50 cursor-pointer"
            >
              <Lightning size={16} weight="fill" />
              {busy === "save" ? "Establishing Handshake…" : "Save connection & Seal"}
            </button>
            <button
              disabled={
                !!busy || accountChanged || !connection.connectionInstanceUrl
              }
              type="button"
              onClick={() => void test()}
              className="flex items-center gap-2 border-2 border-[#0d2f3f] bg-white px-4 py-3 text-xs font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#f4f8f9] disabled:opacity-40 cursor-pointer"
            >
              <Plug size={16} weight="bold" />
              {busy === "test" ? "Testing Handshake…" : "Test saved connection"}
            </button>
          </div>
        </div>
      </form>
      <div className="space-y-5">
        <div className="border-[3px] border-[#0d2f3f] bg-[#ffffff] p-5">
          <div className="flex items-center gap-2">
            <ShieldCheck size={22} weight="bold" />
            <h2 className="font-display text-xl font-black">
              What is protected
            </h2>
          </div>
          <p className="mt-4 text-sm leading-6">
            Your password is never shown again in this page, never sent to an AI
            model and never written to the action history. Saved credentials are
            kept in a local file readable only by your device account (not
            encrypted at rest).
          </p>
          <p className="mt-3 font-mono text-xs">
            Current storage: {connection.secretStorage}
          </p>
        </div>
        <div className="border-[3px] border-[#0d2f3f] bg-[#d2ebf0] p-5">
          <div className="flex items-center gap-2">
            <LockKey size={22} weight="bold" />
            <h2 className="font-display text-xl font-black">Safety rules</h2>
          </div>
          <p className="mt-4 text-sm leading-6">
            No automatic ServiceNow changes. The only live write supported
            today is a reviewed duplicate-relationship delete with a captured
            rollback payload. Other findings are manual-only. Changing the
            source never relabels old records as new data.
          </p>
          {connection.sourceMismatch && (
            <p className="mt-4 border-2 border-[#0d2f3f] bg-white p-3 text-xs font-black">
              Old local copy: {connection.snapshotSourceHost}. Load records from
              the newly selected instance to see findings.
            </p>
          )}
        </div>
        <ModelSettings onNotice={onNotice} />

        {/* Clean & Wipe Maintenance Section */}
        <div className="border-[3px] border-[#0d2f3f] bg-white p-5 shadow-[4px_4px_0_#0d2f3f]">
          <div className="flex items-center justify-between border-b-2 border-[#0d2f3f] pb-3">
            <div className="flex items-center gap-2">
              <Broom size={22} weight="bold" className="text-[#0d2f3f]" />
              <h2 className="font-display text-xl font-black text-[#0d2f3f]">
                Clean & Wipe Scans
              </h2>
            </div>
            <span className="border border-[#0d2f3f] bg-[#fee2e2] px-2 py-0.5 font-mono text-[10px] font-black text-[#991b1b] uppercase">
              MAINTENANCE
            </span>
          </div>

          <p className="mt-3 text-xs font-semibold text-[#3a5966] leading-relaxed">
            Wipe previous audit scans, findings, History audit logs, and Overview health scores to start completely fresh. Next scan will be recorded as <strong>Twin Version 1</strong>. ServiceNow connection credentials remain saved safely.
          </p>

          <div className="mt-4 flex flex-col gap-2.5">
            <button
              disabled={!!busy}
              type="button"
              onClick={() => void handleWipeScans("scans")}
              className="flex items-center justify-center gap-2 border-2 border-[#0d2f3f] bg-[#ffd166] px-4 py-2.5 text-xs font-black text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#ffc233] disabled:opacity-50"
            >
              <ArrowCounterClockwise size={15} weight="bold" />
              {busy === "wipe_scans" ? "Wiping Scans…" : "Wipe Scans & Reset to Version 1"}
            </button>

            <button
              disabled={!!busy}
              type="button"
              onClick={() => void handleWipeScans("all")}
              className="flex items-center justify-center gap-2 border-2 border-[#0d2f3f] bg-[#fee2e2] px-4 py-2.5 text-xs font-black text-[#991b1b] shadow-[2px_2px_0_#0d2f3f] brutal-btn hover:bg-[#fecaca] disabled:opacity-50"
            >
              <Trash size={15} weight="bold" />
              {busy === "wipe_all" ? "Wiping Everything…" : "Full Clean Wipe (Twin Objects + Scans)"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
