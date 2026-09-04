import { describe, it, expect, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import {
  isModelConfigOption,
  extractModels,
  formatModelsText,
  setSessionModel,
  type AgentModelsResult,
} from "../models.js";

describe("models", () => {
  describe("isModelConfigOption", () => {
    it("should return true for category 'model'", () => {
      expect(
        isModelConfigOption({
          id: "custom_opt",
          name: "Custom",
          type: "select",
          category: "model",
          currentValue: "m1",
          options: [{ value: "m1" }],
        } as any),
      ).toBe(true);
    });

    it("should return false for category 'model_config' or 'thought_level'", () => {
      expect(
        isModelConfigOption({
          id: "model_config",
          name: "Configuration",
          type: "select",
          category: "model_config",
          currentValue: "m1",
          options: [{ value: "m1" }],
        } as any),
      ).toBe(false);

      expect(
        isModelConfigOption({
          id: "thought_level",
          name: "Thinking Mode",
          type: "select",
          category: "thought_level",
          currentValue: "high",
          options: [{ value: "high" }],
        } as any),
      ).toBe(false);
    });

    it("should return false when type is not select", () => {
      expect(
        isModelConfigOption({
          id: "model",
          name: "Model",
          type: "boolean",
          category: "model",
          currentValue: true,
        } as any),
      ).toBe(false);
    });

    it("should return false for reasoning, thinking, or effort options", () => {
      expect(
        isModelConfigOption({
          id: "model_reasoning_effort",
          name: "Reasoning Effort",
          type: "select",
          currentValue: "medium",
          options: [{ value: "medium" }],
        } as any),
      ).toBe(false);

      expect(
        isModelConfigOption({
          id: "model_thinking",
          name: "Extended Thinking",
          type: "select",
          currentValue: "on",
          options: [{ value: "on" }],
        } as any),
      ).toBe(false);
    });

    it("should return true for model IDs or names", () => {
      expect(
        isModelConfigOption({
          id: "model",
          name: "LLM",
          type: "select",
          currentValue: "m1",
          options: [{ value: "m1" }],
        } as any),
      ).toBe(true);

      expect(
        isModelConfigOption({
          id: "model_id",
          name: "LLM Selection",
          type: "select",
          currentValue: "m1",
          options: [{ value: "m1" }],
        } as any),
      ).toBe(true);

      expect(
        isModelConfigOption({
          id: "llm",
          name: "Select Model",
          type: "select",
          currentValue: "m1",
          options: [{ value: "m1" }],
        } as any),
      ).toBe(true);
    });

    it("should return false when option is not related to models", () => {
      expect(
        isModelConfigOption({
          id: "theme",
          name: "Color Theme",
          type: "select",
          category: "ui",
          currentValue: "dark",
          options: [{ value: "dark" }],
        } as any),
      ).toBe(false);
    });
  });

  describe("extractModels", () => {
    it("should return undefined for empty or null configOptions", () => {
      expect(extractModels(undefined)).toBeUndefined();
      expect(extractModels(null)).toBeUndefined();
      expect(extractModels([])).toBeUndefined();
    });

    it("should return undefined if no model config option is present", () => {
      const configOptions: acp.SessionConfigOption[] = [
        {
          id: "theme",
          name: "Theme",
          type: "select",
          currentValue: "dark",
          options: [{ value: "dark", name: "Dark" }],
        } as any,
      ];
      expect(extractModels(configOptions)).toBeUndefined();
    });

    it("should return undefined if only boolean config option is present", () => {
      const configOptions: acp.SessionConfigOption[] = [
        {
          id: "model_enabled",
          name: "Model Enabled",
          type: "boolean",
          currentValue: true,
        } as any,
      ];
      expect(extractModels(configOptions)).toBeUndefined();
    });

    it("should skip non-select options and pick the real select model option", () => {
      const configOptions: acp.SessionConfigOption[] = [
        {
          id: "model_thinking",
          name: "Extended thinking",
          type: "boolean",
          currentValue: true,
        } as any,
        {
          id: "llm",
          name: "Model",
          type: "select",
          currentValue: "gpt-4o",
          options: [
            { value: "gpt-4", name: "GPT-4" },
            { value: "gpt-4o", name: "GPT-4o" },
          ],
        } as any,
      ];

      const result = extractModels(configOptions);
      expect(result).toBeDefined();
      expect(result?.configId).toBe("llm");
      expect(result?.currentModelId).toBe("gpt-4o");
      expect(result?.models).toHaveLength(2);
    });

    it("should prioritize category 'model' over auxiliary model_config selectors", () => {
      const configOptions: acp.SessionConfigOption[] = [
        {
          id: "model_reasoning_effort",
          name: "Reasoning Effort",
          category: "model_config",
          type: "select",
          currentValue: "medium",
          options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
        } as any,
        {
          id: "active_model",
          name: "Active Model",
          category: "model",
          type: "select",
          currentValue: "claude-3-7-sonnet",
          options: [
            { value: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
            { value: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
          ],
        } as any,
      ];

      const result = extractModels(configOptions);
      expect(result).toBeDefined();
      expect(result?.configId).toBe("active_model");
      expect(result?.currentModelId).toBe("claude-3-7-sonnet");
      expect(result?.models[0].id).toBe("claude-3-7-sonnet");
    });

    it("should reject category-less reasoning/effort/thinking options when alone", () => {
      const configOptions: acp.SessionConfigOption[] = [
        {
          id: "model_reasoning_effort",
          name: "Reasoning Effort",
          type: "select",
          currentValue: "medium",
          options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
        } as any,
      ];
      expect(extractModels(configOptions)).toBeUndefined();
    });

    it("should handle options with missing or undefined name safely", () => {
      const configOptions: acp.SessionConfigOption[] = [
        {
          id: "model",
          type: "select",
          currentValue: "m1",
          options: [{ value: "m1" }, { value: "m2", name: undefined }],
        } as any,
      ];

      const result = extractModels(configOptions);
      expect(result).toBeDefined();
      expect(result?.models).toEqual([
        { id: "m1", name: "m1", description: undefined, current: true },
        { id: "m2", name: "m2", description: undefined, current: false },
      ]);
    });

    it("should properly match current model with coerced non-string values", () => {
      const configOptions: acp.SessionConfigOption[] = [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: 123 as any,
          options: [{ value: 123 as any }, { value: 456 as any }],
        } as any,
      ];

      const result = extractModels(configOptions);
      expect(result).toBeDefined();
      expect(result?.currentModelId).toBe("123");
      expect(result?.models[0]).toEqual({
        id: "123",
        name: "123",
        description: undefined,
        current: true,
      });
      expect(result?.models[1].current).toBe(false);
    });
    it("should handle malformed or empty options safely", () => {
      const configOptions: acp.SessionConfigOption[] = [
        {
          id: "model",
          name: "Model",
          type: "select",
          options: [null as any, undefined as any, { value: "m1" }],
        } as any,
      ];

      const result = extractModels(configOptions);
      expect(result).toBeDefined();
      expect(result?.models).toEqual([
        { id: "m1", name: "m1", description: undefined, current: false },
      ]);
    });

    it("should extract flat list of model options with current model", () => {
      const configOptions: acp.SessionConfigOption[] = [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gemini-2.5-pro",
          options: [
            {
              value: "gemini-2.5-pro",
              name: "Gemini 2.5 Pro",
              description: "High capability model",
            },
            {
              value: "gemini-2.5-flash",
              name: "Gemini 2.5 Flash",
            },
          ],
        } as any,
      ];

      const result = extractModels(configOptions);
      expect(result).toBeDefined();
      expect(result?.configId).toBe("model");
      expect(result?.currentModelId).toBe("gemini-2.5-pro");
      expect(result?.models).toEqual([
        {
          id: "gemini-2.5-pro",
          name: "Gemini 2.5 Pro",
          description: "High capability model",
          current: true,
        },
        {
          id: "gemini-2.5-flash",
          name: "Gemini 2.5 Flash",
          description: undefined,
          current: false,
        },
      ]);
    });

    it("should extract grouped model options", () => {
      const configOptions: acp.SessionConfigOption[] = [
        {
          id: "model",
          name: "Select Model",
          category: "model",
          type: "select",
          currentValue: "claude-3-7-sonnet",
          options: [
            {
              group: "anthropic",
              name: "Anthropic",
              options: [
                {
                  value: "claude-3-7-sonnet",
                  name: "Claude 3.7 Sonnet",
                  description: "Hybrid reasoning model",
                },
              ],
            },
            {
              group: "google",
              name: "Google",
              options: [
                {
                  value: "gemini-2.5-pro",
                  name: "Gemini 2.5 Pro",
                },
              ],
            },
          ],
        } as any,
      ];

      const result = extractModels(configOptions);
      expect(result).toBeDefined();
      expect(result?.configId).toBe("model");
      expect(result?.currentModelId).toBe("claude-3-7-sonnet");
      expect(result?.models).toEqual([
        {
          id: "claude-3-7-sonnet",
          name: "Claude 3.7 Sonnet",
          description: "Hybrid reasoning model",
          current: true,
          group: "Anthropic",
        },
        {
          id: "gemini-2.5-pro",
          name: "Gemini 2.5 Pro",
          description: undefined,
          current: false,
          group: "Google",
        },
      ]);
    });
  });

  describe("formatModelsText", () => {
    it("should return fallback message if no models in result", () => {
      const res: AgentModelsResult = {
        configId: "model",
        models: [],
      };
      expect(formatModelsText(res, "gemini")).toBe("No models available for gemini.");
      expect(formatModelsText(res)).toBe("No models available for agent.");
    });

    it("should format models with current indicator, names, and descriptions", () => {
      const res: AgentModelsResult = {
        configId: "model",
        currentModelId: "gemini-2.5-pro",
        models: [
          {
            id: "gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
            description: "Most capable model",
            current: true,
          },
          {
            id: "gemini-2.5-flash",
            name: "Gemini 2.5 Flash",
            current: false,
          },
        ],
      };

      const formatted = formatModelsText(res, "gemini");
      expect(formatted).toContain('Models supported by "gemini":');
      expect(formatted).toContain("* gemini-2.5-pro (current)");
      expect(formatted).toContain("Gemini 2.5 Pro");
      expect(formatted).toContain("— Most capable model");
      expect(formatted).toContain("  gemini-2.5-flash");
    });

    it("should include groups when present", () => {
      const res: AgentModelsResult = {
        configId: "model",
        currentModelId: "claude-3-7-sonnet",
        models: [
          {
            id: "claude-3-7-sonnet",
            name: "Claude 3.7 Sonnet",
            group: "Anthropic",
            current: true,
          },
        ],
      };

      const formatted = formatModelsText(res);
      expect(formatted).toContain("Supported models:");
      expect(formatted).toContain("[Anthropic] Claude 3.7 Sonnet");
    });
  });

  describe("setSessionModel", () => {
    it("should call connection.setSessionConfigOption with correct params", async () => {
      const mockConnection = {
        setSessionConfigOption: vi.fn().mockResolvedValue({
          configOptions: [],
        }),
      } as unknown as acp.ClientSideConnection;

      const res = await setSessionModel(
        mockConnection,
        "sess-123",
        "model",
        "gemini-2.5-pro",
      );

      expect(mockConnection.setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: "sess-123",
        configId: "model",
        value: "gemini-2.5-pro",
      });
      expect(res).toEqual({ configOptions: [] });
    });
  });
});
