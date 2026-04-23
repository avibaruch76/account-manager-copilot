# Iterative Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to add new checks after seeing analysis results and run only those new checks, appending results to the existing output without re-running everything.

**Architecture:** A `_runSession` object (in-memory) tracks which checks ran in each iteration. `createCheckRow()` reads session state to show run-status badges. `runAnalysis()` gains a `selectedCheckIds` parameter for partial runs. `renderResearchReport()` appends new run sections instead of replacing when a session exists.

**Tech Stack:** Vanilla JS, single HTML file (`insight-loop-prototype.html`). No server changes. No new dependencies.

---

## File Scope

| File | Changes |
|------|---------|
| `C:\Users\aviav\OneDrive\Documents\Data Analysis\output\insight-loop-prototype.html` | All changes — session state, badges, buttons, prompt assembly, append rendering |
| `jedify-server.js` | **No changes** |
| `research-checks.js` | **No changes** |

---

## Task 1: Add `_runSession` global state variable

**Files:**
- Modify: `insight-loop-prototype.html` near line 896 (after `let _pendingSelection = null;`)

A session object tracks the entity/scope/date context and all runs so far. It lives in memory — cleared on page refresh, entity change, or Re-run Everything.

- [ ] **Step 1: Add the variable declaration**

Find this line (~line 896):
```javascript
let _pendingSelection = null; // holds selection payload while prompt preview is open
```

Add immediately after it:
```javascript
// Run session for iterative checks — in-memory only, cleared on entity change or Re-run Everything
let _runSession = null;
// {
//   entity: string, scope: string, endMonth: string, monthsBack: number,
//   persona: string,
//   runs: Array<{ runNumber: number, timestamp: string, checkIds: string[], report: string }>
// }
```

- [ ] **Step 2: Verify the file still loads without JS errors**

Open `http://localhost:3001` in browser, open DevTools Console — no errors.

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\aviav\OneDrive\Documents\Data Analysis\output"
git add insight-loop-prototype.html
git commit -m "feat(iterative): add _runSession global state variable"
```

---

## Task 2: Add CSS for run-status badges on check rows

**Files:**
- Modify: `insight-loop-prototype.html` — `<style>` block (search for `.check-badge`)

- [ ] **Step 1: Add badge CSS**

Find the existing `.check-badge` style block and add these rules after it:

```css
/* Iterative run-status badges on check rows */
.run-status-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
  margin-left: 6px;
}
.run-status-badge.done {
  background: #F0FDF4;
  color: #16A34A;
  border: 1px solid #BBF7D0;
}
.run-status-badge.selected {
  background: #EFF6FF;
  color: #2563EB;
  border: 1px solid #BFDBFE;
}
.run-status-badge.never {
  background: #F8FAFC;
  color: #94A3B8;
  border: 1px solid #E2E8F0;
}
/* Check row highlight when selected for partial run */
.check-row.partial-selected {
  background: #F0F7FF;
  border-radius: 6px;
}
```

- [ ] **Step 2: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat(iterative): add CSS for run-status badges on check rows"
```

---

## Task 3: Show run-status badges in `createCheckRow()`

**Files:**
- Modify: `insight-loop-prototype.html` — `createCheckRow()` function (~line 1274)

When a session exists, each check row shows: ✓ Run N · HH:MM (green), ▶ Selected (blue), or ○ Not run (grey). The existing toggle/lock UI stays — badges are additive.

- [ ] **Step 1: Add `getCheckRunStatus()` helper function**

Add this function just before `createCheckRow()` (~line 1274):

```javascript
// Returns run status for a check given current _runSession
// Returns: { state: 'done'|'never', runNumber: number|null, timestamp: string|null }
function getCheckRunStatus(checkId) {
  if (!_runSession || !_runSession.runs || _runSession.runs.length === 0) {
    return { state: 'never', runNumber: null, timestamp: null };
  }
  // Find most recent run that included this check
  for (let i = _runSession.runs.length - 1; i >= 0; i--) {
    if (_runSession.runs[i].checkIds.includes(checkId)) {
      return { state: 'done', runNumber: _runSession.runs[i].runNumber, timestamp: _runSession.runs[i].timestamp };
    }
  }
  return { state: 'never', runNumber: null, timestamp: null };
}
```

