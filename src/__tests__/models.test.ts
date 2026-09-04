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
    it("should return true for category 'model' or 'model_config'", () => {
      expect(
        isModelConfigOption({
          id: "custom_opt",
          name: "Custom",
          type: "select",
          category: "model",
          currentValue: "m1",
          options: [],
        } as any),
      ).toBe(true);

      expect(
        isModelConfigOption({
          id: "custom_opt",
          name: "Custom",
          type: "select",
          category: "model_config",
          currentValue: "m1",
          options: [],
        } as any),
      ).toBe(true);
    });

    it("should return true when id or name contains 'model'", () => {
      expect(
        isModelConfigOption({
          id: "model",
          name: "LLM",
          type: "select",
          currentValue: "m1",
          options: [],
        } as any),
      ).toBe(true);

      expect(
        isModelConfigOption({
          id: "select_model",
          name: "Selection",
          type: "select",
          currentValue: "m1",
          options: [],
        } as any),
      ).toBe(true);

      expect(
        isModelConfigOption({
          id: "opt1",
          name: "Language Model",
          type: "select",
          currentValue: "m1",
          options: [],
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
          options: [],
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

    it("should return undefined if model config option is boolean type", () => {
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
          id: "model_config",
          name: "Select Model",
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
      expect(result?.configId).toBe("model_config");
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
