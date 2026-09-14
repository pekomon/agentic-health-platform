import { describe, expect, it } from "vitest";

import {
  HEALTH_TOOL_NAMES,
  SleepHistoryToolResultSchema,
  connectHealthTools,
  createSyntheticHealthTools,
  evidenceFromToolResult
} from "../src/index.js";
import { SCENARIO_IDS, loadFixture } from "./helpers.js";

describe("MCP health tool protocol", () => {
  it("lists exactly the five semantic health tools", async () => {
    const connection = await connectHealthTools(createSyntheticHealthTools(loadFixture()));
    try {
      const tools = await connection.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([...HEALTH_TOOL_NAMES]);
      expect(tools.every((tool) => tool.inputSchema !== undefined)).toBe(true);
      expect(tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it.each(SCENARIO_IDS)("round trips all tools through MCP and delivers evidence after validation for %s", async (scenarioId) => {
    const delivered: string[] = [];
    const connection = await connectHealthTools(createSyntheticHealthTools(loadFixture(scenarioId)));
    connection.onDeliveredEvidence((evidence, toolName) => {
      delivered.push(`${toolName}:${evidence.length}`);
    });

    try {
      const profile = await connection.callTool("get_user_profile");
      const context = await connection.callTool("get_current_context");
      const sleep = await connection.callTool("get_sleep_history", { days: 1 });
      const recovery = await connection.callTool("get_recovery_history", { days: 1 });
      const training = await connection.callTool("get_recent_training", { days: 1 });

      expect(evidenceFromToolResult(profile).length).toBeGreaterThan(0);
      expect(evidenceFromToolResult(context).length).toBeGreaterThan(0);
      expect(SleepHistoryToolResultSchema.parse(sleep).days).toHaveLength(1);
      expect("days" in recovery ? recovery.days : []).toHaveLength(1);
      expect("days" in training ? training.days : []).toHaveLength(1);
      expect(delivered.map((entry) => entry.split(":")[0])).toEqual([...HEALTH_TOOL_NAMES]);
    } finally {
      await connection.close();
    }
  });

  it("rejects invalid tool arguments and unknown public tool names", async () => {
    const connection = await connectHealthTools(createSyntheticHealthTools(loadFixture()));
    try {
      await expect(connection.callTool("get_sleep_history", { days: 15 })).rejects.toThrow();
      await expect(connection.callTool("get_sleep_history", { days: 7, startDate: "2026-01-01" })).rejects.toThrow();
      await expect((connection.callTool as (name: string, input?: Record<string, unknown>) => Promise<unknown>)("get_all_health_data", {})).rejects.toThrow("UNKNOWN_TOOL");
    } finally {
      await connection.close();
    }
  });

  it("does not leak handles when closed twice", async () => {
    const connection = await connectHealthTools(createSyntheticHealthTools(loadFixture()));
    await connection.close();
    await connection.close();
    await expect(connection.callTool("get_sleep_history")).rejects.toThrow();
  });
});
