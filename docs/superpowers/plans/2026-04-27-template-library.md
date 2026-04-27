# Template Library — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single hardcoded slide definition + brand template upload with a named, server-side template library; add a Step 0 template picker to the 4-step wizard; add per-slide editing in Step 3 (edit text, regenerate, reorder, remove).

**Architecture:** Templates are stored in-memory on the server and persisted to a `TEMPLATES_JSON` Render env var. The built-in "RubyPlay Default" template is initialised from the existing hardcoded `SLIDE_DEFS`. Custom templates are uploaded as .pptx files, parsed client-side via JSZip (already loaded), and saved to the server. The wizard gains a Step 0 (template picker) and Step 3 gains an edit panel.

**Tech Stack:** Node.js (no new deps), JSZip (already on CDN), PptxGenJS (already on CDN), existing Anthropic SDK.

**Project root:** `C:\Users\aviav\OneDrive\Documents\Data Analysis\output\`

---

## File Map

| File | Change |
|------|--------|
| `jedify-server.js` | Replace `_brandTemplate` / `DEFAULT_BRAND_TEMPLATE` with template array; add CRUD + regenerate endpoints; update `buildSlidesPrompt` + `/api/generate-slides` |
| `insight-loop-prototype.html` | Remove old brand template section; add Step 0 UI; extend `.pptx` parser; update wizard; add Step 3 edit panel |
| `docs/superpowers/specs/2026-04-27-template-library-design.md` | New design doc (Task 1) |
| `docs/superpowers/plans/2026-04-27-template-library.md` | This plan (Task 1) |

---

## Task 1 — Write design doc and this plan to the repo

**Files:**
- Create: `docs/superpowers/specs/2026-04-27-template-library-design.md`
- Create: `docs/superpowers/plans/2026-04-27-template-library.md`

- [ ] **Step 1: Create the spec file**

Write the design doc to `docs/superpowers/specs/2026-04-27-template-library-design.md` with the full content from the brainstorm session (template data model, endpoints, .pptx parsing rules, wizard flow, Step 3 editing, verification checklist).

- [ ] **Step 2: Create this plan file**

Copy this plan to `docs/superpowers/plans/2026-04-27-template-library.md`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-04-27-template-library-design.md
git add docs/superpowers/plans/2026-04-27-template-library.md
git commit -m "docs: add template library design spec and implementation plan"
```

---

## Task 2 — Server: template data model + storage

**Files:**
- Modify: `jedify-server.js` (lines 1–80, replacing DEFAULT_BRAND_TEMPLATE / _brandTemplate)

- [ ] **Step 1: Replace the existing brand template variables**

Find and replace the `DEFAULT_BRAND_TEMPLATE` const and `_brandTemplate` variable (around lines 22–49). Replace with:

```js
// ── Template library ─────────────────────────────────────────────────────────
// Built-in default: slide definitions from SLIDE_DEFS, RubyPlay brand palette.
// Persisted to TEMPLATES_JSON env var (logos excluded — too large).

function buildDefaultTemplate() {
  return {
    id: 'default',
    name: 'RubyPlay Default',
    isDefault: true,
    slides: [
      { title: 'Title',               description: 'Operator name, bold assertion headline, date range, QBR badge. Headline: strongest statement from data.' },
      { title: 'KPI Charts',          description: '2×2 grid SVG bar charts: Total Bets, GGR, Active Players, Rounds/Player. QBR bars red, prior months grey.' },
      { title: 'Studio Summary Table',description: 'Table: Studio | Games Released | Total Bets | Bet Share % | Total GGR | Bets per Game. Sort by Total Bets desc.' },
      { title: 'Studio Performance',  description: 'Full-width SVG line chart, one line per studio over months. Legend below chart.' },
      { title: 'New Games Launched',  description: 'Table: Game | Studio | RTP | Total Bets 14d | Players 14d. Sort by Total Bets desc.' },
      { title: 'Retention Analysis',  description: 'PLACEHOLDER — Coming Soon.' },
      { title: 'Player Segmentation', description: 'PLACEHOLDER — Coming Soon.' },
      { title: 'VIP Analysis',        description: 'Table: Game | Studio | VIP Players | VIP Bets (€) | VIP GGR (€). Sort by VIP Bets desc.' },
      { title: 'Max Bet Analysis',    description: 'PLACEHOLDER — Coming Soon.' },
      { title: 'Promotion Analysis',  description: 'PLACEHOLDER — Coming Soon.' },
      { title: 'The Portfolio Gap',   description: 'Table: Game | Key Fact | Market Rank | Market Share % | Signal badge. Max 8 rows.' },
      { title: 'Growth Levers',       description: 'Table: Game | Key Fact | Players | GGR/Player | Total GGR | Opportunity | ADD/EXPAND pill. Sort by Opportunity desc.' },
      { title: 'KPI Gaps',            description: 'Table: KPI | Our Value | Peer Benchmark | Gap | Trend arrows. Red gaps negative, green positive.' },
      { title: 'Actions & Priorities',description: 'Up to 5 numbered action cards: priority badge, bold title, rationale, expected outcome.' },
      { title: 'The Ask',             description: 'Full-bleed dark slide. Large headline = the specific ask. 3 bullet next steps. Red accent bar.' },
    ],
    brand: {
      primary: '#CC0000', accent: '#CC0000', background: '#0D0D0D',
      highlight: '#1A1A1A', text: '#CBD5E1',
      fontHeading: 'Segoe UI', fontBody: 'Segoe UI',
      logoBase64: null
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

let _templates = [];

function loadTemplates() {
  try {
    const saved = process.env.TEMPLATES_JSON ? JSON.parse(process.env.TEMPLATES_JSON) : [];
    // Always ensure default is first
    const hasDefault = saved.some(t => t.id === 'default');
    _templates = hasDefault ? saved : [buildDefaultTemplate(), ...saved];
  } catch {
    _templates = [buildDefaultTemplate()];
  }
}

async function persistTemplates() {
  // Strip logos before persisting (too large for env var)
  const stripped = _templates.map(t => ({ ...t, brand: { ...t.brand, logoBase64: null } }));
  const json = JSON.stringify(stripped);
  console.log(`[templates] Persisting ${_templates.length} templates (${json.length} chars)`);
  if (!process.env.RENDER_API_KEY || !process.env.RENDER_SERVICE_ID) {
    console.warn('[templates] RENDER_API_KEY/SERVICE_ID not set — templates will reset on restart');
    return;
  }
  // Reuse existing Render env var update logic (same as old brand template)
  await updateRenderEnvVar('TEMPLATES_JSON', json);
}

loadTemplates();
```

