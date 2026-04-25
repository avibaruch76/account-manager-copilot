# Presentation Builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "✦ Create Presentation" button to the Analysis Results toolbar that generates a professional SCR-structured .pptx file from the analysis, shaped by a Story Brief the AM fills in before generation.

**Architecture:** Single self-contained addition to `insight-loop-prototype.html` (overlay div + script block) plus three new endpoints in `jedify-server.js`. Brand template stored server-side in an env var. PptxGenJS runs fully in the browser. Claude Haiku generates slide JSON via `/api/generate-slides`.

**Tech Stack:** PptxGenJS (CDN), JSZip (CDN), Anthropic SDK (`@anthropic-ai/sdk`), Node.js built-in `https` module (for Render API call to persist env var).

---

## File Map

| File | Change |
|------|--------|
| `jedify-server.js` | Add in-memory brand template store + 3 new endpoints + install `@anthropic-ai/sdk` |
| `insight-loop-prototype.html` | Add "✦ Create Presentation" button, overlay shell, CSS, and JS functions |
| `package.json` | Add `@anthropic-ai/sdk` dependency |

---

## Task 1 — Install Anthropic SDK

**Files:**
- Modify: `package.json`
- Modify: `jedify-server.js` (top of file, after existing `require` lines)

- [ ] **Step 1: Install the SDK**

```bash
cd "C:/Users/aviav/OneDrive/Documents/Data Analysis/output"
npm install @anthropic-ai/sdk
```

Expected output: `added 1 package` (or similar). `package.json` will now have a `dependencies` section.

- [ ] **Step 2: Verify package.json was updated**

`package.json` should now include:
```json
"dependencies": {
  "@anthropic-ai/sdk": "^0.x.x"
}
```

- [ ] **Step 3: Add the require at the top of jedify-server.js**

Find these lines (around line 12):
```javascript
const fs = require('fs');
const path = require('path');
```

Add after them:
```javascript
const Anthropic = require('@anthropic-ai/sdk');
```

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/aviav/OneDrive/Documents/Data Analysis/output"
git add package.json package-lock.json jedify-server.js
git commit -m "feat: install @anthropic-ai/sdk for slide generation"
```

---

## Task 2 — Server: Brand Template In-Memory Store + `/api/get-template`

**Files:**
- Modify: `jedify-server.js`

The brand template is stored in the `BRAND_TEMPLATE` environment variable as a JSON string. On startup we read it into memory. `/api/get-template` returns it (or defaults if not set).

- [ ] **Step 1: Add in-memory store after the existing constants near the top of jedify-server.js**

Find this line (around line 20):
```javascript
const PORT = process.env.PORT || 3001;
```

Add after it:
```javascript
// ── Presentation Builder — Brand Template ────────────────────────────────────
const DEFAULT_BRAND_TEMPLATE = {
  primary:    '#1E2761',
  accent:     '#7C3AED',
  background: '#FFFFFF',
  highlight:  '#F59E0B',
  text:       '#1E293B',
  logoBase64: null,
  fontHeading: 'Calibri',
  fontBody:    'Calibri',
  uploadedAt:  null
};

let _brandTemplate = DEFAULT_BRAND_TEMPLATE;
try {
  if (process.env.BRAND_TEMPLATE) {
    _brandTemplate = { ...DEFAULT_BRAND_TEMPLATE, ...JSON.parse(process.env.BRAND_TEMPLATE) };
    console.log('[brand] Template loaded from env var');
  }
} catch (e) {
  console.warn('[brand] Failed to parse BRAND_TEMPLATE env var:', e.message);
}
```

- [ ] **Step 2: Add `/api/get-template` endpoint**

Find this line (around line 1615):
```javascript
  if (req.method === 'GET' && req.url === '/api/token-status') {
```

Add BEFORE it:
```javascript
  if (req.method === 'GET' && req.url === '/api/get-template') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(_brandTemplate));
    return;
  }
```

- [ ] **Step 3: Commit**

```bash
git add jedify-server.js
git commit -m "feat: add brand template in-memory store and /api/get-template"
```

---

## Task 3 — Server: `/api/upload-template`

**Files:**
- Modify: `jedify-server.js`

Accepts the extracted template JSON from the client, stores it in-memory immediately, and persists it to the `BRAND_TEMPLATE` Render env var via the Render API.

- [ ] **Step 1: Add `/api/upload-template` endpoint**

Add BEFORE the `/api/get-template` block added in Task 2:

```javascript
  if (req.method === 'POST' && req.url === '/api/upload-template') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const template = JSON.parse(body);
        // Validate required fields
        const required = ['primary','accent','background','highlight','text','fontHeading','fontBody'];
        for (const f of required) {
          if (!template[f]) throw new Error(`Missing field: ${f}`);
        }
        template.uploadedAt = new Date().toISOString();
        // Update in-memory immediately
        _brandTemplate = { ...DEFAULT_BRAND_TEMPLATE, ...template };
        console.log('[brand] Template updated in memory');

        // Persist to Render env var if configured
        const renderApiKey = process.env.RENDER_API_KEY;
        const renderServiceId = process.env.RENDER_SERVICE_ID;
        if (renderApiKey && renderServiceId) {
          try {
            await persistTemplateToRender(template, renderApiKey, renderServiceId);
            console.log('[brand] Template persisted to Render env var');
          } catch (e) {
            console.warn('[brand] Render persist failed (template still updated in memory):', e.message);
          }
        } else {
          console.warn('[brand] RENDER_API_KEY or RENDER_SERVICE_ID not set — template will reset on redeploy');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, uploadedAt: template.uploadedAt }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
