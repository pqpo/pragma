import anthropicIcon from "@lobehub/icons-static-svg/icons/anthropic.svg";
import cerebrasIcon from "@lobehub/icons-static-svg/icons/cerebras-color.svg";
import deepseekIcon from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import fireworksIcon from "@lobehub/icons-static-svg/icons/fireworks-color.svg";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import groqIcon from "@lobehub/icons-static-svg/icons/groq.svg";
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import lmStudioIcon from "@lobehub/icons-static-svg/icons/lmstudio.svg";
import minimaxIcon from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistralIcon from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import ollamaIcon from "@lobehub/icons-static-svg/icons/ollama.svg";
import openaiIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import openrouterIcon from "@lobehub/icons-static-svg/icons/openrouter.svg";
import qwenIcon from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import siliconFlowIcon from "@lobehub/icons-static-svg/icons/siliconcloud-color.svg";
import togetherIcon from "@lobehub/icons-static-svg/icons/together-color.svg";
import xaiIcon from "@lobehub/icons-static-svg/icons/xai.svg";
import zhipuIcon from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import { Robot } from "@phosphor-icons/react";

const MODEL_PROVIDER_ICON_BY_PRESET_ID: Readonly<Record<string, string>> = {
  anthropic: anthropicIcon,
  cerebras: cerebrasIcon,
  deepseek: deepseekIcon,
  fireworks: fireworksIcon,
  google: geminiIcon,
  groq: groqIcon,
  "lm-studio": lmStudioIcon,
  minimax: minimaxIcon,
  mistral: mistralIcon,
  moonshotai: kimiIcon,
  ollama: ollamaIcon,
  openai: openaiIcon,
  openrouter: openrouterIcon,
  qwen: qwenIcon,
  siliconflow: siliconFlowIcon,
  together: togetherIcon,
  xai: xaiIcon,
  zai: zhipuIcon,
};

export function ModelProviderLogo({
  presetId,
  className,
}: {
  readonly presetId: string;
  readonly className?: string;
}) {
  const icon = MODEL_PROVIDER_ICON_BY_PRESET_ID[presetId];
  const classes = className ? `model-provider-logo ${className}` : "model-provider-logo";

  return icon ? (
    <img className={classes} src={icon} alt="" aria-hidden="true" draggable={false} />
  ) : (
    <Robot className={classes} aria-hidden="true" />
  );
}

export function hasModelProviderLogo(presetId: string): boolean {
  return presetId in MODEL_PROVIDER_ICON_BY_PRESET_ID;
}
