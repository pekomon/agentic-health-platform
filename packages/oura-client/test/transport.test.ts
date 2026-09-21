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
      withAccessToken: vi.fn()
    };
    
    transport = new OuraRestTransport(mockSession as any, "https://api.ouraring.com");
  });

  it("should initialize properly", () => {
    expect(transport).toBeDefined();
  });

  // The actual implementation test would require more complex mocking
  it("should have the required methods", () => {
    expect(typeof transport.listSleep).toBe("function");
    expect(typeof transport.listReadiness).toBe("function"); 
    expect(typeof transport.listWorkouts).toBe("function");
    expect(typeof transport.refreshAfterUnauthorized).toBe("function");
  });
});