```

- [ ] **Step 2: Add the `persistTemplateToRender` helper function**

Add this function near the top of the file, after the `_brandTemplate` initialisation block from Task 2:

```javascript
async function persistTemplateToRender(template, apiKey, serviceId) {
  const jsonStr = JSON.stringify(template);
  // Render API: PATCH /v1/services/{serviceId}/env-vars
  // Uses native https module (already available in Node)
  const https = require('https');
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify([
      { key: 'BRAND_TEMPLATE', value: jsonStr }
    ]);
    const options = {
      hostname: 'api.render.com',
      path: `/v1/services/${serviceId}/env-vars`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Render API returned ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add jedify-server.js
git commit -m "feat: add /api/upload-template with Render env var persistence"
```

---

## Task 4 — Server: `/api/generate-slides`

**Files:**
- Modify: `jedify-server.js`

Calls Claude Haiku with the selected check content + Story Brief. Returns a JSON array of slide objects.

- [ ] **Step 1: Add the Claude slide generation function**

Add this function after `persistTemplateToRender`:

```javascript
async function generateSlidesWithClaude(sections, brief, operator) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const toneDescriptions = {
    opportunity: 'Frame everything as an exciting opportunity with strong upside. Emphasise potential and growth levers.',
    risk:        'Frame as a risk management conversation. Be measured, flag concerns clearly, recommend protective actions.',
    growth:      'Celebrate momentum. Lead with positive trends. Frame actions as accelerating what is already working.',
    recovery:    'Acknowledge current challenges honestly. Focus on recovery plan and green shoots.'
  };
  const toneInstruction = toneDescriptions[brief.tone] || toneDescriptions.opportunity;

  const sectionContent = sections.map(s =>
    `=== ${s.checkName} ===\n${s.content}`
  ).join('\n\n');

  const systemPrompt = `You are an expert McKinsey-trained business storyteller. You create crisp SCR (Situation-Complication-Resolution) presentations for B2B client meetings.

CRITICAL: Return ONLY a valid JSON array. No markdown, no code fences, no explanation. Just the raw JSON array starting with [ and ending with ].`;

  const userPrompt = `Create a presentation for ${operator} using the SCR narrative structure.

## STORY BRIEF
${brief.angle ? `Angle: ${brief.angle}` : ''}
Tone: ${toneInstruction}
${brief.ask ? `The Ask: ${brief.ask}` : ''}

## ANALYSIS DATA
${sectionContent}

## REQUIRED OUTPUT FORMAT
Return a JSON array with exactly this structure (5-8 slides total):

[
  {
    "type": "title",
    "headline": "One powerful 6-8 word headline that captures the whole story",
    "subtitle": "Operator name and period, e.g. Codere MX — Q1 2026 QBR",
    "notes": "2-3 sentence talking track for presenter view. Welcome the audience, state the purpose of the meeting."
  },
  {
    "type": "situation",
    "title": "The Situation — what is the current state?",
    "bullets": ["Key fact 1", "Key fact 2", "Key fact 3"],
    "notes": "2-3 sentences. Set the scene. Establish what we know to be true."
  },
  {
    "type": "complication",
    "title": "The Complication — what is the tension?",
    "bullets": ["Point 1", "Point 2"],
    "dataPoint": "One bold stat that crystallises the complication, e.g. '12% market capture vs 31% competitor'",
    "notes": "2-3 sentences. This is the 'but'. Introduce the tension that demands action."
  },
  {
    "type": "supporting",
    "title": "Title of this supporting data slide",
    "bullets": ["Finding 1", "Finding 2", "Finding 3", "Finding 4"],
    "notes": "2-3 sentences. Explain what this data means and why it matters."
  },
  {
    "type": "resolution",
    "title": "The Resolution — what are the three moves?",
    "actions": [
      {"label": "Action 1 short label", "outcome": "The outcome this action produces"},
      {"label": "Action 2 short label", "outcome": "The outcome this action produces"},
      {"label": "Action 3 short label", "outcome": "The outcome this action produces"}
    ],
    "notes": "2-3 sentences. Walk through each action. Connect them back to the opportunity."
  },
  {
    "type": "ask",
    "cta": "${brief.ask || 'Clear, specific call to action for this meeting'}",
    "next_steps": ["Step 1 with owner and date", "Step 2 with owner and date", "Step 3 with owner and date"],
    "notes": "2-3 sentences. State the ask clearly. Explain what happens if they say yes today."
  }
]

Rules:
- Insert one "supporting" slide per major check section (between complication and resolution)
- Bullets: max 12 words each, no bullet symbols, just plain strings
- Headlines/titles: max 10 words, punchy, active voice
- All text must be derived from the analysis data provided
- Do not invent facts not in the data`;

  const message = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 4096,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt
  });

  const raw = message.content[0].text.trim();
  // Strip any accidental markdown code fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}
