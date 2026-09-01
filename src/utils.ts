import * as core from "@actions/core";
import fetch from "node-fetch";

export interface FileChange {
  filename: string;
  patch?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

// File types to exclude from review
export const EXCLUDED_FILE_PATTERNS = [
  /\.lock$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.min\.(js|css)$/,
  /\.bundle\.(js|css)$/,
  /node_modules/,
  /\.git/,
  /\.DS_Store$/,
  /\.log$/,
  /\.tmp$/,
  /\.temp$/,
];

export const MAX_FILE_SIZE = 50000;

export function shouldExcludeFile(filename: string, patch?: string): boolean {
  // Check file patterns
  if (EXCLUDED_FILE_PATTERNS.some(pattern => pattern.test(filename))) {
    return true;
  }

  // Check file size
  if (patch && patch.length > MAX_FILE_SIZE) {
    core.info(`Skipping large file: ${filename} (${patch.length} characters)`);
    return true;
  }

  return false;
}

export function createReviewPrompt(files: FileChange[], prTitle?: string, prBody?: string): string {
  const fileCount = files.length;
  const totalChanges = files.reduce((sum, file) => sum + file.changes, 0);

  let prompt = `You are an expert code reviewer with extensive experience in software development. Please review the following pull request changes and provide constructive, actionable feedback.

**Pull Request Context:**
- Title: ${prTitle || 'No title provided'}
- Description: ${prBody || 'No description provided'}
- Files changed: ${fileCount}
- Total changes: ${totalChanges} lines

**Review Guidelines:**
1. Focus on code quality, security, performance, and maintainability
2. Identify potential bugs, edge cases, and improvements
3. Check for proper error handling and validation
4. Ensure code follows best practices and conventions
5. Suggest specific improvements with clear explanations
6. Be constructive and professional in your feedback

**Code Changes to Review:**

`;

  files.forEach((file, index) => {
    if (file.patch) {
      prompt += `**File ${index + 1}: ${file.filename}** (${file.status}, +${file.additions}/-${file.deletions})
\`\`\`diff
${file.patch}
\`\`\`

`;
    }
  });

  prompt += `Respond with ONLY a single JSON object (no markdown code fences, no commentary before or after it) matching this exact shape:

{
  "summary": "one or two sentence overall assessment of the changes",
  "issues": [
    {
      "severity": "info" | "warning" | "critical",
      "category": "bug" | "style" | "security" | "performance",
      "file": "path/to/file.ts" or null if not tied to a specific file,
      "line": 42 or null if not identifiable,
      "message": "specific, actionable description of the issue"
    }
  ]
}

Guidelines:
- Use "critical" only for issues likely to cause bugs, security vulnerabilities, or data loss.
- Use "issues": [] if there is nothing worth flagging.
- "file" and "line" should reference the actual diff above when identifiable; use null otherwise.`;

  return prompt;
}

export type IssueSeverity = "info" | "warning" | "critical";
export type IssueCategory = "bug" | "style" | "security" | "performance";

export interface ReviewIssue {
  severity: IssueSeverity;
  category: IssueCategory;
  file: string | null;
  line: number | null;
  message: string;
}

export interface StructuredReview {
  summary: string;
  issues: ReviewIssue[];
}

const VALID_SEVERITIES: IssueSeverity[] = ["info", "warning", "critical"];
const VALID_CATEGORIES: IssueCategory[] = ["bug", "style", "security", "performance"];

function isReviewIssue(value: unknown): value is ReviewIssue {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.message === "string" &&
    VALID_SEVERITIES.includes(v.severity as IssueSeverity) &&
    VALID_CATEGORIES.includes(v.category as IssueCategory) &&
    (v.file === null || v.file === undefined || typeof v.file === "string") &&
    (v.line === null || v.line === undefined || typeof v.line === "number")
  );
}

// Gemini sometimes wraps JSON in a ```json ... ``` fence despite instructions not to.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

// Parses the model's response into a StructuredReview. Returns null (rather than
// throwing) on any malformed/unexpected shape so the caller can fall back to raw text.
export function parseStructuredReview(text: string): StructuredReview | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.summary !== "string" || !Array.isArray(candidate.issues)) {
    return null;
  }
  if (!candidate.issues.every(isReviewIssue)) {
    return null;
  }

  return {
    summary: candidate.summary,
    issues: (candidate.issues as ReviewIssue[]).map(issue => ({
      severity: issue.severity,
      category: issue.category,
      file: issue.file ?? null,
      line: issue.line ?? null,
      message: issue.message,
    })),
  };
}

const SEVERITY_ORDER: IssueSeverity[] = ["critical", "warning", "info"];
const SEVERITY_LABELS: Record<IssueSeverity, string> = {
  critical: "🔴 Critical",
  warning: "🟡 Warning",
  info: "🔵 Info",
};

// Renders a StructuredReview as markdown, grouped by severity (critical first).
export function formatStructuredReview(review: StructuredReview): string {
  if (review.issues.length === 0) {
    return `${review.summary}\n\nNo issues found.`;
  }

  let body = `${review.summary}\n\n`;

  for (const severity of SEVERITY_ORDER) {
    const issuesForSeverity = review.issues.filter(issue => issue.severity === severity);
    if (issuesForSeverity.length === 0) {
      continue;
    }

    body += `### ${SEVERITY_LABELS[severity]} (${issuesForSeverity.length})\n\n`;
    for (const issue of issuesForSeverity) {
      const location = issue.file
        ? issue.line !== null
          ? `\`${issue.file}:${issue.line}\` `
          : `\`${issue.file}\` `
        : "";
      body += `- ${location}**[${issue.category}]** ${issue.message}\n`;
    }
    body += "\n";
  }

  return body.trim();
}

export const MAX_RETRIES = 3;
export const INITIAL_BACKOFF_MS = 1000;

export function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retries on network errors and 5xx responses with exponential backoff.
// 4xx responses (e.g. a bad API key) are returned as-is since they won't succeed on retry.
export async function fetchWithRetry(
  url: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
  maxRetries: number = MAX_RETRIES,
  initialDelayMs: number = INITIAL_BACKOFF_MS
): Promise<Awaited<ReturnType<typeof fetch>>> {
  let lastError: Error | undefined;
  let lastResponse: Awaited<ReturnType<typeof fetch>> | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (response.ok || !isRetryableStatus(response.status)) {
        return response;
      }

      lastResponse = response;
      lastError = new Error(`Gemini API request failed: ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < maxRetries) {
      const delay = initialDelayMs * Math.pow(2, attempt);
      core.info(`Gemini API call failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  // Retries exhausted. If we got a (failing) response, return it so the caller's
  // existing error-formatting logic (which reads the response body) still applies.
  // Only throw when we never got a response at all, e.g. persistent network errors.
  if (lastResponse) {
    return lastResponse;
  }
  throw lastError ?? new Error("Gemini API request failed after retries");
}
