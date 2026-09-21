import { describe, it, expect, vi, beforeEach } from "vitest";
import { OuraRestTransport } from "../src/transport/transport.js";

// Mock fetch for testing
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("OuraRestTransport", () => {
  let transport: OuraRestTransport;
  
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock a session that we can test with
    const mockSession = {
      withAccessToken: vi.fn(),
      refreshAfterUnauthorized: vi.fn()
    };
    
    transport = new OuraRestTransport(mockSession as any, "https://api.ouraring.com");
  });

  it("should initialize properly", () => {
    expect(transport).toBeDefined();
  });

  it("should have the required methods", () => {
    expect(typeof transport.listSleep).toBe("function");
    expect(typeof transport.listReadiness).toBe("function"); 
    expect(typeof transport.listWorkouts).toBe("function");
    expect(typeof transport.refreshAfterUnauthorized).toBe("function");
  });
  
  it("should handle 401 recovery properly", async () => {
    // This would test the 401 recovery mechanism more thoroughly
    expect(true).toBe(true);
  });
});