- [ ] **Step 2: Extract the Render env var update logic into a reusable function**

The existing code around lines 44–76 makes the Render API call. Extract it:

```js
async function updateRenderEnvVar(key, value) {
  // existing PUT /v1/services/:id/env-vars logic, generalised to accept key+value
  // (move the existing _brandTemplate Render update code here)
}
```

- [ ] **Step 3: Commit**

```bash
git add jedify-server.js
git commit -m "refactor: replace single brand template with template array + persist helpers"
```

---

## Task 3 — Server: CRUD endpoints for templates

**Files:**
- Modify: `jedify-server.js` (after existing `/api/get-template` endpoint, around line 2193)

- [ ] **Step 1: Add GET /api/templates (list)**

```js
if (req.method === 'GET' && req.url === '/api/templates') {
  const list = _templates.map(({ id, name, isDefault, slides, createdAt, updatedAt }) => ({
    id, name, isDefault, slideCount: slides.length, createdAt, updatedAt
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(list));
  return;
}
```

- [ ] **Step 2: Add GET /api/templates/:id (full template)**

```js
if (req.method === 'GET' && req.url.startsWith('/api/templates/')) {
  const id = req.url.slice('/api/templates/'.length);
  const t = _templates.find(t => t.id === id);
  if (!t) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(t));
  return;
}
```

- [ ] **Step 3: Add POST /api/templates (create)**

```js
if (req.method === 'POST' && req.url === '/api/templates') {
  if (!isAuthenticated(req)) { rejectUnauth(res); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    const { name, slides, brand } = JSON.parse(body);
    if (!name || !slides || !brand) { res.writeHead(400); res.end(JSON.stringify({ error: 'name, slides, brand required' })); return; }
    const id = 'tpl_' + Date.now();
    const now = new Date().toISOString();
    const tpl = { id, name, isDefault: false, slides, brand, createdAt: now, updatedAt: now };
    _templates.push(tpl);
    await persistTemplates();
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id }));
  });
  return;
}
```

- [ ] **Step 4: Add PUT /api/templates/:id (update)**

```js
if (req.method === 'PUT' && req.url.startsWith('/api/templates/')) {
  if (!isAuthenticated(req)) { rejectUnauth(res); return; }
  const id = req.url.slice('/api/templates/'.length);
  const idx = _templates.findIndex(t => t.id === id);
  if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    const patch = JSON.parse(body); // { name?, slides?, brand? }
    _templates[idx] = { ..._templates[idx], ...patch, updatedAt: new Date().toISOString() };
    await persistTemplates();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return;
}
```

- [ ] **Step 5: Add DELETE /api/templates/:id**

```js
if (req.method === 'DELETE' && req.url.startsWith('/api/templates/')) {
  if (!isAuthenticated(req)) { rejectUnauth(res); return; }
  const id = req.url.slice('/api/templates/'.length);
  const tpl = _templates.find(t => t.id === id);
  if (!tpl) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
  if (tpl.isDefault) { res.writeHead(403); res.end(JSON.stringify({ error: 'Cannot delete default template' })); return; }
  _templates = _templates.filter(t => t.id !== id);
  await persistTemplates();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  return;
}
```

- [ ] **Step 6: Remove old /api/upload-template and /api/get-template endpoints**

Delete the blocks at the old `/api/upload-template` and `/api/get-template` routes.