- [ ] **Step 2: Inject badge HTML into `createCheckRow()`**

Inside `createCheckRow()`, find this line (~line 1345):
```javascript
  li.innerHTML = `
    ${toggleHtml}
    <div class="check-info">
      <div class="check-name">${check.name} ${badgeHtml}</div>
      <div class="check-desc">${descHtml}</div>
    </div>
    <div class="check-actions" style="display:flex;align-items:center;gap:2px;flex-shrink:0;">${actionsHtml}</div>
  `;
```

Replace with:
```javascript
  // Build run-status badge (only visible when a session exists)
  const runStatus = getCheckRunStatus(check.id);
  let runStatusHtml = '';
  if (_runSession) {
    if (runStatus.state === 'done') {
      runStatusHtml = `<span class="run-status-badge done">✓ Run ${runStatus.runNumber} · ${runStatus.timestamp}</span>`;
    } else {
      runStatusHtml = `<span class="run-status-badge never">○ Not run</span>`;
    }
  }

  li.innerHTML = `
    ${toggleHtml}
    <div class="check-info">
      <div class="check-name">${check.name} ${badgeHtml}</div>
      <div class="check-desc">${descHtml}</div>
    </div>
    <div class="check-actions" style="display:flex;align-items:center;gap:2px;flex-shrink:0;">${actionsHtml}${runStatusHtml}</div>
  `;
```

- [ ] **Step 3: Verify badges don't appear before first run**

Open the tool, go to Config panel — no run-status badges visible (session is null).

- [ ] **Step 4: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat(iterative): show run-status badges on check rows when session exists"
```

---

## Task 4: Add partial-run checkbox to check rows when session exists

**Files:**
- Modify: `insight-loop-prototype.html` — `createCheckRow()` function (~line 1274)

When a session exists, every check (including mandatory) gets a checkbox for selecting it in a partial re-run. The existing mandatory lock icon is hidden in this mode.

- [ ] **Step 1: Add `_partialSelectedIds` set for tracking ticked checks**

After the `_runSession` declaration added in Task 1:
```javascript
let _partialSelectedIds = new Set(); // check IDs ticked for next partial run
```

- [ ] **Step 2: Modify `createCheckRow()` to show partial-run checkbox when session active**

Find this block inside `createCheckRow()` (~line 1302):
```javascript
  // Toggle
  let toggleHtml = '';
  if (isMandatory) {
    toggleHtml = '<label class="check-toggle"><input type="checkbox" checked disabled><span class="check-slider"></span></label>';
  } else {
    toggleHtml = '<label class="check-toggle"><input type="checkbox" ' + (check.enabled ? 'checked' : '') + '><span class="check-slider"></span></label>';
  }
```

Replace with:
```javascript
  // Toggle — in session mode, all checks get a partial-run checkbox instead
  let toggleHtml = '';
  if (_runSession) {
    // Partial-run mode: checkbox for selecting checks to re-run
    const isPartialSelected = _partialSelectedIds.has(check.id);
    toggleHtml = `<input type="checkbox" class="partial-run-cb" data-check-id="${check.id}" ${isPartialSelected ? 'checked' : ''} style="width:16px;height:16px;accent-color:#2563EB;cursor:pointer;flex-shrink:0;">`;
  } else if (isMandatory) {
    toggleHtml = '<label class="check-toggle"><input type="checkbox" checked disabled><span class="check-slider"></span></label>';
  } else {
    toggleHtml = '<label class="check-toggle"><input type="checkbox" ' + (check.enabled ? 'checked' : '') + '><span class="check-slider"></span></label>';
  }
```

- [ ] **Step 3: Attach partial-run checkbox listener at bottom of `createCheckRow()`**

Find the closing `return li;` at the end of `createCheckRow()` (~line 1375). Add before it:

```javascript
  // Partial-run checkbox listener
  if (_runSession) {
    const partialCb = li.querySelector('.partial-run-cb');
    if (partialCb) {
      partialCb.addEventListener('change', function() {
        if (this.checked) {
          _partialSelectedIds.add(check.id);
          li.classList.add('partial-selected');
        } else {
          _partialSelectedIds.delete(check.id);
          li.classList.remove('partial-selected');
        }
        updatePartialRunButton();
      });
      if (_partialSelectedIds.has(check.id)) li.classList.add('partial-selected');
    }
  }
