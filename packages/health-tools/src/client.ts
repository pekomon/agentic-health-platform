import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FetchLike, Tool } from "@modelcontextprotocol/client";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";

import {
  HEALTH_TOOL_NAMES,
  evidenceFromToolResult,
  isHealthToolName,
  validateToolResult,
  type HealthToolName,
  type HealthToolResult,
  type SemanticHealthReaders
} from "./contracts.js";
import { createHealthToolsServer } from "./server.js";
import type { Evidence } from "@ahp/health-domain";

export type DeliveredEvidenceListener = (evidence: Evidence[], toolName: HealthToolName) => void;

export type HealthToolsConnection = {
  listTools(): Promise<Tool[]>;
  callTool(name: HealthToolName, input?: Record<string, unknown>): Promise<HealthToolResult>;
  onDeliveredEvidence(listener: DeliveredEvidenceListener): () => void;
  close(): Promise<void>;
};

function evidenceId(evidence: Evidence): string {
  return evidence.kind === "observation" ? evidence.observation.id : evidence.id;
}

function assertDeliveredEvidence(current: Map<string, Evidence>, entries: Evidence[]): void {
  for (const entry of entries) {
    const id = evidenceId(entry);
    const existing = current.get(id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error("CONFLICTING_EVIDENCE");
    current.set(id, entry);
  }
}

function fetchFromHandler(handler: McpHttpHandler): FetchLike {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler.fetch(request);
  };
}

export async function connectHealthTools(readers: SemanticHealthReaders): Promise<HealthToolsConnection> {
  const handler = createMcpHandler(() => createHealthToolsServer(readers), { responseMode: "json" });
  const transport = new StreamableHTTPClientTransport(new URL("http://health-tools.local/mcp"), { fetch: fetchFromHandler(handler) });
  const client = new Client(
    { name: "agentic-health-platform-health-tools-client", version: "0.0.0" },
    { versionNegotiation: { mode: "auto" } }
  );
  const listeners = new Set<DeliveredEvidenceListener>();
  const delivered = new Map<string, Evidence>();
  let closed = false;

  await client.connect(transport);

  return {
    async listTools() {
      const result = await client.listTools(undefined, { cacheMode: "bypass" });
      const tools = result.tools;
      if (tools.length !== HEALTH_TOOL_NAMES.length || tools.some((tool, index) => tool.name !== HEALTH_TOOL_NAMES[index])) {
        throw new Error("UNEXPECTED_TOOL_LIST");
      }
      return tools;
    },

    async callTool(name, input = {}) {
      if (!isHealthToolName(name)) throw new Error("UNKNOWN_TOOL");
      const result = await client.callTool({ name, arguments: input });
      if (result.isError) {
        const code = result.content[0]?.type === "text" ? result.content[0].text : "TOOL_ERROR";
        throw new Error(code);
      }
      const parsed = validateToolResult(name, result.structuredContent);
      const evidence = evidenceFromToolResult(parsed);
      assertDeliveredEvidence(delivered, evidence);
      for (const listener of listeners) listener(evidence, name);
      return parsed;
    },

    onDeliveredEvidence(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      await client.close();
      await handler.close();
    }
  };
}