- [ ] **Step 7: Commit**

```bash
git add jedify-server.js
git commit -m "feat: add template CRUD endpoints (GET/POST/PUT/DELETE /api/templates)"
```

---

## Task 4 — Server: /api/regenerate-slide endpoint

**Files:**
- Modify: `jedify-server.js`

- [ ] **Step 1: Add the endpoint after /api/generate-slides handler**

```js
if (req.method === 'POST' && req.url === '/api/regenerate-slide') {
  if (!process.env.ANTHROPIC_API_KEY) { res.writeHead(500); res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' })); return; }
  if (!isAuthenticated(req)) { rejectUnauth(res); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    const { slideTitle, slideDescription, brief, operator, sectionContent, instructions } = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    try {
      await streamSingleSlide({ slideTitle, slideDescription, brief, operator, sectionContent, instructions }, res);
    } catch (e) {
      res.write(`<GENERATION_ERROR>${e.message}</GENERATION_ERROR>`);
    }
    res.end();
  });
  return;
}
```

- [ ] **Step 2: Add streamSingleSlide helper (above streamSlidesToResponse)**

```js
async function streamSingleSlide({ slideTitle, slideDescription, brief, operator, sectionContent, instructions }, res) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const systemPrompt = `You are a world-class presentation designer. Generate exactly ONE slide following the RubyPlay brand design rules. Output only: <SLIDE_START><NOTES>notes</NOTES><HTML>html</HTML><SLIDE_END>`;
  const userPrompt = `Slide: ${slideTitle}\nDescription: ${slideDescription}\n${instructions ? `Special instructions: ${instructions}\n` : ''}Analysis data:\n${sectionContent}\nOperator: ${operator}\nBrief tone: ${brief?.tone || 'opportunity'}`;
  const stream = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 8000, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }], stream: true });
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') res.write(chunk.delta.text);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add jedify-server.js
git commit -m "feat: add /api/regenerate-slide endpoint for single-slide rewrite"
```

---

## Task 5 — Server: update buildSlidesPrompt + /api/generate-slides to use template

**Files:**
- Modify: `jedify-server.js` (`buildSlidesPrompt` function and `/api/generate-slides` handler)

- [ ] **Step 1: Update buildSlidesPrompt signature to accept a template**

Change the function signature from:
```js
function buildSlidesPrompt(sections, brief, operator, slidePlan) {
```
to:
```js
function buildSlidesPrompt(sections, brief, operator, slidePlan, template) {
  const tpl = template || _templates.find(t => t.id === 'default');
```

- [ ] **Step 2: Replace hardcoded SLIDE_DEFS with template.slides**

Remove the `SLIDE_DEFS`, `ACTIONS_DEF`, `ASK_DEF`, `SLIDE_ORDER` constants. Replace the slide list assembly loop with:

```js
const enabledIds = (slidePlan?.enabled) ? slidePlan.enabled : tpl.slides.map((_, i) => i);
const customSlides = slidePlan?.custom || [];

const slideLines = [];
let slideN = 1;
for (const idx of enabledIds) {
  const s = tpl.slides[idx];
  if (!s) continue;
  slideLines.push(`SLIDE ${slideN++} — ${s.title.toUpperCase()}\n  ${s.description}`);
}
for (const c of customSlides) {
  slideLines.push(`SLIDE ${slideN++} — ${c.title.toUpperCase()}\n  [CUSTOM] ${c.description || 'Create a relevant slide from the analysis.'}`);
}
const totalSlides = slideN - 1;
const slidesText = slideLines.join('\n\n');
```

- [ ] **Step 3: Replace hardcoded brand palette with template.brand**

In the design rules section of the user prompt, replace the hardcoded colour block with:

```js
const b = tpl.brand;
// Replace colour lines with:
`Brand colours:
  Primary/Red: ${b.primary}  (accents, key numbers, badges, QBR bars)
  Dark:        ${b.highlight}  (table headers, card surfaces)
  Background:  ${b.background}
  Body text:   ${b.text}
  Fonts: heading=${b.fontHeading}, body=${b.fontBody}`
```

- [ ] **Step 4: Update /api/generate-slides to load template by ID**

In the handler, after extracting `{ sections, brief, operator, slidePlan }` from the body, add:

```js
const { sections, brief, operator, slidePlan, templateId } = parsed;
const template = _templates.find(t => t.id === templateId) || _templates.find(t => t.id === 'default');
// Pass template into streamSlidesToResponse:
await streamSlidesToResponse(sections, brief || {}, operator || 'Operator', res, slidePlan || null, template);
```

Update `streamSlidesToResponse` signature to accept and pass through `template`:
```js
async function streamSlidesToResponse(sections, brief, operator, res, slidePlan, template) {
  const { systemPrompt, userPrompt } = buildSlidesPrompt(sections, brief, operator, slidePlan, template);
```

- [ ] **Step 5: Commit**

```bash
git add jedify-server.js
git commit -m "feat: buildSlidesPrompt and generate-slides now driven by template object"
```

