import { installedModels, selectedModel } from "./local";

export type AiProviderStatus = {
  provider: "ollama";
  model: string;
  baseUrl: string;
  available: boolean;
  message: string;
};

/**
 * Local-only model health check. Agent workflows will call their fixed tool
 * contracts before this provider is used for explanation or narration.
 */
export async function getAiProviderStatus(): Promise<AiProviderStatus> {
  const model = await selectedModel();
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  try {
    const models = await installedModels();
    const hasModel = models.some((candidate) => candidate.name === model);

    return {
      provider: "ollama",
      model,
      baseUrl,
      available: hasModel,
      message: hasModel
        ? "Selected Ollama model ready"
        : model
          ? `Selected model ${model} is not installed. Choose an installed model in Settings.`
          : "Choose an installed Ollama model in Settings to enable explanations.",
    };
  } catch {
    return {
      provider: "ollama",
      model,
      baseUrl,
      available: false,
      message: "Ollama is not running on this device",
    };
  }
}
