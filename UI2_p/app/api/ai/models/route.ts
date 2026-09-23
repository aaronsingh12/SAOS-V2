import { installedModels, selectedModel } from "@/lib/ai/local";

export const dynamic = "force-dynamic";
export async function GET() {
  const selected = await selectedModel();
  try {
    const installed = await installedModels();
    return Response.json({
      provider: "ollama",
      selected,
      installed,
      available: true,
    });
  } catch (error) {
    return Response.json({
      provider: "ollama",
      selected,
      installed: [],
      available: false,
      message:
        error instanceof TypeError
          ? "Ollama is not running on this device."
          : error instanceof Error
            ? error.message
            : "Ollama unavailable",
    });
  }
}