---

## Task 6 — Frontend: extend .pptx parser to extract slide definitions

**Files:**
- Modify: `insight-loop-prototype.html` (`_pptxHandleFile` function, around line 6719)

- [ ] **Step 1: Add slide XML parsing inside _pptxHandleFile, after existing phases**

After the existing Phase 3 (logo extraction), add Phase 4:

```js
// Phase 4: extract slide definitions from ppt/slides/slide*.xml
const slideFiles = Object.keys(zip.files)
  .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
  .sort((a, b) => {
    const na = parseInt(a.match(/\d+/)[0]), nb = parseInt(b.match(/\d+/)[0]);
    return na - nb;
  });

const extractedSlides = [];
for (const fname of slideFiles) {
  const xml = await zip.files[fname].async('string');
  // Extract title: <p:ph type="title"> or <p:ph type="ctrTitle">
  const titleMatch = xml.match(/<p:sp>(?:(?!<p:sp>).)*?<p:ph[^>]+type="(?:title|ctrTitle)"[^>]*\/>(?:(?!<\/p:sp>).)*?<\/p:sp>/s);
  const title = titleMatch ? titleMatch[0].replace(/<[^>]+>/g, '').trim() : null;
  if (!title) continue;
  // Extract body text: all other <p:sp> text runs
  const bodyXml = xml.replace(titleMatch ? titleMatch[0] : '', '');
  const description = bodyXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  extractedSlides.push({ title, description });
}
_pptxExtracted.slides = extractedSlides;
```

- [ ] **Step 2: Verify _pptxExtracted structure after this change**

`_pptxExtracted` now has:
```js
{
  primary, accent, background, highlight, text,  // colors (existing)
  fontHeading, fontBody,                          // fonts (existing)
  logoBase64,                                     // logo (existing)
  slides: [{ title, description }, ...]           // NEW
}
```

- [ ] **Step 3: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: extract slide definitions from pptx upload (title + description per slide)"
```

---

## Task 7 — Frontend: remove old Brand Template section

**Files:**
- Modify: `insight-loop-prototype.html`

- [ ] **Step 1: Remove the HTML block (lines 744–786)**

Delete the entire `<div>` block starting with `🎨 Brand Template` and ending before the next section.

- [ ] **Step 2: Remove associated JS functions**

Delete: `_pptxSaveTemplate()`, `_pptxClearTemplate()`, `_pptxShowExtracted()`, `_pptxHandleDrop()`, and the `_pptxTemplate` variable declaration at line 5318.

- [ ] **Step 3: Remove the /api/get-template fetch call** (around line 5387)

Delete the `fetch('/api/get-template')` block in `openPresentationBuilder()`.

- [ ] **Step 4: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "refactor: remove old single brand template section from presentation builder"
```

---

## Task 8 — Frontend: add Step 0 template picker

**Files:**
- Modify: `insight-loop-prototype.html`

- [ ] **Step 1: Add new JS variables near _pptxSlides declarations (~line 5318)**

```js
let _pptxTemplates     = [];    // list from GET /api/templates
let _selectedTemplateId = 'default';
let _selectedTemplate  = null;  // full template loaded before generation
```

- [ ] **Step 2: Add _pptxRenderStep0() function**

```js
function _pptxRenderStep0() {
  _pptxSetStepLabel('Choose a presentation template', 0);
  const c = document.getElementById('pptx-content');
  c.innerHTML = `
    <div style="font-size:13px;font-weight:700;color:#1E293B;margin-bottom:4px;">Choose a template</div>
    <div style="font-size:11px;color:#64748B;margin-bottom:14px;">Shared across your team · Defines slide structure and brand</div>
    <div id="pptx-tpl-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;"></div>
    <div id="pptx-tpl-upload" style="border:1.5px dashed #CBD5E1;border-radius:8px;padding:12px;text-align:center;cursor:pointer;"
         onclick="document.getElementById('pptx-tpl-file').click()">
      <div style="font-size:18px;margin-bottom:4px;">+</div>
      <div style="font-weight:600;font-size:12px;color:#64748B;">Upload new template (.pptx)</div>
      <input type="file" id="pptx-tpl-file" accept=".pptx" style="display:none" onchange="_pptxUploadTemplate(this.files[0])">
    </div>`;
  _pptxLoadTemplateList();
  const footer = document.getElementById('pptx-footer');
  footer.innerHTML = `
    <button onclick="_pptxStep0Next()" style="margin-left:auto;padding:8px 20px;background:linear-gradient(135deg,#7C3AED,#4A235A);color:white;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">Next: Story Brief →</button>`;
}
```

- [ ] **Step 3: Add _pptxLoadTemplateList()**

