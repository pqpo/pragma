import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel } from "@pragma/shared";

export interface PiCompatibilityProfileDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly api: "openai-completions" | "openai-responses";
}

interface PiCompatibilityProfile extends PiCompatibilityProfileDescriptor {
  readonly compat: NonNullable<Model<Api>["compat"]>;
  readonly thinkingLevelMap?: Model<Api>["thinkingLevelMap"] | undefined;
  readonly supportedThinkingLevels: readonly ModelThinkingLevel[];
}

const TOGGLE_THINKING_LEVELS = ["off", "high"] as const;
const EFFORT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const PROFILES = [
  profile(
    "pi.openai-modern@v1",
    "Modern OpenAI",
    "Uses developer instructions, reasoning_effort, and max_completion_tokens.",
    "openai-completions",
    {
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      maxTokensField: "max_completion_tokens",
      thinkingFormat: "openai",
    },
    EFFORT_THINKING_LEVELS,
    effortThinkingMap(),
  ),
  profile(
    "pi.openai-compatible-safe@v1",
    "Conservative OpenAI-compatible",
    "Uses system instructions and omits non-standard reasoning controls.",
    "openai-completions",
    {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      thinkingFormat: "openai",
    },
    ["off"],
  ),
  profile(
    "pi.openrouter@v1",
    "OpenRouter",
    "Uses OpenRouter reasoning objects and conservative system instructions.",
    "openai-completions",
    { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
    EFFORT_THINKING_LEVELS,
    effortThinkingMap(),
  ),
  profile(
    "pi.deepseek@v1",
    "DeepSeek",
    "Uses DeepSeek thinking controls and reasoning-content replay.",
    "openai-completions",
    {
      supportsStore: false,
      supportsDeveloperRole: false,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    },
    ["off", "high", "max"],
    { off: "off", minimal: null, low: null, medium: null, high: "high", max: "max" },
  ),
  profile(
    "pi.qwen@v1",
    "Qwen API",
    "Uses top-level enable_thinking for Qwen-compatible APIs.",
    "openai-completions",
    {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "qwen",
    },
    TOGGLE_THINKING_LEVELS,
    toggleThinkingMap(),
  ),
  profile(
    "pi.qwen-chat-template@v1",
    "Qwen chat template",
    "Uses chat_template_kwargs for local Qwen servers such as Ollama or vLLM.",
    "openai-completions",
    {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "qwen-chat-template",
    },
    TOGGLE_THINKING_LEVELS,
    toggleThinkingMap(),
  ),
  profile(
    "pi.zai@v1",
    "Z.AI / GLM",
    "Uses Z.AI thinking.type controls.",
    "openai-completions",
    {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      thinkingFormat: "zai",
    },
    TOGGLE_THINKING_LEVELS,
    toggleThinkingMap(),
  ),
  profile(
    "pi.together@v1",
    "Together",
    "Uses Together reasoning.enabled controls.",
    "openai-completions",
    {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      thinkingFormat: "together",
    },
    TOGGLE_THINKING_LEVELS,
    toggleThinkingMap(),
  ),
  profile(
    "pi.moonshot@v1",
    "Moonshot / Kimi",
    "Uses Moonshot-compatible thinking controls and system instructions.",
    "openai-completions",
    {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      thinkingFormat: "deepseek",
    },
    TOGGLE_THINKING_LEVELS,
    toggleThinkingMap(),
  ),
  profile(
    "pi.openai-responses-modern@v1",
    "Modern OpenAI Responses",
    "Uses developer instructions with the OpenAI Responses API.",
    "openai-responses",
    { supportsDeveloperRole: true },
    EFFORT_THINKING_LEVELS,
    effortThinkingMap(),
  ),
  profile(
    "pi.openai-responses-safe@v1",
    "Conservative OpenAI Responses",
    "Uses system instructions with OpenAI Responses-compatible proxies.",
    "openai-responses",
    { supportsDeveloperRole: false, supportsLongCacheRetention: false },
    ["off"],
  ),
] as const satisfies readonly PiCompatibilityProfile[];

const PROFILES_BY_ID = new Map(PROFILES.map((entry) => [entry.id, entry]));

export function listPiCompatibilityProfiles(): readonly PiCompatibilityProfileDescriptor[] {
  return PROFILES.map(({ id, displayName, description, api }) => ({
    id,
    displayName,
    description,
    api,
  }));
}

export function resolvePiCompatibilityProfile(
  id: string | undefined,
  api: Api,
): PiCompatibilityProfile | undefined {
  if (id === undefined) return undefined;
  const resolved = PROFILES_BY_ID.get(id);
  if (resolved === undefined) {
    throw new Error(`Unknown PI compatibility profile: ${id}`);
  }
  if (resolved.api !== api) {
    throw new Error(`PI compatibility profile "${id}" does not support API "${api}".`);
  }
  return resolved;
}

export function defaultPiCompatibilityProfileId(catalogId: string, api: Api): string | undefined {
  if (api === "openai-responses") {
    return catalogId === "custom-openai" ? "pi.openai-responses-safe@v1" : undefined;
  }
  if (api !== "openai-completions") return undefined;
  switch (catalogId) {
    case "qwen":
      return "pi.qwen@v1";
    case "openrouter":
      return "pi.openrouter@v1";
    case "deepseek":
      return "pi.deepseek@v1";
    case "zai":
      return "pi.zai@v1";
    case "together":
      return "pi.together@v1";
    case "moonshotai":
      return "pi.moonshot@v1";
    case "ollama":
    case "lm-studio":
    case "siliconflow":
    case "custom-openai":
      return "pi.openai-compatible-safe@v1";
    default:
      return "pi.openai-compatible-safe@v1";
  }
}

function profile(
  id: string,
  displayName: string,
  description: string,
  api: PiCompatibilityProfileDescriptor["api"],
  compat: NonNullable<Model<Api>["compat"]>,
  supportedThinkingLevels: readonly ModelThinkingLevel[],
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"],
): PiCompatibilityProfile {
  return {
    id,
    displayName,
    description,
    api,
    compat,
    supportedThinkingLevels,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
  };
}

function toggleThinkingMap(): NonNullable<Model<Api>["thinkingLevelMap"]> {
  return {
    off: "off",
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  };
}

function effortThinkingMap(): NonNullable<Model<Api>["thinkingLevelMap"]> {
  return { xhigh: "xhigh", max: "max" };
}

export type { PiCompatibilityProfile };
