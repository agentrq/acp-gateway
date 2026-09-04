/**
 * models.ts
 *
 * Extracts, formats, and manages LLM models supported by an ACP agent.
 *
 * ACP agents advertise configurable options via `configOptions` on `session/new`
 * and update them dynamically via `config_option_update` session notifications.
 * Models are represented as a select-type config option under the "model" or
 * "model_config" category/id.
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
  /** The config option ID used to select models (e.g. "model", "model_config"). */
  configId: string;
  /** The currently selected model identifier, if any. */
  currentModelId?: string;
  /** All selectable models offered by the agent. */
  models: AgentModel[];
}

/**
 * Determines whether a session config option represents an LLM model selector.
 */
export function isModelConfigOption(option: acp.SessionConfigOption): boolean {
  if (option.category === "model" || option.category === "model_config") {
    return true;
  }
  const id = option.id.toLowerCase();
  const name = option.name.toLowerCase();
  return (
    id === "model" ||
    id === "model_config" ||
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
  if (!configOptions || configOptions.length === 0) return undefined;

  // Prioritize an option with category === "model" or exact id === "model"
  const modelOption =
    configOptions.find((opt) => opt.category === "model" || opt.id === "model") ??
    configOptions.find(isModelConfigOption);

  if (!modelOption || modelOption.type !== "select") return undefined;

  const models: AgentModel[] = [];
  const currentModelId =
    typeof modelOption.currentValue === "string"
      ? modelOption.currentValue
      : undefined;

  for (const item of modelOption.options) {
    if ("group" in item && Array.isArray(item.options)) {
      const groupName = item.name || item.group;
      for (const opt of item.options) {
        models.push({
          id: opt.value,
          name: opt.name || opt.value,
          description: opt.description ?? undefined,
          current: opt.value === currentModelId,
          group: groupName,
        });
      }
    } else if ("value" in item) {
      models.push({
        id: item.value,
        name: item.name || item.value,
        description: item.description ?? undefined,
        current: item.value === currentModelId,
      });
    }
  }

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