```js
async function _pptxLoadTemplateList() {
  try {
    const res = await fetch('/api/templates', { headers: { Authorization: 'Bearer ' + _authToken } });
    _pptxTemplates = await res.json();
  } catch { _pptxTemplates = [{ id: 'default', name: 'RubyPlay Default', isDefault: true, slideCount: 15 }]; }
  const list = document.getElementById('pptx-tpl-list');
  if (!list) return;
  list.innerHTML = _pptxTemplates.map(t => `
    <div onclick="_pptxSelectTemplate('${t.id}')" id="pptx-tpl-${t.id}"
         style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:8px;cursor:pointer;border:1.5px solid ${_selectedTemplateId===t.id?'#7C3AED':'#E2E8F0'};background:${_selectedTemplateId===t.id?'#F5F3FF':'white'};">
      <div style="width:36px;height:36px;background:${t.isDefault?'#7C3AED':'#1A1A2E'};border-radius:6px;display:flex;align-items:center;justify-content:center;color:white;font-size:${t.isDefault?'16':'10'}px;font-weight:700;flex-shrink:0;">${t.isDefault?'★':t.name.slice(0,2).toUpperCase()}</div>
      <div style="flex:1;">
        <div style="font-weight:700;color:#1E293B;font-size:13px;">${t.name}</div>
        <div style="font-size:11px;color:#64748B;">${t.slideCount} slides${t.updatedAt?' · Updated '+t.updatedAt.slice(0,10):''}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        ${_selectedTemplateId===t.id?'<span style="font-size:10px;font-weight:700;color:#7C3AED;background:#EDE9FE;padding:2px 8px;border-radius:10px;">SELECTED</span>':''}
        <button onclick="event.stopPropagation();_pptxEditTemplate('${t.id}')" style="padding:3px 8px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:5px;font-size:10px;color:#64748B;cursor:pointer;">Edit</button>
        ${!t.isDefault?`<button onclick="event.stopPropagation();_pptxDeleteTemplate('${t.id}')" style="padding:3px 8px;background:#FEF2F2;border:1px solid #FECACA;border-radius:5px;font-size:10px;color:#CC0000;cursor:pointer;">Delete</button>`:''}
      </div>
    </div>`).join('');
}

function _pptxSelectTemplate(id) {
  _selectedTemplateId = id;
  _pptxLoadTemplateList();
}

function _pptxStep0Next() {
  _pptxRenderBrief();  // existing Step 1 function
}
```

- [ ] **Step 4: Update openPresentationBuilder() to call _pptxRenderStep0() instead of _pptxRenderBrief()**

Change the final call in `openPresentationBuilder()`:
```js
// was: _pptxRenderBrief();
_pptxRenderStep0();
```

- [ ] **Step 5: Update the step bar to show 4 steps**

In the HTML, update the step bar div (around line 1005) to add Step 0:
```html
<div class="pptx-step-dot" id="pptx-dot-0" ...>0 TEMPLATE</div>
<div class="pptx-step-dot" id="pptx-dot-1" ...>1 STORY BRIEF</div>
<div class="pptx-step-dot" id="pptx-dot-2" ...>2 SLIDE PLAN</div>
<div class="pptx-step-dot" id="pptx-dot-3" ...>3 PREVIEW</div>
```

Update `_pptxSetStepLabel` (or equivalent) to handle steps 0–3.

