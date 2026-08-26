# pi-review-action

A from-scratch GitHub Action that runs a **fresh, independent AI PR validator** for the
OpenCharly org. It replaces the agent-posted `charly/pr-validator` commit status with a
real check outcome: the workflow sets a required check (named `charly/pr-validator`) from
the validator's deterministic `Verdict: PASS|BLOCK` final line.

The action is deliberately **zero-dependency** (Node 24 built-in `fetch` only) — no SDK,
no runtime install, nothing to ship beyond the two files here. It follows the general shape
of a pi-style action (read-only GitHub tools → LLM agent loop → one PR comment → outputs),
but is fully ours so the tools and staleness handling are under our control.

## Tools the validator gets

| Tool | What it returns |
|---|---|
| `get_pr_diff` | The CURRENT unified diff (head vs base) of the triggering PR. |
| `get_pr_commits` | The PR commit history (sha, message, author) — read "commit messages since the last review" here. |
| `get_pr_thread` | The CURRENT live issue body (flagged authoritative) **plus** all prior comments. |
| `get_pr_meta` | PR state: title, mergeable, head/base sha, file counts. |

The validator is instructed (in `prompt.txt`) that prior comments are **not authoritative
and are often stale** — it must re-derive every claim from the CURRENT body/diff (R1
reality-over-text) and dismiss superseded findings. It never pretends to have commit-message
knowledge beyond the tools, and it never treats a self-install's unobservable green as a
blocking finder. CI status is deliberately NOT a tool: the repo's required checks are
enforced by branch protection (a red gate blocks the merge mechanically), the validator is
read-only and cannot act on CI state, and its own `validate / validate` run is always
`in_progress` while it reviews — so a CI-status tool would be self-referential and serve no
purpose (R3: no duplication of the branch-protection mechanism).

## Usage

```yaml
- uses: opencharly/pi-review-action@v1.0.0
  id: review
  with:
    provider: ${{ vars.AI_REVIEW_PROVIDER }}
    model: ${{ vars.AI_REVIEW_MODEL }}
    base_url: ${{ vars.AI_REVIEW_BASE_URL }}
    api_key: ${{ secrets.AI_REVIEW_API_KEY }}
```

Inputs: `github_token` (defaults to `${{ github.token }}`), `provider`, `model`, `base_url`,
`api_key`, `max_turns`. Outputs: `response` (the full review, final line `Verdict: PASS|BLOCK`)
and `success` (the action ran).

## Copyright

MIT License. Copyright (c) 2026 OpenCharly. See `LICENSE`.