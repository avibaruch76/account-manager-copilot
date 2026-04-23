# Iterative Checks — Design Spec

**Date:** 2026-04-23  
**File:** `insight-loop-prototype.html` + `jedify-server.js`  
**Status:** Approved for implementation

---

## Context

Each full analysis takes 5–10 minutes and runs all enabled checks in a single Jedify inquiry. After seeing results, users often want to drill into one or two additional checks — without re-running everything. This feature adds iterative analysis: run a subset of checks, append results to the existing output, repeat as needed.

---

## Design

### Core Model

A **run session** is created when the first analysis completes for a given entity + date range. It lives in memory (`window._runSession`) and is cleared when:
- The user clicks "Re-run Everything" (starts a fresh Run 1)
- The entity or date range changes
- The page is refreshed

```js
window._runSession = {
  entity: 'Baba Entertainment',
  scope: 'operator',
  endMonth: '2026-03',
  monthsBack: 6,
  persona: 'am_actions',
  runs: [
    {
      runNumber: 1,
      timestamp: '10:42',
      checkIds: ['ggr_trend', 'concentration', 'hidden_gems', 'benchmark_gap', 'new_launches', 'open_scan', 'retention', 'market_breakdown'],
      report: '# GGR Analysis\n\n...'  // markdown string
    }
    // Run 2 appended here after partial re-run
  ]
}
```

### Check Run Status

Each check shows one of three states, derived from `_runSession.runs`:

| State | Badge | Meaning |
|-------|-------|---------|
| **Run N · HH:MM** | ✓ green | Included in a previous run |
| **Selected** | ▶ blue | Currently ticked to run |
| **Not run** | ○ grey | Never included in any run |

A check's "last run" = the most recent run whose `checkIds` includes that check's ID.

### UX Flow

**First run (no session):**
- Mandatory checks are forced (checkboxes hidden/disabled)
- Optional checks follow existing enabled/disabled state
- Run button: "▶ Run Analysis" (existing behaviour)
- On completion: session created, `runs[0]` stored

**Subsequent runs (session exists):**
- All checks (including mandatory) show checkboxes
- Mandatory checks that already ran show ✓ badge — unchecked by default
- Checks never run show ○ grey — unchecked by default
- User ticks the checks they want; a count badge shows "N selected"
- Two buttons appear:
  - **"▶ Run N Selected Checks"** — runs only ticked checks (disabled if 0 selected)
  - **"↺ Re-run Everything"** — clears session, starts fresh Run 1 with all checks

**Partial run prompt assembly:**  
`buildResearchPrompt()` is called with only the selected check IDs. Mandatory check list is replaced by the user's selection. Global rules and persona instruction remain the same.

### Output Rendering

Results are **appended**, never replaced. The persona pane (`#persona-action` etc.) accumulates sections:

```
━━ Run 1 · 10:42 · 8 checks ━━━━━━━━━━
[original report markdown]

- - - Run 2 · 11:05 · VIP Behavior, Promo Impact - - -
[new checks report markdown]
```

Each run section has:
- Run number badge + timestamp + check names summary
- The report rendered via existing `renderMarkdown()`
- A subtle dashed divider between sections

The `data_analyst` background run (Analysis Results tab) follows the same append pattern.

### What Does NOT Change

- `runAnalysis()` entry point — same function, same progress overlay
- `fireForeground()` / `fireBackground()` — unchanged
- SSE streaming — unchanged
- `buildResearchPrompt()` server function — unchanged (already accepts `enabledOptionalCheckIds` + `checkDefinitions`)
- Persona selection — partial runs use the same persona as the session

---

## Implementation Plan

### 1. Session state (`window._runSession`)
- Create session on first `renderResearchReport()` call for non-data_analyst persona
- Clear session when entity/date changes (hook into `runAnalysis()` — compare against session)
- Clear session on "Re-run Everything"

### 2. Check status badges in Config panel
- After each run, update `_runSession.runs` with check IDs + timestamp
- `renderCheckLists()` reads session state to render badges
- Add CSS classes: `.check-run-done`, `.check-run-selected`, `.check-run-never`

### 3. Partial run button logic
- When session exists: show "Run N Selected Checks" + "↺ Re-run Everything" instead of single "▶ Run Analysis"
- Count of ticked checks drives the button label and disabled state
- "Re-run Everything" calls existing `runAnalysis()` after `window._runSession = null`

### 4. Prompt assembly for partial runs
- `fetchJedifyAnalysis()` receives a `selectedCheckIds` parameter
- When set: `enabledOptionalCheckIds = selectedCheckIds.filter(optional)`, mandatory check list = `selectedCheckIds.filter(mandatory)`
- Server `buildResearchPrompt()` already handles this via `enabledOptionalIds` — no server changes needed

### 5. Append rendering
- `renderResearchReport()` checks `_runSession` — if session exists, append; otherwise replace
- New helper: `buildRunSectionHtml(runNumber, timestamp, checkNames, report)` wraps report in divider + header
- Existing `renderMarkdown()` reused for report body

---

## Files Changed

| File | Changes |
|------|---------|
| `insight-loop-prototype.html` | Session state, check badges, partial run buttons, append rendering |
| `jedify-server.js` | **No changes** |
| `research-checks.js` | **No changes** |

---

## Verification

1. Run a full analysis → confirm Run 1 badge appears on all checks
2. Tick 2 optional checks → "Run 2 Selected Checks (2)" button appears
3. Run partial → confirm new section appended below Run 1 in output (not replaced)
4. Change entity → confirm session cleared, badges reset
5. "Re-run Everything" → confirm session cleared, fresh Run 1 starts
6. Confirm mandatory checks are uncheckable on first run, checkable on second
7. Confirm data_analyst (Analysis Results tab) also appends
