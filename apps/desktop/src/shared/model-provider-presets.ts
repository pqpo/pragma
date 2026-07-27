import type { ModelProvider } from "./contracts/index.ts";

export type ModelProviderPresetCategory = "official" | "gateway" | "local" | "custom";

export interface ModelProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly category: ModelProviderPresetCategory;
  readonly protocol: ModelProvider["protocol"];
  readonly baseUrl: string;
  readonly requiresApiKey: boolean;
  readonly supportsDiscovery: boolean;
  readonly description: string;
}

export const MODEL_PROVIDER_PRESETS = [
  preset(
    "openai",
    "OpenAI",
    "official",
    "openai-responses",
    "https://api.openai.com/v1",
    true,
    true,
  ),
  preset(
    "anthropic",
    "Anthropic",
    "official",
    "anthropic-messages",
    "https://api.anthropic.com",
    true,
    false,
  ),
  preset(
    "google",
    "Google Gemini",
    "official",
    "google-generative-ai",
    "https://generativelanguage.googleapis.com/v1beta",
    true,
    true,
  ),
  preset(
    "mistral",
    "Mistral AI",
    "official",
    "mistral-conversations",
    "https://api.mistral.ai/v1",
    true,
    true,
  ),
  preset(
    "openrouter",
    "OpenRouter",
    "gateway",
    "openai-completions",
    "https://openrouter.ai/api/v1",
    true,
    true,
  ),
  preset(
    "deepseek",
    "DeepSeek",
    "gateway",
    "openai-completions",
    "https://api.deepseek.com/v1",
    true,
    true,
  ),
  preset("xai", "xAI", "gateway", "openai-completions", "https://api.x.ai/v1", true, true),
  preset(
    "groq",
    "Groq",
    "gateway",
    "openai-completions",
    "https://api.groq.com/openai/v1",
    true,
    true,
  ),
  preset(
    "cerebras",
    "Cerebras",
    "gateway",
    "openai-completions",
    "https://api.cerebras.ai/v1",
    true,
    true,
  ),
  preset(
    "together",
    "Together AI",
    "gateway",
    "openai-completions",
    "https://api.together.xyz/v1",
    true,
    true,
  ),
  preset(
    "fireworks",
    "Fireworks AI",
    "gateway",
    "openai-completions",
    "https://api.fireworks.ai/inference/v1",
    true,
    true,
  ),
  preset(
    "qwen",
    "Qwen / Bailian",
    "gateway",
    "openai-completions",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    true,
    true,
  ),
  preset(
    "moonshotai",
    "Moonshot / Kimi",
    "gateway",
    "openai-completions",
    "https://api.moonshot.ai/v1",
    true,
    true,
  ),
  preset(
    "zai",
    "Z.AI / GLM",
    "gateway",
    "openai-completions",
    "https://api.z.ai/api/paas/v4",
    true,
    true,
  ),
  preset(
    "minimax",
    "MiniMax",
    "gateway",
    "anthropic-messages",
    "https://api.minimax.io/anthropic",
    true,
    false,
  ),
  preset(
    "siliconflow",
    "SiliconFlow",
    "gateway",
    "openai-completions",
    "https://api.siliconflow.cn/v1",
    true,
    true,
  ),
  preset(
    "ollama",
    "Ollama",
    "local",
    "openai-completions",
    "http://127.0.0.1:11434/v1",
    false,
    true,
  ),
  preset(
    "lm-studio",
    "LM Studio",
    "local",
    "openai-completions",
    "http://127.0.0.1:1234/v1",
    false,
    true,
  ),
  {
    id: "custom-openai",
    name: "OpenAI-compatible API",
    category: "custom",
    protocol: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    requiresApiKey: true,
    supportsDiscovery: true,
    description: "Fallback for any service that implements an OpenAI-compatible API.",
  },
] as const satisfies readonly ModelProviderPreset[];

export function findModelProviderPreset(id: string): ModelProviderPreset | undefined {
  return MODEL_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

function preset(
  id: string,
  name: string,
  category: Exclude<ModelProviderPresetCategory, "custom">,
  protocol: ModelProvider["protocol"],
  baseUrl: string,
  requiresApiKey: boolean,
  supportsDiscovery: boolean,
): ModelProviderPreset {
  return {
    id,
    name,
    category,
    protocol,
    baseUrl,
    requiresApiKey,
    supportsDiscovery,
    description:
      category === "local"
        ? "Connect to a model server running on this computer."
        : category === "official"
          ? "Connect directly with the provider's official API."
          : "Connect through this provider's OpenAI-compatible gateway.",
  };
}