```

- [ ] **Step 2: Add `/api/generate-slides` endpoint**

Add BEFORE the `/api/get-template` block:

```javascript
  if (req.method === 'POST' && req.url === '/api/generate-slides') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        if (!process.env.ANTHROPIC_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY env var not set on server.' }));
          return;
        }
        const { sections, brief, operator } = JSON.parse(body);
        if (!sections || !sections.length) throw new Error('No sections provided');
        const slides = await generateSlidesWithClaude(sections, brief || {}, operator || 'Operator');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ slides }));
      } catch (e) {
        console.error('[generate-slides] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
```

- [ ] **Step 3: Commit**

```bash
git add jedify-server.js
git commit -m "feat: add /api/generate-slides with Claude Haiku SCR slide generation"
```

---

## Task 5 — Client: Overlay Shell + CSS + "✦ Create Presentation" Button

**Files:**
- Modify: `insight-loop-prototype.html`

Two changes: (A) Add the button to the download toolbar. (B) Add the overlay `<div>` and all CSS before `</body>`.

- [ ] **Step 1: Add the "✦ Create Presentation" button**

Find this exact block (around line 717):
```html
    <div id="download-btns" style="display:none;gap:8px;display:none">
      <button onclick="downloadAnalysisPDF()" style="padding:7px 14px;background:#1E2761;color:white;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer">⬇ PDF</button>
      <button onclick="downloadAnalysisWord()" style="padding:7px 14px;background:#1D6A39;color:white;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer">⬇ Word</button>
    </div>
```

Replace with:
```html
    <div id="download-btns" style="display:none;gap:8px;display:none">
      <button onclick="downloadAnalysisPDF()" style="padding:7px 14px;background:#1E2761;color:white;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer">⬇ PDF</button>
      <button onclick="downloadAnalysisWord()" style="padding:7px 14px;background:#1D6A39;color:white;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer">⬇ Word</button>
      <button onclick="openPresentationBuilder()" id="pptx-btn" style="padding:7px 14px;background:linear-gradient(135deg,#4A235A,#7C3AED);color:white;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px;">✦ Create Presentation</button>
    </div>
```

- [ ] **Step 2: Add the overlay HTML and CSS**

Find this closing tag near the end of the file:
```html
<div class="success-toast" id="toast"></div>
```

Add AFTER it:

```html
<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- PRESENTATION BUILDER OVERLAY                                    -->
<!-- ═══════════════════════════════════════════════════════════════ -->
<div id="pptx-overlay" style="display:none;position:fixed;top:0;right:0;bottom:0;width:min(700px,100vw);background:white;box-shadow:-4px 0 32px rgba(0,0,0,.18);z-index:9000;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .3s cubic-bezier(.4,0,.2,1);">
  <div style="background:linear-gradient(135deg,#1E2761,#4A235A);padding:18px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
    <div>
      <div style="color:white;font-size:16px;font-weight:800;">✦ Presentation Builder</div>
      <div id="pptx-step-label" style="color:#C7B3D4;font-size:11px;margin-top:2px;">Select sections to include</div>
    </div>
    <button onclick="closePresentationBuilder()" style="background:rgba(255,255,255,.15);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;">×</button>
  </div>

  <!-- Step indicator -->
  <div style="display:flex;background:#F8FAFC;border-bottom:1px solid #E2E8F0;flex-shrink:0;">
    <div class="pptx-step-dot" id="pptx-dot-1" style="flex:1;padding:10px;text-align:center;font-size:10px;font-weight:700;color:#1E2761;border-bottom:2px solid #7C3AED;">1 SECTIONS</div>
    <div class="pptx-step-dot" id="pptx-dot-2" style="flex:1;padding:10px;text-align:center;font-size:10px;font-weight:600;color:#94A3B8;border-bottom:2px solid transparent;">2 BRIEF</div>
    <div class="pptx-step-dot" id="pptx-dot-3" style="flex:1;padding:10px;text-align:center;font-size:10px;font-weight:600;color:#94A3B8;border-bottom:2px solid transparent;">3 PREVIEW</div>
  </div>

  <!-- Scrollable content area -->
  <div id="pptx-content" style="flex:1;overflow-y:auto;padding:20px 24px;"></div>

  <!-- Footer buttons -->
  <div id="pptx-footer" style="padding:16px 24px;background:white;border-top:1px solid #E2E8F0;display:flex;gap:10px;flex-shrink:0;"></div>
</div>

<!-- Dim backdrop -->
<div id="pptx-backdrop" onclick="closePresentationBuilder()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:8999;opacity:0;transition:opacity .3s;"></div>
```

- [ ] **Step 3: Add CSS for the overlay components**

Find the `<style>` block (it starts early in the file). Add these classes anywhere inside it:

```css
/* ── Presentation Builder ── */
#pptx-overlay.open { transform: translateX(0) !important; display: flex !important; }
#pptx-backdrop.open { display: block !important; opacity: 1 !important; }
.pptx-section-card { background: white; border: 1.5px solid #E2E8F0; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; display: flex; align-items: flex-start; gap: 12px; cursor: pointer; transition: border-color .15s; }
.pptx-section-card.selected { border-color: #7C3AED; background: #F5F3FF; }
.pptx-section-card:hover { border-color: #C4B5FD; }
.pptx-check-box { width: 20px; height: 20px; border-radius: 4px; border: 2px solid #CBD5E1; flex-shrink: 0; margin-top: 1px; display: flex; align-items: center; justify-content: center; font-size: 12px; transition: all .15s; }
.pptx-section-card.selected .pptx-check-box { background: #7C3AED; border-color: #7C3AED; color: white; }
.pptx-tone-pill { padding: 7px 14px; border-radius: 20px; border: 1.5px solid #E2E8F0; font-size: 12px; font-weight: 600; cursor: pointer; transition: all .15s; background: white; color: #475569; }
.pptx-tone-pill.active { border-color: #7C3AED; background: #7C3AED; color: white; }
.pptx-slide-thumb { flex: 0 0 80px; height: 54px; border-radius: 5px; cursor: pointer; border: 2px solid transparent; transition: border-color .15s; overflow: hidden; position: relative; }
.pptx-slide-thumb.active { border-color: #7C3AED; }
.pptx-slide-full { border-radius: 10px; overflow: hidden; min-height: 320px; box-shadow: 0 4px 24px rgba(0,0,0,.1); }
```

- [ ] **Step 4: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: add presentation builder overlay shell, CSS, and trigger button"
```

---

## Task 6 — Client: Section Picker (Step 1 of the builder)

**Files:**
- Modify: `insight-loop-prototype.html` (add JS functions in a new `<script>` block before `</body>`)

- [ ] **Step 1: Add the presentation builder JS block**

Find `</body>` at the very end of the file. Add BEFORE it:

```html
<script>
// ════════════════════════════════════════════════════════════════
// PRESENTATION BUILDER
// ════════════════════════════════════════════════════════════════

let _pptxTemplate = null;   // brand template from server
let _pptxSlides   = null;   // generated slide JSON
let _pptxSections = [];     // selected sections [{checkId, checkName, content}]
let _pptxBrief    = { angle: '', tone: 'opportunity', ask: '' };

// ── Open / Close ────────────────────────────────────────────────
async function openPresentationBuilder() {
  const overlay   = document.getElementById('pptx-overlay');
  const backdrop  = document.getElementById('pptx-backdrop');
  overlay.style.display   = 'flex';
  backdrop.style.display  = 'block';
  // Trigger CSS transition on next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.classList.add('open');
      backdrop.classList.add('open');
    });
  });
  // Load template from server
  try {
    const res = await apiFetch('/api/get-template');
    _pptxTemplate = await res.json();
  } catch (e) {
    _pptxTemplate = {
      primary:'#1E2761', accent:'#7C3AED', background:'#FFFFFF',
      highlight:'#F59E0B', text:'#1E293B', logoBase64:null,
      fontHeading:'Calibri', fontBody:'Calibri'
    };
  }
  _pptxShowStep(1);
  _pptxRenderSectionPicker();
}

function closePresentationBuilder() {
  const overlay  = document.getElementById('pptx-overlay');
  const backdrop = document.getElementById('pptx-backdrop');
  overlay.classList.remove('open');
  backdrop.classList.remove('open');
  setTimeout(() => {
    overlay.style.display  = 'none';
    backdrop.style.display = 'none';
  }, 300);
}

// ── Step indicator ──────────────────────────────────────────────
function _pptxShowStep(n) {
  const labels = ['', 'Select sections to include', 'Shape the story angle', 'Review and download'];
  document.getElementById('pptx-step-label').textContent = labels[n];
  [1,2,3].forEach(i => {
    const dot = document.getElementById(`pptx-dot-${i}`);
    dot.style.color        = i === n ? '#1E2761' : '#94A3B8';
    dot.style.fontWeight   = i === n ? '700' : '600';
    dot.style.borderBottom = i === n ? '2px solid #7C3AED' : '2px solid transparent';
  });
}

// ── Section Picker ──────────────────────────────────────────────
function _pptxRenderSectionPicker() {
  _pptxShowStep(1);
  const checkIds = window._currentRunCheckIds || [];
  // Map check IDs to names + content from rendered results
  const sections = checkIds.map(id => {
    const check = _checks.find(c => c.id === id);
    const name  = check ? check.name : id;
    // Grab rendered text from the check-results DOM card
    const card = document.querySelector(`[data-check-id="${id}"]`);
    const content = card ? (card.innerText || card.textContent || '') : '(no content available)';
    return { checkId: id, checkName: name, content: content.trim().slice(0, 4000), selected: true };
  });

  const content = document.getElementById('pptx-content');
  content.innerHTML = `
    <p style="font-size:12px;color:#64748B;margin-bottom:16px;">Select the check results to include in the presentation. Each ticked section becomes one or more slides.</p>
    <div id="pptx-section-list">
      ${sections.length === 0
        ? '<p style="color:#94A3B8;font-size:12px;">No analysis results available. Run an analysis first.</p>'
        : sections.map((s, i) => `
          <div class="pptx-section-card selected" data-idx="${i}" onclick="_pptxToggleSection(this,${i})">
            <div class="pptx-check-box">✓</div>
            <div>
              <div style="font-size:13px;font-weight:700;color:#1E2761;">${_pptxEsc(s.checkName)}</div>
              <div style="font-size:11px;color:#64748B;margin-top:2px;">${_pptxEsc(s.content.slice(0,100))}…</div>
            </div>
          </div>
        `).join('')}
    </div>
  `;
  // Store initial state
  _pptxSections = sections;

  const footer = document.getElementById('pptx-footer');
  footer.innerHTML = `
    <div style="flex:1;font-size:11px;color:#64748B;display:flex;align-items:center;">
      <span id="pptx-selected-count">${sections.length}</span> sections selected
    </div>
    <button onclick="_pptxGoToBrief()" style="padding:9px 20px;background:linear-gradient(135deg,#4A235A,#7C3AED);color:white;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">
      Next: Story Brief →
    </button>
  `;
}

function _pptxToggleSection(el, idx) {
  const isSelected = el.classList.toggle('selected');
  el.querySelector('.pptx-check-box').textContent = isSelected ? '✓' : '';
  _pptxSections[idx].selected = isSelected;
  const count = _pptxSections.filter(s => s.selected).length;
  const countEl = document.getElementById('pptx-selected-count');
  if (countEl) countEl.textContent = count;
}

function _pptxEsc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
```

- [ ] **Step 2: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: presentation builder section picker (Step 1)"
```

---

## Task 7 — Client: Story Brief (Step 2 of the builder)

**Files:**
- Modify: `insight-loop-prototype.html` (inside the `<script>` block added in Task 6)

- [ ] **Step 1: Add `_pptxGoToBrief()` and `_pptxRenderBrief()` functions**

Add inside the presentation builder `<script>` block (before the closing `</script>`):

```javascript
// ── Story Brief ─────────────────────────────────────────────────
function _pptxGoToBrief() {
  const selected = _pptxSections.filter(s => s.selected);
  if (selected.length === 0) {
    showToast('⚠️ Select at least one section', true);
    return;
  }
  _pptxRenderBrief();
}

function _pptxRenderBrief() {
  _pptxShowStep(2);
  const content = document.getElementById('pptx-content');
  const t = _pptxTemplate;
  const tones = [
    { id:'opportunity', label:'🚀 Opportunity' },
    { id:'risk',        label:'⚠️ Risk' },
    { id:'growth',      label:'📈 Growth Story' },
    { id:'recovery',    label:'🔄 Recovery' }
  ];
  content.innerHTML = `
    <p style="font-size:12px;color:#64748B;margin-bottom:20px;">
      Shape the story angle. All fields are optional — but even a brief angle makes the AI's narrative much sharper.
    </p>

    <div style="margin-bottom:18px;">
      <label style="font-size:11px;font-weight:700;color:#64748B;display:block;margin-bottom:6px;">STORY ANGLE (optional)</label>
      <textarea id="pptx-angle" rows="3" placeholder="e.g. Strong 14% growth but only 12% of market potential. Competitor PlayAGS is at 31%. Frame as an opportunity — we've proved the model, now we scale." style="width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid #E2E8F0;border-radius:8px;font-size:12px;font-family:inherit;resize:vertical;">${_pptxEsc(_pptxBrief.angle)}</textarea>
    </div>

    <div style="margin-bottom:18px;">
      <label style="font-size:11px;font-weight:700;color:#64748B;display:block;margin-bottom:8px;">TONE</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${tones.map(t => `
          <button class="pptx-tone-pill${_pptxBrief.tone===t.id?' active':''}" data-tone="${t.id}" onclick="_pptxSelectTone('${t.id}')">
            ${t.label}
          </button>
        `).join('')}
      </div>
    </div>

    <div style="margin-bottom:8px;">
      <label style="font-size:11px;font-weight:700;color:#64748B;display:block;margin-bottom:6px;">THE ASK — what do you need from this meeting?</label>
      <input id="pptx-ask" type="text" placeholder="e.g. Approve 3 studio launches this quarter" value="${_pptxEsc(_pptxBrief.ask)}" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid #E2E8F0;border-radius:8px;font-size:12px;font-family:inherit;">
    </div>
  `;

  const footer = document.getElementById('pptx-footer');
  footer.innerHTML = `
    <button onclick="_pptxRenderSectionPicker()" style="padding:9px 18px;background:#F1F5F9;color:#475569;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">← Back</button>
    <div style="flex:1"></div>
    <button onclick="_pptxGenerate()" style="padding:9px 20px;background:linear-gradient(135deg,#4A235A,#7C3AED);color:white;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">
      ✦ Generate Slides
    </button>
  `;
}

function _pptxSelectTone(toneId) {
  _pptxBrief.tone = toneId;
  document.querySelectorAll('.pptx-tone-pill').forEach(el => {
    el.classList.toggle('active', el.dataset.tone === toneId);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: presentation builder story brief UI (Step 2)"
```

---

## Task 8 — Client: Generate + Loading Spinner (Step 3 trigger)

**Files:**
- Modify: `insight-loop-prototype.html` (inside the presentation builder `<script>` block)

- [ ] **Step 1: Add `_pptxGenerate()` function**

Add inside the presentation builder `<script>` block:

```javascript
// ── Generate ─────────────────────────────────────────────────────
async function _pptxGenerate() {
  // Save brief state
  _pptxBrief.angle = (document.getElementById('pptx-angle')?.value || '').trim();
  _pptxBrief.ask   = (document.getElementById('pptx-ask')?.value || '').trim();

  const selected = _pptxSections.filter(s => s.selected);
  if (selected.length === 0) {
    showToast('⚠️ Select at least one section', true);
    return;
  }

  // Show spinner
  _pptxShowStep(3);
  const content = document.getElementById('pptx-content');
  content.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:300px;gap:20px;">
      <div style="width:48px;height:48px;border:4px solid #EDE9FE;border-top-color:#7C3AED;border-radius:50%;animation:spin 1s linear infinite;"></div>
      <div style="text-align:center;">
        <div style="font-size:14px;font-weight:700;color:#1E2761;">Building your story…</div>
        <div style="font-size:12px;color:#64748B;margin-top:4px;">Claude is mapping ${selected.length} sections to SCR slides (~5 seconds)</div>
      </div>
    </div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  `;
  document.getElementById('pptx-footer').innerHTML = '';

  try {
    const entity = document.getElementById('operator-select')?.value ||
                   document.querySelector('[id*="operator"]')?.value || 'Operator';
    const res = await apiFetch('/api/generate-slides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sections: selected.map(s => ({ checkId: s.checkId, checkName: s.checkName, content: s.content })),
        brief: _pptxBrief,
        operator: entity
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    _pptxSlides = data.slides;
    _pptxRenderPreview();
  } catch (e) {
    content.innerHTML = `
      <div style="text-align:center;padding:40px 20px;">
        <div style="font-size:32px;margin-bottom:12px;">❌</div>
        <div style="font-size:14px;font-weight:700;color:#DC2626;margin-bottom:8px;">Generation failed</div>
        <div style="font-size:12px;color:#64748B;margin-bottom:20px;">${_pptxEsc(e.message)}</div>
      </div>
    `;
    document.getElementById('pptx-footer').innerHTML = `
      <button onclick="_pptxRenderBrief()" style="padding:9px 18px;background:#F1F5F9;color:#475569;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">← Back to Brief</button>
    `;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: presentation builder generate call + loading spinner"
```

---

## Task 9 — Client: HTML Slide Preview (Step 3 display, all 6 slide types)

**Files:**
- Modify: `insight-loop-prototype.html` (inside the presentation builder `<script>` block)

- [ ] **Step 1: Add `_pptxRenderPreview()` and slide rendering functions**

Add inside the presentation builder `<script>` block:

```javascript
// ── HTML Preview ─────────────────────────────────────────────────
let _pptxActiveSlide = 0;

function _pptxRenderPreview() {
  _pptxShowStep(3);
  if (!_pptxSlides || !_pptxSlides.length) return;
  _pptxActiveSlide = 0;
  _pptxDrawPreview();
}

function _pptxDrawPreview() {
  const slides = _pptxSlides;
  const t = _pptxTemplate;
  const content = document.getElementById('pptx-content');

  // Thumbnail strip
  const thumbs = slides.map((s, i) => `
    <div class="pptx-slide-thumb${i===_pptxActiveSlide?' active':''}" onclick="_pptxSetSlide(${i})"
         style="background:${s.type==='title'||s.type==='ask'?t.primary:'white'};border-color:${i===_pptxActiveSlide?t.accent:'#E2E8F0'};">
      <div style="padding:6px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:2px;">
        <div style="height:4px;background:${s.type==='title'||s.type==='ask'?'rgba(255,255,255,.6)':t.primary};border-radius:2px;width:75%;"></div>
        <div style="height:3px;background:${s.type==='title'||s.type==='ask'?'rgba(255,255,255,.3)':'#CBD5E1'};border-radius:2px;width:90%;"></div>
        <div style="height:3px;background:${s.type==='title'||s.type==='ask'?'rgba(255,255,255,.3)':'#CBD5E1'};border-radius:2px;width:60%;"></div>
      </div>
    </div>
  `).join('');

  const activeSlide = slides[_pptxActiveSlide];
  const notes = activeSlide.notes || '';

  content.innerHTML = `
    <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:12px;margin-bottom:16px;">
      ${thumbs}
    </div>
    <div class="pptx-slide-full" style="background:${t.background};">
      ${_pptxRenderSlide(activeSlide, t)}
    </div>
    ${notes ? `
      <div style="margin-top:12px;background:#F8FAFC;border-radius:8px;padding:12px 14px;border-left:3px solid ${t.accent};">
        <div style="font-size:10px;font-weight:700;color:#64748B;margin-bottom:4px;">🎤 PRESENTER NOTES</div>
        <div style="font-size:12px;color:#475569;line-height:1.6;">${_pptxEsc(notes)}</div>
      </div>
    ` : ''}
    <div style="text-align:center;margin-top:8px;font-size:11px;color:#94A3B8;">
      Slide ${_pptxActiveSlide+1} of ${slides.length}
    </div>
  `;

  document.getElementById('pptx-footer').innerHTML = `
    <button onclick="_pptxRenderBrief()" style="padding:9px 18px;background:#F1F5F9;color:#475569;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">← Edit Brief</button>
    <div style="flex:1"></div>
    <button onclick="_pptxDownload()" style="padding:9px 20px;background:linear-gradient(135deg,#14532D,#16A34A);color:white;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">⬇ Download .pptx</button>
  `;
}

function _pptxSetSlide(idx) {
  _pptxActiveSlide = idx;
  _pptxDrawPreview();
}

// ── Slide Renderers (one per type) ───────────────────────────────
function _pptxRenderSlide(slide, t) {
  switch (slide.type) {
    case 'title':      return _pptxSlideTitle(slide, t);
    case 'situation':  return _pptxSlideSituation(slide, t);
    case 'complication': return _pptxSlideComplication(slide, t);
    case 'supporting': return _pptxSlideSupporting(slide, t);
    case 'resolution': return _pptxSlideResolution(slide, t);
    case 'ask':        return _pptxSlideAsk(slide, t);
    default:           return `<div style="padding:40px;color:#64748B;">[Unknown slide type: ${_pptxEsc(slide.type)}]</div>`;
  }
}

function _pptxSlideTitle(s, t) {
  const logo = t.logoBase64
    ? `<img src="${t.logoBase64}" style="height:36px;object-fit:contain;" alt="logo">`
    : `<div style="font-size:11px;font-weight:800;color:rgba(255,255,255,.7);letter-spacing:2px;">YOUR LOGO</div>`;
  return `
    <div style="background:${t.primary};padding:48px 40px;min-height:320px;display:flex;flex-direction:column;justify-content:space-between;">
      <div>${logo}</div>
      <div style="text-align:center;">
        <div style="font-size:22px;font-weight:800;color:white;line-height:1.3;margin-bottom:14px;">${_pptxEsc(s.headline||'')}</div>
        <div style="font-size:13px;color:rgba(255,255,255,.65);">${_pptxEsc(s.subtitle||'')}</div>
      </div>
      <div style="height:3px;background:${t.accent};border-radius:2px;margin-top:12px;"></div>
    </div>
  `;
}

function _pptxSlideSituation(s, t) {
  const bullets = (s.bullets || []).map(b =>
    `<li style="margin-bottom:8px;color:${t.text};font-size:13px;">${_pptxEsc(b)}</li>`
  ).join('');
  return `
    <div style="background:white;min-height:320px;">
      <div style="background:${t.primary};padding:14px 24px;">
        <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,.6);letter-spacing:1px;margin-bottom:2px;">THE SITUATION</div>
        <div style="font-size:16px;font-weight:800;color:white;">${_pptxEsc(s.title||'')}</div>
      </div>
      <div style="padding:24px;">
        <ul style="margin:0;padding-left:20px;line-height:1.7;">${bullets}</ul>
      </div>
    </div>
  `;
}

function _pptxSlideComplication(s, t) {
  const bullets = (s.bullets || []).map(b =>
    `<li style="margin-bottom:8px;color:${t.text};font-size:12px;">${_pptxEsc(b)}</li>`
  ).join('');
  return `
    <div style="background:white;min-height:320px;border-left:5px solid ${t.accent};">
      <div style="padding:20px 24px 12px;">
        <div style="font-size:11px;font-weight:700;color:${t.accent};letter-spacing:1px;margin-bottom:4px;">THE COMPLICATION</div>
        <div style="font-size:16px;font-weight:800;color:${t.text};margin-bottom:14px;">${_pptxEsc(s.title||'')}</div>
        ${s.dataPoint ? `
          <div style="background:${t.accent};color:white;padding:14px 18px;border-radius:8px;font-size:18px;font-weight:800;text-align:center;margin-bottom:18px;">${_pptxEsc(s.dataPoint)}</div>
        ` : ''}
        <ul style="margin:0;padding-left:20px;line-height:1.7;">${bullets}</ul>
      </div>
    </div>
  `;
}

function _pptxSlideSupporting(s, t) {
  const bullets = (s.bullets || []).map(b =>
    `<li style="margin-bottom:8px;color:${t.text};font-size:12px;padding-left:4px;">${_pptxEsc(b)}</li>`
  ).join('');
  return `
    <div style="background:white;min-height:320px;">
      <div style="background:${t.primary};padding:12px 24px;">
        <div style="font-size:15px;font-weight:800;color:white;">${_pptxEsc(s.title||'')}</div>
      </div>
      <div style="padding:20px 24px;">
        <ul style="margin:0;padding-left:16px;line-height:1.8;list-style:none;">
          ${(s.bullets||[]).map(b =>
            `<li style="margin-bottom:10px;color:${t.text};font-size:12px;display:flex;align-items:flex-start;gap:8px;">
              <span style="color:${t.accent};font-weight:800;flex-shrink:0;">▸</span>
              <span>${_pptxEsc(b)}</span>
             </li>`
          ).join('')}
        </ul>
      </div>
    </div>
  `;
}

function _pptxSlideResolution(s, t) {
  const actions = (s.actions || []).map((a, i) => `
    <div style="display:flex;gap:0;margin-bottom:10px;">
      <div style="background:${t.primary};color:white;padding:10px 14px;border-radius:6px 0 0 6px;font-size:12px;font-weight:700;min-width:140px;display:flex;align-items:center;">
        ${_pptxEsc(a.label||'')}
      </div>
      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-left:none;padding:10px 14px;border-radius:0 6px 6px 0;font-size:12px;color:${t.text};flex:1;display:flex;align-items:center;">
        ${_pptxEsc(a.outcome||'')}
      </div>
    </div>
  `).join('');
  return `
    <div style="background:white;min-height:320px;">
      <div style="background:${t.primary};padding:12px 24px;">
        <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,.6);letter-spacing:1px;margin-bottom:2px;">THE RESOLUTION</div>
        <div style="font-size:15px;font-weight:800;color:white;">${_pptxEsc(s.title||'Three moves to capture the opportunity')}</div>
      </div>
      <div style="padding:20px 24px;">${actions}</div>
    </div>
  `;
}

function _pptxSlideAsk(s, t) {
  const steps = (s.next_steps || []).map(step =>
    `<div style="font-size:12px;color:rgba(255,255,255,.85);margin-bottom:6px;padding-left:12px;border-left:2px solid ${t.accent};">${_pptxEsc(step)}</div>`
  ).join('');
  return `
    <div style="background:${t.primary};padding:40px;min-height:320px;display:flex;flex-direction:column;justify-content:center;gap:24px;">
      <div style="text-align:center;">
        <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,.5);letter-spacing:2px;margin-bottom:10px;">THE ASK</div>
        <div style="font-size:20px;font-weight:800;color:white;line-height:1.3;">${_pptxEsc(s.cta||'')}</div>
      </div>
      ${steps ? `
        <div>
          <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,.5);letter-spacing:1px;margin-bottom:10px;">NEXT STEPS</div>
          ${steps}
        </div>
      ` : ''}
    </div>
  `;
}
```

- [ ] **Step 2: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: presentation builder HTML preview with all 6 slide types"
```

---

## Task 10 — Client: PptxGenJS .pptx Download

**Files:**
- Modify: `insight-loop-prototype.html` (inside the presentation builder `<script>` block)

PptxGenJS loaded on demand (CDN). Generates a real Office Open XML `.pptx` file in the browser.

- [ ] **Step 1: Add `_pptxDownload()` and PptxGenJS slide builder**

Add inside the presentation builder `<script>` block:

```javascript
// ── .pptx Download ───────────────────────────────────────────────
async function _pptxDownload() {
  if (!_pptxSlides || !_pptxSlides.length) return;
  const btn = document.querySelector('#pptx-footer button:last-child');
  if (btn) { btn.textContent = '⏳ Building .pptx…'; btn.disabled = true; }

  // Load PptxGenJS on demand
  if (!window.PptxGenJS) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load PptxGenJS'));
      document.head.appendChild(s);
    });
  }

  try {
    const pptx = new window.PptxGenJS();
    pptx.layout  = 'LAYOUT_WIDE';  // 13.33" × 7.5"
    pptx.author  = 'Account Manager Copilot';
    pptx.company = 'RubyPlay';

    const t = _pptxTemplate;
    const entity = document.getElementById('operator-select')?.value || 'Operator';

    for (const slide of _pptxSlides) {
      _pptxBuildSlide(pptx, slide, t);
    }

    // Filename: {Entity}_QBR_{MonthYear}.pptx
    const now = new Date();
    const monthYear = now.toLocaleString('en-US', { month: 'short', year: 'numeric' }).replace(' ', '');
    const safeName = entity.replace(/[^a-zA-Z0-9_]/g, '_');
    const fileName = `${safeName}_QBR_${monthYear}.pptx`;

    await pptx.writeFile({ fileName });
    showToast(`📊 ${fileName} downloaded!`);
  } catch (e) {
    showToast('❌ .pptx export failed: ' + e.message, true);
  }

  if (btn) { btn.textContent = '⬇ Download .pptx'; btn.disabled = false; }
}

function _pptxBuildSlide(pptx, slide, t) {
  const s = pptx.addSlide();
  // Helper: colour without '#' for PptxGenJS
  const hex = c => c.replace('#','');

  switch (slide.type) {

    case 'title': {
      // Full bleed background
      s.addShape(pptx.ShapeType.rect, { x:0, y:0, w:'100%', h:'100%', fill:{color: hex(t.primary)} });
      // Accent bar at bottom
      s.addShape(pptx.ShapeType.rect, { x:0, y:6.9, w:'100%', h:0.1, fill:{color: hex(t.accent)} });
      // Logo or placeholder
      if (t.logoBase64) {
        s.addImage({ data: t.logoBase64, x:0.4, y:0.3, h:0.5, w:1.5, sizing:{type:'contain',w:1.5,h:0.5} });
      } else {
        s.addText('YOUR LOGO', { x:0.4, y:0.25, w:2, h:0.5, fontSize:9, bold:true, color:'FFFFFF', valign:'middle', align:'left' });
      }
      s.addText(slide.headline || '', {
        x:1, y:2.5, w:11.3, h:1.5, fontSize:28, bold:true, color:'FFFFFF', align:'center', valign:'middle',
        fontFace: t.fontHeading, wrap:true
      });
      s.addText(slide.subtitle || '', {
        x:1, y:4.2, w:11.3, h:0.5, fontSize:13, color:'AAAACC', align:'center',
        fontFace: t.fontBody
      });
      if (slide.notes) s.addNotes(slide.notes);
      break;
    }

    case 'situation': {
      s.addShape(pptx.ShapeType.rect, { x:0, y:0, w:'100%', h:1.1, fill:{color: hex(t.primary)} });
      s.addText('THE SITUATION', { x:0.4, y:0.08, w:12, h:0.3, fontSize:8, bold:true, color:'AAAACC' });
      s.addText(slide.title || '', { x:0.4, y:0.35, w:12, h:0.65, fontSize:18, bold:true, color:'FFFFFF', fontFace:t.fontHeading, wrap:true });
      const bullets = (slide.bullets || []).map(b => ({ text: b, options:{fontSize:13, color:hex(t.text), paraSpaceBefore:4} }));
      if (bullets.length) {
        s.addText(bullets, { x:0.6, y:1.3, w:12, h:5.5, bullet:true, fontFace:t.fontBody, valign:'top' });
      }
      if (slide.notes) s.addNotes(slide.notes);
      break;
    }

    case 'complication': {
      s.addShape(pptx.ShapeType.rect, { x:0, y:0, w:0.1, h:'100%', fill:{color: hex(t.accent)} });
      s.addText('THE COMPLICATION', { x:0.3, y:0.25, w:12, h:0.3, fontSize:8, bold:true, color:hex(t.accent) });
      s.addText(slide.title || '', { x:0.3, y:0.55, w:12, h:0.8, fontSize:18, bold:true, color:hex(t.text), fontFace:t.fontHeading, wrap:true });
      if (slide.dataPoint) {
        s.addShape(pptx.ShapeType.rect, { x:0.5, y:1.5, w:12.3, h:0.9, fill:{color:hex(t.accent)}, rounding:true });
        s.addText(slide.dataPoint, { x:0.5, y:1.5, w:12.3, h:0.9, fontSize:18, bold:true, color:'FFFFFF', align:'center', valign:'middle', fontFace:t.fontHeading });
      }
      const startY = slide.dataPoint ? 2.55 : 1.5;
      const bullets = (slide.bullets || []).map(b => ({ text: b, options:{fontSize:12, color:hex(t.text), paraSpaceBefore:4} }));
      if (bullets.length) {
        s.addText(bullets, { x:0.6, y:startY, w:12, h:4.5, bullet:true, fontFace:t.fontBody, valign:'top' });
      }
      if (slide.notes) s.addNotes(slide.notes);
      break;
    }

    case 'supporting': {
      s.addShape(pptx.ShapeType.rect, { x:0, y:0, w:'100%', h:0.9, fill:{color: hex(t.primary)} });
      s.addText(slide.title || '', { x:0.4, y:0.08, w:12.5, h:0.75, fontSize:16, bold:true, color:'FFFFFF', fontFace:t.fontHeading, valign:'middle' });
      const bullets = (slide.bullets || []).map(b => ({ text: b, options:{fontSize:12, color:hex(t.text), paraSpaceBefore:6} }));
      if (bullets.length) {
        s.addText(bullets, { x:0.6, y:1.1, w:12, h:5.8, bullet:{type:'bullet', code:'25B8', color:hex(t.accent)}, fontFace:t.fontBody, valign:'top' });
      }
      if (slide.notes) s.addNotes(slide.notes);
      break;
    }

    case 'resolution': {
      s.addShape(pptx.ShapeType.rect, { x:0, y:0, w:'100%', h:0.9, fill:{color: hex(t.primary)} });
      s.addText('THE RESOLUTION', { x:0.4, y:0.04, w:12, h:0.25, fontSize:8, bold:true, color:'AAAACC' });
      s.addText(slide.title || 'Three moves to capture the opportunity', {
        x:0.4, y:0.28, w:12.5, h:0.6, fontSize:15, bold:true, color:'FFFFFF', fontFace:t.fontHeading, valign:'middle'
      });
      const actions = slide.actions || [];
      actions.forEach((a, i) => {
        const yPos = 1.1 + i * 1.5;
        s.addShape(pptx.ShapeType.rect, { x:0.4, y:yPos, w:3.5, h:1.3, fill:{color:hex(t.primary)}, rounding:false });
        s.addShape(pptx.ShapeType.rect, { x:3.9, y:yPos, w:9.5, h:1.3, fill:{color:'F8FAFC'}, line:{color:'E2E8F0',width:1} });
        s.addText(a.label || '', { x:0.4, y:yPos, w:3.5, h:1.3, fontSize:12, bold:true, color:'FFFFFF', align:'center', valign:'middle', fontFace:t.fontHeading });
        s.addText(a.outcome || '', { x:4.0, y:yPos, w:9.3, h:1.3, fontSize:12, color:hex(t.text), valign:'middle', fontFace:t.fontBody, wrap:true });
      });
      if (slide.notes) s.addNotes(slide.notes);
      break;
    }

    case 'ask': {
      s.addShape(pptx.ShapeType.rect, { x:0, y:0, w:'100%', h:'100%', fill:{color:hex(t.primary)} });
      s.addText('THE ASK', { x:1, y:0.6, w:11.3, h:0.4, fontSize:9, bold:true, color:'AAAACC', align:'center' });
      s.addText(slide.cta || '', {
        x:0.8, y:1.1, w:11.7, h:2, fontSize:24, bold:true, color:'FFFFFF', align:'center', valign:'middle',
        fontFace:t.fontHeading, wrap:true
      });
      const steps = slide.next_steps || [];
      if (steps.length) {
        s.addText('NEXT STEPS', { x:1.5, y:3.4, w:10, h:0.3, fontSize:8, bold:true, color:'AAAACC' });
        steps.forEach((step, i) => {
          const yPos = 3.8 + i * 0.7;
          s.addShape(pptx.ShapeType.rect, { x:1.5, y:yPos, w:0.05, h:0.5, fill:{color:hex(t.accent)} });
          s.addText(step, { x:1.7, y:yPos, w:10, h:0.5, fontSize:11, color:'DDDDEE', valign:'middle', fontFace:t.fontBody });
        });
      }
      if (slide.notes) s.addNotes(slide.notes);
      break;
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: PptxGenJS .pptx download with all 6 slide types"
```

---

## Task 11 — Client: Brand Template Upload UI in Config

**Files:**
- Modify: `insight-loop-prototype.html`

Add a "Brand Template" section at the bottom of the `#config-panel` div. Uses JSZip (CDN) to parse the uploaded .pptx in the browser, extracts colours + logo, shows editable preview, POSTs to `/api/upload-template`.

- [ ] **Step 1: Add the Brand Template section to the config panel**

Find this exact closing tag (around line 708, end of config-panel):
```html
    </div>
  </div>


</div>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- CHECK RESULTS (replaces old ReAct Loop)                        -->
```

Replace the `</div>\n\n\n</div>` portion (the two closing divs before the comment) with:

```html
    </div>
  </div>

  <!-- BRAND TEMPLATE UPLOAD -->
  <h3 style="font-size:14px;font-weight:800;color:#1E2761;margin:28px 0 12px;display:flex;align-items:center;gap:8px;">
    🎨 Brand Template <span style="font-size:11px;color:#64748B;font-weight:400;">— upload once, applied to all presentations</span>
  </h3>
  <div style="background:white;border-radius:12px;border:1.5px solid #E0E8F0;padding:20px 24px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,.06);">
    <p style="font-size:12px;color:#64748B;line-height:1.6;margin-bottom:16px;">
      Upload one empty branded .pptx slide. We extract your logo, colours, and fonts automatically. Saved to the server — shared across all team members.
    </p>
    <div id="brand-upload-zone" onclick="document.getElementById('brand-file-input').click()"
         style="border:2px dashed #CBD5E1;border-radius:8px;padding:24px;text-align:center;background:#F8FAFC;cursor:pointer;transition:border-color .15s;"
         ondragover="event.preventDefault();this.style.borderColor='#7C3AED'"
         ondragleave="this.style.borderColor='#CBD5E1'"
         ondrop="_pptxHandleDrop(event)">
      <div style="font-size:28px;margin-bottom:8px;">📎</div>
      <div style="font-size:13px;font-weight:600;color:#1E2761;">Drop your .pptx template here</div>
      <div style="font-size:11px;color:#94A3B8;margin-top:4px;">One slide with your logo and brand colours · .pptx files only</div>
      <div style="margin-top:12px;display:inline-block;padding:6px 16px;background:#1E2761;color:white;border-radius:6px;font-size:12px;font-weight:600;">Choose file</div>
      <input type="file" id="brand-file-input" accept=".pptx" style="display:none;" onchange="_pptxHandleFile(this.files[0])">
    </div>

    <div id="brand-preview" style="display:none;margin-top:16px;">
      <div style="font-size:11px;font-weight:700;color:#64748B;margin-bottom:10px;">EXTRACTED BRAND ASSETS — click swatches to adjust</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;margin-bottom:16px;">
        <div id="brand-logo-preview" style="flex:0 0 auto;"></div>
        <div style="flex:1;min-width:200px;">
          <div style="font-size:10px;font-weight:700;color:#64748B;margin-bottom:8px;">COLOURS</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;" id="brand-swatches"></div>
          <div style="margin-top:10px;">
            <div style="font-size:10px;font-weight:700;color:#64748B;margin-bottom:4px;">FONTS</div>
            <div id="brand-fonts" style="font-size:12px;color:#1E2761;"></div>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        <button onclick="_pptxSaveTemplate()" style="padding:8px 18px;background:linear-gradient(135deg,#1E2761,#4A235A);color:white;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">💾 Save Template</button>
        <button onclick="_pptxClearTemplate()" style="padding:8px 14px;background:#F1F5F9;color:#64748B;border:none;border-radius:8px;font-size:12px;cursor:pointer;">Clear</button>
        <span id="brand-save-msg" style="font-size:11px;color:#16A34A;display:none;align-self:center;">✓ Saved</span>
        <span id="brand-save-err" style="font-size:11px;color:#DC2626;display:none;align-self:center;"></span>
      </div>
    </div>

    <div id="brand-current" style="margin-top:14px;padding:10px 14px;background:#F0F9FF;border-radius:6px;border-left:3px solid #0EA5E9;font-size:11px;color:#0C4A6E;display:none;">
      ✓ Template active — last uploaded <span id="brand-uploaded-at"></span>
    </div>
  </div>

</div>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- CHECK RESULTS (replaces old ReAct Loop)                        -->
```

- [ ] **Step 2: Add brand template JS functions inside the presentation builder script block**

Add inside the presentation builder `<script>` block:

```javascript
// ── Brand Template Upload ────────────────────────────────────────
let _pptxExtracted = null;  // extracted template data before save

function _pptxHandleDrop(event) {
  event.preventDefault();
  document.getElementById('brand-upload-zone').style.borderColor = '#CBD5E1';
  const file = event.dataTransfer.files[0];
  if (file) _pptxHandleFile(file);
}

async function _pptxHandleFile(file) {
  if (!file || !file.name.endsWith('.pptx')) {
    showToast('⚠️ Please upload a .pptx file', true);
    return;
  }
  // Load JSZip on demand
  if (!window.JSZip) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load JSZip'));
      document.head.appendChild(s);
    });
  }
  try {
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);

    // ── 1. Extract colours from theme1.xml ──
    let primary='#1E2761', accent='#7C3AED', background='#FFFFFF', highlight='#F59E0B', text='#1E293B';
    const themeFile = zip.file('ppt/theme/theme1.xml') ||
                      zip.file(Object.keys(zip.files).find(k => k.match(/ppt\/theme\/theme\d+\.xml/)) || '');
    if (themeFile) {
      const xml = await themeFile.async('text');
      // Extract dk1, dk2, lt1, lt2, accent1, accent2 from <a:srgbClr val="...">
      const colorsFromScheme = (tagName) => {
        const re = new RegExp(`<a:${tagName}[^>]*>[\\s\\S]*?<a:srgbClr val="([A-Fa-f0-9]{6})"`, 'i');
        const m = xml.match(re);
        return m ? '#' + m[1] : null;
      };
      // Simpler: grab all hex colours in order
      const allHex = [...xml.matchAll(/val="([A-Fa-f0-9]{6})"/g)].map(m => '#' + m[1]);
      if (allHex[0]) primary    = allHex[0];
      if (allHex[1]) text       = allHex[1];
      if (allHex[2]) background = allHex[2];
      if (allHex[4]) accent     = allHex[4];
      if (allHex[6]) highlight  = allHex[6];
    }

    // ── 2. Extract fonts from slideMaster1.xml ──
    let fontHeading = 'Calibri', fontBody = 'Calibri';
    const masterFile = zip.file('ppt/slideMasters/slideMaster1.xml') ||
                       zip.file(Object.keys(zip.files).find(k => k.match(/ppt\/slideMasters\/slideMaster\d+\.xml/)) || '');
    if (masterFile) {
      const xml = await masterFile.async('text');
      const latinMatches = [...xml.matchAll(/latin typeface="([^"]+)"/g)];
      if (latinMatches[0]) fontHeading = latinMatches[0][1];
      if (latinMatches[1]) fontBody    = latinMatches[1][1];
    }

    // ── 3. Extract logo (largest image in ppt/media/) ──
    let logoBase64 = null;
    const mediaFiles = Object.entries(zip.files).filter(([k]) => k.startsWith('ppt/media/') && !zip.files[k].dir);
    if (mediaFiles.length) {
      // Sort by file size descending, take the largest
      const withSizes = await Promise.all(mediaFiles.map(async ([k, f]) => {
        const data = await f.async('uint8array');
        return { key: k, data, size: data.length };
      }));
      withSizes.sort((a, b) => b.size - a.size);
      const largest = withSizes[0];
      const ext = largest.key.split('.').pop().toLowerCase();
      const mimeMap = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', svg:'image/svg+xml', emf:'image/x-emf' };
      const mime = mimeMap[ext] || 'image/png';
      const b64 = btoa(String.fromCharCode(...largest.data));
      logoBase64 = `data:${mime};base64,${b64}`;
    }

    _pptxExtracted = { primary, accent, background, highlight, text, logoBase64, fontHeading, fontBody };
    _pptxShowExtracted(_pptxExtracted);
  } catch (e) {
    showToast('❌ Could not parse .pptx: ' + e.message, true);
  }
}

function _pptxShowExtracted(data) {
  document.getElementById('brand-preview').style.display = 'block';

  // Logo
  const logoEl = document.getElementById('brand-logo-preview');
  if (data.logoBase64) {
    logoEl.innerHTML = `
      <div style="font-size:10px;font-weight:700;color:#64748B;margin-bottom:6px;">LOGO</div>
      <img src="${data.logoBase64}" style="height:60px;max-width:120px;object-fit:contain;border-radius:6px;border:1px solid #E2E8F0;" alt="logo">
    `;
  } else {
    logoEl.innerHTML = '<div style="font-size:11px;color:#94A3B8;margin-top:10px;">No image found in template</div>';
  }

  // Colour swatches
  const fields = [
    { key:'primary', label:'Primary' },
    { key:'accent', label:'Accent' },
    { key:'background', label:'Background' },
    { key:'highlight', label:'Highlight' },
    { key:'text', label:'Text' }
  ];
  document.getElementById('brand-swatches').innerHTML = fields.map(f => `
    <div style="text-align:center;">
      <div style="width:40px;height:40px;border-radius:6px;background:${data[f.key]};border:2px solid #E2E8F0;cursor:pointer;position:relative;"
           onclick="document.getElementById('swatch-input-${f.key}').click()">
        <input type="color" id="swatch-input-${f.key}" value="${data[f.key]}"
               style="position:absolute;opacity:0;width:100%;height:100%;cursor:pointer;"
               oninput="_pptxUpdateSwatch('${f.key}',this.value)">
      </div>
      <div style="font-size:9px;color:#64748B;margin-top:3px;">${f.label}</div>
    </div>
  `).join('');

  // Fonts
  document.getElementById('brand-fonts').innerHTML =
    `<span style="background:#F1F5F9;padding:3px 10px;border-radius:4px;margin-right:6px;">${_pptxEsc(data.fontHeading)} — Headings</span>` +
    `<span style="background:#F1F5F9;padding:3px 10px;border-radius:4px;">${_pptxEsc(data.fontBody)} — Body</span>`;
}

function _pptxUpdateSwatch(field, value) {
  if (_pptxExtracted) _pptxExtracted[field] = value;
  // Update swatch background visually
  const input = document.getElementById(`swatch-input-${field}`);
  if (input && input.parentElement) input.parentElement.style.background = value;
}

async function _pptxSaveTemplate() {
  if (!_pptxExtracted) return;
  const msg = document.getElementById('brand-save-msg');
  const err = document.getElementById('brand-save-err');
  msg.style.display = 'none';
  err.style.display = 'none';
  try {
    const res = await apiFetch('/api/upload-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_pptxExtracted)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    _pptxTemplate = { ..._pptxExtracted, uploadedAt: data.uploadedAt };
    msg.style.display = 'inline';
    setTimeout(() => { msg.style.display = 'none'; }, 3000);
    showToast('🎨 Brand template saved!');
    _pptxShowCurrentTemplate(data.uploadedAt);
  } catch (e) {
    err.textContent = '❌ ' + e.message;
    err.style.display = 'inline';
  }
}

function _pptxClearTemplate() {
  _pptxExtracted = null;
  document.getElementById('brand-preview').style.display = 'none';
  document.getElementById('brand-file-input').value = '';
}

function _pptxShowCurrentTemplate(uploadedAt) {
  const el = document.getElementById('brand-current');
  const dateEl = document.getElementById('brand-uploaded-at');
  if (!el) return;
  el.style.display = 'block';
  if (dateEl && uploadedAt) {
    try {
      dateEl.textContent = new Date(uploadedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
    } catch(e) { dateEl.textContent = uploadedAt; }
  }
}

// Show current template status on page load
(async () => {
  try {
    const res = await apiFetch('/api/get-template');
    const data = await res.json();
    if (data.uploadedAt) _pptxShowCurrentTemplate(data.uploadedAt);
  } catch(e) { /* ignore */ }
})();
```

- [ ] **Step 3: Commit**

```bash
git add insight-loop-prototype.html
git commit -m "feat: brand template upload UI with JSZip extraction"
```

---

## Task 12 — Push and Deploy

- [ ] **Step 1: Push to GitHub**

```bash
cd "C:/Users/aviav/OneDrive/Documents/Data Analysis/output"
git push origin main
```

Note the commit hash from `git log --oneline -1`.

- [ ] **Step 2: Add `ANTHROPIC_API_KEY` env var on Render**

In the Render dashboard → your service → Environment:
- Add `ANTHROPIC_API_KEY` = (your Anthropic API key)
- Add `RENDER_API_KEY` = (your Render API key, for template persistence — optional)
- Add `RENDER_SERVICE_ID` = (your Render service ID — optional)

- [ ] **Step 3: Deploy on Render**

In Render dashboard → Manual Deploy. Wait for deploy to complete (~60s).

- [ ] **Step 4: Smoke test**

1. Open the tool → run any analysis
2. When results appear, confirm "✦ Create Presentation" button is visible alongside PDF/Word
3. Click it → panel slides in from right
4. Section Picker shows the checks that ran — all ticked by default
5. Untick one check → "2 sections selected" updates
6. Click "Next: Story Brief" → Step 2 appears
7. Type an angle, pick 🚀 Opportunity tone, type an Ask
8. Click "✦ Generate Slides" → spinner appears → slides appear after ~5s
9. Thumbnail strip shows 5-7 slide thumbnails, active slide renders below
10. Click a different thumbnail → slide changes
11. Presenter notes appear below active slide
12. Click "⬇ Download .pptx" → file downloads as `{Operator}_QBR_{MonthYear}.pptx`
13. Open in PowerPoint — confirm all slides render with correct layout
14. Go to Research Config → scroll to bottom → Brand Template section visible
15. Upload a branded .pptx → colours and logo extracted → swatches shown
16. Click a swatch → colour picker opens → colour updates
17. Click Save Template → "✓ Saved" appears
18. Run presentation builder again → new brand colours applied in preview and .pptx

- [ ] **Step 5: Final commit (if any hotfixes were needed during smoke test)**

```bash
git add -p
git commit -m "fix: presentation builder smoke test fixes"
git push origin main
```

---

## Spec Coverage Check

| Spec requirement | Task |
|-----------------|------|
| "✦ Create Presentation" button in output toolbar | Task 5 |
| Panel slides in from right, full-height overlay | Task 5 |
| Section picker — one card per check, all ticked by default | Task 6 |
| `window._currentRunCheckIds` to identify checks | Task 6 |
| Story Brief: angle + tone pill + The Ask | Task 7 |
| Angle/tone/ask concatenated into Claude prompt framing | Task 4 |
| `/api/generate-slides` with Haiku, structured JSON, notes field | Task 4 |
| Brand colours NOT sent to server — applied client-side | Tasks 9–10 |
| HTML preview: thumbnail strip + active slide + back + download | Task 9 |
| "← Edit Brief" returns to Step 3 pre-populated | Task 8 |
| PptxGenJS CDN, loaded on demand | Task 10 |
| All 6 slide types: title/situation/complication/supporting/resolution/ask | Tasks 9 & 10 |
| Filename: `{OperatorName}_QBR_{MonthYear}.pptx` | Task 10 |
| Brand template upload → JSZip → colour + logo + font extraction | Task 11 |
| Editable colour swatches before saving | Task 11 |
| Server-side template storage in `BRAND_TEMPLATE` env var | Tasks 2 & 3 |
| `RENDER_API_KEY` + `RENDER_SERVICE_ID` for persistence | Task 3 |
| Default colour scheme when no template uploaded | Task 2 |
| `/api/get-template`, `/api/upload-template`, `/api/generate-slides` | Tasks 2–4 |
| Presenter notes on every slide (Presenter View) | Tasks 4, 9 |
| No changes to analysis pipeline | All tasks — server routes added, nothing touched |