```

- [ ] **Step 4: Add `updatePartialRunButton()` helper**

Add this function just after `updateCount()` function (search for `function updateCount`):

```javascript
function updatePartialRunButton() {
  const btn = document.getElementById('partial-run-btn');
  const countEl = document.getElementById('partial-run-count');
  if (!btn) return;
  const n = _partialSelectedIds.size;
  btn.disabled = n === 0;
  btn.textContent = n === 0 ? '▶ Run Selected Checks' : `▶ Run ${n} Selected Check${n > 1 ? 's' : ''}`;
  if (countEl) countEl.textContent = n > 0 ? `${n} selected` : '';
}
```

- [ ] **Step 5: Verify — no JS errors, existing toggle still works when no session**

Open browser, run no analysis, go to Config — toggles work normally. No partial checkboxes visible.

- [ ] **Step 6: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat(iterative): add partial-run checkboxes to check rows in session mode"
```

---

## Task 5: Add "Run N Selected Checks" and "Re-run Everything" buttons to Config panel

**Files:**
- Modify: `insight-loop-prototype.html` — Config panel HTML (~line 505–550, the checks section buttons area)

- [ ] **Step 1: Find the existing Run Analysis button in the config/checks area**

Search for `id="run-btn"` — there is one in the top filter bar. The config panel has its own call-to-action area. Find the HTML for the config panel's bottom action row (search for `id="config-panel"` then find the bottom button).

- [ ] **Step 2: Add the partial-run button row to the config panel**

Find the closing `</div>` of the config panel checks section. Just before it, add:

```html
<!-- Iterative run controls — visible only when a session exists -->
<div id="partial-run-controls" style="display:none;margin-top:16px;padding-top:14px;border-top:1px solid #F1F5F9;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
  <button id="partial-run-btn" onclick="runPartialAnalysis()" disabled
    style="padding:8px 20px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:white;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">
    ▶ Run Selected Checks
  </button>
  <span id="partial-run-count" style="font-size:12px;font-weight:700;color:#2563EB;background:#EFF6FF;padding:3px 10px;border-radius:10px;"></span>
  <button onclick="rerunEverything()"
    style="margin-left:auto;padding:8px 18px;background:white;color:#64748B;border:1.5px solid #CBD5E1;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">
    ↺ Re-run Everything
  </button>
  <div style="width:100%;font-size:11px;color:#94A3B8;margin-top:4px;">Results will be appended as a new iteration below the existing report.</div>
</div>
```

- [ ] **Step 3: Add `showPartialRunControls()` and `hidePartialRunControls()` helpers**

Add after `updatePartialRunButton()`:

```javascript
function showPartialRunControls() {
  const el = document.getElementById('partial-run-controls');
  if (el) el.style.display = 'flex';
  updatePartialRunButton();
}

function hidePartialRunControls() {
  const el = document.getElementById('partial-run-controls');
  if (el) el.style.display = 'none';
  _partialSelectedIds.clear();
}
```

- [ ] **Step 4: Add `rerunEverything()` function**

```javascript
function rerunEverything() {
  _runSession = null;
  _partialSelectedIds.clear();
  hidePartialRunControls();
  renderCheckLists(); // reset badges
  runAnalysis();      // fresh Run 1
}
```

