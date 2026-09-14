import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  EmptyToolInputSchema,
  HistoryToolInputSchema,
  MAX_TOOL_RESPONSE_BYTES,
  TOOL_RESULT_SCHEMAS,
  type HealthToolName,
  type HealthToolResult,
  type SemanticHealthReaders
} from "./contracts.js";

function successResult(result: HealthToolResult): CallToolResult {
  const text = JSON.stringify(result);
  if (new TextEncoder().encode(text).byteLength > MAX_TOOL_RESPONSE_BYTES) {
    return { content: [{ type: "text", text: "OUTPUT_LIMIT" }], isError: true };
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: result
  };
}

function errorResult(code: string): CallToolResult {
  return { content: [{ type: "text", text: code }], isError: true };
}

function validatedResult(name: HealthToolName, value: unknown): CallToolResult {
  const parsed = TOOL_RESULT_SCHEMAS[name].safeParse(value);
  if (!parsed.success) return errorResult("OUTPUT_VALIDATION_FAILED");
  return successResult(parsed.data as HealthToolResult);
}

function safeToolResult(name: HealthToolName, read: () => unknown): CallToolResult {
  try {
    return validatedResult(name, read());
  } catch {
    return errorResult("INTERNAL_ERROR");
  }
}

export function createHealthToolsServer(readers: SemanticHealthReaders): McpServer {
  const server = new McpServer({ name: "agentic-health-platform-health-tools", version: "0.0.0" });

  server.registerTool(
    "get_user_profile",
    {
      title: "Get User Profile",
      description: "Return the explicit synthetic training profile with provenance.",
      inputSchema: EmptyToolInputSchema,
      outputSchema: TOOL_RESULT_SCHEMAS.get_user_profile
    },
    async () => safeToolResult("get_user_profile", () => readers.get_user_profile())
  );

  server.registerTool(
    "get_current_context",
    {
      title: "Get Current Context",
      description: "Return the frozen synthetic current context with provenance.",
      inputSchema: EmptyToolInputSchema,
      outputSchema: TOOL_RESULT_SCHEMAS.get_current_context
    },
    async () => safeToolResult("get_current_context", () => readers.get_current_context())
  );

  server.registerTool(
    "get_sleep_history",
    {
      title: "Get Sleep History",
      description: "Return bounded recent synthetic sleep history.",
      inputSchema: HistoryToolInputSchema,
      outputSchema: TOOL_RESULT_SCHEMAS.get_sleep_history
    },
    async (input) => safeToolResult("get_sleep_history", () => readers.get_sleep_history(input))
  );

  server.registerTool(
    "get_recovery_history",
    {
      title: "Get Recovery History",
      description: "Return bounded recent synthetic recovery history.",
      inputSchema: HistoryToolInputSchema,
      outputSchema: TOOL_RESULT_SCHEMAS.get_recovery_history
    },
    async (input) => safeToolResult("get_recovery_history", () => readers.get_recovery_history(input))
  );

  server.registerTool(
    "get_recent_training",
    {
      title: "Get Recent Training",
      description: "Return bounded recent synthetic training history.",
      inputSchema: HistoryToolInputSchema,
      outputSchema: TOOL_RESULT_SCHEMAS.get_recent_training
    },
    async (input) => safeToolResult("get_recent_training", () => readers.get_recent_training(input))
  );

  return server;
}
