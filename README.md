# Marlin

Marlin is a GitHub Action that reviews pull requests with Google's Gemini API. When a PR is opened or updated, it reads the diff, asks Gemini for a structured review, and posts a single comment with the issues grouped by severity.

It's written in TypeScript and uses the GitHub REST API through Octokit (`@actions/github`).

## What it does

- **Reviews every PR automatically** on `opened`, `synchronize` (new commits), and `reopened`.
- **Filters out noise** before calling the model: lock files, minified and bundled assets, `node_modules/`, the `.git/` directory, logs and temp files, files with no diff (binary files), and any file whose diff is over 50,000 characters.
- **Keeps the prompt bounded**: if the remaining diffs add up to more than 200,000 characters, files that don't fit are skipped and the comment says how many.
- **Asks Gemini for structured JSON**, with a severity, category, file, line, and message for each issue.
- **Posts a comment grouped by severity**: Critical, then Warning, then Info.
- **Falls back to raw text** if the model's response isn't valid JSON in the expected shape, so the PR still gets a review instead of an error.
- **Retries the Gemini call** with exponential backoff on network errors and 5xx responses. It doesn't retry 4xx errors, because a bad API key won't fix itself.

## How it works

```
pull_request event
      │
      ▼
fetch changed files      octokit.paginate(pulls.listFiles), 100 per page
      │
      ▼
filter files             shouldExcludeFile(): patterns, missing patch, per-file size cap
      │                      selectFilesWithinBudget(): 200k-character total budget
      │
      ▼
build prompt             createReviewPrompt(): PR title/body + diffs + JSON schema
      │
      ▼
call Gemini              fetchWithRetry(): up to 3 retries, 1s → 2s → 4s
      │
      ▼
parse JSON               parseStructuredReview(): validates every field
      │
      ├── valid ───────► formatStructuredReview(): grouped markdown
      │
      └── invalid ─────► raw model text (with a warning in the Action log)
      │
      ▼
post one PR comment      octokit.rest.issues.createComment
```

| File | Responsibility |
|---|---|
| `src/index.ts` | Entry point: reads inputs, talks to GitHub and Gemini, posts the comment |
| `src/utils.ts` | Pure logic with no GitHub Actions side effects: filtering, prompt building, retry, JSON parsing and formatting |
| `src/utils.test.ts` | Vitest suite for everything in `utils.ts` |
| `action.yml` | Composite action: sets up Node 24, runs `npm ci` and `npm run build`, then runs `dist/index.js` |

## Example comment

```
🤖 Marlin AI Code Review

📊 Review Summary:
- Files reviewed: 2/3
- Total changes: 41 lines
- Files excluded: 1 (large files, lock files, etc.)

The change adds a user lookup endpoint, but the query is built from raw input.

### 🔴 Critical (1)
- `src/users.ts:14` [security] User input is concatenated into a SQL query; use a parameterized query.

### 🟡 Warning (1)
- `src/users.ts:22` [bug] The database error is caught and ignored, so the caller gets undefined.
```

## Setup

1. **Get a Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey).
2. **Add it as a repository secret** named `GEMINI_API_KEY` (Settings → Secrets and variables → Actions → New repository secret).
3. **Add a workflow** at `.github/workflows/marlin.yml`:

```yaml
name: Marlin AI Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Run Marlin
        uses: Ratangulati/marlin@main
        with:
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

## Configuration

| Input | Required | Description |
|---|---|---|
| `gemini_api_key` | Yes | Gemini API key. Pass it from a secret; never commit it. |

Other settings are constants in the code, so you change them by editing the source:

| Setting | Where | Value |
|---|---|---|
| Model | `GEMINI_MODEL` in `src/index.ts` | `gemini-3.1-flash-lite` |
| Max output tokens | `src/index.ts` | `8192` |
| Excluded file patterns | `EXCLUDED_FILE_PATTERNS` in `src/utils.ts` | lock, minified, bundle, logs, etc. |
| Per-file diff size cap | `MAX_FILE_SIZE` in `src/utils.ts` | 50,000 characters |
| Total diff size budget | `MAX_TOTAL_PATCH_SIZE` in `src/utils.ts` | 200,000 characters (~50k tokens) |
| Retries / initial backoff | `MAX_RETRIES`, `INITIAL_BACKOFF_MS` in `src/utils.ts` | 3 retries, 1000 ms (doubles each time) |

The API key goes in the `x-goog-api-key` request header, not in the URL, so it can't leak into error messages or logs.

## Development and testing

Requires Node.js 24+.

```bash
npm ci          # install dependencies
npm test        # run the Vitest suite
npx tsc         # type check (tsconfig sets noEmit)
npm run build   # bundle src/index.ts into dist/ with ncc
```

The tests cover file filtering (including the size-cap boundary), the total size budget, retry behavior (which statuses retry, how many attempts, the exact 1000/2000/4000 ms backoff using Vitest fake timers, and that the key goes in a header), JSON parsing (valid input, code fences, missing fields, invalid values), and severity-grouped formatting. They don't make network calls: `fetchWithRetry` takes a `fetch` implementation as a parameter, so the tests pass in a `vi.fn()` mock instead of calling Gemini.

`dist/` isn't committed. The composite action builds it fresh on every run, so the code that runs always matches the source.

To run the workflow locally with [act](https://github.com/nektos/act), put `GEMINI_API_KEY=...` in a git-ignored `.env` file. `.actrc` already passes it as a secret file.

### Demo PRs

PRs #1–5 are closed demo PRs that show Marlin reviewing real code. Their sample files **intentionally contain fake credentials** (for example `apiKey: "sk-1234567890abcdef"`) and other planted bugs as test input for the reviewer. None of them are real secrets.

## Known limitations

- **Very large PRs:** to stay within the size budget, files that don't fit are skipped, not reviewed. They're picked in GitHub's order, not by importance, so a big PR gets only a partial review.
- **Duplicate comments:** every push to a PR posts a new comment instead of updating the previous one.
- **No inline comments:** issues are listed in one PR comment, not attached to diff lines with the review API.
- **Prompt injection:** the PR title, description, and diff go straight into the prompt, so a PR author can try to steer the review.
- **False positives:** the model sees only the diff, not the rest of the codebase, so it can flag things that are handled elsewhere.
- **No runtime context:** it can't see test results, production behavior, or how the code is actually used.
- **Forked PRs:** GitHub doesn't give `pull_request` workflows from forks access to secrets, so Marlin can't run on them.
- **429 rate limits aren't retried:** only network errors and 5xx responses are retried.

## License

MIT. See [LICENSE](LICENSE).