- [ ] **Step 5: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat(iterative): add partial-run and re-run-everything buttons to config panel"
```

---

## Task 6: Initialise session on first `renderResearchReport()` and show controls

**Files:**
- Modify: `insight-loop-prototype.html` — `renderResearchReport()` (~line 2583)

When the first result comes back, create the session, store the run, and show the partial-run controls. On subsequent calls (partial runs), append to `_runSession.runs`.

- [ ] **Step 1: Add `initOrUpdateSession()` helper**

Add this function just before `renderResearchReport()` (~line 2582):

```javascript
// Call after each completed run to update _runSession and refresh check badges
function initOrUpdateSession(data, checkedIds) {
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!_runSession) {
    // First run — create session keyed to this entity + date context
    _runSession = {
      entity: data.entity || '',
      scope: data.scope || 'operator',
      persona: data.persona,
      runs: []
    };
  }
  const runNumber = _runSession.runs.length + 1;
  _runSession.runs.push({
    runNumber,
    timestamp: now,
    checkIds: checkedIds || [],
    report: data.report || ''
  });
  renderCheckLists();       // refresh badges
  showPartialRunControls(); // show partial-run controls now that session exists
}
```

- [ ] **Step 2: Collect the check IDs that just ran**

In `fetchJedifyAnalysis()` (~line 2246), add a helper to know which IDs were used:

Find:
```javascript
async function fetchJedifyAnalysis(selection, abortSignal, customPrompt) {
  const globalPrompt = document.getElementById('global-prompt-prefix')?.value || '';
  const enabledOptionalCheckIds = _checks.filter(c => c.type === 'optional' && c.enabled).map(c => c.id);
```

Replace with:
```javascript
async function fetchJedifyAnalysis(selection, abortSignal, customPrompt, partialCheckIds) {
  const globalPrompt = document.getElementById('global-prompt-prefix')?.value || '';
  // In partial-run mode use only the selected check IDs; otherwise use all enabled
  const enabledOptionalCheckIds = partialCheckIds
    ? partialCheckIds.filter(id => _checks.find(c => c.id === id && c.type === 'optional'))
    : _checks.filter(c => c.type === 'optional' && c.enabled).map(c => c.id);
  // Track all IDs included in this run (mandatory + optional selected)
  const mandatoryIds = partialCheckIds
    ? partialCheckIds.filter(id => _checks.find(c => c.id === id && c.type === 'mandatory'))
    : _checks.filter(c => c.type === 'mandatory').map(c => c.id);
  window._currentRunCheckIds = [...mandatoryIds, ...enabledOptionalCheckIds];
```

- [ ] **Step 3: Pass `partialCheckIds` down to the server payload**

In `makePayload()` inside `fetchJedifyAnalysis()`, find:
```javascript
  function makePayload(persona) {
    return { ...selection, persona, enabledOptionalCheckIds, globalRules: globalPrompt,
      ...(customPrompt ? { customPrompt } : {}) };
  }
```

Replace with:
```javascript
  function makePayload(persona) {
    // In partial-run mode, override enabledOptionalCheckIds with the selected subset
    // Also pass mandatoryOverride so server uses only selected mandatory checks
    const payload = { ...selection, persona, enabledOptionalCheckIds, globalRules: globalPrompt,
      ...(customPrompt ? { customPrompt } : {}),
      checkDefinitions: getCheckDefinitions()
    };
    if (partialCheckIds) {
      payload.partialMandatoryIds = mandatoryIds; // server will use these instead of all mandatory
    }
    return payload;
  }
```

- [ ] **Step 4: Call `initOrUpdateSession()` inside `renderResearchReport()`**

In `renderResearchReport()` (~line 2583), add at the very top of the function body:

```javascript
function renderResearchReport(data) {
  console.log('[renderResearchReport] persona:', data?.persona, '| report length:', data?.report?.length ?? 'N/A');
  // Update session state (creates session on first call, appends on subsequent)
  if (data.persona !== 'data_analyst') {
    initOrUpdateSession(data, window._currentRunCheckIds || []);
  }
  const html = buildReportHtml(data);
  // ... rest unchanged
```

- [ ] **Step 5: Verify — run a full analysis, then go to Config panel**

After analysis completes: Config panel should show run-status badges (✓ Run 1 · HH:MM) on all checks, and the "Run Selected Checks" + "Re-run Everything" buttons should appear.

- [ ] **Step 6: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat(iterative): initialise session on first result, show partial-run controls"
```

---

## Task 7: Append new run sections instead of replacing output

**Files:**
- Modify: `insight-loop-prototype.html` — `renderResearchReport()` (~line 2607) and `buildReportHtml()`

On Run 2+, instead of `pane.innerHTML = html`, append a new divider + run header + report below the existing content.

- [ ] **Step 1: Add `buildRunSectionHtml()` helper**

Add just before `buildReportHtml()` (~line 2570):

```javascript
function buildRunSectionHtml(runNumber, timestamp, checkNames, reportHtml) {
  const isFirst = runNumber === 1;
  const divider = isFirst ? '' : `<hr style="border:none;border-top:2px dashed #E2E8F0;margin:20px 0;">`;
  const badge = isFirst
    ? `<span style="background:#1E293B;color:white;font-size:11px;font-weight:700;padding:3px 10px;border-radius:10px;">Run 1</span>`
    : `<span style="background:#2563EB;color:white;font-size:11px;font-weight:700;padding:3px 10px;border-radius:10px;">Run ${runNumber}</span>`;
  const meta = `<span style="font-size:11px;color:#94A3B8;margin-left:8px;">${timestamp}${checkNames ? ' · ' + checkNames : ''}</span>`;
  return `
    ${divider}
    <div style="display:flex;align-items:center;margin-bottom:12px;">${badge}${meta}</div>
    ${reportHtml}
  `;
}
```

- [ ] **Step 2: Modify the non-data_analyst branch of `renderResearchReport()` to append**

Find this block in `renderResearchReport()`:
```javascript
    const pane = document.getElementById(paneId);
    if (!pane) return;
    pane.innerHTML = html;
```

Replace with:
```javascript
    const pane = document.getElementById(paneId);
    if (!pane) return;

    if (_runSession && _runSession.runs.length > 1) {
      // Append — wrap in run section header
      const run = _runSession.runs[_runSession.runs.length - 1];
      const checkNames = run.checkIds
        .map(id => _checks.find(c => c.id === id)?.name || id)
        .join(', ');
      const section = document.createElement('div');
      section.setAttribute('data-run', run.runNumber);
      section.innerHTML = buildRunSectionHtml(run.runNumber, run.timestamp, checkNames, html);
      pane.appendChild(section);
    } else {
      // First run — wrap Run 1 header around the initial report
      if (_runSession && _runSession.runs.length === 1) {
        const run = _runSession.runs[0];
        pane.innerHTML = `<div data-run="1">${buildRunSectionHtml(1, run.timestamp, null, html)}</div>`;
      } else {
        pane.innerHTML = html;
      }
    }
```

- [ ] **Step 3: Apply same append logic to `data_analyst` branch**

Find this block for data_analyst:
```javascript
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-persona', 'data_analyst');
      wrapper.innerHTML = html;
      checkResults.appendChild(wrapper);
```

Replace with:
```javascript
      if (_runSession && _runSession.runs.length > 1) {
        // Partial run — append below existing data_analyst section
        const run = _runSession.runs[_runSession.runs.length - 1];
        const checkNames = run.checkIds
          .map(id => _checks.find(c => c.id === id)?.name || id)
          .join(', ');
        const section = document.createElement('div');
        section.setAttribute('data-persona', 'data_analyst');
        section.setAttribute('data-run', run.runNumber);
        section.innerHTML = buildRunSectionHtml(run.runNumber, run.timestamp, checkNames, html);
        checkResults.appendChild(section);
      } else {
        const wrapper = document.createElement('div');
        wrapper.setAttribute('data-persona', 'data_analyst');
        if (_runSession && _runSession.runs.length === 1) {
          const run = _runSession.runs[0];
          wrapper.innerHTML = buildRunSectionHtml(1, run.timestamp, null, html);
        } else {
          wrapper.innerHTML = html;
        }
        checkResults.appendChild(wrapper);
      }
```

- [ ] **Step 4: Verify append works**

After Run 1 completes, go to Config, tick one check, click "Run 1 Selected Check". When it finishes, the output pane should show Run 1 report + dashed divider + Run 2 report below.

- [ ] **Step 5: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat(iterative): append new run sections below existing output instead of replacing"
```

---

## Task 8: Wire up `runPartialAnalysis()` and session invalidation

**Files:**
- Modify: `insight-loop-prototype.html` — add `runPartialAnalysis()`, modify `runAnalysis()` for session invalidation

- [ ] **Step 1: Add `runPartialAnalysis()` function**

Add after `rerunEverything()`:

```javascript
function runPartialAnalysis() {
  if (_partialSelectedIds.size === 0) {
    showToast('⚠️ Select at least one check to run.', true);
    return;
  }
  const selectedIds = Array.from(_partialSelectedIds);
  _partialSelectedIds.clear();
  updatePartialRunButton();
  // Delegate to runAnalysis with the selected IDs
  runAnalysis(null, selectedIds);
}
```

- [ ] **Step 2: Add `partialCheckIds` parameter to `runAnalysis()`**

Find:
```javascript
function runAnalysis(customPrompt) {
```

Replace with:
```javascript
function runAnalysis(customPrompt, partialCheckIds) {
```

- [ ] **Step 3: Pass `partialCheckIds` through to `fetchJedifyAnalysis()`**

Find:
```javascript
  fetchJedifyAnalysis(selection, _analysisAbortController?.signal, customPrompt).then(data => {
```

Replace with:
```javascript
  fetchJedifyAnalysis(selection, _analysisAbortController?.signal, customPrompt, partialCheckIds || null).then(data => {
```

- [ ] **Step 4: Clear session when entity or date changes**

At the top of `runAnalysis()`, after `const selection = buildSelectionPayload(pop);` (~line 1971), add:

```javascript
  // Invalidate session if entity or date context has changed
  if (_runSession) {
    const entityNow = selection.entity || (selection.values && selection.values[0]) || '';
    const sessionKey = _runSession.entity + '|' + _runSession.scope;
    const nowKey = entityNow + '|' + (selection.scope || 'operator');
    if (sessionKey !== nowKey) {
      _runSession = null;
      _partialSelectedIds.clear();
      hidePartialRunControls();
      renderCheckLists();
    }
  }
```

- [ ] **Step 5: In partial-run mode, update the overlay label to say "Iteration N"**

Find:
```javascript
  document.getElementById('run-eta').innerHTML =
    `<strong style="color:#4A235A">🔬 Persona: ${personaLabel}</strong> — Jedify is researching. This takes 5-10 minutes.`;
```

Replace with:
```javascript
  const iterLabel = (partialCheckIds && _runSession)
    ? ` — Run ${_runSession.runs.length + 1} (${partialCheckIds.length} check${partialCheckIds.length > 1 ? 's' : ''})`
    : '';
  document.getElementById('run-eta').innerHTML =
    `<strong style="color:#4A235A">🔬 Persona: ${personaLabel}${iterLabel}</strong> — Jedify is researching. This takes 5-10 minutes.`;
```

- [ ] **Step 6: End-to-end verification**

1. Run a full analysis → Run 1 badge appears on all checks in Config
2. Tick "VIP Behavior" in Config → "Run 1 Selected Check" button enabled
3. Click it → overlay shows "Run 2 (1 check)" → analysis runs
4. On completion → output shows Run 1 + divider + Run 2 appended
5. Change the operator in the filter → go to Config → badges reset (session cleared)
6. Click "Re-run Everything" → fresh Run 1 starts, old session gone

- [ ] **Step 7: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat(iterative): wire runPartialAnalysis, session invalidation on entity change"
```

---

## Task 9: Handle `partialMandatoryIds` on the server side

**Files:**
- Modify: `C:\Users\aviav\OneDrive\Documents\Data Analysis\output\jedify-server.js` — `buildResearchPrompt()` (~line 960)

When `partialMandatoryIds` is sent, use only those mandatory checks instead of all mandatory checks.

- [ ] **Step 1: Update `buildResearchPrompt()` signature and logic**

Find (~line 960):
```javascript
function buildResearchPrompt(entity, scope, dateRange, enabledOptionalIds, persona, globalRules, checkDefinitions) {
  const checks = require('./research-checks');
  const selectedChecks = [
    ...checks.mandatory,
    ...checks.optional.filter(c => enabledOptionalIds.includes(c.id))
  ];
```

Replace with:
```javascript
function buildResearchPrompt(entity, scope, dateRange, enabledOptionalIds, persona, globalRules, checkDefinitions, partialMandatoryIds) {
  const checks = require('./research-checks');
  const mandatoryChecks = partialMandatoryIds && partialMandatoryIds.length > 0
    ? checks.mandatory.filter(c => partialMandatoryIds.includes(c.id))
    : checks.mandatory;
  const selectedChecks = [
    ...mandatoryChecks,
    ...checks.optional.filter(c => enabledOptionalIds.includes(c.id))
  ];
```

- [ ] **Step 2: Pass `partialMandatoryIds` through `runResearch()` and `/api/build-prompt`**

In `runResearch()` (~line 1110), find:
```javascript
  const { entity, scope, dateRange, enabledOptionalCheckIds, checkDefinitions, persona, customPrompt, globalRules } = reqBody;
```
Replace with:
```javascript
  const { entity, scope, dateRange, enabledOptionalCheckIds, checkDefinitions, partialMandatoryIds, persona, customPrompt, globalRules } = reqBody;
```

Find (~line 1118):
```javascript
  const prompt = customPrompt || buildResearchPrompt(entity, scopeLabel, dateRange, enabledOptionalCheckIds || [], activePersona, globalRules || '', checkDefinitions || {});
```
Replace with:
```javascript
  const prompt = customPrompt || buildResearchPrompt(entity, scopeLabel, dateRange, enabledOptionalCheckIds || [], activePersona, globalRules || '', checkDefinitions || {}, partialMandatoryIds || null);
```

In `/api/build-prompt` handler (~line 1261), find:
```javascript
        const { entity, scope, dateRange, enabledOptionalCheckIds, checkDefinitions, persona, globalRules } = JSON.parse(body);
        const prompt = buildResearchPrompt(
          entity || 'Unknown',
          scope || 'operator',
          dateRange || { start: '6 months ago', end: 'current month' },
          enabledOptionalCheckIds || [],
          persona || 'am_actions',
          globalRules || '',
          checkDefinitions || {}
        );
```
Replace with:
```javascript
        const { entity, scope, dateRange, enabledOptionalCheckIds, checkDefinitions, partialMandatoryIds, persona, globalRules } = JSON.parse(body);
        const prompt = buildResearchPrompt(
          entity || 'Unknown',
          scope || 'operator',
          dateRange || { start: '6 months ago', end: 'current month' },
          enabledOptionalCheckIds || [],
          persona || 'am_actions',
          globalRules || '',
          checkDefinitions || {},
          partialMandatoryIds || null
        );
```

- [ ] **Step 3: Verify prompt preview shows only selected checks for a partial run**

In the browser: after Run 1, tick only "VIP Behavior". Click "Skip preview & run directly" link — inspect the Render logs to see the prompt only contains the VIP check bullet, not all 6 mandatory checks.

- [ ] **Step 4: Commit**

```bash
git add jedify-server.js insight-loop-prototype.html
git commit -m "feat(iterative): server respects partialMandatoryIds in buildResearchPrompt"
git push origin master
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `_runSession` global state (Task 1)
- ✅ Check run-status badges (Tasks 2, 3)
- ✅ Partial-run checkboxes on all checks incl. mandatory in session mode (Task 4)
- ✅ "Run N Selected" + "Re-run Everything" buttons (Task 5)
- ✅ Session initialised on first result (Task 6)
- ✅ Append rendering with run header + divider (Task 7)
- ✅ `runPartialAnalysis()`, session invalidation on entity change (Task 8)
- ✅ Server `partialMandatoryIds` support (Task 9)
- ✅ `data_analyst` tab also appends (Task 7, Step 3)
- ✅ Mandatory = forced on first run, selectable after (Task 4 — session mode enables checkboxes for mandatory)
- ✅ Re-run Everything clears session (Task 5, Step 4 + Task 8)
- ✅ In-memory only, cleared on refresh (no localStorage persistence added)

**Type consistency:** `_runSession.runs[i].checkIds` used consistently across Tasks 3, 6, 7, 8. `partialCheckIds` parameter name used consistently through Tasks 6→8→9. `_partialSelectedIds` is a `Set` throughout.

**No placeholders found.**
