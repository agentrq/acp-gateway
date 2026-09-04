/**
 * models.ts
 *
 * Extracts, formats, and manages LLM models supported by an ACP agent.
 *
 * ACP agents advertise configurable options via `configOptions` on `session/new`
 * and update them dynamically via `config_option_update` session notifications.
 * Models are represented as a select-type config option under the "model" category/id.
 */

import type * as acp from "@agentclientprotocol/sdk";

export interface AgentModel {
  /** Unique model identifier (e.g. "gemini-2.5-pro", "claude-3-7-sonnet"). */
  id: string;
  /** Human-readable display name (e.g. "Gemini 2.5 Pro"). */
  name: string;
  /** Optional model description. */
  description?: string;
  /** Whether this is currently the active model. */
  current?: boolean;
  /** Optional grouping name (e.g. "Anthropic", "Google"). */
  group?: string;
}

export interface AgentModelsResult {
  /** The config option ID used to select models (e.g. "model", "model_id"). */
  configId: string;
  /** The currently selected model identifier, if any. */
  currentModelId?: string;
  /** All selectable models offered by the agent. */
  models: AgentModel[];
}

/**
 * Determines whether a session config option represents an LLM model selector.
 *
 * Restricts to select-type options and specifically excludes auxiliary configuration
 * categories (e.g. "model_config", "thought_level") or options for reasoning effort/thinking.
 */
export function isModelConfigOption(option: acp.SessionConfigOption): boolean {
  if (option.type !== "select") return false;
  if (option.category === "model") return true;

  // The ACP spec uses category "model_config" and "thought_level" for auxiliary controls
  // like reasoning effort or thinking mode. We must not mistake these for the model list.
  if (option.category === "model_config" || option.category === "thought_level") {
    return false;
  }

  const id = (option.id || "").toLowerCase();
  const name = (option.name || "").toLowerCase();

  // Exclude common non-model sub-selectors (reasoning effort, thinking, etc.)
  if (
    id.includes("effort") ||
    id.includes("thinking") ||
    id.includes("reasoning") ||
    name.includes("effort") ||
    name.includes("thinking") ||
    name.includes("reasoning")
  ) {
    return false;
  }

  return (
    id === "model" ||
    id === "model_id" ||
    id === "model_name" ||
    id === "llm" ||
    name === "model" ||
    name === "select model" ||
    id.includes("model") ||
    name.includes("model")
  );
}

/**
 * Extracts the list of supported models from an agent's session `configOptions`.
 */
export function extractModels(
  configOptions?: Array<acp.SessionConfigOption> | null,
): AgentModelsResult | undefined {
  if (!configOptions || !Array.isArray(configOptions) || configOptions.length === 0) {
    return undefined;
  }

  // Filter candidates strictly to select-type options that have an options array
  const selectOptions = configOptions.filter(
    (opt): opt is acp.SessionConfigOption & { type: "select"; options: any[] } =>
      opt.type === "select" && Array.isArray(opt.options) && opt.options.length > 0,
  );

  if (selectOptions.length === 0) return undefined;

  // Priority 1: category === "model" or exact id === "model"
  // Priority 2: candidate matching isModelConfigOption
  // Priority 3: any remaining select option with "model" in id/name without non-model keywords
  const modelOption =
    selectOptions.find((opt) => opt.category === "model" || opt.id === "model") ??
    selectOptions.find(isModelConfigOption) ??
    selectOptions.find(
      (opt) =>
        opt.category !== "model_config" &&
        opt.category !== "thought_level" &&
        (opt.id.toLowerCase().includes("model") || opt.name.toLowerCase().includes("model")),
    );

  if (!modelOption || !Array.isArray(modelOption.options) || modelOption.options.length === 0) {
    return undefined;
  }

  const models: AgentModel[] = [];
  const currentModelId =
    typeof modelOption.currentValue === "string"
      ? modelOption.currentValue
      : undefined;

  for (const item of modelOption.options) {
    if (!item || typeof item !== "object") continue;

    if ("group" in item && Array.isArray((item as any).options)) {
      const groupName = (item as any).name || (item as any).group;
      for (const opt of (item as any).options) {
        if (!opt || typeof opt !== "object" || !("value" in opt)) continue;
        models.push({
          id: String(opt.value),
          name: opt.name || String(opt.value),
          description: opt.description ?? undefined,
          current: opt.value === currentModelId,
          group: groupName,
        });
      }
    } else if ("value" in item) {
      models.push({
        id: String(item.value),
        name: item.name || String(item.value),
        description: item.description ?? undefined,
        current: item.value === currentModelId,
      });
    }
  }

  if (models.length === 0) return undefined;

  return {
    configId: modelOption.id,
    currentModelId,
    models,
  };
}

/**
 * Formats the list of models into a readable text output for CLI display.
 */
export function formatModelsText(
  result: AgentModelsResult,
  agentName?: string,
): string {
  if (result.models.length === 0) {
    return `No models available for ${agentName ?? "agent"}.`;
  }

  const header = agentName
    ? `Models supported by "${agentName}":`
    : `Supported models:`;

  const rows: Array<[string, string, string]> = result.models.map((m) => {
    const marker = m.current ? "* " : "  ";
    const idLabel = `${marker}${m.id}${m.current ? " (current)" : ""}`;
    const nameLabel = m.name !== m.id ? m.name : "";
    const descLabel = m.description ? `— ${m.description}` : "";
    const groupLabel = m.group ? `[${m.group}] ` : "";
    return [idLabel, `${groupLabel}${nameLabel}`.trim(), descLabel];
  });

  const idWidth = Math.max(...rows.map(([id]) => id.length));
  const nameWidth = Math.max(...rows.map(([, name]) => name.length));

  const body = rows
    .map(([id, name, desc]) => {
      const col1 = id.padEnd(idWidth);
      const col2 = nameWidth > 0 ? (name ? name.padEnd(nameWidth) : "".padEnd(nameWidth)) : "";
      const parts = [col1];
      if (col2) parts.push(col2);
      if (desc) parts.push(desc);
      return `  ${parts.join("  ")}`.trimEnd();
    })
    .join("\n");

  return `${header}\n\n${body}`;
}

/**
 * Sets the active model on an ACP session via `session/set_config_option`.
 */
export async function setSessionModel(
  connection: acp.ClientSideConnection,
  sessionId: string,
  configId: string,
  modelId: string,
): Promise<acp.SetSessionConfigOptionResponse> {
  return await connection.setSessionConfigOption({
    sessionId,
    configId,
    value: modelId,
  });
}
