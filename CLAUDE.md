# CLAUDE.md — rules for this repo

You are working on **Account Manager Copilot** — a Jedify-powered analysis web app.
Read this file at the start of every session before editing anything.

---

## ❌ Hard rules (never break these)

1. **Never guess data shapes.** When code depends on the shape of an HTML page,
   an API response, an analysis output, a localStorage entry, or a file
   produced by another system: **ask the user to paste a real sample, or run a
   diagnostic in DevTools console, BEFORE writing the consumer code.** Burning
   user time on speculation is worse than asking one question.

2. **Read before you write.** If you're about to call `Edit` on a file you've
   never read, you're guessing. Use `Read` first.

3. **Verify file integrity after every edit.** The Cowork linter sometimes
   truncates files mid-edit. After any edit to a long file:
   - Run `wc -l <file>` and `tail -15 <file>` to confirm the file still has
     a valid ending.
   - Run a syntax check: `node --check file.js` or `node -e "(check script blocks for HTML)"`.
   - If truncated, restore from git or by re-appending — DO NOT pile more
     edits onto a half-broken file.

4. **Never push to this repo while an analysis is running.** Render auto-deploys
   on push, sends SIGTERM to the old process, and the SIGTERM handler in
   `jedify-server.js` calls `_cancelToken.cancelled = true`. Result: in-flight
   analyses get killed mid-flight. Always confirm with the user that no
   analysis is running before suggesting a push.

5. **No fake data, no sample/illustrative numbers, no invented values.** When
   data for a slide / section / table is missing, render a clear "not
   available" placeholder. Never fabricate.

6. **One change, one commit.** Don't bundle unrelated fixes in a single push —
   makes rollback impossible if one breaks.

7. **Do not run `git add .`** in this repo — line-ending differences (CRLF vs
   LF when cloned on Windows + read via WSL) will stage ~15 spurious file
   changes. Always `git add <specific-file>`.

---

## How this app works

### Stack
- **Frontend:** vanilla HTML + JS in `insight-loop-prototype.html` (~9000 lines).
  No framework. No build step. Loaded directly by the Node server.
- **Backend:** `jedify-server.js` (Node 18+). Connects to Jedify MCP for SQL,
  uses Anthropic SDK for narrative generation, exposes `/api/research`.
- **Hosting:** Render (`account-manager-copilot.onrender.com`). Auto-deploys
  on push to `master`.

### Key files (read these BEFORE touching the corresponding feature)
| File | What it owns |
|---|---|
| `insight-loop-prototype.html` | All UI, all browser logic, including the Generate Deck integration |
| `jedify-server.js` | HTTP server, research pipeline, prompt building, SSE delivery |
| `jedify-direct.js` | MCP transport layer (SSE connection management) |
| `research-checks.js` | Built-in mandatory + optional check definitions |
| `capture-token.js` | OAuth token capture utility |
| `package.json` | Deps: @anthropic-ai/sdk, jsonrepair |

### Analysis pipeline (the new "research" path)
- Browser POSTs analysis spec to `/api/research`
- Backend builds a research prompt via `buildResearchPrompt()` (line ~1515)
- Calls Jedify MCP for SQL queries
- Calls Anthropic to format results per persona
- Returns `{ report: "<markdown text>" }` per persona
- Browser renders the markdown into `#check-results` div, including HTML tables
- **The structured rows are NOT returned to the browser as JSON** — they're
  baked into the rendered HTML. Generate Deck scrapes them back out.

### Operator name pinning
`window._lastDisplayName` and `#persona-header-name` MUST be set BEFORE the
pipeline result handler. This is done in:
- `runAnalysis()` immediately after the displayName variable is computed
- `confirmAndRun()` at the same point

If you move or remove these pins, history saves will revert to "Unknown
Operator" and Generate Deck filenames will be wrong. Test with a fresh
analysis before declaring any related change "done".

### Custom checks
- Defined in `_checks` array (in HTML).
- New custom checks set both `description` and `question` to the same query.
- Sent to backend in `selection.checkDefinitions` (map of id → {name, question}).
- Backend handles them in `buildResearchPrompt`: optional via `enabledOptionalIds`,
  mandatory via the `else` branch added after we discovered it was dropping
  custom mandatory checks for full runs.

### Generate Deck integration
- Button in #download-btns row + a duplicate inside the Data Analyst persona pane.
- `generateDeck()` either reads `window._lastResearchResult.checks` (old
  pipeline) or falls back to scraping rendered tables from #check-results
  via `scrapeTablesFromDom()`.
- Tables are classified by **section heading** via `classifyScrapedTable()`.
  Heading-based, not column-based — much more stable.
- Payload sent to `https://rubyplay-deck-service.onrender.com/generate`.

### Section headings produced by current Jedify analysis (verify if changes)
Run the DevTools diagnostic in `_developer-notes/diagnostic-snippets.md` (TODO:
create) to confirm. Last verified May 2026:

```
1. Monthly Performance — Is the Brand Growing or Declining?
2. Top Games by GGR Share
3. Growth Levers — High GGR/Player, Low Player Count
4. Top Games in Mexico Market vs <Operator>'s Portfolio
5. Tier 1 — Critical Opportunities
6. Tier 2 — High-Value Opportunities
7. Studio Summary (<period>)
8. Monthly Studio Performance
9. Per-Player KPI Comparison with <Market> Market Leaders
10. VIP Player Analysis
11. Latest Game Releases — Adoption Check
```

The classifier in `insight-loop-prototype.html` (search for
`classifyScrapedTable`) routes each heading to a deck slot. **If headings
change, ask the user to re-run the diagnostic and update the regexes — don't
guess.**

---

## When the user asks for something new

- **First question:** does it depend on data I haven't seen? If yes, ask for
  a sample.
- **Second:** is there a running analysis? If yes, do not push the main app.
- **Third:** is it a frontend-only or backend change? Frontend changes show
  up after Render redeploy + browser hard-refresh (Ctrl+F5).

---

## Diagnostic snippets to run when stuck

### List all tables in the current analysis with their headings
```javascript
[...document.querySelectorAll('#check-results table')].map((t,i) => {
  let cur = t, title = '', steps = 0;
  while (cur && steps++ < 200 && !title) {
    let p = cur.previousElementSibling;
    while (p && !title) {
      if (/^H[1-6]$/.test(p.tagName)) title = p.textContent.trim();
      else if (p.querySelector) {
        const n = p.querySelector('h1,h2,h3,h4,h5,h6');
        if (n) title = n.textContent.trim();
      }
      p = p.previousElementSibling;
    }
    cur = cur.parentElement;
  }
  const headers = [...t.querySelectorAll('tr')[0]?.querySelectorAll('th,td')||[]].map(c => c.textContent.trim());
  return { idx: i+1, heading: title || '(NO HEADING)', headers, rows: t.querySelectorAll('tr').length - 1 };
});
```

### Inspect last research result
```javascript
console.log(JSON.stringify({
  displayName: window._lastDisplayName,
  hasResult: !!window._lastResearchResult,
  checks: window._lastResearchResult?.checks?.length,
}, null, 2));
```

### Check what was sent in the last /api/research call
DevTools → Network tab → click the POST request → Payload tab.