- [ ] **Step 6: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: add Step 0 template picker to presentation builder wizard"
```

---

## Task 9 — Frontend: template upload + naming + inline editor

**Files:**
- Modify: `insight-loop-prototype.html`

- [ ] **Step 1: Add _pptxUploadTemplate(file)**

```js
async function _pptxUploadTemplate(file) {
  if (!file || !file.name.endsWith('.pptx')) return;
  // Reuse existing _pptxHandleFile logic to extract brand + slides
  await _pptxHandleFile(file);  // populates _pptxExtracted
  const name = prompt('Name this template:', file.name.replace('.pptx','')) || file.name.replace('.pptx','');
  const { primary, accent, background, highlight, text, fontHeading, fontBody, logoBase64, slides } = _pptxExtracted;
  const res = await fetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _authToken },
    body: JSON.stringify({ name, slides: slides || [], brand: { primary, accent, background, highlight, text, fontHeading, fontBody, logoBase64 } })
  });
  const { id } = await res.json();
  _selectedTemplateId = id;
  _pptxLoadTemplateList();
}
```

- [ ] **Step 2: Add _pptxDeleteTemplate(id)**

```js
async function _pptxDeleteTemplate(id) {
  if (!confirm('Delete this template? This cannot be undone.')) return;
  await fetch(`/api/templates/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + _authToken } });
  if (_selectedTemplateId === id) _selectedTemplateId = 'default';
  _pptxLoadTemplateList();
}
```

- [ ] **Step 3: Add _pptxEditTemplate(id) — inline slide editor**

```js
async function _pptxEditTemplate(id) {
  const res = await fetch(`/api/templates/${id}`, { headers: { Authorization: 'Bearer ' + _authToken } });
  const tpl = await res.json();
  const c = document.getElementById('pptx-content');
  c.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
      <button onclick="_pptxRenderStep0()" style="padding:4px 10px;background:#F1F5F9;border:none;border-radius:6px;cursor:pointer;font-size:12px;">← Back</button>
      <span style="font-weight:700;font-size:13px;">Edit: ${tpl.name}</span>
      ${!tpl.isDefault ? `<input id="pptx-tpl-rename" value="${tpl.name}" style="margin-left:auto;font-size:12px;border:1px solid #E2E8F0;border-radius:5px;padding:3px 8px;width:160px;">` : ''}
    </div>
    <div id="pptx-slide-editor" style="display:flex;flex-direction:column;gap:6px;"></div>
    <button onclick="event.preventDefault();_pptxAddSlide()" style="margin-top:8px;width:100%;padding:6px;background:#F8FAFC;border:1.5px dashed #CBD5E1;border-radius:6px;font-size:12px;color:#64748B;cursor:pointer;">+ Add slide</button>
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
      <button onclick="_pptxSaveTemplateEdits('${id}')" style="padding:8px 18px;background:#7C3AED;color:white;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">Save changes</button>
    </div>`;
  _pptxEditorSlides = tpl.slides.map(s => ({ ...s }));
  _pptxRenderSlideEditorRows();
}

let _pptxEditorSlides = [];

function _pptxRenderSlideEditorRows() {
  const el = document.getElementById('pptx-slide-editor');
  if (!el) return;
  el.innerHTML = _pptxEditorSlides.map((s, i) => `
    <div style="display:flex;gap:8px;align-items:flex-start;padding:8px;background:#F8FAFC;border-radius:6px;border:1px solid #E2E8F0;">
      <span style="color:#94A3B8;font-size:11px;font-weight:700;width:18px;text-align:right;padding-top:6px;">${i+1}</span>
      <div style="flex:1;display:flex;flex-direction:column;gap:4px;">
        <input value="${s.title}" oninput="_pptxEditorSlides[${i}].title=this.value" placeholder="Slide title"
               style="font-size:12px;font-weight:600;border:1px solid #E2E8F0;border-radius:4px;padding:4px 6px;">
        <textarea oninput="_pptxEditorSlides[${i}].description=this.value" rows="2"
                  style="font-size:11px;color:#64748B;border:1px solid #E2E8F0;border-radius:4px;padding:4px 6px;resize:none;">${s.description}</textarea>
      </div>
      <button onclick="_pptxEditorSlides.splice(${i},1);_pptxRenderSlideEditorRows()" style="padding:4px 6px;background:#FEF2F2;border:1px solid #FECACA;border-radius:5px;font-size:11px;color:#CC0000;cursor:pointer;flex-shrink:0;">×</button>
    </div>`).join('');
}

function _pptxAddSlide() {
  _pptxEditorSlides.push({ title: 'New Slide', description: 'Describe what this slide should contain.' });
  _pptxRenderSlideEditorRows();
}

async function _pptxSaveTemplateEdits(id) {
  const nameInput = document.getElementById('pptx-tpl-rename');
  const patch = { slides: _pptxEditorSlides };
  if (nameInput) patch.name = nameInput.value;
  await fetch(`/api/templates/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _authToken },
    body: JSON.stringify(patch)
  });
  _pptxRenderStep0();
}
```

- [ ] **Step 4: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: template upload, delete, and inline slide editor"
```

---

## Task 10 — Frontend: load full template before generation + wire templateId

**Files:**
- Modify: `insight-loop-prototype.html` (generate-slides fetch call, around line 5772)

- [ ] **Step 1: Load the selected template before generation starts**

In `_pptxGenerate()` (the function that sends the POST to /api/generate-slides), add at the top:

```js
async function _pptxGenerate() {
  // Load full template
  try {
    const r = await fetch(`/api/templates/${_selectedTemplateId}`, { headers: { Authorization: 'Bearer ' + _authToken } });
    _selectedTemplate = await r.json();
  } catch { _selectedTemplate = null; }
  // ... rest of existing generate logic
```

- [ ] **Step 2: Add templateId to the POST payload**

In the fetch body for `/api/generate-slides`:
```js
body: JSON.stringify({
  sections,
  brief: _pptxBrief,
  operator: _currentOperator,
  slidePlan: { enabled: _pptxEnabledSlides, custom: _pptxCustomSlides },
  templateId: _selectedTemplateId   // ADD THIS
})
```

- [ ] **Step 3: Update Step 2 (_pptxRenderPlan) to show template slide names**

When in template mode, populate the slide toggle list from `_selectedTemplate.slides` rather than the hardcoded `_PPTX_STANDARD_SLIDES` array:

```js
const slideSource = (_selectedTemplate && _selectedTemplate.slides.length)
  ? _selectedTemplate.slides.map((s, i) => ({ id: i, name: s.title, description: s.description, locked: false }))
  : _PPTX_STANDARD_SLIDES;
```

- [ ] **Step 4: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: wire selected template through Step 2 and generate-slides payload"
```

---

## Task 11 — Frontend: Step 3 edit panel (reorder + remove)

**Files:**
- Modify: `insight-loop-prototype.html` (`_pptxRenderPreview` and `_pptxDrawPreview`, around lines 5882–5947)

- [ ] **Step 1: Add right-side action panel to Step 3**

In `_pptxDrawPreview(idx)`, after rendering the slide HTML pane, add:

```js
const actionPanel = `
  <div id="pptx-action-panel" style="width:190px;flex-shrink:0;display:flex;flex-direction:column;gap:8px;">
    <div style="font-size:10px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;">Slide ${idx+1} — Actions</div>
    <button onclick="_pptxEditSlideText(${idx})" style="width:100%;padding:8px 10px;background:#F5F3FF;color:#7C3AED;border:1.5px solid #DDD6FE;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;text-align:left;">✏️ Edit text</button>
    <button onclick="_pptxShowRegenPanel(${idx})" style="width:100%;padding:8px 10px;background:#F5F3FF;color:#7C3AED;border:1.5px solid #DDD6FE;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;text-align:left;">↺ Regenerate slide</button>
    <button onclick="_pptxRemoveSlide(${idx})" style="width:100%;padding:8px 10px;background:#FEF2F2;color:#CC0000;border:1.5px solid #FECACA;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;text-align:left;">🗑 Remove slide</button>
    <div style="border-top:1px solid #E2E8F0;padding-top:8px;">
      <div style="font-size:10px;font-weight:700;color:#94A3B8;margin-bottom:4px;">Presenter Notes</div>
      <textarea style="width:100%;font-size:11px;border:1px solid #E2E8F0;border-radius:6px;padding:5px;resize:vertical;height:60px;box-sizing:border-box;"
        onchange="_pptxSlides[${idx}].notes=this.value">${_pptxSlides[idx]?.notes||''}</textarea>
    </div>
    <div id="pptx-edit-subpanel"></div>
  </div>`;
```

- [ ] **Step 2: Add _pptxRemoveSlide(idx)**

```js
function _pptxRemoveSlide(idx) {
  if (!confirm('Remove this slide from the deck?')) return;
  _pptxSlides.splice(idx, 1);
  _pptxRenderPreview();
}
```

- [ ] **Step 3: Add drag-to-reorder on thumbnails**

In the thumbnail strip render loop, add `draggable="true"` and handlers:

```js
// On each thumb div:
draggable="true"
ondragstart="_pptxDragStart(event,${i})"
ondragover="event.preventDefault()"
ondrop="_pptxDragDrop(event,${i})"
```

```js
let _pptxDragIdx = null;
function _pptxDragStart(e, idx) { _pptxDragIdx = idx; e.dataTransfer.effectAllowed = 'move'; }
function _pptxDragDrop(e, targetIdx) {
  if (_pptxDragIdx === null || _pptxDragIdx === targetIdx) return;
  const moved = _pptxSlides.splice(_pptxDragIdx, 1)[0];
  _pptxSlides.splice(targetIdx, 0, moved);
  _pptxDragIdx = null;
  _pptxRenderPreview();
}
```

- [ ] **Step 4: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: Step 3 action panel — remove slide + drag-to-reorder thumbnails"
```

---

## Task 12 — Frontend: Step 3 edit text

**Files:**
- Modify: `insight-loop-prototype.html`

- [ ] **Step 1: Add _pptxEditSlideText(idx)**

```js
function _pptxEditSlideText(idx) {
  const html = _pptxSlides[idx].html;
  // Parse text nodes from slide HTML via temporary DOM
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const textEls = Array.from(tmp.querySelectorAll('span, div, td, th'))
    .filter(el => el.children.length === 0 && el.textContent.trim().length > 3 && el.textContent.trim().length < 200);
  // Deduplicate by text content
  const unique = [...new Map(textEls.map(el => [el.textContent.trim(), el])).values()].slice(0, 8);

  const subpanel = document.getElementById('pptx-edit-subpanel');
  subpanel.innerHTML = `
    <div style="background:#FFFBEB;border:1.5px solid #FDE68A;border-radius:8px;padding:10px;margin-top:4px;">
      <div style="font-size:11px;font-weight:700;color:#92400E;margin-bottom:6px;">✏️ Edit text elements</div>
      ${unique.map((el, i) => `
        <div style="margin-bottom:5px;">
          <div style="font-size:9px;color:#92400E;margin-bottom:2px;">Element ${i+1}</div>
          <input id="pptx-text-edit-${i}" value="${el.textContent.trim().replace(/"/g,'&quot;')}"
                 style="width:100%;font-size:11px;border:1px solid #FDE68A;border-radius:4px;padding:3px 6px;box-sizing:border-box;">
        </div>`).join('')}
      <div style="display:flex;gap:5px;margin-top:6px;">
        <button onclick="_pptxApplyTextEdits(${idx},[${unique.map(el => `'${CSS.escape(el.textContent.trim().slice(0,30))}'`).join(',')}])"
                style="padding:4px 10px;background:#7C3AED;color:white;border:none;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;">Apply</button>
        <button onclick="document.getElementById('pptx-edit-subpanel').innerHTML=''"
                style="padding:4px 8px;background:white;color:#64748B;border:1px solid #E2E8F0;border-radius:5px;font-size:11px;cursor:pointer;">Cancel</button>
      </div>
    </div>`;
}

function _pptxApplyTextEdits(idx, originalTexts) {
  let html = _pptxSlides[idx].html;
  originalTexts.forEach((orig, i) => {
    const input = document.getElementById(`pptx-text-edit-${i}`);
    if (input && input.value !== orig) {
      html = html.replace(orig, input.value);
    }
  });
  _pptxSlides[idx].html = html;
  _pptxDrawPreview(idx);
}
```

- [ ] **Step 2: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: Step 3 edit text panel — extract and inline-edit slide text elements"
```

---

## Task 13 — Frontend: Step 3 regenerate single slide

**Files:**
- Modify: `insight-loop-prototype.html`

- [ ] **Step 1: Add _pptxShowRegenPanel(idx)**

```js
function _pptxShowRegenPanel(idx) {
  const subpanel = document.getElementById('pptx-edit-subpanel');
  subpanel.innerHTML = `
    <div style="background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:8px;padding:10px;margin-top:4px;">
      <div style="font-size:11px;font-weight:700;color:#166534;margin-bottom:6px;">↺ Regenerate Slide ${idx+1}</div>
      <textarea id="pptx-regen-instructions" rows="3" placeholder="Instructions for Claude — e.g. 'Use a horizontal bar chart' or 'Make the headline more urgent'"
                style="width:100%;font-size:11px;border:1px solid #86EFAC;border-radius:5px;padding:5px;box-sizing:border-box;resize:none;"></textarea>
      <div style="display:flex;gap:5px;margin-top:6px;">
        <button onclick="_pptxRegenerateSlide(${idx})"
                style="padding:4px 12px;background:#16A34A;color:white;border:none;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;">↺ Regenerate</button>
        <button onclick="document.getElementById('pptx-edit-subpanel').innerHTML=''"
                style="padding:4px 8px;background:white;color:#64748B;border:1px solid #E2E8F0;border-radius:5px;font-size:11px;cursor:pointer;">Cancel</button>
      </div>
    </div>`;
}

async function _pptxRegenerateSlide(idx) {
  const instructions = document.getElementById('pptx-regen-instructions')?.value || '';
  const slideSource = (_selectedTemplate?.slides || [])[idx] || { title: `Slide ${idx+1}`, description: '' };
  // Collect section content (same as generation)
  const sectionContent = _pptxSections.map(s => `=== ${s.checkName} ===\n${s.content}`).join('\n\n').slice(0, 30000);

  const btn = document.querySelector('#pptx-edit-subpanel button');
  if (btn) btn.textContent = 'Generating...';

  const res = await fetch('/api/regenerate-slide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _authToken },
    body: JSON.stringify({
      slideTitle: slideSource.title,
      slideDescription: slideSource.description,
      brief: _pptxBrief,
      operator: _currentOperator,
      sectionContent,
      instructions
    })
  });

  let raw = '';
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += new TextDecoder().decode(value);
  }

  const parsed = parseSlidesFromStream(raw);  // existing frontend parse function (~line 5494)
  if (parsed.length > 0) {
    _pptxSlides[idx] = parsed[0];
    _pptxDrawPreview(idx);
  }
  document.getElementById('pptx-edit-subpanel').innerHTML = '';
}
```

- [ ] **Step 2: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: Step 3 regenerate single slide via /api/regenerate-slide"
```

---

## Task 14 — End-to-end verification

- [ ] **Step 1: Start the server locally**
```bash
cd "C:/Users/aviav/OneDrive/Documents/Data Analysis/output"
node jedify-server.js
```

- [ ] **Step 2: Open http://localhost:3001 and click "✦ Create Presentation"**

Expected: Step 0 shows template list with "RubyPlay Default" selected.

- [ ] **Step 3: Upload a branded .pptx with at least 3 slides**

Expected: Upload prompt → name dialog → template appears in list → slide count shows correctly.

- [ ] **Step 4: Click Edit on the new template → change a slide description → Save**

Expected: Changes persist; re-opening editor shows updated description.

- [ ] **Step 5: Select new template → complete Steps 1–2 → click Generate**

Expected: Generation uses template's slide definitions and brand colors (visible in presenter notes and HTML structure).

- [ ] **Step 6: In Step 3, drag two thumbnails to swap order → Download .pptx**

Expected: Downloaded deck has slides in the new order.

- [ ] **Step 7: Click Regenerate on one slide with instruction "make the headline more urgent"**

Expected: Only that slide refreshes; other slides unchanged.

- [ ] **Step 8: Click Edit text on the title slide → change headline → Apply**

Expected: Slide preview updates inline.

- [ ] **Step 9: Click Delete on the custom template → confirm**

Expected: Template removed from list; selected template reverts to Default.

- [ ] **Step 10: Commit and push**

```bash
git add -A
git commit -m "feat: template library — end-to-end verified"
git push
```
