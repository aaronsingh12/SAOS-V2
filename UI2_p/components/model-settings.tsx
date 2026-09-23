"use client";

import { useEffect, useState } from "react";
import { ArrowClockwise, Cpu, LockKey } from "@phosphor-icons/react";

type Models = {
  provider: "ollama";
  selected: string;
  installed: {
    name: string;
    size?: number;
    remote_model?: string;
    remote_host?: string;
  }[];
  available: boolean;
  message?: string;
};

export function ModelSettings({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  const [models, setModels] = useState<Models | null>(null);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    try {
      const response = await fetch("/api/ai/models", { cache: "no-store" });
      const result = (await response.json()) as Models;
      if (!response.ok)
        throw new Error(result.message ?? "Ollama is not available");
      setModels(result);
      setChosen(
        result.installed.some((model) => model.name === result.selected)
          ? result.selected
          : (result.installed[0]?.name ?? ""),
      );
    } catch {
      setModels({
        provider: "ollama",
        selected: "",
        installed: [],
        available: false,
        message: "Ollama is not running on this device.",
      });
    }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);
  async function save() {
    setBusy(true);
    onNotice("");
    try {
      const response = await fetch("/api/ai/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "ollama", model: chosen }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(result.error ?? "Could not change model");
      onNotice(
        `Ollama model changed to ${chosen}. Findings are still rule-based.`,
      );
      await load();
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Could not change model",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="border-[3px] border-[#0d2f3f] bg-white">
      <div className="flex items-center gap-2 border-b-[3px] border-[#0d2f3f] p-4">
        <Cpu size={22} weight="bold" />
        <h2 className="font-display text-xl font-black">AI model (Ollama)</h2>
      </div>
      <div className="space-y-3 p-4 text-sm">
        <p className="leading-6">
          Optional: Ollama can rewrite an issue in simpler words. It never
          decides whether a problem exists or changes ServiceNow.
        </p>
        <div className="flex items-center justify-between gap-2">
          <span className="font-black">Provider: Ollama</span>
          <button
            onClick={() => void load()}
            type="button"
            aria-label="Refresh installed models"
            className="grid size-9 place-items-center border-2 border-[#0d2f3f]"
          >
            <ArrowClockwise size={18} weight="bold" />
          </button>
        </div>
        {models?.available ? (
          <>
            <label className="block text-xs font-black" htmlFor="local-model">
              Installed model
            </label>
            <select
              id="local-model"
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
              className="w-full border-2 border-[#0d2f3f] bg-white px-3 py-2.5"
            >
              <option value="" disabled>
                {models.installed.length
                  ? "Select installed model"
                  : "No models installed"}
              </option>
              {models.installed.map((model) => (
                <option key={model.name} value={model.name}>
                  {model.name}
                  {model.remote_host ? " (cloud-backed)" : ""}
                </option>
              ))}
            </select>
            <button
              disabled={
                busy ||
                !models.installed.some((item) => item.name === chosen) ||
                chosen === models.selected
              }
              onClick={() => void save()}
              type="button"
              className="border-2 border-[#0d2f3f] bg-[#5edc56] px-4 py-2.5 text-xs font-black disabled:opacity-40"
            >
              Save model
            </button>
            {models.installed.some((model) => model.remote_host) ? (
              <p className="border-l-4 border-[#0d2f3f] bg-[#e9f1f3] p-3 text-xs">
                This list includes a cloud-backed Ollama model. SAOS only sends
                text when you ask for an AI explanation; checks and findings
                stay local and rule-based.
              </p>
            ) : null}
          </>
        ) : (
          <p className="border-l-4 border-[#0d2f3f] bg-[#e9f1f3] p-3 text-xs">
            {models?.message ?? "Checking Ollama…"} Install Ollama and a model
            on this device, then refresh.
          </p>
        )}
        <div className="flex gap-2 border-t-2 border-[#0d2f3f] pt-3 text-xs">
          <LockKey size={18} weight="bold" className="shrink-0" />
          <span>
            Cloud providers and API keys are not enabled yet. No key form is
            shown until a real provider adapter and secret handling exist.
          </span>
        </div>
      </div>
    </section>
  );
}
