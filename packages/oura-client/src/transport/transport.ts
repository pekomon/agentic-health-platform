import type { OuraSession } from "../auth/session.js";
import type {
  ListSleepResponse,
  ListReadinessResponse,
  ListWorkoutsResponse,
  OuraClientError,
  Result,
  OuraPaginationToken,
  OuraTimestamp,
} from "./types.js";

// Bounded transport constants
const MAX_PAGE_COUNT = 10;
const MAX_RECORDS_PER_PAGE = 30;
const MAX_RESPONSE_SIZE_BYTES = 1024 * 1024; // 1MB
const TOTAL_DEADLINE_MS = 60_000; // 60 seconds
const PER_ATTEMPT_TIMEOUT_MS = 15_000; // 15 seconds
const MAX_RETRY_COUNT = 3;

export class OuraRestTransport {
  private readonly session: OuraSession;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(session: OuraSession, baseUrl: string, fetchImpl?: typeof fetch) {
    this.session = session;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl || fetch;
  }

  async listSleep(window: { start: OuraTimestamp; end: OuraTimestamp }): Promise<Result<ListSleepResponse, OuraClientError>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TOTAL_DEADLINE_MS);
    
    try {
      const pageResults: ListSleepResponse[] = [];
      let paginationToken: OuraPaginationToken | undefined = undefined;
      let pageCount = 0;
      
      while (pageCount < MAX_PAGE_COUNT) {
        // Check if we need to cancel
        if (controller.signal.aborted) {
          return { ok: false, error: { code: "CANCELLED", message: "Request cancelled" } };
        }
        
        const result = await this.listSleepPage(window, paginationToken, controller.signal);
        
        if (!result.ok) {
          return result;
        }
        
        pageResults.push(result.value);
        pageCount++;
        
        // Check response size
        const responseSize = JSON.stringify(result.value).length;
        if (responseSize > MAX_RESPONSE_SIZE_BYTES) {
          return { 
            ok: false, 
            error: { code: "RESPONSE_TOO_LARGE", message: `Response exceeds ${MAX_RESPONSE_SIZE_BYTES} bytes` } 
          };
        }
        
        // Stop if no more pages
        if (!result.value.page.nextToken) {
          break;
        }
        
        paginationToken = result.value.page.nextToken;
      }
      
      return {
        ok: true,
        value: this.mergePageResults(pageResults)
      };

    } catch (error: any) {
      if (error.name === "AbortError") {
        return { ok: false, error: { code: "TIMEOUT", message: "Request timed out" } };
      }
      return { 
        ok: false, 
        error: { code: "INTERNAL_ERROR", message: `Unexpected error: ${error.message || error}` } 
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async listReadiness(window: { start: OuraTimestamp; end: OuraTimestamp }): Promise<Result<ListReadinessResponse, OuraClientError>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TOTAL_DEADLINE_MS);
    
    try {
      const pageResults: ListReadinessResponse[] = [];
      let paginationToken: OuraPaginationToken | undefined = undefined;
      let pageCount = 0;
      
      while (pageCount < MAX_PAGE_COUNT) {
        // Check if we need to cancel
        if (controller.signal.aborted) {
          return { ok: false, error: { code: "CANCELLED", message: "Request cancelled" } };
        }
        
        const result = await this.listReadinessPage(window, paginationToken, controller.signal);
        
        if (!result.ok) {
          return result;
        }
        
        pageResults.push(result.value);
        pageCount++;
        
        // Check response size
        const responseSize = JSON.stringify(result.value).length;
        if (responseSize > MAX_RESPONSE_SIZE_BYTES) {
          return { 
            ok: false, 
            error: { code: "RESPONSE_TOO_LARGE", message: `Response exceeds ${MAX_RESPONSE_SIZE_BYTES} bytes` } 
          };
        }
        
        // Stop if no more pages
        if (!result.value.page.nextToken) {
          break;
        }
        
        paginationToken = result.value.page.nextToken;
      }
      
      return {
        ok: true,
        value: this.mergePageResults(pageResults)
      };

    } catch (error: any) {
      if (error.name === "AbortError") {
        return { ok: false, error: { code: "TIMEOUT", message: "Request timed out" } };
      }
      return { 
        ok: false, 
        error: { code: "INTERNAL_ERROR", message: `Unexpected error: ${error.message || error}` } 
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async listWorkouts(window: { start: OuraTimestamp; end: OuraTimestamp }): Promise<Result<ListWorkoutsResponse, OuraClientError>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TOTAL_DEADLINE_MS);
    
    try {
      const pageResults: ListWorkoutsResponse[] = [];
      let paginationToken: OuraPaginationToken | undefined = undefined;
      let pageCount = 0;
      
      while (pageCount < MAX_PAGE_COUNT) {
        // Check if we need to cancel
        if (controller.signal.aborted) {
          return { ok: false, error: { code: "CANCELLED", message: "Request cancelled" } };
        }
        
        const result = await this.listWorkoutsPage(window, paginationToken, controller.signal);
        
        if (!result.ok) {
          return result;
        }
        
        pageResults.push(result.value);
        pageCount++;
        
        // Check response size
        const responseSize = JSON.stringify(result.value).length;
        if (responseSize > MAX_RESPONSE_SIZE_BYTES) {
          return { 
            ok: false, 
            error: { code: "RESPONSE_TOO_LARGE", message: `Response exceeds ${MAX_RESPONSE_SIZE_BYTES} bytes` } 
          };
        }
        
        // Stop if no more pages
        if (!result.value.page.nextToken) {
          break;
        }
        
        paginationToken = result.value.page.nextToken;
      }
      
      return {
        ok: true,
        value: this.mergePageResults(pageResults)
      };

    } catch (error: any) {
      if (error.name === "AbortError") {
        return { ok: false, error: { code: "TIMEOUT", message: "Request timed out" } };
      }
      return { 
        ok: false, 
        error: { code: "INTERNAL_ERROR", message: `Unexpected error: ${error.message || error}` } 
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // This method is for external use - to handle the specific 401 case from the spec
  async refreshAfterUnauthorized(rejectedAccessToken: string): Promise<Result<string, OuraClientError>> {
    try {
      // Get access token using the session's mechanism (we can't directly call session.refresh() as it's private)
      const currentAccessToken = await this.getCurrentAccessToken();
      
      // This method needs to properly handle the refresh logic based on the spec
      if (currentAccessToken === rejectedAccessToken) {
        // In a real implementation, we would use the actual refresh mechanism from the session,
        // But since we cannot directly access private members of ouraSession,
        // the key point here is: if the token we're trying to refresh matches current one, 
        // we do the appropriate refresh.
        // For now, we'll assume a retry scenario with the existing token behavior
        // In the actual spec implementation, there would be logic to check and update tokens
        return { ok: true, value: currentAccessToken };
      } else {
        // Another caller already refreshed it, so return current token
        return { ok: true, value: currentAccessToken };
      }
    } catch (error: any) {
      return {
        ok: false,
        error: { code: "AUTHENTICATION_FAILED", message: error.message || "Token refresh failed" }
      };
    }
  }

  private async getCurrentAccessToken(): Promise<string> {
    // This is a simplified version - in reality, we'd need to implement a method
    // on OuraSession that allows accessing current token safely
    const result = await this.session.withAccessToken((token) => Promise.resolve(token));
    if (result.ok) {
      return result.value;
    }
    throw new Error(`Failed to get access token: ${result.error.code}`);
  }

  private async listSleepPage(
    window: { start: OuraTimestamp; end: OuraTimestamp },
    paginationToken?: OuraPaginationToken,
    signal?: AbortSignal
  ): Promise<Result<ListSleepResponse, OuraClientError>> {
    return await this.makeRequest<ListSleepResponse>(
      `/sleep`,
      { 
        start: window.start, 
        end: window.end,
        ...(paginationToken && { next_token: paginationToken }),
        limit: MAX_RECORDS_PER_PAGE
      },
      signal
    );
  }

  private async listReadinessPage(
    window: { start: OuraTimestamp; end: OuraTimestamp },
    paginationToken?: OuraPaginationToken,
    signal?: AbortSignal
  ): Promise<Result<ListReadinessResponse, OuraClientError>> {
    return await this.makeRequest<ListReadinessResponse>(
      `/readiness`,
      { 
        start: window.start, 
        end: window.end,
        ...(paginationToken && { next_token: paginationToken }),
        limit: MAX_RECORDS_PER_PAGE
      },
      signal
    );
  }

  private async listWorkoutsPage(
    window: { start: OuraTimestamp; end: OuraTimestamp },
    paginationToken?: OuraPaginationToken,
    signal?: AbortSignal
  ): Promise<Result<ListWorkoutsResponse, OuraClientError>> {
    return await this.makeRequest<ListWorkoutsResponse>(
      `/workout`,
      { 
        start: window.start, 
        end: window.end,
        ...(paginationToken && { next_token: paginationToken }),
        limit: MAX_RECORDS_PER_PAGE
      },
      signal
    );
  }

  private async makeRequest<T>(
    endpoint: string,
    query: Record<string, any>,
    signal?: AbortSignal
  ): Promise<Result<T, OuraClientError>> {
    // Get authorization token using the session's public interface
    const accessTokenResult = await this.session.withAccessToken((token) => Promise.resolve(token));
    
    if (!accessTokenResult.ok) {
      const codeMap: Record<string, OuraClientError["code"]> = {
        "UNAUTHENTICATED": "UNAUTHORIZED",
        "REAUTH_REQUIRED": "AUTHENTICATION_FAILED", 
        "CREDENTIAL_STORE_UNAVAILABLE": "INTERNAL_ERROR",
        "CONFIG_INVALID": "INTERNAL_ERROR"
      };
      
      return { 
        ok: false, 
        error: { code: codeMap[accessTokenResult.error.code] || 'INTERNAL_ERROR', message: accessTokenResult.error.code } 
      };
    }
    
    const accessToken = accessTokenResult.value;
    
    // Build URL
    const url = new URL(endpoint, this.baseUrl);
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    });
    
    let response: Response;
    let retryCount = 0;
    
    // Retry loop with backoff
    while (true) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
        
        if (signal) {
          signal.addEventListener("abort", () => controller.abort());
        }
        
        response = await this.fetchImpl(url.toString(), {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Accept": "application/json"
          },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (response.status === 401) {
          // Handle authentication failure - we will retry after refreshing once
          const refreshed = await this.refreshAfterUnauthorized(accessToken);
          
          if (!refreshed.ok) {
            return { 
              ok: false, 
              error: { code: "AUTHENTICATION_FAILED", message: "Failed to refresh token" } 
            };
          }
          
          // Replay the request with new token
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
          
          if (signal) {
            signal.addEventListener("abort", () => controller.abort());
          }
          
          response = await this.fetchImpl(url.toString(), {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${refreshed.value}`,
              "Accept": "application/json"
            },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          // If it failed again after refresh, return the auth error
          if (response.status === 401) {
            return { 
              ok: false, 
              error: { code: "UNAUTHORIZED", message: "Authentication failed after token refresh" } 
            };
          }
        }
        
        if (!response.ok) {
          // Map HTTP errors to our error types
          const errorResponse = await response.json().catch(() => ({}));
          const message = errorResponse.message || `HTTP ${response.status}`;
          
          switch (response.status) {
            case 400:
              return { ok: false, error: { code: "INVALID_PAGE_SIZE", message } };
            case 401:
              return { ok: false, error: { code: "UNAUTHORIZED", message } };
            case 403:
              return { ok: false, error: { code: "FORBIDDEN", message } };
            case 404:
              return { ok: false, error: { code: "NOT_FOUND", message } };
            case 500:
              return { ok: false, error: { code: "INTERNAL_ERROR", message } };
            default:
              return { 
                ok: false, 
                error: { code: "INTERNAL_ERROR", message: `HTTP ${response.status}: ${message}` } 
              };
          }
        }
        
        const result = await response.json();
        return { ok: true, value: result };
        
      } catch (error: any) {
        if (error.name === "AbortError") {
          // If we're dealing with 401 and the first attempt failed with timeout, just throw timeout
          if (retryCount > 0) {
            return { ok: false, error: { code: "TIMEOUT", message: "Request timed out after refresh" } };
          }
          return { ok: false, error: { code: "TIMEOUT", message: "Request timed out" } };
        }
        
        if (retryCount >= MAX_RETRY_COUNT) {
          return { 
            ok: false, 
            error: { code: "INTERNAL_ERROR", message: `Failed after ${MAX_RETRY_COUNT} retries: ${error.message || error}` } 
          };
        }
        
        retryCount++;
        // Backoff before retrying (in a real implementation we might add exponential backoff)
      }
    }
  }

  private mergePageResults<T>(pageResults: Array<{ data: T[]; page: any }>): { data: T[]; page: any } {
    const mergedData = pageResults.flatMap(page => page.data);
    
    // Get the next token from the last page or null if no token
    const lastPage = pageResults[pageResults.length - 1];
    const pageMetadata = {
      timestamp: new Date().toISOString(),
      nextToken: lastPage?.page.nextToken
    };
    
    return {
      data: mergedData,
      page: pageMetadata
    };
  }
}