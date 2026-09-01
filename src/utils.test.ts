import { describe, it, expect, vi } from "vitest";
import {
  shouldExcludeFile,
  MAX_FILE_SIZE,
  isRetryableStatus,
  fetchWithRetry,
  parseStructuredReview,
  formatStructuredReview,
} from "./utils";

describe("shouldExcludeFile", () => {
  it("excludes lock files", () => {
    expect(shouldExcludeFile("package-lock.json")).toBe(true);
    expect(shouldExcludeFile("yarn.lock")).toBe(true);
    expect(shouldExcludeFile("pnpm-lock.yaml")).toBe(true);
    expect(shouldExcludeFile("some-tool.lock")).toBe(true);
  });

  it("excludes minified and bundled assets", () => {
    expect(shouldExcludeFile("app.min.js")).toBe(true);
    expect(shouldExcludeFile("styles.min.css")).toBe(true);
    expect(shouldExcludeFile("app.bundle.js")).toBe(true);
  });

  it("excludes node_modules, .git, and system/temp files", () => {
    expect(shouldExcludeFile("node_modules/foo/index.js")).toBe(true);
    expect(shouldExcludeFile(".git/config")).toBe(true);
    expect(shouldExcludeFile(".DS_Store")).toBe(true);
    expect(shouldExcludeFile("debug.log")).toBe(true);
    expect(shouldExcludeFile("cache.tmp")).toBe(true);
    expect(shouldExcludeFile("cache.temp")).toBe(true);
  });

  it("does not exclude regular source files", () => {
    expect(shouldExcludeFile("src/index.ts")).toBe(false);
    expect(shouldExcludeFile("README.md")).toBe(false);
  });

  it("excludes a file whose patch exceeds the size cap", () => {
    const oversizedPatch = "x".repeat(MAX_FILE_SIZE + 1);
    expect(shouldExcludeFile("src/big.ts", oversizedPatch)).toBe(true);
  });

  it("does not exclude a file whose patch is exactly at the size cap", () => {
    const exactPatch = "x".repeat(MAX_FILE_SIZE);
    expect(shouldExcludeFile("src/big.ts", exactPatch)).toBe(false);
  });

  it("does not exclude a file with no patch (e.g. binary or renamed files)", () => {
    expect(shouldExcludeFile("src/ok.ts", undefined)).toBe(false);
  });
});

describe("isRetryableStatus", () => {
  it("treats 5xx as retryable", () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  it("treats 4xx as non-retryable", () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(429)).toBe(false);
  });

  it("treats 2xx as non-retryable (no retry needed)", () => {
    expect(isRetryableStatus(200)).toBe(false);
  });
});

function mockResponse(status: number, ok: boolean) {
  return {
    ok,
    status,
    statusText: `Status ${status}`,
    text: async () => "",
    json: async () => ({}),
  } as any;
}

describe("fetchWithRetry", () => {
  it("returns immediately on a successful response, without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(200, true));

    const response = await fetchWithRetry("https://example.com", "{}", fetchImpl, 3, 1);

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry on a 4xx response (e.g. bad API key)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(401, false));

    const response = await fetchWithRetry("https://example.com", "{}", fetchImpl, 3, 1);

    expect(response.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on a 5xx response up to maxRetries, then returns the last response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(503, false));

    const response = await fetchWithRetry("https://example.com", "{}", fetchImpl, 3, 1);

    expect(response.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 1 initial attempt + 3 retries
  });

  it("retries on thrown network errors and succeeds once the network recovers", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(mockResponse(200, true));

    const response = await fetchWithRetry("https://example.com", "{}", fetchImpl, 3, 1);

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after exhausting retries on persistent network errors", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      fetchWithRetry("https://example.com", "{}", fetchImpl, 3, 1)
    ).rejects.toThrow("ECONNRESET");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("backs off exponentially between retries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse(503, false));

    const start = Date.now();
    await fetchWithRetry("https://example.com", "{}", fetchImpl, 3, 10);
    const elapsed = Date.now() - start;

    // delays are 10ms, 20ms, 40ms => at least 70ms total; allow scheduling jitter
    expect(elapsed).toBeGreaterThanOrEqual(60);
  });
});

describe("parseStructuredReview", () => {
  it("parses a well-formed JSON response", () => {
    const raw = JSON.stringify({
      summary: "Looks mostly good.",
      issues: [
        { severity: "warning", category: "style", file: "src/index.ts", line: 12, message: "Use const instead of let." },
      ],
    });

    const result = parseStructuredReview(raw);

    expect(result).toEqual({
      summary: "Looks mostly good.",
      issues: [
        { severity: "warning", category: "style", file: "src/index.ts", line: 12, message: "Use const instead of let." },
      ],
    });
  });

  it("strips a markdown code fence if the model adds one anyway", () => {
    const raw = "```json\n" + JSON.stringify({ summary: "ok", issues: [] }) + "\n```";

    expect(parseStructuredReview(raw)).toEqual({ summary: "ok", issues: [] });
  });

  it("defaults missing file/line to null", () => {
    const raw = JSON.stringify({
      summary: "ok",
      issues: [{ severity: "info", category: "bug", message: "Edge case not handled." }],
    });

    const result = parseStructuredReview(raw);

    expect(result?.issues[0].file).toBeNull();
    expect(result?.issues[0].line).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseStructuredReview("not json at all")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseStructuredReview(JSON.stringify({ issues: [] }))).toBeNull();
  });

  it("returns null when an issue has an invalid severity", () => {
    const raw = JSON.stringify({
      summary: "ok",
      issues: [{ severity: "extremely-bad", category: "bug", message: "x" }],
    });

    expect(parseStructuredReview(raw)).toBeNull();
  });
});

describe("formatStructuredReview", () => {
  it("groups issues by severity, critical first", () => {
    const output = formatStructuredReview({
      summary: "Two issues found.",
      issues: [
        { severity: "info", category: "style", file: null, line: null, message: "Minor nit." },
        { severity: "critical", category: "security", file: "src/auth.ts", line: 10, message: "SQL injection risk." },
      ],
    });

    const criticalIndex = output.indexOf("Critical");
    const infoIndex = output.indexOf("Info");

    expect(criticalIndex).toBeGreaterThan(-1);
    expect(infoIndex).toBeGreaterThan(-1);
    expect(criticalIndex).toBeLessThan(infoIndex);
    expect(output).toContain("src/auth.ts:10");
  });

  it("reports no issues found when the array is empty", () => {
    const output = formatStructuredReview({ summary: "All clear.", issues: [] });

    expect(output).toContain("No issues found.");
  });
});
