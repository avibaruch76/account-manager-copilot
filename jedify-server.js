#!/usr/bin/env node
/**
 * jedify-server.js
 * HTTP server that connects to Jedify MCP and runs real SQL queries.
 * Used by insight-loop-prototype.html for live analysis.
 *
 * Local:  node jedify-server.js
 * Cloud:  Set JEDIFY_REFRESH_TOKEN env var, deploy to Render/etc.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const jedify = require('./jedify-direct');
const { jsonrepair } = require('jsonrepair');

const PORT = process.env.PORT || 3001;

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
      { title: 'Studio Summary Table',description: 'Table with EXACTLY these 6 columns in this order: Studio | Games Released | Total Bets (€) | Bet Share % | Total GGR (€) | Bets per Game (€). Include ALL studios present in the data — do not filter or drop any. Bet Share % values across all rows MUST sum to ~100%. Sort by Total Bets desc. Do not add or rename columns.' },
      { title: 'New Games Launched',  description: 'Table: Game | Studio | RTP | Total Bets 14d | Players 14d. Sort by Total Bets desc.' },
      { title: 'Retention Analysis',  description: 'SVG line chart. X axis: D1, D2, D4, D5, D7, D14, D30, D60 (day-cohort retention milestones). Y axis: Retention % (0–100%). One line per entity in the data — the operator\'s own line is highlighted (thicker, brand primary color #CC0000), competitor lines are thinner in distinct muted colors, each labeled at line end. If competitor benchmark data exists in the analysis, show all lines with a legend. If no competitor data is available, show only the operator line and add a note "No competitor benchmark available for this market." Below the chart: 2–3 sentence insight on where retention is strongest or weakest vs benchmarks (or vs expected industry norms if no competitors shown).' },
      { title: 'Player Segmentation', description: 'Two side-by-side SVG stacked bar charts covering all available months. LEFT chart: Y axis = total active players (count), each bar stacked by segment. RIGHT chart: Y axis = % share (each bar = 100%), same segments. Segments to use from the data — if pre-defined segments exist use them; if not, derive: New Players (first active month), Returning (active last month too), Reactivated (returning after 1+ month gap), High Value (top 10% by bets). New Players segment MUST always appear. Each segment gets a distinct color; shared legend below both charts. Charts should be wide — each taking ~45% of slide width. Below charts: 2–3 sentence insight answering: Is the new player share growing or shrinking? Which segment is driving total volume? Flag if any month shows a sharp drop in returning players as a retention warning.' },
      { title: 'VIP Analysis',        description: 'ALWAYS write one of these two sentences first: either "VIP player segmentation data is available" or "No VIP player segmentation data available for this operator." REGARDLESS of whether VIP data exists, ALWAYS show a table of the top 10 players by total bets or GGR — label the table "Top 10 Players (all segments)" if no VIP breakdown is available. Never leave this slide empty. If no VIP data: add a prominent action item recommending VIP tagging be implemented.' },
      { title: 'Max Bet Analysis',    description: 'Three-part layout. TOP: SVG line chart — X axis = months, Y axis = max bet player count. One line per entity (operator + competitors in same market). Highlights whether the operator\'s max bet player base is growing, shrinking, or lagging behind market. If no competitor data, show operator line only with note. MIDDLE: Dual-axis SVG bar+line chart — bars = max bet player count per month (left Y axis), line = GGR (€) per month (right Y axis). Visually shows whether changes in max bet player volume drive GGR movement. BOTTOM: Two stat cards — (1) Max bet players as % of total active players, (2) GGR contribution from max bet players as % of total GGR. Then 2–3 sentence insight: are max bet players punching above their weight in GGR? Is the count trending in the right direction vs competitors?' },
      { title: 'Promotion Analysis',  description: 'Two-part layout. TOP: Dual-axis SVG line chart over all available months — LEFT Y axis = free rounds granted (count or value €), RIGHT Y axis = GGR (€). Two lines plotted together so spikes in free rounds can be visually correlated with GGR movement. Highlight months where free rounds were significantly above average. BOTTOM: Two-column insight panel. LEFT: correlation summary — did GGR rise in the month following high free-round months? Show avg GGR in high-promo months vs low-promo months as two stat cards. RIGHT: 3–4 bullet conclusions: is the promotion driving incremental GGR or just subsidising existing play? Are free rounds concentrated on a few games or spread across the portfolio? Recommendation on whether to increase, maintain, or redirect promo spend.' },
      { title: 'The Portfolio Gap',   description: 'Table: Game | Key Fact | Market Rank | Market Share % | Signal badge. Max 8 rows.' },
      { title: 'Growth Levers',       description: 'Table: Game | Key Fact | Players | GGR/Player | Total GGR | Opportunity | ADD/EXPAND pill. Sort by Opportunity desc.' },
      { title: 'KPI Gaps',            description: 'Three sections stacked vertically. TOP: Two-column layout — LEFT (65%): table with KPI | Our Value | Market Benchmark (Range) | Gap | Trend. Gap column uses colored status pills: "ABOVE AVERAGE – 2ND BEST" (green fill), "MIDDLE OF RANGE" (grey fill), "BELOW LEADERS — 47% GAP" (red fill). Trend arrows green up or red right. RIGHT (35%): "Root Causes" header, 3 bullet points with colored dots explaining root causes, then a highlighted box "The Fix Is Clear" with 2-3 sentences on the fix. MIDDLE: SVG horizontal bar chart for the single biggest gap KPI — two bars (Our Value vs Market Leader), labeled, different colors. BOTTOM: Row of 4 summary score cards, one per KPI. Each card: metric label in small caps, large bold gap % (red if negative, green if positive), short "Fix:" or "✓" note. Positive outlier card gets green border.' },
      { title: 'Actions & Priorities',description: 'Up to 5 numbered action cards in a 2-column CSS grid (last card spans full width if count is odd). Each card: circular red number badge, bold title, priority pill (CRITICAL/URGENT/HIGH/MEDIUM/MONITOR), 2-3 sentence rationale, optional expected outcome line in red italic. Dark card background (#1A1A1A), red left border accent on the #1 action. Cards must NOT be in a single horizontal row.' },
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

const TEMPLATES_FILE = path.join(__dirname, 'templates.json');

function loadTemplates() {
  try {
    let saved = [];
    if (process.env.TEMPLATES_JSON) {
      saved = JSON.parse(process.env.TEMPLATES_JSON);
    } else if (fs.existsSync(TEMPLATES_FILE)) {
      saved = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
    }
    const hasDefault = saved.some(t => t.id === 'default');
    _templates = hasDefault ? saved : [buildDefaultTemplate(), ...saved];
  } catch {
    _templates = [buildDefaultTemplate()];
  }
}

async function updateRenderEnvVar(key, value) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify([
      { key, value }
    ]);
    const options = {
      hostname: 'api.render.com',
      path: `/v1/services/${process.env.RENDER_SERVICE_ID}/env-vars`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RENDER_API_KEY}`,
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

async function persistTemplates() {
  const stripped = _templates.map(t => ({ ...t, brand: { ...t.brand, logoBase64: null } }));
  const json = JSON.stringify(stripped);
  console.log(`[templates] Persisting ${_templates.length} templates (${json.length} chars)`);
  if (!process.env.RENDER_API_KEY || !process.env.RENDER_SERVICE_ID) {
    try {
      fs.writeFileSync(TEMPLATES_FILE, json, 'utf8');
      console.log(`[templates] Saved to ${TEMPLATES_FILE}`);
    } catch (e) {
      console.warn('[templates] File save failed:', e.message);
    }
    return;
  }
  await updateRenderEnvVar('TEMPLATES_JSON', json);
}

loadTemplates();

// ── Template migrations ───────────────────────────────────────────────────────
// Sync default template slide descriptions to saved templates on startup.
(function migrateTemplates() {
  const canonical = buildDefaultTemplate().slides;
  const canonicalMap = Object.fromEntries(canonical.map(s => [s.title, s.description]));
  let changed = false;
  for (const tpl of _templates) {
    for (const slide of (tpl.slides || [])) {
      const best = canonicalMap[slide.title];
      if (best && slide.description !== best) {
        slide.description = best;
        changed = true;
      }
    }
  }
  if (changed) {
    persistTemplates().catch(e => console.warn('[migrate] persist failed:', e.message));
    console.log('[migrate] Synced slide descriptions to latest canonical versions');
  }
})();

// ── Operator Notes ────────────────────────────────────────────────────────────
let _operatorNotes = {};

function loadOperatorNotes() {
  try {
    _operatorNotes = process.env.OPERATOR_NOTES_JSON ? JSON.parse(process.env.OPERATOR_NOTES_JSON) : {};
  } catch { _operatorNotes = {}; }
}

async function persistOperatorNotes() {
  const json = JSON.stringify(_operatorNotes);
  if (!process.env.RENDER_API_KEY || !process.env.RENDER_SERVICE_ID) {
    console.warn('[notes] RENDER_API_KEY/SERVICE_ID not set — notes will reset on restart');
    return;
  }
  try {
    await updateRenderEnvVar('OPERATOR_NOTES_JSON', json);
  } catch (e) {
    console.error('[notes] Failed to persist:', e.message);
  }
}

loadOperatorNotes();

// ── Shared Presentations ──────────────────────────────────────────────────────
let _shares = {};  // id → { id, operator, createdAt, slides: [{html, notes}] }

function loadShares() {
  try { _shares = process.env.SHARES_JSON ? JSON.parse(process.env.SHARES_JSON) : {}; }
  catch { _shares = {}; }
}

async function persistShares() {
  const entries = Object.values(_shares).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
  _shares = Object.fromEntries(entries.map(e => [e.id, e]));
  const json = JSON.stringify(_shares);
  if (!process.env.RENDER_API_KEY || !process.env.RENDER_SERVICE_ID) {
    console.warn('[shares] RENDER_API_KEY/SERVICE_ID not set — shares will reset on restart');
    return;
  }
  try {
    await updateRenderEnvVar('SHARES_JSON', json);
  } catch (e) {
    console.error('[shares] Failed to persist:', e.message);
  }
}

loadShares();

// ── Presentation History ──────────────────────────────────────────────────────
let _presentationHistory = [];
let _historyPersistPending = false;

function loadHistory() {
  try { _presentationHistory = process.env.HISTORY_JSON ? JSON.parse(process.env.HISTORY_JSON) : []; }
  catch { _presentationHistory = []; }
}

async function persistHistory() {
  if (_historyPersistPending) return;
  _historyPersistPending = true;
  try {
    const trimmed = _presentationHistory.slice(0, 50);
    // Strip slide HTML — only persist metadata (slides live in memory only)
    const metaOnly = trimmed.map(({ id, operator, date, slideCount, title, brief }) => ({
      id, operator, date, slideCount, title, brief
    }));
    const json = JSON.stringify(metaOnly);
    console.log(`[history] Persisting ${metaOnly.length} entries (${json.length} chars)`);
    if (!process.env.RENDER_API_KEY || !process.env.RENDER_SERVICE_ID) {
      console.warn('[history] RENDER_API_KEY/SERVICE_ID not set');
      return;
    }
    await updateRenderEnvVar('HISTORY_JSON', json);
  } catch (e) {
    console.error('[history] Failed to persist:', e.message);
  } finally {
    _historyPersistPending = false;
  }
}

loadHistory();

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build the prompt for slide generation — shared by streaming and non-streaming paths
function _escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _styledCell(cell, brand) {
  const v = String(cell).trim();
  const p = brand.primary;
  // Priority / signal badges
  if (/^critical$/i.test(v)) return `<span style='display:inline-block;padding:2px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;background:${p};color:#fff;border-radius:3px;'>CRITICAL</span>`;
  if (/^high$/i.test(v))     return `<span style='display:inline-block;padding:2px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;background:#92400E;color:#FDE68A;border-radius:3px;'>HIGH</span>`;
  if (/^moderate$/i.test(v)) return `<span style='display:inline-block;padding:2px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;background:#374151;color:#CBD5E1;border-radius:3px;'>MODERATE</span>`;
  if (/^medium$/i.test(v))   return `<span style='display:inline-block;padding:2px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;background:#374151;color:#CBD5E1;border-radius:3px;'>MEDIUM</span>`;
  if (/^low$/i.test(v))      return `<span style='display:inline-block;padding:2px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;background:#1E3A2F;color:#6EE7B7;border-radius:3px;'>LOW</span>`;
  // Rank values — top 3 in primary colour, others in gold
  if (/^1st$/i.test(v)) return `<span style='color:${p};font-weight:700;'>${v}</span>`;
  if (/^2nd$/i.test(v)) return `<span style='color:#FBBF24;font-weight:700;'>${v}</span>`;
  if (/^3rd$/i.test(v)) return `<span style='color:#FBBF24;font-weight:700;'>${v}</span>`;
  if (/^top\s*\d+$/i.test(v)) return `<span style='color:#60A5FA;font-weight:600;'>${v}</span>`;
  // Absent / zero
  if (/€0\s*\(absent\)/i.test(v) || /\(absent\)/i.test(v)) return `<span style='color:${p};font-weight:600;'>${v}</span>`;
  // Euro amounts
  if (/^€[\d,\.]+[KM]?$/.test(v)) return `<span style='color:#34D399;font-weight:600;'>${v}</span>`;
  // Percentages with + or -
  if (/^[+\-]\d+(\.\d+)?%$/.test(v)) {
    const col = v.startsWith('-') ? p : '#34D399';
    return `<span style='color:${col};font-weight:600;'>${v}</span>`;
  }
  return _escHtml(v);
}

function buildStyledTableHtml(table, brand) {
  const b = brand || buildDefaultTemplate().brand;
  const headers = table.headers || [];
  const rows = table.rows || [];
  const headerHtml = headers.length
    ? `<thead><tr>${headers.map(h => `<th style='background:${b.highlight};color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;padding:8px 12px;text-align:left;'>${_escHtml(h)}</th>`).join('')}</tr></thead>`
    : '';
  const rowsHtml = rows.map((row, i) => {
    const bg = i % 2 === 0 ? '#161616' : '#1E1E1E';
    const cells = row.map(cell => `<td style='font-size:12px;color:${b.text};padding:7px 12px;border-bottom:1px solid #2D3748;'>${_styledCell(cell, b)}</td>`).join('');
    return `<tr style='background:${bg};'>${cells}</tr>`;
  }).join('');
  const caption = table.label
    ? `<caption style='font-size:11px;font-weight:700;color:${b.primary};text-transform:uppercase;letter-spacing:1px;padding:0 0 6px;text-align:left;caption-side:top;'>${_escHtml(table.label)}</caption>`
    : '';
  return `<table style='border-collapse:collapse;width:100%;'>${caption}${headerHtml}<tbody>${rowsHtml}</tbody></table>`;
}


function buildSlidesPrompt(sections, brief, operator, slidePlan, template) {
  const tpl = template || _templates.find(t => t.id === 'default') || buildDefaultTemplate();
  if (!tpl.brand) tpl.brand = buildDefaultTemplate().brand;
  const toneMap = {
    opportunity: 'Frame as an exciting opportunity — highlight upside, growth potential, and what is possible.',
    risk:        'Frame as a risk review — be measured, flag concerns clearly, recommend protective actions.',
    growth:      'Celebrate momentum — lead with positive trends and what is working well.',
    recovery:    'Acknowledge challenges honestly — focus on the recovery plan and early green shoots.'
  };
  const toneInstruction = toneMap[brief.tone] || toneMap.opportunity;

  const sectionContent = sections.map(s => {
    let block = `=== ${s.checkName} ===\n${s.content || ''}`;
    if (s.tables && s.tables.length > 0) {
      const preBuilt = s.tables.map(t => {
        const html = buildStyledTableHtml(t, tpl.brand);
        return `<PRE_BUILT_TABLE>\n${html}\n</PRE_BUILT_TABLE>`;
      }).join('\n\n');
      block += `\n\n${preBuilt}`;
    }
    return block;
  }).join('\n\n');

  // Build dynamic slide list based on template + plan
  const enabledIds = (slidePlan && slidePlan.enabled) ? slidePlan.enabled : tpl.slides.map((_, i) => i);
  const customSlides = (slidePlan && slidePlan.custom) ? slidePlan.custom : [];

  const slideLines = [];
  let slideN = 1;
  const manualContext = (slidePlan && slidePlan.context) ? slidePlan.context : {};
  for (const idx of enabledIds) {
    const s = tpl.slides[idx];
    if (!s) continue;
    let entry = `SLIDE ${slideN++} — ${s.title.toUpperCase()}\n  ${s.description}`;
    if (s.exampleHtml) {
      const minified = s.exampleHtml.replace(/\s+/g, ' ').replace(/> </g, '><').slice(0, 2000);
      entry += `\n  LAYOUT REFERENCE (replicate this HTML structure exactly, update all data/numbers with current analysis):\n  ${minified}`;
    }
    const ctx = manualContext[String(idx)];
    if (ctx) {
      entry += `\n  MANUAL DATA (user-provided — use this as the primary data source for this slide, Jedify has no data for it):\n  ${ctx}`;
    }
    slideLines.push(entry);
  }
  for (const c of customSlides) {
    slideLines.push(`SLIDE ${slideN++} — ${c.title.toUpperCase()}\n  [CUSTOM] ${c.description || 'Create a relevant slide from the analysis.'}`);
  }

  const totalSlides = slideN - 1;
  const slidesText = slideLines.join('\n\n');

  const PLACEHOLDER_DEF = `COMING SOON PLACEHOLDER (use ONLY for slides whose description contains the exact text "PLACEHOLDER — Coming Soon". NEVER use this for any other slide — if data seems sparse, still generate a real slide with what you have. Do NOT use placeholder for: New Games Launched, KPI Charts, Studio Summary, Studio Performance, VIP Analysis, Portfolio Gap, Growth Levers, KPI Gaps, Actions, The Ask, or ANY slide not explicitly marked PLACEHOLDER):
  <div style='flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;'>
    <div style='width:40px;height:40px;border-radius:50%;background:#1A1A1A;border:1px solid #333;display:flex;align-items:center;justify-content:center;font-size:20px;'>⏳</div>
    <div style='font-size:16px;font-weight:700;color:#FFFFFF;'>[TOPIC] — Coming Soon</div>
    <div style='font-size:13px;color:#64748B;'>Data will appear here in a future analysis run</div>
  </div>`;

  const systemPrompt = `You are a world-class business presentation designer and storyteller with deep expertise in B2B executive communications.

STORYTELLING PRINCIPLES — apply these to every presentation:
- Structure slides as a journey that moves the audience one step at a time toward a decision: establish reality → reveal the gap → show what's possible → make the ask. Every slide shifts thinking forward.
- Open with something that makes the room lean in — a number, a contrast, or a statement that reframes how they see their situation.
- Each slide headline is a conclusion, not a topic. "GGR grew +34%" not "GGR Overview". The audience should understand the point before reading the data below it.
- Build emotional momentum: early slides create concern or curiosity, middle slides build conviction, closing slides create urgency and confidence to act.
- The closing must feel inevitable — by the time The Ask arrives, the audience should already know what they need to do.
- Presenter notes are a coaching tool: tell the speaker what emotion to project, what objection to pre-empt, and what the audience is thinking at that moment.

PRE-BUILT TABLES — the most important rule:
Some sections contain <PRE_BUILT_TABLE> blocks. These are fully styled HTML tables built directly from the raw data source — they are 100% accurate.
- Copy <PRE_BUILT_TABLE> HTML verbatim into the slide body. Do NOT change any cell text, add rows, remove rows, or reword values.
- Your only job for slides with PRE_BUILT_TABLE: write the outer slide wrapper, logo bar, editorial headline, section label, and presenter notes.
- The table itself is already done. Touch nothing inside <PRE_BUILT_TABLE>.

SEPARATION OF STORYTELLING AND DATA:
- Storytelling (headlines, narrative text, presenter notes, tone) = you have creative latitude.
- Table data, rankings, game names, numbers, tiers = copy verbatim from PRE_BUILT_TABLE. Zero creativity allowed.
- A compelling headline on a slide with wrong table data is worse than a boring headline with correct data.

ABSOLUTE DATA INTEGRITY RULES — violating these destroys credibility:
1. Use ONLY data explicitly stated in the analysis text. Never invent, estimate, or interpolate numbers, dates, game names, or any facts.
2. Never reference time periods not mentioned in the analysis text.
3. Never use made-up game names or placeholder values — only exact names and numbers from the data.
4. OMIT OVER INVENT: If you cannot find a specific value verbatim in the analysis text, leave that cell/field EMPTY. An empty table cell is always better than a wrong number. Never fill a gap by guessing or inferring.
5. Output ONLY the slide delimiters below. No other text outside the delimiters.
6. RANKINGS ARE SACRED: Copy ordinal positions (1st, 2nd, 3rd, Top 10, etc.) character-for-character from the analysis. Never upgrade, round, or change a rank in any way. If the analysis says "2nd", write "2nd" — not "1st", not "#2".
7. GAME NAMES ARE SACRED: Copy game names exactly. Never substitute a different game for one listed in a tier. If Tier 1 contains Game A and Game B, only Game A and Game B appear in Tier 1 — no other games.
8. ONE SECTION PER SLIDE: When a slide corresponds to a named analysis section (e.g. Portfolio Gap, Benchmark Gap, VIP Analysis), use ONLY rows and values from that exact section. Never borrow data from another section to fill out a table.

OUTPUT FORMAT — use exactly these delimiters for each slide:
<SLIDE_START>
<NOTES>presenter talking track (2-3 sentences, plain text)</NOTES>
<HTML>complete slide HTML here</HTML>
<SLIDE_END>`;

  const b = tpl.brand;

  const userPrompt = `Create a QBR presentation for ${operator} using ONLY the data in the analysis text below.

STORY BRIEF:
${brief.context ? `AM's note: ${brief.context}` : ''}
${brief.operatorNotes ? `OPERATOR CONTEXT (known about this client — always keep in mind):\n${brief.operatorNotes}\n` : ''}
${brief.angle ? `Angle: ${brief.angle}` : ''}
Tone: ${toneInstruction}
${brief.ask ? `The Ask: ${brief.ask}` : ''}
${brief.include ? `MUST-INCLUDE topics (if data exists): ${brief.include}` : ''}
${brief.exclude ? `EXCLUDE these topics entirely: ${brief.exclude}` : ''}

══════════════════════════════════════
ANALYSIS DATA — USE ONLY WHAT IS EXPLICITLY STATED HERE:
${sectionContent}
══════════════════════════════════════

FIXED SLIDE TEMPLATE — generate ALL ${totalSlides} slides in order. Each slide must use the DESIGN RULES below.

CRITICAL — NEVER SKIP A SLIDE: You MUST output exactly ${totalSlides} slides. Do NOT drop, merge, or omit any slide for any reason — not for missing data, not for redundancy, not for brevity. Every slide in the list must appear in the output.
CRITICAL — NEVER INVENT DATA: If no data exists for a slide, do NOT make up numbers, names, or facts. Instead render the slide with a clear "No data available for this section" message. An honest "no data" slide is always better than invented data.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DESIGN RULES (brand — apply to every slide):

Brand colours:
  Primary:  ${b.primary}  (accents, key numbers, signal badges, chart QBR bars)
  Dark:     ${b.highlight}  (table headers, card surfaces)
  Surface:  #161616  (even table rows on black bg)
  Surface2: #1E1E1E  (odd table rows on black bg)
  Body:     ${b.text}  (body text on dark bg)
  Muted:    #64748B
  White:    #FFFFFF  (headlines, important text)
  Positive: #16A34A  |  Negative: ${b.primary}
  Chart palette (studios/lines): ['${b.primary}','#60A5FA','#34D399','#FBBF24','#A78BFA','#F87171','#38BDF8']

Outer div (every slide):
  style='width:1280px;height:720px;box-sizing:border-box;background:${b.background};color:${b.text};font-family:${b.fontBody},Inter,system-ui,sans-serif;position:relative;overflow:hidden;display:flex;flex-direction:column;'

Logo bar (top of every slide):
  <div style='font-size:11px;color:#555;letter-spacing:2px;padding:10px 28px 0;text-transform:uppercase;'>RUBYPLAY × ${operator.toUpperCase()}</div>

Editorial headline block (after logo bar, before body):
  <div style='border-left:3px solid ${b.primary};padding-left:12px;margin:8px 28px 0;'>
    <span style='display:block;font-size:10px;color:${b.primary};letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:4px;'>[SECTION LABEL]</span>
    <span style='display:block;font-size:32px–40px;font-weight:800;color:#FFFFFF;line-height:1.2;font-family:${b.fontHeading},Inter,system-ui,sans-serif;'>[HEADLINE — a conclusion, not a topic]</span>
  </div>

Body area: <div style='padding:10px 28px;flex:1;overflow:hidden;'>

Tables: border-collapse:collapse; width:100%;
  Header: background:${b.highlight}; color:#fff; font-size:10px; text-transform:uppercase; letter-spacing:0.5px; padding:8px 12px;
  Rows: alternating #161616 / #1E1E1E; font-size:12px; color:${b.text}; padding:7px 12px; border-bottom:1px solid #2D3748;
  Key numbers: color:${b.primary}; font-weight:700;

Signal badges: display:inline-block; padding:2px 8px; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:1px;
  CRITICAL → background:${b.primary}; color:#fff
  HIGH     → background:${b.highlight}; color:#fff
  MEDIUM   → background:#374151; color:${b.text}

Footer (bottom of every slide): <div style='font-size:10px;color:#555;padding:0 28px 8px;display:flex;justify-content:space-between;'><span>${operator} QBR</span><span>[SLIDE NUMBER]</span></div>

SVG CHART RULES:
- Use inline <svg> with a viewBox; set width="100%" and a fixed height in px
- Bar charts: vertical bars, x-axis shows abbreviated month labels (Jan, Feb…), bars touching
- QBR-period bars: fill ${b.primary} | Non-QBR bars: fill #374151
- Axis labels: fill #888 | Tick lines: stroke #333
- Line charts: multiple coloured lines, one per studio; dots at data points; x-axis = months
- Horizontal bar charts: sorted descending; label on left, bar extends right, value label at end
- Always include axis tick lines and labels; no grid lines
- Show up to 12 months of data — use whatever months are present in the analysis data
- If only 1 or 2 months of data exist, show those bars/points; do not invent extra months
- CRITICAL — bar label clearance: always reserve at least 30px of top padding inside the SVG viewBox above the tallest bar so value labels (e.g. "2.63M") are never clipped. The chart area must start at y≥30 and value labels must sit inside the viewBox, not above it.

ATTRIBUTE QUOTES: Use ONLY single quotes for ALL HTML attribute values. No double quotes inside HTML strings.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NOW GENERATE ALL ${totalSlides} SLIDES:

${slidesText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${PLACEHOLDER_DEF}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Generate all ${totalSlides} slides now. Output only the slide delimiters — no other text:`;

  return { systemPrompt, userPrompt };
}

// Parse raw Claude text into slide objects
function parseSlidesFromText(raw) {
  const slides = [];
  const slideRegex = /<SLIDE_START>([\s\S]*?)<SLIDE_END>/g;
  let match;
  while ((match = slideRegex.exec(raw)) !== null) {
    const block = match[1];
    const notesMatch = block.match(/<NOTES>([\s\S]*?)<\/NOTES>/);
    const htmlMatch  = block.match(/<HTML>([\s\S]*?)<\/HTML>/);
    if (htmlMatch) {
      slides.push({
        notes: notesMatch ? notesMatch[1].trim() : '',
        html:  htmlMatch[1].trim()
      });
    }
  }
  return slides;
}

async function streamSingleSlide({ slideTitle, slideDescription, brief, operator, sections, instructions }, res) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const tpl = _templates.find(t => t.id === 'default') || buildDefaultTemplate();
  if (!tpl.brand) tpl.brand = buildDefaultTemplate().brand;
  // Build section content with pre-built tables — same approach as buildSlidesPrompt
  const sectionContent = (sections || []).map(s => {
    let block = `=== ${s.checkName} ===\n${s.content || ''}`;
    if (s.tables && s.tables.length > 0) {
      const preBuilt = s.tables.map(t => `<PRE_BUILT_TABLE>\n${buildStyledTableHtml(t, tpl.brand)}\n</PRE_BUILT_TABLE>`).join('\n\n');
      block += `\n\n${preBuilt}`;
    }
    return block;
  }).join('\n\n').slice(0, 30000);
  const systemPrompt = `You are a world-class presentation designer. Generate exactly ONE slide following the RubyPlay brand design rules. When the analysis contains <PRE_BUILT_TABLE> blocks, copy that HTML verbatim — do not change any cell values. Output only: <SLIDE_START><NOTES>notes</NOTES><HTML>html</HTML><SLIDE_END>`;
  const userPrompt = `Slide: ${slideTitle}\nDescription: ${slideDescription}\n${instructions ? `Special instructions: ${instructions}\n` : ''}Analysis data:\n${sectionContent}\nOperator: ${operator}\nBrief tone: ${brief?.tone || 'opportunity'}`;
  const stream = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 8000, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }], stream: true });
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') res.write(chunk.delta.text);
  }
}

// Stream Claude's slide generation directly to an HTTP response.
// The response is written as plain text chunks — client reads with ReadableStream.
async function streamSlidesToResponse(sections, brief, operator, res, slidePlan, template) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { systemPrompt, userPrompt } = buildSlidesPrompt(sections, brief, operator, slidePlan, template);

  const stream = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 48000,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
    stream:     true
  });

  let totalChars = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const chunk of stream) {
    if (chunk.type === 'message_start') {
      inputTokens = chunk.message.usage?.input_tokens || 0;
    } else if (chunk.type === 'message_delta') {
      outputTokens = chunk.usage?.output_tokens || 0;
    } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      const text = chunk.delta.text;
      res.write(text);
      totalChars += text.length;
    }
  }
  const costUSD = (inputTokens / 1_000_000 * 3) + (outputTokens / 1_000_000 * 15);
  console.log(`[generate-slides] Streamed ${totalChars} chars | tokens: ${inputTokens} in / ${outputTokens} out | cost: $${costUSD.toFixed(4)} USD`);
}

// ── Auth ─────────────────────────────────────────────────────────────────────
// Set APP_PASSWORD env var on Render to enable password protection.
// Locally it's disabled (no env var = open access).
const APP_PASSWORD = process.env.APP_PASSWORD || null;

// Allowed origin for CORS — set APP_URL env var on Render (e.g. https://account-manager-copilot.onrender.com)
// Falls back to * only when running locally without APP_PASSWORD.
const APP_URL = process.env.APP_URL || null;

// ── Token: signed expiring token (no session store) ──────────────────────────
// Format: "<expiresAt>.<hmac(password+expiresAt)>"
// Default lifetime: 24 hours. Change TOKEN_TTL_MS to adjust.
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function makeAuthToken(password) {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const sig = crypto.createHmac('sha256', password).update('jedify-crm-v1:' + expiresAt).digest('hex');
  return expiresAt + '.' + sig;
}

function verifyAuthToken(password, token) {
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const expiresAt = parseInt(token.slice(0, dot), 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt) return false; // expired
  const expected = crypto.createHmac('sha256', password).update('jedify-crm-v1:' + expiresAt).digest('hex');
  const actual = token.slice(dot + 1);
  // Constant-time compare to prevent timing attacks
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function isAuthenticated(req) {
  if (!APP_PASSWORD) return true;
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try { return verifyAuthToken(APP_PASSWORD, token); } catch { return false; }
}

function rejectUnauth(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

// ── Rate limiter for /api/auth (brute-force protection) ──────────────────────
// Max 5 failed attempts per IP per 15 minutes.
const _authAttempts = new Map(); // ip → { count, resetAt }
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = _authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + AUTH_WINDOW_MS };
    _authAttempts.set(ip, entry);
  }
  entry.count++;
  return entry.count <= AUTH_MAX_ATTEMPTS;
}

function recordAuthSuccess(ip) {
  _authAttempts.delete(ip); // reset on success
}

// Clean up old entries every 30 min to avoid memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _authAttempts) {
    if (now > entry.resetAt) _authAttempts.delete(ip);
  }
}, 30 * 60 * 1000);

// ── MCP connection (via jedify-direct.js) ─────────────────────────────────

const { sendMCP, notifyMCP, initMCP, isMCPReady, setMCPReady, getSessionVersion, getTokenStatus } = jedify;
let mcpReady = false;

async function runSQL(query, maxResults = 500) {
  const res = await sendMCP({
    method: 'tools/call',
    params: {
      name: 'run_sql_query',
      arguments: { query, max_results: maxResults }
    }
  }, 60000);

  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  const text = res.result?.content?.[0]?.text;
  if (!text) throw new Error('Empty response from run_sql_query');
  const parsed = JSON.parse(text);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.data || [];
}

// ── Jedify Research Mode: ask natural language questions ──────────────────

async function askJedify(question, overrides = {}) {
  // Step 1: Submit the question
  console.log(`[jedify-research] Asking: "${question.slice(0, 80)}..."`);
  const args = { question };
  if (overrides.entity_classification || overrides.sql_generation) {
    args.prompts_overrides = {};
    if (overrides.entity_classification) args.prompts_overrides.entity_classification = overrides.entity_classification;
    if (overrides.sql_generation) args.prompts_overrides.sql_generation = overrides.sql_generation;
  }
  const askRes = await sendMCP({
    method: 'tools/call',
    params: {
      name: 'ask_a_single_question',
      arguments: args
    }
  }, 120000);

  if (askRes.error) throw new Error('ask_a_single_question error: ' + (askRes.error.message || JSON.stringify(askRes.error)));
  const askText = askRes.result?.content?.[0]?.text;
  if (!askText) throw new Error('Empty response from ask_a_single_question');
  const askParsed = JSON.parse(askText);
  const inquiryId = askParsed.inquiry_id;
  if (!inquiryId) throw new Error('No inquiry_id returned: ' + askText);

  console.log(`[jedify-research] Submitted → inquiry_id=${inquiryId}, polling...`);

  // Step 2: Poll check_question_status until done (max ~120s)
  const maxPolls = 40;
  const pollInterval = 3000;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, pollInterval));
    try {
      const statusRes = await sendMCP({
        method: 'tools/call',
        params: {
          name: 'check_question_status',
          arguments: { inquiry_id: inquiryId }
        }
      }, 30000);

      if (statusRes.error) continue; // Retry on error
      const statusText = statusRes.result?.content?.[0]?.text;
      if (!statusText) continue;
      const statusParsed = JSON.parse(statusText);

      const generalStatus = statusParsed.status?.general || statusParsed.status;
      if (generalStatus === 'done' || statusParsed.answer) {
        console.log(`[jedify-research] Done in ${(i+1)*pollInterval/1000}s`);
        // Build answer from all available sources — Jedify sometimes puts the answer in data.title + data.data
        let answer = statusParsed.answer || '';
        const answerExplanation = statusParsed.answer_explanation || '';
        const explanation = statusParsed.explanation || '';

        // If answer is empty but data has a title/data, build the answer from that
        if (!answer && statusParsed.data) {
          const dataObj = statusParsed.data;
          const parts = [];
          if (dataObj.title) parts.push(dataObj.title);
          if (dataObj.data && Array.isArray(dataObj.data)) {
            dataObj.data.forEach(row => {
              const vals = Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(', ');
              if (vals) parts.push(vals);
            });
          }
          if (parts.length > 0) answer = parts.join('. ');
        }
        // Also try answer_explanation as fallback
        if (!answer && answerExplanation) answer = answerExplanation;

        console.log(`[jedify-research] Answer: ${(answer || '').slice(0, 120)}`);

        return {
          answer,
          explanation: explanation || answerExplanation || '',
          data: statusParsed.data?.data || statusParsed.data?.rows || statusParsed.data || [],
          columns: statusParsed.data?.columns || Object.keys((statusParsed.data?.data || [])[0] || {}),
          sql: statusParsed.sql_query || statusParsed.thinking?.sql_query || statusParsed.sql || '',
          inquiry_id: inquiryId
        };
      }
      if (generalStatus === 'failed' || generalStatus === 'error') {
        throw new Error('Jedify question failed: ' + (statusParsed.error || statusText));
      }
      // Still processing — continue polling
    } catch (e) {
      if (e.message.includes('timeout') || e.message.includes('MCP')) continue;
      throw e;
    }
  }
  throw new Error(`Jedify question timed out after ${maxPolls * pollInterval / 1000}s (inquiry_id=${inquiryId})`);
}

// ── Analysis: check-based architecture ─────────────────────────────────────
// Source: FACT_SPINS_AGGREGATED_ALL_V + ENTITIES_V + CURRENCY_INFO_V + GAME_INFO_V
// Each Research Config check = a real Jedify SQL query

function escStr(s) { return s.replace(/'/g, "''"); }
function fmt(n) { return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : String(n); }

// ── Competitive Intelligence utilities ────────────────────────────────────

function indexToBaseline(series) {
  const base = series[0]?.value;
  if (!base || base === 0) return series.map(s => ({ ...s, indexed: null }));
  return series.map(s => ({ ...s, indexed: Math.round((s.value / base) * 10000) / 100 }));
}

function calcSlope(values) {
  const vals = values.filter(v => v !== null && v !== undefined);
  const n = vals.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  vals.forEach((y, x) => { sx += x; sy += y; sxy += x * y; sx2 += x * x; });
  return (n * sxy - sx * sy) / (n * sx2 - sx * sx);
}

function classifyTrend(slope) {
  if (slope < -2) return 'dropping';
  if (slope > 2) return 'growing';
  return 'stable';
}

function trendArrow(trend) {
  if (trend === 'growing') return '↑';
  if (trend === 'dropping') return '↓';
  return '→';
}

// ── Markets cache (for /api/markets dropdown) ────────────────────────────
let _marketsCache = { data: null, fetchedAt: 0 };
const MARKETS_CACHE_TTL = 3600000; // 1 hour

// ── Jurisdictions cache (for /api/jurisdictions dropdown) ────────────────
let _jurisdictionsCache = { data: null, fetchedAt: 0 };
const JURISDICTIONS_CACHE_TTL = 3600000; // 1 hour

// ── Competitive Intelligence pipeline ─────────────────────────────────────

async function runCompetitiveAnalysis(params, onProgress) {
  const { entity, scope, endMonth, monthsBack, metric, compareMode, manualCompetitors, market, jurisdiction } = params;
  const emit = onProgress || (() => {});
  const metricCol = metric === 'BETS' ? 'BETS_EUR' : metric === 'PLAYERS' ? 'PLAYER_COUNT' : 'GGR_EUR';

  // Build date filter
  let dateWhere;
  if (endMonth && /^\d{4}-\d{2}$/.test(endMonth)) {
    const mb = parseInt(monthsBack) || 6;
    dateWhere = `s.DATE >= DATEADD(MONTH, -${mb - 1}, DATE '${endMonth}-01') AND s.DATE < DATEADD(MONTH, 1, DATE '${endMonth}-01')`;
  } else {
    const mb = parseInt(monthsBack) || 6;
    dateWhere = `s.DATE >= DATEADD(MONTH, -${mb}, DATE_TRUNC('MONTH', CURRENT_DATE())) AND s.DATE < DATE_TRUNC('MONTH', CURRENT_DATE())`;
  }

  // Scope-aware: compare operators vs operators, brands vs brands, accounts vs accounts
  const scopeCol = scope === 'brand' ? 'e.BRAND_NAME' : scope === 'account' ? 'e.ACCOUNT_NAME' : 'e.OPERATOR_NAME';
  const scopeLabel = scope === 'brand' ? 'brand' : scope === 'account' ? 'account' : 'operator';
  const entitySafe = escStr(entity);

  // Optional market filter (player country) — used in discovery prompt AND SQL
  const marketContext = market ? ` in the ${market} market` : '';
  const marketFilter = market ? `AND s.COUNTRY = '${escStr(market)}'` : '';

  // Optional jurisdiction filter (operator licence territory) — entity-level filter
  const jurisdictionContext = jurisdiction ? ` under ${jurisdiction} jurisdiction` : '';
  const jurisdictionFilter = jurisdiction ? `AND e.JURISDICTION = '${escStr(jurisdiction)}'` : '';

  // Step 1: Discover top 3 competitors
  emit({ type: 'step', step: 'discover_competitors', name: 'Finding top competitors', index: 0, total: 5 });
  let competitorNames = [];

  if (compareMode === 'manual' && manualCompetitors && manualCompetitors.length > 0) {
    competitorNames = manualCompetitors.slice(0, 3);
    console.log(`[competitive] Manual competitors: ${competitorNames.join(', ')}`);
  } else {
    try {
      const discoveryResult = await askJedifyWithRetry(
        `List the top 3 ${scopeLabel}s by total GGR (excluding "${entity}")${marketContext}${jurisdictionContext} from our data. Return ONLY the ${scopeLabel} names, one per line, nothing else.`,
        {}, 'competitive_discover'
      );
      const raw = discoveryResult.answer || '';
      // Try to extract "Operator Name: X" patterns first (Jedify often returns this format)
      const namePattern = /(?:Operator|Brand|Account)\s*Name\s*[:\-]\s*([^\.\n,]+)/gi;
      let matches = [...raw.matchAll(namePattern)].map(m => m[1].trim()).filter(Boolean);
      if (matches.length === 0) {
        // Fallback: split by newlines or ". " and clean up
        const lines = raw.split(/[\n]|(?:\.\s)/)
          .map(l => l.replace(/^\d+[\.\)\-]\s*/, '').replace(/[*"]/g, '').trim())
          .filter(l => l.length > 2 && l.length < 100 && !/^(top|here|the |based|note)/i.test(l));
        matches = lines;
      }
      competitorNames = matches.slice(0, 3);
      console.log(`[competitive] Raw answer: ${raw.slice(0, 200)}`);
      console.log(`[competitive] Parsed competitors: ${competitorNames.join(', ')}`);
      console.log(`[competitive] Discovered competitors: ${competitorNames.join(', ')}`);
    } catch (e) {
      console.error('[competitive] Discovery failed:', e.message);
      emit({ type: 'done', step: 'discover_competitors', index: 0, status: 'error' });
      return { error: 'Failed to discover competitors: ' + e.message };
    }
  }

  if (competitorNames.length === 0) {
    emit({ type: 'done', step: 'discover_competitors', index: 0, status: 'error' });
    return { error: 'No competitors found.' };
  }
  emit({ type: 'done', step: 'discover_competitors', index: 0 });

  // Step 2: Pull operator monthly data
  emit({ type: 'step', step: 'operator_data', name: 'Loading operator data', index: 1, total: 5 });
  let operatorMonthly;
  try {
    operatorMonthly = await runSQL(`
      SELECT DATE_TRUNC('MONTH', s.DATE) AS M,
             ROUND(SUM(s.GGR_EUR), 0) AS GGR_EUR,
             ROUND(SUM(s.BETS_EUR), 0) AS BETS_EUR,
             COUNT(DISTINCT s.PLAYER_ID) AS PLAYER_COUNT
      FROM ${BASE_FROM}
      WHERE ${MF} AND ${scopeCol} = '${entitySafe}' AND ${dateWhere} ${marketFilter} ${jurisdictionFilter}
      GROUP BY M ORDER BY M
    `);
    console.log(`[competitive] Operator data: ${operatorMonthly.length} months`);
  } catch (e) {
    console.error('[competitive] Operator data failed:', e.message);
    emit({ type: 'done', step: 'operator_data', index: 1, status: 'error' });
    return { error: 'Failed to load operator data: ' + e.message };
  }
  emit({ type: 'done', step: 'operator_data', index: 1 });

  // Step 3: Pull competitor monthly data
  emit({ type: 'step', step: 'competitor_data', name: 'Loading competitor data', index: 2, total: 5 });
  const compList = competitorNames.map(n => `'${escStr(n)}'`).join(',');
  let competitorMonthly;
  try {
    competitorMonthly = await runSQL(`
      SELECT e.OPERATOR_NAME AS COMP_NAME, DATE_TRUNC('MONTH', s.DATE) AS M,
             ROUND(SUM(s.GGR_EUR), 0) AS GGR_EUR,
             ROUND(SUM(s.BETS_EUR), 0) AS BETS_EUR,
             COUNT(DISTINCT s.PLAYER_ID) AS PLAYER_COUNT
      FROM ${BASE_FROM}
      WHERE ${MF} AND e.OPERATOR_NAME IN (${compList}) AND ${dateWhere} ${marketFilter} ${jurisdictionFilter}
      GROUP BY e.OPERATOR_NAME, M ORDER BY e.OPERATOR_NAME, M
    `);
    console.log(`[competitive] Competitor data: ${competitorMonthly.length} rows`);
  } catch (e) {
    console.error('[competitive] Competitor data failed:', e.message);
    emit({ type: 'done', step: 'competitor_data', index: 2, status: 'error' });
    return { error: 'Failed to load competitor data: ' + e.message };
  }
  emit({ type: 'done', step: 'competitor_data', index: 2 });

  // Step 4: Pull per-game data
  emit({ type: 'step', step: 'game_data', name: 'Loading per-game data', index: 3, total: 5 });
  let gameData;
  try {
    const topGames = await runSQL(`
      SELECT g.NAME AS GAME_NAME, ROUND(SUM(s.GGR_EUR), 0) AS TOTAL_GGR
      FROM ${BASE_FROM}
      LEFT JOIN IN_RUBYPLAY.JEDIFY.GAME_INFO_V g ON s.GAME_ID = g.ID
      WHERE ${MF} AND ${scopeCol} = '${entitySafe}' AND ${dateWhere} ${marketFilter} ${jurisdictionFilter}
        AND g.NAME IS NOT NULL
      GROUP BY g.NAME ORDER BY TOTAL_GGR DESC LIMIT 10
    `);
    const gameNames = topGames.map(r => r.GAME_NAME).filter(Boolean);
    console.log(`[competitive] Top games: ${gameNames.join(', ')}`);

    if (gameNames.length > 0) {
      const gameList = gameNames.map(n => `'${escStr(n)}'`).join(',');
      const allOperators = `'${entitySafe}',${compList}`;
      gameData = await runSQL(`
        SELECT e.OPERATOR_NAME AS OP_NAME, g.NAME AS GAME_NAME,
               DATE_TRUNC('MONTH', s.DATE) AS M,
               ROUND(SUM(s.GGR_EUR), 0) AS GGR_EUR,
               ROUND(SUM(s.BETS_EUR), 0) AS BETS_EUR,
               COUNT(DISTINCT s.PLAYER_ID) AS PLAYER_COUNT
        FROM ${BASE_FROM}
        LEFT JOIN IN_RUBYPLAY.JEDIFY.GAME_INFO_V g ON s.GAME_ID = g.ID
        WHERE ${MF} AND e.OPERATOR_NAME IN (${allOperators}) AND ${dateWhere} ${marketFilter} ${jurisdictionFilter}
          AND g.NAME IN (${gameList})
        GROUP BY e.OPERATOR_NAME, g.NAME, M
        ORDER BY g.NAME, e.OPERATOR_NAME, M
      `, 2000);
      console.log(`[competitive] Game data: ${gameData.length} rows`);
    } else {
      gameData = [];
    }
  } catch (e) {
    console.error('[competitive] Game data failed:', e.message);
    gameData = [];
  }
  emit({ type: 'done', step: 'game_data', index: 3 });

  // ── Process data: index, trend, anonymize ──

  const months = operatorMonthly.map(r => {
    const d = new Date(r.M);
    return d.toISOString().slice(0, 7);
  });

  const processMetrics = (rows) => {
    const result = {};
    for (const m of ['GGR_EUR', 'BETS_EUR', 'PLAYER_COUNT']) {
      const series = rows.map(r => ({ month: new Date(r.M).toISOString().slice(0, 7), value: parseFloat(r[m]) || 0 }));
      const indexed = indexToBaseline(series);
      const indexedVals = indexed.map(s => s.indexed);
      const slope = calcSlope(indexedVals);
      result[m] = { raw: series.map(s => s.value), indexed: indexedVals, slope, trend: classifyTrend(slope) };
    }
    return result;
  };

  const operatorMetrics = processMetrics(operatorMonthly);

  const compGrouped = {};
  for (const row of competitorMonthly) {
    const name = row.COMP_NAME;
    if (!compGrouped[name]) compGrouped[name] = [];
    compGrouped[name].push(row);
  }

  const competitors = [];
  const anonymousLabels = ['Competitor A', 'Competitor B', 'Competitor C'];
  let idx = 0;
  for (const [realName, rows] of Object.entries(compGrouped)) {
    const metrics = processMetrics(rows);
    competitors.push({
      realName,
      label: anonymousLabels[idx] || `Competitor ${String.fromCharCode(65 + idx)}`,
      metrics
    });
    idx++;
  }

  const games = {};
  for (const row of gameData) {
    const gn = row.GAME_NAME;
    const op = row.OP_NAME;
    if (!games[gn]) games[gn] = {};
    if (!games[gn][op]) games[gn][op] = [];
    games[gn][op].push(row);
  }

  const perGameResults = [];
  for (const [gameName, operators] of Object.entries(games)) {
    const opRows = operators[entity] || [];
    if (opRows.length < 2) continue;
    const opMetrics = processMetrics(opRows);
    const gameComps = [];
    for (const comp of competitors) {
      const compRows = operators[comp.realName] || [];
      if (compRows.length < 2) continue;
      const compMetrics = processMetrics(compRows);
      gameComps.push({ realName: comp.realName, label: comp.label, metrics: compMetrics });
    }
    const opTrend = opMetrics[metricCol]?.trend || 'stable';
    const anyBetter = gameComps.some(c => {
      const cTrend = c.metrics[metricCol]?.trend || 'stable';
      if (opTrend === 'dropping') return cTrend === 'stable' || cTrend === 'growing';
      if (opTrend === 'stable') return cTrend === 'growing';
      return false;
    });
    perGameResults.push({
      gameName,
      operator: opMetrics,
      competitors: gameComps,
      underperforming: anyBetter,
      gameMonths: opRows.map(r => new Date(r.M).toISOString().slice(0, 7))
    });
  }

  // Step 5: Generate AI action items
  emit({ type: 'step', step: 'action_items', name: 'Generating action items', index: 4, total: 5 });
  let actionItems = null;
  try {
    const opTrend = operatorMetrics[metricCol]?.trend || 'stable';
    const opSlope = operatorMetrics[metricCol]?.slope?.toFixed(1) || '0';
    const compSummary = competitors.map(c => {
      const t = c.metrics[metricCol]?.trend || 'stable';
      const s = c.metrics[metricCol]?.slope?.toFixed(1) || '0';
      return `${c.label} (${t}, slope ${s})`;
    }).join(', ');
    const underGames = perGameResults.filter(g => g.underperforming).map(g => g.gameName).join(', ');

    const prompt = `You are an account manager preparing for a QBR with ${scopeLabel} "${entity}"${marketContext}.

Competitive analysis shows:
- ${entity} is ${opTrend} (slope: ${opSlope}) on ${metric || 'GGR'}
- Top 3 competitors: ${compSummary}
- Games where ${entity} underperforms: ${underGames || 'none'}

Generate 3-5 specific, actionable recommendations. For each:
- State what the data shows (use indexed %, not absolute numbers)
- Recommend a specific action (reposition game, run promotion, increase max bet, etc.)
- Explain the expected impact

Format each item with an icon: ⚠ for problems, ✓ for strengths, 💡 for opportunities.`;

    actionItems = await askJedifyWithRetry(prompt, {}, 'competitive_actions');
    console.log(`[competitive] Action items generated`);
  } catch (e) {
    console.warn('[competitive] Action items failed:', e.message);
    actionItems = { answer: 'Action item generation failed: ' + e.message };
  }
  emit({ type: 'done', step: 'action_items', index: 4 });

  // Build response
  const opTrend = operatorMetrics[metricCol]?.trend || 'stable';
  const growingComps = competitors.filter(c => (c.metrics[metricCol]?.trend || 'stable') === 'growing').length;
  let status = 'ok';
  let finding = `${entity} is ${opTrend} on ${metric || 'GGR'}`;
  if (opTrend === 'dropping' && growingComps > 0) {
    status = 'warning';
    finding += ` while ${growingComps} competitor${growingComps > 1 ? 's are' : ' is'} growing`;
  } else if (opTrend === 'stable' && growingComps > 0) {
    status = 'warning';
    finding += ` while ${growingComps} competitor${growingComps > 1 ? 's are' : ' is'} growing`;
  } else if (opTrend === 'growing') {
    finding += ' — outperforming the market';
  }

  return {
    status,
    finding,
    months,
    metric: metricCol,
    operator: { realName: entity, metrics: operatorMetrics },
    competitors,
    games: perGameResults,
    actionItems: actionItems?.answer || '',
    generatedAt: new Date().toISOString()
  };
}

const BASE_FROM = `IN_RUBYPLAY.JEDIFY.FACT_SPINS_AGGREGATED_ALL_V s `
  + `LEFT JOIN IN_RUBYPLAY.JEDIFY.ENTITIES_V e ON IFF(s.SUBCLUSTER_ID IS NULL, s.BRAND_ID, CONCAT('usa1_', s.SUBCLUSTER_ID, '_', s.SUB_BRAND_ID)) = e.BRAND_ID `
  + `LEFT JOIN IN_RUBYPLAY.JEDIFY.CURRENCY_INFO_V c ON s.ORIGINAL_CURRENCY = c.CODE `
  + `LEFT JOIN IN_RUBYPLAY.JEDIFY.DIM_STREAMERS_V ds ON s.EXTERNAL_PLAYER_ID = ds.EXTERNAL_PLAYER_ID `
  + `AND IFF(s.SUBCLUSTER_ID IS NULL, s.BRAND_ID, CONCAT('usa1_', s.SUBCLUSTER_ID, '_', s.SUB_BRAND_ID)) = ds.CLUSTER_BRAND_ID `
  + `AND s.DATE BETWEEN ds.START_DATE AND ds.END_DATE`;

const MF = `e.OPERATOR_NAME != 'test' AND e.OPERATOR_NAME != 'TEST' `
  + `AND IFF(s.SUBCLUSTER_ID IS NULL, s.BRAND_ID, CONCAT('usa1_', s.SUBCLUSTER_ID, '_', s.SUB_BRAND_ID)) NOT IN ('eur_21','asi_71','eur_160','eur_74') `
  + `AND c.IS_BILLABLE = 1 AND COALESCE(e.IS_BONUS_BRAND, 0) = 0 `
  + `AND NOT (s.SUBCLUSTER_ID IS NULL AND s.BRAND_ID LIKE 'usa%' AND e.OPERATOR_ID_NO_CLUSTER = 4) `
  + `AND ds.EXTERNAL_PLAYER_ID IS NULL`;

function scopeFilter(sel) {
  const { scope, values } = sel;
  const list = values.map(v => `'${escStr(v)}'`).join(',');
  if (scope === 'operator') return `e.OPERATOR_NAME IN (${list})`;
  if (scope === 'brand') return `e.BRAND_NAME IN (${list})`;
  if (scope === 'account') return `e.ACCOUNT_NAME IN (${list})`;
  return '1=1';
}

function buildDateFilters(sel) {
  const monthsBack = parseInt(sel.monthsBack) || 6;
  let endExpr = `DATE_TRUNC('MONTH', CURRENT_DATE())`;
  let startExpr = `DATEADD(MONTH, -${monthsBack}, ${endExpr})`;
  if (sel.endMonth && /^\d{4}-\d{2}$/.test(sel.endMonth)) {
    endExpr = `DATE '${sel.endMonth}-01'`;
    startExpr = `DATEADD(MONTH, -${monthsBack - 1}, ${endExpr})`;
    endExpr = `DATEADD(MONTH, 1, DATE '${sel.endMonth}-01')`;
  }
  const full = `s.DATE >= ${startExpr} AND s.DATE < ${endExpr}`;
  const detailM = Math.max(3, Math.ceil(monthsBack / 2));
  let detailStart;
  if (sel.endMonth && /^\d{4}-\d{2}$/.test(sel.endMonth)) {
    detailStart = `DATEADD(MONTH, -${detailM - 1}, DATE '${sel.endMonth}-01')`;
  } else {
    detailStart = `DATEADD(MONTH, -${detailM}, DATE_TRUNC('MONTH', CURRENT_DATE()))`;
  }
  const detail = `s.DATE >= ${detailStart} AND s.DATE < ${endExpr}`;
  return { full, detail, endExpr, monthsBack };
}

// ── Individual check functions ────────────────────────────────────────────

async function checkGgrTrend(sf, df) {
  const data = await runSQL(`SELECT DATE_TRUNC('MONTH', s.DATE) AS INVOICE_MONTH, `
    + `ROUND(SUM(s.GGR_EUR),0) AS GGR_EUR, ROUND(SUM(s.BETS_EUR),0) AS BETS_EUR, `
    + `COUNT(DISTINCT s.PLAYER_ID) AS ACTIVE_PLAYERS `
    + `FROM ${BASE_FROM} WHERE ${MF} AND ${sf} AND ${df.full} `
    + `GROUP BY INVOICE_MONTH ORDER BY INVOICE_MONTH`);
  const total = data.reduce((s,r) => s + (r.GGR_EUR||0), 0);
  const half = Math.floor(data.length / 2);
  const h1 = data.slice(0, half).reduce((s,r) => s + (r.GGR_EUR||0), 0);
  const h2 = data.slice(half).reduce((s,r) => s + (r.GGR_EUR||0), 0);
  const growth = h1 > 0 ? Math.round(((h2 - h1) / h1) * 100) : 0;
  const status = growth > 0 ? 'ok' : growth >= -10 ? 'warning' : 'critical';
  const arrow = growth >= 0 ? 'up' : 'down';
  return { id: 'ggr_trend', name: 'GGR Trend', status, data,
    finding: `GGR ${arrow} ${Math.abs(growth)}% over ${data.length} months. Total: €${fmt(total)}.` };
}

async function checkConcentration(sf, df) {
  const data = await runSQL(`SELECT s.GAME_ID, g.NAME AS GAME_NAME, `
    + `ROUND(SUM(s.GGR_EUR),0) AS GGR_EUR, ROUND(SUM(s.BETS_EUR),0) AS BETS_EUR, `
    + `ROUND(CASE WHEN SUM(s.BETS_EUR)>0 THEN SUM(s.WINS_EUR)/SUM(s.BETS_EUR)*100 ELSE 0 END, 2) AS RTP `
    + `FROM ${BASE_FROM} LEFT JOIN IN_RUBYPLAY.JEDIFY.GAME_INFO_V g ON s.GAME_ID = g.ID `
    + `WHERE ${MF} AND ${sf} AND ${df.detail} `
    + `GROUP BY s.GAME_ID, g.NAME HAVING SUM(s.GGR_EUR) > 0 ORDER BY GGR_EUR DESC LIMIT 15`);
  const total = data.reduce((s,g) => s + (g.GGR_EUR||0), 0);
  const top = data[0] || {};
  const share = total > 0 ? Math.round((top.GGR_EUR||0) / total * 100) : 0;
  const status = share > 50 ? 'critical' : share > 40 ? 'warning' : 'ok';
  const name = top.GAME_NAME || ('Game #' + top.GAME_ID) || '—';
  return { id: 'concentration', name: 'Game Concentration Risk', status, data,
    finding: share > 40
      ? `${name} = ${share}% of GGR. ${status === 'critical' ? 'Critical' : 'Near warning'} threshold.`
      : `Healthy spread. Top game ${name} at ${share}% of GGR.` };
}

async function checkHiddenGems(sf, df) {
  // Games with above-average GGR but below-average player count
  const data = await runSQL(`SELECT s.GAME_ID, g.NAME AS GAME_NAME, `
    + `ROUND(SUM(s.GGR_EUR),0) AS GGR_EUR, COUNT(DISTINCT s.PLAYER_ID) AS PLAYERS, `
    + `ROUND(SUM(s.GGR_EUR) / NULLIF(COUNT(DISTINCT s.PLAYER_ID),0), 2) AS GGR_PER_PLAYER `
    + `FROM ${BASE_FROM} LEFT JOIN IN_RUBYPLAY.JEDIFY.GAME_INFO_V g ON s.GAME_ID = g.ID `
    + `WHERE ${MF} AND ${sf} AND ${df.detail} `
    + `GROUP BY s.GAME_ID, g.NAME HAVING SUM(s.GGR_EUR) > 0 ORDER BY GGR_PER_PLAYER DESC LIMIT 20`);
  // Find games with high GGR/player but not in top 3 by total GGR
  const byGgr = [...data].sort((a,b) => (b.GGR_EUR||0) - (a.GGR_EUR||0));
  const top3Ids = byGgr.slice(0,3).map(g => g.GAME_ID);
  const gems = data.filter(g => !top3Ids.includes(g.GAME_ID) && g.GGR_PER_PLAYER > 0).slice(0, 5);
  const status = gems.length > 0 ? 'ok' : 'warning';
  return { id: 'hidden_gems', name: 'Hidden Gem Games', status, data: gems,
    finding: gems.length > 0
      ? `${gems.length} games with high GGR/player but low exposure. Top: ${gems[0].GAME_NAME || 'Game #'+gems[0].GAME_ID} (€${fmt(gems[0].GGR_PER_PLAYER)}/player).`
      : `No clear hidden gems found — game performance is evenly distributed.` };
}

async function checkBenchmarkGap(sf, df) {
  // Global top 10 games vs this operator's games
  const globalTop = await runSQL(`SELECT s.GAME_ID, g.NAME AS GAME_NAME, ROUND(SUM(s.GGR_EUR),0) AS GGR_EUR `
    + `FROM ${BASE_FROM} LEFT JOIN IN_RUBYPLAY.JEDIFY.GAME_INFO_V g ON s.GAME_ID = g.ID `
    + `WHERE ${MF} AND ${df.detail} `
    + `GROUP BY s.GAME_ID, g.NAME HAVING SUM(s.GGR_EUR) > 0 ORDER BY GGR_EUR DESC LIMIT 10`);
  const opGames = await runSQL(`SELECT DISTINCT s.GAME_ID FROM ${BASE_FROM} `
    + `WHERE ${MF} AND ${sf} AND ${df.detail} AND s.GGR_EUR > 0 GROUP BY s.GAME_ID`);
  const opGameIds = new Set(opGames.map(g => String(g.GAME_ID)));
  const missing = globalTop.filter(g => !opGameIds.has(String(g.GAME_ID)));
  const present = globalTop.length - missing.length;
  const status = missing.length > 3 ? 'warning' : 'ok';
  return { id: 'benchmark_gap', name: 'Global Benchmark Gap', status, data: { globalTop, missing },
    finding: missing.length > 0
      ? `Missing ${missing.length} of top 10 global games. Biggest gap: ${missing[0].GAME_NAME || 'Game #'+missing[0].GAME_ID} (€${fmt(missing[0].GGR_EUR)} globally).`
      : `Has ${present}/10 top global games. Strong game portfolio alignment.` };
}

async function checkNewLaunches(sf, df) {
  // Games where this operator's first activity is within last 90 days
  const data = await runSQL(`SELECT s.GAME_ID, g.NAME AS GAME_NAME, MIN(s.DATE) AS FIRST_SPIN, `
    + `ROUND(SUM(s.GGR_EUR),0) AS GGR_EUR, COUNT(DISTINCT s.PLAYER_ID) AS PLAYERS `
    + `FROM ${BASE_FROM} LEFT JOIN IN_RUBYPLAY.JEDIFY.GAME_INFO_V g ON s.GAME_ID = g.ID `
    + `WHERE ${MF} AND ${sf} AND ${df.detail} `
    + `GROUP BY s.GAME_ID, g.NAME HAVING MIN(s.DATE) >= DATEADD(DAY, -90, CURRENT_DATE()) `
    + `ORDER BY GGR_EUR DESC LIMIT 10`);
  const status = data.length > 0 ? 'ok' : 'warning';
  return { id: 'new_launches', name: 'New Game Launches (90 Days)', status, data,
    finding: data.length > 0
      ? `${data.length} new games adopted. Best performer: ${data[0].GAME_NAME || 'Game #'+data[0].GAME_ID} at €${fmt(data[0].GGR_EUR)} GGR.`
      : `No new games adopted in the last 90 days. Recommend content refresh.` };
}

async function checkOpenScan(sf, df) {
  // Brand breakdown + anomaly detection
  const data = await runSQL(`SELECT e.BRAND_NAME, e.OPERATOR_NAME, `
    + `ROUND(SUM(s.GGR_EUR),0) AS GGR_EUR, ROUND(SUM(s.BETS_EUR),0) AS BETS_EUR, `
    + `COUNT(DISTINCT s.PLAYER_ID) AS ACTIVE_PLAYERS `
    + `FROM ${BASE_FROM} WHERE ${MF} AND ${sf} AND ${df.detail} `
    + `GROUP BY e.BRAND_NAME, e.OPERATOR_NAME ORDER BY GGR_EUR DESC LIMIT 20`);
  // Anomaly: any brand with negative GGR or very low player count relative to others
  const anomalies = [];
  const avgPlayers = data.length > 0 ? data.reduce((s,b) => s + (b.ACTIVE_PLAYERS||0), 0) / data.length : 0;
  data.forEach(b => {
    if (b.GGR_EUR < 0) anomalies.push(`${b.BRAND_NAME} has negative GGR (€${fmt(b.GGR_EUR)})`);
    if (b.ACTIVE_PLAYERS < avgPlayers * 0.1 && b.GGR_EUR > 0) anomalies.push(`${b.BRAND_NAME} has very few players (${b.ACTIVE_PLAYERS}) relative to GGR`);
  });
  const status = anomalies.length > 0 ? 'warning' : 'ok';
  return { id: 'open_scan', name: 'Open Opportunity Scan', status, data,
    finding: anomalies.length > 0
      ? `${anomalies.length} anomaly found: ${anomalies[0]}.`
      : `${data.length} brands scanned. No anomalies — revenue distribution looks healthy.` };
}

async function checkRetention(sf, df) {
  // Active players month-over-month
  const data = await runSQL(`SELECT DATE_TRUNC('MONTH', s.DATE) AS MONTH, `
    + `COUNT(DISTINCT s.PLAYER_ID) AS ACTIVE_PLAYERS `
    + `FROM ${BASE_FROM} WHERE ${MF} AND ${sf} AND ${df.full} `
    + `GROUP BY MONTH ORDER BY MONTH`);
  if (data.length < 2) return { id: 'retention', name: 'Player Retention', status: 'warning', data, finding: 'Not enough data for retention analysis.' };
  const first = data[0].ACTIVE_PLAYERS || 1;
  const last = data[data.length-1].ACTIVE_PLAYERS || 0;
  const change = Math.round(((last - first) / first) * 100);
  const status = change > 0 ? 'ok' : change >= -15 ? 'warning' : 'critical';
  return { id: 'retention', name: 'Player Retention', status, data,
    finding: `Active players ${change >= 0 ? 'up' : 'down'} ${Math.abs(change)}% (${fmt(first)} → ${fmt(last)}) over ${data.length} months.` };
}

async function checkMarketBreakdown(sf, df) {
  const data = await runSQL(`SELECT s.COUNTRY, ROUND(SUM(s.GGR_EUR),0) AS GGR_EUR, `
    + `COUNT(DISTINCT s.PLAYER_ID) AS PLAYERS `
    + `FROM ${BASE_FROM} WHERE ${MF} AND ${sf} AND ${df.detail} `
    + `GROUP BY s.COUNTRY HAVING SUM(s.GGR_EUR) > 0 ORDER BY GGR_EUR DESC LIMIT 15`);
  const total = data.reduce((s,r) => s + (r.GGR_EUR||0), 0);
  const topCountry = data[0] || {};
  const topShare = total > 0 ? Math.round((topCountry.GGR_EUR||0) / total * 100) : 0;
  const status = topShare > 70 ? 'warning' : 'ok';
  return { id: 'market_breakdown', name: 'Market / Country Breakdown', status, data,
    finding: `${data.length} markets. Top: ${topCountry.COUNTRY || '—'} at ${topShare}% of GGR (€${fmt(topCountry.GGR_EUR||0)}).` };
}

async function checkDeviceSplit(sf, df) {
  const data = await runSQL(`SELECT CASE WHEN s.DEVICE_TYPE=0 THEN 'Mobile' WHEN s.DEVICE_TYPE=2 THEN 'Desktop' ELSE 'Unknown' END AS DEVICE, `
    + `ROUND(SUM(s.GGR_EUR),0) AS GGR_EUR, COUNT(DISTINCT s.PLAYER_ID) AS PLAYERS `
    + `FROM ${BASE_FROM} WHERE ${MF} AND ${sf} AND ${df.detail} `
    + `GROUP BY DEVICE ORDER BY GGR_EUR DESC`);
  const total = data.reduce((s,r) => s + (r.GGR_EUR||0), 0);
  const mobile = data.find(r => r.DEVICE === 'Mobile') || {};
  const mobileShare = total > 0 ? Math.round((mobile.GGR_EUR||0) / total * 100) : 0;
  const status = mobileShare < 40 ? 'warning' : 'ok';
  return { id: 'device_split', name: 'Desktop vs Mobile Split', status, data,
    finding: `Mobile: ${mobileShare}% of GGR. Desktop: ${100-mobileShare}%. ${mobileShare < 40 ? 'Mobile underperforming — consider mobile optimization.' : 'Healthy mobile share.'}` };
}

async function checkPromoImpact(sf, df) {
  const data = await runSQL(`SELECT CASE WHEN s.IS_PROMO = TRUE THEN 'Promo' ELSE 'Regular' END AS ROUND_TYPE, `
    + `ROUND(SUM(s.GGR_EUR),0) AS GGR_EUR, ROUND(SUM(s.BETS_EUR),0) AS BETS_EUR `
    + `FROM ${BASE_FROM} WHERE ${MF} AND ${sf} AND ${df.detail} `
    + `GROUP BY ROUND_TYPE ORDER BY ROUND_TYPE`);
  const promo = data.find(r => r.ROUND_TYPE === 'Promo') || { GGR_EUR: 0, BETS_EUR: 0 };
  const reg = data.find(r => r.ROUND_TYPE === 'Regular') || { GGR_EUR: 0, BETS_EUR: 0 };
  const totalBets = (promo.BETS_EUR||0) + (reg.BETS_EUR||0);
  const promoShare = totalBets > 0 ? Math.round((promo.BETS_EUR||0) / totalBets * 100) : 0;
  const status = promoShare > 30 ? 'warning' : 'ok';
  return { id: 'promo_impact', name: 'Promotional Round Impact', status, data,
    finding: `Promo rounds = ${promoShare}% of bets. Promo GGR: €${fmt(promo.GGR_EUR||0)}. ${promoShare > 30 ? 'High promo dependency.' : 'Healthy promo ratio.'}` };
}

async function checkVipBehavior(sf, df) {
  const [top, totals] = await Promise.all([
    runSQL(`SELECT s.PLAYER_ID, ROUND(SUM(s.GGR_EUR),2) AS GGR_EUR, `
      + `ROUND(SUM(s.BETS_EUR),2) AS BETS_EUR, COUNT(*) AS ROUNDS `
      + `FROM ${BASE_FROM} WHERE ${MF} AND ${sf} AND ${df.detail} `
      + `GROUP BY s.PLAYER_ID HAVING SUM(s.GGR_EUR) > 0 ORDER BY GGR_EUR DESC LIMIT 50`),
    runSQL(`SELECT ROUND(SUM(s.GGR_EUR),2) AS TOTAL_GGR, COUNT(DISTINCT s.PLAYER_ID) AS TOTAL_PLAYERS `
      + `FROM ${BASE_FROM} WHERE ${MF} AND ${sf} AND ${df.detail}`)
  ]);
  if (!top.length) return { id: 'vip_behavior', name: 'VIP Player Behavior', status: 'warning', data: [], finding: 'No player data available.' };

  const totalGgrAll = totals[0]?.TOTAL_GGR || 1;
  const totalPlayers = totals[0]?.TOTAL_PLAYERS || top.length;
  const top10 = top.slice(0, 10);
  const top10Ggr = top10.reduce((s, r) => s + (r.GGR_EUR || 0), 0);
  const top50Ggr = top.reduce((s, r) => s + (r.GGR_EUR || 0), 0);
  const top10Share = Math.round(top10Ggr / totalGgrAll * 100);
  const top50Share = Math.round(top50Ggr / totalGgrAll * 100);
  const top10Rounds = top10.reduce((s, r) => s + (r.ROUNDS || 0), 0);
  const top10Bets = top10.reduce((s, r) => s + (r.BETS_EUR || 0), 0);
  const avgBetTop10 = top10Rounds > 0 ? Math.round(top10Bets / top10Rounds * 100) / 100 : 0;
  const status = top10Share > 50 ? 'warning' : 'ok';
  return {
    id: 'vip_behavior', name: 'VIP Player Behavior', status, data: top,
    finding: `Top 10 players = ${top10Share}% of GGR. Top 50 = ${top50Share}% of GGR. Avg bet/round (top 10): €${fmt(avgBetTop10)}. Total unique players: ${fmt(totalPlayers)}.`
  };
}

// ── Check registry ────────────────────────────────────────────────────────

const CHECK_REGISTRY = {
  ggr_trend:         checkGgrTrend,
  concentration:     checkConcentration,
  hidden_gems:       checkHiddenGems,
  benchmark_gap:     checkBenchmarkGap,
  new_launches:      checkNewLaunches,
  open_scan:         checkOpenScan,
  retention:         checkRetention,
  market_breakdown:  checkMarketBreakdown,
  device_split:      checkDeviceSplit,
  promo_impact:      checkPromoImpact,
  vip_behavior:      checkVipBehavior,
};

async function runAnalysis(selection) {
  const sf = scopeFilter(selection);
  const df = buildDateFilters(selection);

  // Which checks to run — from client payload or default all mandatory
  const defaultChecks = ['ggr_trend', 'concentration', 'hidden_gems', 'benchmark_gap', 'new_launches', 'open_scan'];
  const enabledChecks = (selection.enabledChecks && selection.enabledChecks.length > 0)
    ? selection.enabledChecks
    : defaultChecks;

  console.log(`[jedify] Running ${enabledChecks.length} checks for:`, JSON.stringify(selection.values));

  const checks = [];
  for (const checkId of enabledChecks) {
    const fn = CHECK_REGISTRY[checkId];
    if (!fn) {
      checks.push({ id: checkId, name: checkId, status: 'warning', finding: 'Check not implemented yet.', data: [] });
      continue;
    }
    try {
      console.log(`[jedify]   → ${checkId}...`);
      const result = await fn(sf, df);
      checks.push(result);
      console.log(`[jedify]   ✓ ${checkId}: ${result.status}`);
    } catch (e) {
      console.error(`[jedify]   ✗ ${checkId} failed:`, e.message);
      checks.push({ id: checkId, name: checkId, status: 'critical', finding: 'Query failed: ' + e.message, data: [] });
    }
  }

  // Build summary from core checks (for persona tabs)
  const trendCheck = checks.find(c => c.id === 'ggr_trend');
  const concCheck = checks.find(c => c.id === 'concentration');
  const scanCheck = checks.find(c => c.id === 'open_scan');

  return {
    checks,
    summary: {
      monthly: trendCheck ? trendCheck.data : [],
      games: concCheck ? concCheck.data : [],
      brands: scanCheck ? scanCheck.data : [],
    },
    selection,
    generatedAt: new Date().toISOString()
  };
}

// ── Jedify Research Registry (askJedify-powered checks) ──────────────────────
// Each check sends a natural language question to Jedify Research Mode
// and returns { id, name, status, finding, explanation, data, columns, sql, inquiry_id }

function deriveStatus(result) {
  const text = ((result.answer || '') + ' ' + (result.explanation || '')).toLowerCase();
  // Critical signals
  if (/\b(critical|severe|alarming|dramatic decline|significant risk|very high risk)\b/.test(text)) return 'critical';
  if (/\b(declining|dropped|decreased|falling|negative|risk|concern|issue|problem|below|underperform|missing|gap|weak|low)\b/.test(text)) return 'warning';
  if (/\b(strong|growth|growing|increased|improving|healthy|positive|good|excellent|above|outperform)\b/.test(text)) return 'ok';
  return 'ok'; // default
}

function extractFinding(answer) {
  if (!answer) return '—';
  // Take first sentence or first 200 chars
  const firstSentence = answer.match(/^[^.!?]+[.!?]/);
  if (firstSentence && firstSentence[0].length < 200) return firstSentence[0];
  return answer.slice(0, 200) + (answer.length > 200 ? '...' : '');
}

const MAX_RETRIES = 3;

// Retry wrapper for askJedify — retries on timeout/MCP errors up to MAX_RETRIES times
async function askJedifyWithRetry(question, overrides = {}, label = '') {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) console.log(`[jedify-research] Retry ${attempt}/${MAX_RETRIES} for ${label || 'query'}...`);
      return await askJedify(question, overrides);
    } catch (e) {
      lastError = e;
      const isRetryable = e.message.includes('timed out') || e.message.includes('timeout') || e.message.includes('MCP');
      if (!isRetryable || attempt === MAX_RETRIES) throw e;
      console.warn(`[jedify-research] Attempt ${attempt} failed (${e.message}), retrying...`);
    }
  }
  throw lastError;
}

function buildResearchCheck(id, name, questionTemplate) {
  return async function(entity, scope, dateRange) {
    const question = questionTemplate
      .replace(/\{entity\}/g, entity)
      .replace(/\{scope\}/g, scope || 'operator')
      .replace(/\{start\}/g, dateRange.start || 'last 6 months')
      .replace(/\{end\}/g, dateRange.end || 'current month');

    try {
      const result = await askJedifyWithRetry(question, {}, id);
      return {
        id,
        name,
        status: deriveStatus(result),
        finding: extractFinding(result.answer),
        answer: result.answer || '',
        explanation: result.explanation || '',
        data: result.data || [],
        columns: result.columns || [],
        sql: result.sql || '',
        inquiry_id: result.inquiry_id
      };
    } catch (e) {
      console.error(`[research] Check ${id} failed after ${MAX_RETRIES} attempts:`, e.message);
      return {
        id, name,
        status: 'error',
        finding: 'Check failed: ' + e.message,
        answer: '', explanation: '', data: [], columns: [], sql: '', inquiry_id: null
      };
    }
  };
}

const RESEARCH_REGISTRY = {
  ggr_trend: buildResearchCheck('ggr_trend', 'GGR Trend',
    `Analyze the GGR trend for {scope} {entity} over the last 6 months ({start} to {end}). Show monthly breakdown. Is it growing, flat, or declining? What's driving the change? Include month-over-month percentage changes.`),

  concentration: buildResearchCheck('concentration', 'Game Concentration Risk',
    `What is the game concentration risk for {scope} {entity}? Show top 15 games by GGR share. Is any single game dominant? What percentage of total GGR do the top 3 games represent?`),

  hidden_gems: buildResearchCheck('hidden_gems', 'Hidden Gem Games',
    `Find hidden gem games for {scope} {entity} — games with high GGR per player but low overall exposure (low player count relative to their revenue efficiency). Which games deserve more promotion?`),

  benchmark_gap: buildResearchCheck('benchmark_gap', 'Global Benchmark Gap',
    `Compare {scope} {entity}'s top games against the global top 10 games by GGR across all operators. Which globally popular games is this {scope} missing or underperforming on? Quantify the gap.`),

  new_launches: buildResearchCheck('new_launches', 'New Game Launches (90 Days)',
    `Which games has {scope} {entity} started offering in the last 90 days? How are they performing compared to their established games? Are they adopting new content?`),

  open_scan: buildResearchCheck('open_scan', 'Open Opportunity Scan',
    `Provide a brand-level breakdown for {scope} {entity}. Are there any anomalies — brands with unusual GGR/player ratios, sudden drops, or disproportionate concentration?`),

  retention: buildResearchCheck('retention', 'Player Retention',
    `Analyze player retention for {scope} {entity} over the last 6 months. How many active players per month? What's the month-over-month retention rate? Any concerning trends?`),

  vip_behavior: buildResearchCheck('vip_behavior', 'VIP Player Behavior',
    `Analyze VIP/high-value player behavior for {scope} {entity}. Who are the top players by GGR? How concentrated is revenue among top players?`),

  market_breakdown: buildResearchCheck('market_breakdown', 'Market / Country Breakdown',
    `Break down {scope} {entity}'s GGR by country/market. Which markets are growing? Which are declining? Any untapped opportunities?`),

  device_split: buildResearchCheck('device_split', 'Desktop vs Mobile Split',
    `Compare {scope} {entity}'s mobile vs desktop performance. What's the device split by GGR and players? Is the mobile share growing?`),

  promo_impact: buildResearchCheck('promo_impact', 'Promotional Round Impact',
    `Analyze the impact of promotional rounds for {scope} {entity}. What percentage of GGR comes from promo vs regular play? Is promo spend efficient?`),

  revenue_leakage: buildResearchCheck('revenue_leakage', 'Revenue vs GGR Leakage',
    `Compare {scope} {entity}'s theoretical GGR vs actual invoiced revenue. Are there discrepancies suggesting revenue leakage?`),
};

// ── Persona prompt instructions ───────────────────────────────────────────────
const PERSONA_INSTRUCTIONS = {
  qbr_customer:
    'Present this as a customer-facing QBR summary. Use ONLY favorable metrics and positive framing. ' +
    'Show numbers that highlight opportunities or successes (e.g., "this game has 25% better D7 retention ' +
    'than competitors — promote it more prominently"). Format as 5-7 specific, actionable talking points. ' +
    'Never mention negative metrics directly — reframe as opportunities.',

  am_actions:
    'Present this as Account Manager action items for a call with this operator. ' +
    'Be direct and concise. Back each item with ONE concrete number and a market comparison. ' +
    'Example: "Promote Game X — it\'s 0.5% of this operator\'s portfolio but 5% of market GGR. 10× underweighted." ' +
    'Format as a numbered list of 5-8 items.',

  am_detailed:
    'Present this as an Account Manager briefing with full data support. ' +
    'For each recommendation: state the action, the operator\'s relevant numbers, the market comparison, ' +
    'and all data used to arrive at the recommendation. ' +
    'Format: recommendation first, then "Supporting data:" section with the evidence.',

  data_analyst:
    'Present the complete research findings as a comprehensive report suitable for download. ' +
    'Include all discovered metrics, trend data, anomalies, and methodology notes. ' +
    'Use headers for each research area. Completeness and accuracy over brevity.'
};

// ── Build the research prompt for ask_a_research_question ─────────────────────
function buildResearchPrompt(entity, scope, dateRange, enabledOptionalIds, persona, globalRules, checkDefinitions, partialMandatoryIds) {
  const checks = require('./research-checks');
  // partialMandatoryIds=null → full run, use all mandatory
  // partialMandatoryIds=[] → partial run with no mandatory selected, use none
  // partialMandatoryIds=['id1',...] → partial run, use only those
  const mandatoryChecks = Array.isArray(partialMandatoryIds)
    ? checks.mandatory.filter(c => partialMandatoryIds.includes(c.id))
    : checks.mandatory;
  const selectedChecks = [
    ...mandatoryChecks,
    ...checks.optional.filter(c => enabledOptionalIds.includes(c.id))
  ];

  // Append custom checks (not in research-checks.js) that live only in checkDefinitions.
  // These are user-created checks whose IDs start with 'custom_' or simply aren't builtin.
  if (checkDefinitions) {
    const builtinIds = new Set(selectedChecks.map(c => c.id));
    // Custom optional checks passed via enabledOptionalIds
    enabledOptionalIds.forEach(id => {
      if (!builtinIds.has(id) && checkDefinitions[id]) {
        const def = checkDefinitions[id];
        selectedChecks.push({ id, query: def.question || def.query || def.name || id });
        builtinIds.add(id);
      }
    });
    // Custom mandatory checks passed via partialMandatoryIds (partial runs only)
    if (Array.isArray(partialMandatoryIds)) {
      partialMandatoryIds.forEach(id => {
        if (!builtinIds.has(id) && checkDefinitions[id]) {
          const def = checkDefinitions[id];
          selectedChecks.push({ id, query: def.question || def.query || def.name || id });
          builtinIds.add(id);
        }
      });
    }
  }

  // Use user-edited check text if provided (checkDefinitions overrides research-checks.js)
  const bullets = selectedChecks.map(c => {
    const override = checkDefinitions && (checkDefinitions[c.id]?.question || checkDefinitions[c.id]?.query);
    return `• ${override || c.query}`;
  }).join('\n');
  const instruction = PERSONA_INSTRUCTIONS[persona] || PERSONA_INSTRUCTIONS.am_actions;

  const globalSection = globalRules && globalRules.trim()
    ? `Global analysis rules (apply to everything below):\n${globalRules.trim()}\n\n`
    : '';

  return (
    globalSection +
    `Research ${scope} "${entity}" performance from ${dateRange.start} to ${dateRange.end}.\n\n` +
    `Investigate the following:\n${bullets}\n\n` +
    instruction
  );
}

// ── Research stage labels (emitted as polling progresses) ─────────────────────
const RESEARCH_STAGES = [
  'Submitting research request...',
  'Jedify is reading the semantic model...',
  'Querying performance data...',
  'Analyzing trends and patterns...',
  'Building insights...',
  'Drafting recommendations...',
  'Finalizing report...'
];
// STAGE_POLL_AT[i] = minimum poll number before emitting stage i
const STAGE_POLL_AT = [0, 2, 5, 9, 14, 20, 28];

// Active inquiry ID — stored so /api/cancel-research can stop it
let _activeInquiryId = null;

async function askJedifyResearch(prompt, onStage, onHeartbeat, cancelToken, onInquiryId) {
  // Submit the research question
  console.log(`[jedify-research] Submitting ask_a_research_question (prompt length: ${prompt.length})`);
  const askRes = await sendMCP({
    method: 'tools/call',
    params: {
      name: 'ask_a_research_question',
      arguments: { question: prompt }
    }
  }, 120000);

  if (askRes.error) throw new Error('ask_a_research_question error: ' + (askRes.error.message || JSON.stringify(askRes.error)));
  const askText = askRes.result?.content?.[0]?.text;
  if (!askText) throw new Error('Empty response from ask_a_research_question');
  const askParsed = JSON.parse(askText);
  const inquiryId = askParsed.inquiry_id;
  if (!inquiryId) throw new Error('No inquiry_id in response: ' + askText.slice(0, 200));

  _activeInquiryId = inquiryId;
  if (onInquiryId) onInquiryId(inquiryId); // notify caller so it can associate inquiry_id with bgRunId
  const sessionVersionAtStart = getSessionVersion();
  console.log(`[jedify-research] Submitted → inquiry_id=${inquiryId}, session=${sessionVersionAtStart}, polling...`);
  if (onStage) onStage(0, RESEARCH_STAGES[0]);

  // Poll until done (max 30 min at 5s intervals = 360 polls)
  const maxPolls = 360;
  const pollInterval = 5000;
  let stageIdx = 0;

  try {
    for (let i = 1; i <= maxPolls; i++) {
      await new Promise(r => setTimeout(r, pollInterval));

      // Check if cancelled
      if (cancelToken && cancelToken.cancelled) {
        console.log(`[jedify-research] Cancelled at poll ${i}`);
        throw new Error('cancelled');
      }

      // If MCP session reconnected, log it but keep polling — the inquiry lives on Jedify's backend
      // independent of our MCP transport session, so it survives reconnects.
      if (getSessionVersion() !== sessionVersionAtStart) {
        console.warn(`[jedify-research] MCP session changed during poll ${i} (was ${sessionVersionAtStart}, now ${getSessionVersion()}) — continuing to poll inquiry ${inquiryId}`);
      }

      // Send heartbeat every poll to keep SSE connection alive through Render's idle timeout
      if (onHeartbeat) onHeartbeat(i);

      // Advance stage based on poll count
      while (stageIdx + 1 < STAGE_POLL_AT.length && i >= STAGE_POLL_AT[stageIdx + 1]) {
        stageIdx++;
        if (onStage) onStage(stageIdx, RESEARCH_STAGES[stageIdx]);
      }

      try {
        const statusRes = await sendMCP({
          method: 'tools/call',
          params: {
            name: 'check_question_status',
            arguments: { inquiry_id: inquiryId, inquiry_type: 'research' }
          }
        }, 30000);

        if (statusRes.error) { console.warn(`[jedify-research] Poll ${i} statusRes.error:`, statusRes.error); continue; }
        const statusText = statusRes.result?.content?.[0]?.text;
        if (!statusText) { console.warn(`[jedify-research] Poll ${i} no statusText`); continue; }
        const statusParsed = JSON.parse(statusText);

        const generalStatus = statusParsed.status?.general || statusParsed.status;
        const iteration = statusParsed.current_iteration || 0;
        const maxIter = statusParsed.max_iterations || 1;
        const progressPct = Math.round((statusParsed.progress || 0) * 100);
        console.log(`[jedify-research] Poll ${i}: status=${JSON.stringify(generalStatus)} iter=${iteration}/${maxIter} progress=${progressPct}%`);
        // Expose live progress to /api/research-status so client can show a progress indicator
        _bgProgress = { iter: iteration, maxIter, pct: progressPct, elapsedS: i * pollInterval / 1000, inquiryId };

        // Emit real progress stage based on iteration count
        if (onStage && maxIter > 0) {
          const realStageIdx = Math.min(Math.floor((iteration / maxIter) * (RESEARCH_STAGES.length - 2)) + 1, RESEARCH_STAGES.length - 2);
          if (realStageIdx > stageIdx) {
            stageIdx = realStageIdx;
            onStage(stageIdx, RESEARCH_STAGES[stageIdx]);
          }
        }

        if (generalStatus === 'done' || statusParsed.is_complete) {
          const report = statusParsed.final_answer || statusParsed.answer || statusParsed.report || '';
          console.log(`[jedify-research] Done in ${i * pollInterval / 1000}s, report length: ${report.length}`);
          _bgProgress = null; // clear progress — run is done
          if (onStage) onStage(RESEARCH_STAGES.length - 1, RESEARCH_STAGES[RESEARCH_STAGES.length - 1]);
          return report;
        }
      } catch (e) {
        if (e.message === 'cancelled') throw e;
        console.warn(`[jedify-research] Poll ${i} error (continuing):`, e.message);
      }
    }
    throw new Error('Research timed out after ' + (maxPolls * pollInterval / 1000) + 's');
  } finally {
    _activeInquiryId = null;
  }
}

// ── /api/research endpoint — Jedify Research Mode pipeline ──────────────────

// Cancel token for the active research run — set cancelled=true to stop polling
let _cancelToken = null;
// Last completed result — kept in memory so browser can recover if SSE dropped
let _lastCompletedResult = null;
// Per-runId completed results — keyed by runId so concurrent runs don't overwrite each other
const _completedResultsByRunId = new Map(); // runId → result
const _activeRunIds = new Set();             // runIds currently executing
const _bgInquiryByRunId = new Map();         // runId → Jedify inquiry_id (for resume after restart)
// Live progress for the active background run — exposed via /api/research-status
let _bgProgress = null; // { iter, maxIter, pct, elapsed, inquiryId }
// All active SSE response objects — so SIGTERM can notify them before shutdown
const _activeSSeClients = new Set();

async function runResearch(reqBody, onProgress, onInquiryId) {
  const { entity, scope, dateRange, enabledOptionalCheckIds, checkDefinitions, partialMandatoryIds, persona, customPrompt, globalRules } = reqBody;
  const emit = onProgress || (() => {});
  const scopeLabel = scope || 'operator';
  const activePersona = persona || 'am_actions';

  console.log(`[research] Starting research — ${scopeLabel}: "${entity}", persona: ${activePersona}`);

  const prompt = customPrompt || buildResearchPrompt(entity, scopeLabel, dateRange, enabledOptionalCheckIds || [], activePersona, globalRules || '', checkDefinitions || {}, partialMandatoryIds || null);
  console.log(`[research] Prompt ${customPrompt ? '(custom, user-edited)' : '(auto-built)'} (${prompt.length} chars). Submitting to Jedify...`);

  const onStage = (idx, label) => {
    emit({ type: 'stage', index: idx, total: RESEARCH_STAGES.length, label });
  };

  _cancelToken = { cancelled: false };
  const report = await askJedifyResearch(prompt, onStage, (pollNum) => {
    emit({ type: 'heartbeat', poll: pollNum });
  }, _cancelToken, onInquiryId || null);

  console.log(`[research] Research complete. Report length: ${report.length} chars.`);

  _lastCompletedResult = {
    entity,
    scope: scopeLabel,
    persona: activePersona,
    report,
    generatedAt: new Date().toISOString()
  };
  return _lastCompletedResult;
}

// ── HTTP server ─────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 64 * 1024; // 64KB — prompts are ~2KB, this is very generous
const IS_PROD = !!APP_PASSWORD; // treat as production when password is set

const server = http.createServer(async (req, res) => {
  // CORS — restrict to known origin in production, open locally
  const allowedOrigin = APP_URL || (APP_PASSWORD ? null : '*');
  if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // #6 — Request size limit: reject bodies over 64KB before reading
  if (req.method === 'POST') {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request too large.' }));
      return;
    }
  }

  // Health check — always public (Render uses this)
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mcpReady }));
    return;
  }

  // Auth endpoint — public (needed to log in)
  if (req.method === 'POST' && req.url === '/api/auth') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    let body = '';
    req.on('data', c => { if (body.length < 1024) body += c; }); // max 1KB body
    req.on('end', () => {
      try {
        if (!APP_PASSWORD) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token: 'no-auth' }));
          return;
        }
        // Rate limit check
        if (!checkRateLimit(ip)) {
          console.warn(`[auth] Rate limit hit for IP ${ip}`);
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many attempts — try again in 15 minutes.' }));
          return;
        }
        const { password } = JSON.parse(body);
        if (password === APP_PASSWORD) {
          recordAuthSuccess(ip);
          const token = makeAuthToken(APP_PASSWORD);
          console.log(`[auth] Login success from ${ip}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token, expiresIn: TOKEN_TTL_MS }));
        } else {
          console.warn(`[auth] Failed login attempt from ${ip}`);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Wrong password.' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/share/')) {
      const id = req.url.slice('/share/'.length).split('?')[0];
      const share = _shares[id];
      if (!share) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;background:#0D0D0D;color:#fff;"><div style="text-align:center"><h2>Presentation not found</h2><p style="color:#64748B;">This link may have expired.</p></div></body></html>');
        return;
      }
      const slidesJson = JSON.stringify(share.slides)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/\//g, '\\u002f');
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${share.operator} QBR — RubyPlay</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0A0A0A;font-family:system-ui,sans-serif;color:#fff;height:100vh;overflow:hidden;display:flex;flex-direction:column}
  #toolbar{display:flex;align-items:center;gap:12px;padding:10px 20px;background:#111;border-bottom:1px solid #222;flex-shrink:0}
  #toolbar h1{font-size:14px;font-weight:700;color:#fff;flex:1}
  #toolbar span{font-size:12px;color:#64748B}
  #nav-btn{padding:6px 14px;background:#CC0000;color:white;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer}
  #viewer{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:20px}
  #slide-wrap{width:100%;max-width:1280px;position:relative}
  #slide-frame{width:1280px;height:720px;border:none;display:block;transform-origin:top left}
  #thumbs{display:flex;gap:6px;overflow-x:auto;padding:8px 20px;background:#111;border-top:1px solid #222;flex-shrink:0}
  .thumb{flex-shrink:0;width:80px;height:45px;border-radius:4px;cursor:pointer;border:2px solid transparent;background:#1A1A1A;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#64748B;transition:border-color .15s}
  .thumb.active{border-color:#CC0000;color:#CC0000}
  #notes-bar{background:#1A1A1A;padding:8px 20px;font-size:11px;color:#64748B;border-top:1px solid #222;flex-shrink:0;min-height:32px;max-height:60px;overflow:hidden}
</style>
</head>
<body>
<div id="toolbar">
  <h1>RubyPlay \xD7 ${share.operator.toUpperCase()}</h1>
  <span id="slide-counter">1 / ${share.slides.length}</span>
  <button id="nav-btn" onclick="nextSlide()">Next \u2192</button>
</div>
<div id="viewer">
  <div id="slide-wrap">
    <iframe id="slide-frame" srcdoc=""></iframe>
  </div>
</div>
<div id="notes-bar"></div>
<div id="thumbs"></div>
<script>
const slides = ${slidesJson};
let cur = 0;
const frame = document.getElementById('slide-frame');
const wrap  = document.getElementById('slide-wrap');
const counter = document.getElementById('slide-counter');
const notesBar = document.getElementById('notes-bar');

function scale() {
  const w = wrap.offsetWidth;
  const s = w / 1280;
  frame.style.transform = 'scale(' + s + ')';
  wrap.style.height = (720 * s) + 'px';
}

function goTo(i) {
  cur = Math.max(0, Math.min(slides.length - 1, i));
  frame.srcdoc = slides[cur].html || '';
  notesBar.textContent = slides[cur].notes || '';
  counter.textContent = (cur + 1) + ' / ' + slides.length;
  document.getElementById('nav-btn').textContent = cur === slides.length - 1 ? 'Restart' : 'Next \u2192';
  document.querySelectorAll('.thumb').forEach((t, idx) => t.classList.toggle('active', idx === cur));
}

function nextSlide() { goTo(cur === slides.length - 1 ? 0 : cur + 1); }

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === ' ') nextSlide();
  if (e.key === 'ArrowLeft') goTo(cur - 1);
});

const thumbs = document.getElementById('thumbs');
slides.forEach((_, i) => {
  const t = document.createElement('div');
  t.className = 'thumb' + (i === 0 ? ' active' : '');
  t.textContent = i + 1;
  t.onclick = () => goTo(i);
  thumbs.appendChild(t);
});

window.addEventListener('resize', scale);
scale();
goTo(0);
<\/script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

  // All other /api/* routes require authentication
  if (req.url.startsWith('/api/') && !isAuthenticated(req)) {
    return rejectUnauth(res);
  }

  if (req.method === 'GET' && req.url.startsWith('/api/research-status')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const runId = urlObj.searchParams.get('runId');

    if (runId) {
      // Per-run lookup: only return the result for this specific SSE request
      const result = _completedResultsByRunId.get(runId);
      if (result) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } else {
        const active = _activeRunIds.has(runId);
        // Return the specific inquiry_id for this runId (more reliable than the global _activeInquiryId)
        const inquiryId = _bgInquiryByRunId.get(runId) || (active ? _activeInquiryId : null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active, inquiry_id: inquiryId, progress: _bgProgress }));
      }
    } else {
      // Legacy path (no runId) — return last completed result or active status
      if (_lastCompletedResult) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(_lastCompletedResult));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: !!_activeInquiryId, inquiry_id: _activeInquiryId || null }));
      }
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/cancel-research') {
    // Signal the poll loop to stop
    if (_cancelToken) _cancelToken.cancelled = true;

    // Tell Jedify to stop the active inquiry
    if (_activeInquiryId) {
      const idToCancel = _activeInquiryId;
      console.log(`[research] Cancelling inquiry ${idToCancel}`);
      try {
        await sendMCP({
          method: 'tools/call',
          params: { name: 'stop_question', arguments: { inquiry_id: idToCancel } }
        }, 10000);
        console.log(`[research] Jedify stop_question sent for ${idToCancel}`);
      } catch (e) {
        console.warn(`[research] stop_question error (ignored):`, e.message);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cancelled: _activeInquiryId || 'none' }));
    return;
  }

  // Resume polling an existing Jedify inquiry after server restart.
  // The inquiry lives on Jedify's backend and survives our server restarts.
  if (req.method === 'POST' && req.url === '/api/resume-inquiry') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { runId, inquiryId } = JSON.parse(body);
        if (!runId || !inquiryId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing runId or inquiryId' }));
          return;
        }
        // If already completed or already active, don't start a duplicate
        if (_completedResultsByRunId.has(runId) || _activeRunIds.has(runId)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: 'already_tracked' }));
          return;
        }
        console.log(`[resume-inquiry] Resuming polling for runId=${runId} inquiryId=${inquiryId}`);
        _activeRunIds.add(runId);
        _bgInquiryByRunId.set(runId, inquiryId);
        _activeInquiryId = inquiryId;
        // Poll the existing inquiry until done
        (async () => {
          const maxPolls = 360;
          const pollInterval = 5000;
          try {
            for (let i = 1; i <= maxPolls; i++) {
              await new Promise(r => setTimeout(r, pollInterval));
              try {
                const statusRes = await sendMCP({
                  method: 'tools/call',
                  params: { name: 'check_question_status', arguments: { inquiry_id: inquiryId, inquiry_type: 'research' } }
                }, 30000);
                if (statusRes.error) continue;
                const sp = JSON.parse(statusRes.result?.content?.[0]?.text || '{}');
                const iter = sp.current_iteration || 0;
                const maxIter = sp.max_iterations || 1;
                const pct = Math.round((sp.progress || 0) * 100);
                _bgProgress = { iter, maxIter, pct, elapsedS: i * pollInterval / 1000, inquiryId };
                const done = (sp.status?.general || sp.status) === 'done' || sp.is_complete;
                console.log(`[resume-inquiry] poll ${i}: iter=${iter}/${maxIter} pct=${pct}% done=${done}`);
                if (done) {
                  const report = sp.final_answer || sp.answer || sp.report || '';
                  const result = { report, persona: 'data_analyst', generatedAt: new Date().toISOString() };
                  _completedResultsByRunId.set(runId, result);
                  _lastCompletedResult = result;
                  _bgProgress = null;
                  console.log(`[resume-inquiry] Done. report=${report.length} chars`);
                  break;
                }
              } catch (e) { console.warn(`[resume-inquiry] poll ${i} error:`, e.message); }
            }
          } finally {
            _activeRunIds.delete(runId);
            _bgInquiryByRunId.delete(runId);
            _activeInquiryId = null;
          }
        })();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, runId, inquiryId }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/research-config') {
    const checks = require('./research-checks');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(checks));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/build-prompt') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prompt }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Markets dropdown data (cached)
  if (req.method === 'GET' && req.url === '/api/markets') {
    if (!mcpReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MCP not ready yet.' }));
      return;
    }
    try {
      const now = Date.now();
      if (_marketsCache.data && (now - _marketsCache.fetchedAt) < MARKETS_CACHE_TTL) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ markets: _marketsCache.data }));
        return;
      }
      console.log('[markets] Fetching distinct countries...');
      // Use lightweight query on fact table only — no heavy joins needed for country list
      const rows = await runSQL(`
        SELECT DISTINCT COUNTRY
        FROM IN_RUBYPLAY.JEDIFY.FACT_SPINS_AGGREGATED_ALL_V
        WHERE COUNTRY IS NOT NULL AND COUNTRY != ''
        ORDER BY COUNTRY
      `, 500);
      const markets = rows.map(r => r.COUNTRY).filter(Boolean);
      _marketsCache = { data: markets, fetchedAt: Date.now() };
      console.log(`[markets] Found ${markets.length} markets`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ markets }));
    } catch (err) {
      console.error('[markets] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/api/jurisdictions') {
    if (!mcpReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MCP not ready yet.' }));
      return;
    }
    try {
      const now = Date.now();
      if (_jurisdictionsCache.data && (now - _jurisdictionsCache.fetchedAt) < JURISDICTIONS_CACHE_TTL) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jurisdictions: _jurisdictionsCache.data }));
        return;
      }
      console.log('[jurisdictions] Fetching distinct jurisdictions...');
      const rows = await runSQL(`
        SELECT DISTINCT e.JURISDICTION
        FROM IN_RUBYPLAY.JEDIFY.ENTITIES_V e
        WHERE e.JURISDICTION IS NOT NULL AND e.JURISDICTION != ''
        ORDER BY e.JURISDICTION
      `, 200);
      const jurisdictions = rows.map(r => r.JURISDICTION).filter(Boolean);
      _jurisdictionsCache = { data: jurisdictions, fetchedAt: Date.now() };
      console.log(`[jurisdictions] Found ${jurisdictions.length} jurisdictions`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jurisdictions }));
    } catch (err) {
      console.error('[jurisdictions] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/analyze') {
    if (!mcpReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MCP not ready yet. Try again in a few seconds.' }));
      return;
    }

    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const selection = JSON.parse(body); // { scope, values: string[] }
        const results = await runAnalysis(selection);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
      } catch (err) {
        console.error('[jedify] Analysis error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Jedify Research Pipeline — full analysis via Jedify Research Mode (with SSE streaming)
  if (req.method === 'POST' && req.url === '/api/research') {
    console.log(`[research-handler] POST /api/research received — mcpReady=${mcpReady}`);
    if (!mcpReady) {
      console.log(`[research-handler] Rejected: MCP not ready`);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MCP not ready yet. Try again in a few seconds.' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const reqBody = JSON.parse(body);
        // Build entity name and scope from selection payload
        const entity = reqBody.entity || ((reqBody.values && reqBody.values.length > 0) ? reqBody.values.join(', ') : reqBody.operator || 'Unknown');
        const scope = reqBody.scope || 'operator';
        const endMonth = reqBody.endMonth || '';
        const monthsBack = parseInt(reqBody.monthsBack) || 6;
        let startLabel = '', endLabel = '';
        if (endMonth && /^\d{4}-\d{2}$/.test(endMonth)) {
          const [y, m] = endMonth.split('-').map(Number);
          const endDate = new Date(y, m - 1, 1);
          const startDate = new Date(y, m - monthsBack, 1);
          startLabel = startDate.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
          endLabel = endDate.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
        } else {
          endLabel = 'current month';
          startLabel = `${monthsBack} months ago`;
        }
        const dateRange = { start: startLabel, end: endLabel };
        const enabledOptionalCheckIds = reqBody.enabledOptionalCheckIds || [];
        const persona = reqBody.persona || 'am_actions';
        const noSSE = !!reqBody.noSSE; // background mode: return plain JSON, no SSE stream

        if (noSSE) {
          // Fire-and-forget: return a backgroundRunId immediately so the client can poll.
          // This avoids holding a long HTTP connection open through Render's proxy timeout.
          const bgRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ backgroundRunId: bgRunId }));
          // Run async — store result in the same per-runId map used by /api/research-status
          _activeRunIds.add(bgRunId);
          runResearch(
            { ...reqBody, entity, scope, dateRange, enabledOptionalCheckIds, persona },
            null,
            (inquiryId) => {
              // Inquiry submitted to Jedify — store id so client can resume if server restarts
              _bgInquiryByRunId.set(bgRunId, inquiryId);
              console.log(`[noSSE background] Run ${bgRunId} → Jedify inquiry ${inquiryId}`);
            }
          )
            .then(results => {
              _completedResultsByRunId.set(bgRunId, results);
              _lastCompletedResult = results;
              _activeRunIds.delete(bgRunId);
              _bgInquiryByRunId.delete(bgRunId);
              if (_completedResultsByRunId.size > 20) {
                _completedResultsByRunId.delete(_completedResultsByRunId.keys().next().value);
              }
              console.log(`[noSSE background] Run ${bgRunId} complete, report: ${results?.report?.length ?? 0} chars`);
            })
            .catch(err => {
              _activeRunIds.delete(bgRunId);
              _bgInquiryByRunId.delete(bgRunId);
              console.error(`[noSSE background] Run ${bgRunId} failed:`, err.message);
            });
          return;
        }

        // SSE streaming — send progress events as each check completes
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'  // disable nginx buffering if behind proxy
        });

        // Generate a unique runId so the polling fallback can find THIS run's result
        // even when concurrent runs (e.g. data_analyst background) complete first
        runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        _activeRunIds.add(runId);
        // Clear stale _lastCompletedResult so a leftover result from a previous run
        // isn't returned to a new polling client before this run completes
        _lastCompletedResult = null;

        // Track this client so SIGTERM can notify it
        _activeSSeClients.add(res);
        res.on('close', () => _activeSSeClients.delete(res));

        // Send runId as the very first event so the client can use it when polling
        res.write(`data: ${JSON.stringify({ type: 'run_started', runId })}\n\n`);

        const onProgress = (evt) => {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        };

        const results = await runResearch({ ...reqBody, entity, scope, dateRange, enabledOptionalCheckIds, persona }, onProgress);
        // Store result keyed by runId BEFORE sending the final SSE event
        _completedResultsByRunId.set(runId, results);
        _activeRunIds.delete(runId);
        // Limit map size — keep at most 20 completed results
        if (_completedResultsByRunId.size > 20) {
          _completedResultsByRunId.delete(_completedResultsByRunId.keys().next().value);
        }
        // Send final result as the last event
        _activeSSeClients.delete(res);
        res.write(`data: ${JSON.stringify({ type: 'result', data: results })}\n\n`);
        res.end();
      } catch (err) {
        console.error('[research] Pipeline error:', err);
        if (runId) _activeRunIds.delete(runId); // runId may be undefined if error was in noSSE path
        _activeSSeClients.delete(res);
        // If headers already sent (SSE mode), send error as event
        if (res.headersSent) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
          res.end();
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  // Competitive Intelligence endpoint — standalone comparison with SSE streaming
  if (req.method === 'POST' && req.url === '/api/competitive') {
    if (!mcpReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MCP not ready yet.' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const params = JSON.parse(body);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        const onProgress = (evt) => {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        };
        const result = await runCompetitiveAnalysis(params, onProgress);
        res.write(`data: ${JSON.stringify({ type: 'result', data: result })}\n\n`);
        res.end();
      } catch (err) {
        console.error('[competitive] Error:', err);
        if (res.headersSent) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
          res.end();
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  // Test Jedify Research Mode (single question)
  if (req.method === 'POST' && req.url === '/api/ask') {
    if (!mcpReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MCP not ready' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { question, prompts_overrides } = JSON.parse(body);
        const result = await askJedify(question, prompts_overrides || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error('[jedify] Ask error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Serve the HTML frontend
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const htmlPath = path.join(__dirname, 'insight-loop-prototype.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500); res.end('Failed to load HTML: ' + e.message);
    }
    return;
  }

  // Serve the Data Agent Builder frontend
  if (req.method === 'GET' && (req.url === '/builder' || req.url === '/builder.html')) {
    const htmlPath = path.join(__dirname, 'data-agent-builder.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500); res.end('Failed to load HTML: ' + e.message);
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/generate-slides') {
    // Validate before starting the stream
    if (!process.env.ANTHROPIC_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY env var not set on server.' }));
      return;
    }
    if (!isAuthenticated(req)) { rejectUnauth(res); return; }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
        return;
      }

      const { sections, brief, operator, slidePlan, templateId } = parsed;
      const template = _templates.find(t => t.id === templateId) || _templates.find(t => t.id === 'default') || buildDefaultTemplate();
      if (!sections || !sections.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No sections provided' }));
        return;
      }

      // Start streaming response immediately — keeps connection alive during long generation
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',      // Tell Render/nginx NOT to buffer — critical for streaming
        'X-Content-Type-Options': 'nosniff'
      });
      // flushHeaders() sends HTTP headers to the client immediately, before any body data.
      // This resolves the browser's await fetch() right away so the elapsed timer can start.
      // Without this, Node.js + Render's nginx both buffer until enough bytes accumulate.
      res.flushHeaders();

      // Send a newline heartbeat every 15s during TTFT so the connection stays alive.
      // The parser ignores whitespace — only <SLIDE_START>/<SLIDE_END> delimiters matter.
      const _heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write('\n');
      }, 15000);

      try {
        await streamSlidesToResponse(sections, brief || {}, operator || 'Operator', res, slidePlan || null, template);
      } catch (e) {
        console.error('[generate-slides] Stream error:', e.message);
        res.write(`<GENERATION_ERROR>${e.message}</GENERATION_ERROR>`);
      } finally {
        clearInterval(_heartbeat);
      }
      res.end();
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/preview-prompt') {
    if (!isAuthenticated(req)) { rejectUnauth(res); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { sections, brief, operator, slidePlan, templateId } = JSON.parse(body);
        const template = _templates.find(t => t.id === templateId) || _templates.find(t => t.id === 'default') || buildDefaultTemplate();
        const { systemPrompt, userPrompt } = buildSlidesPrompt(sections || [], brief || {}, operator || 'Operator', slidePlan || null, template);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ systemPrompt, userPrompt }));
      } catch (e) {
        console.error('[preview-prompt] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/regenerate-slide') {
    if (!process.env.ANTHROPIC_API_KEY) { res.writeHead(500); res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' })); return; }
    if (!isAuthenticated(req)) { rejectUnauth(res); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const { slideTitle, slideDescription, brief, operator, sections, instructions } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      try {
        await streamSingleSlide({ slideTitle, slideDescription, brief, operator, sections, instructions }, res);
      } catch (e) {
        res.write(`<GENERATION_ERROR>${e.message}</GENERATION_ERROR>`);
      }
      res.end();
    });
    return;
  }

  // GET /api/templates — list all templates (no auth required)
  if (req.method === 'GET' && req.url === '/api/templates') {
    const list = _templates.map(({ id, name, isDefault, slides, brand, createdAt, updatedAt }) => ({
      id, name, isDefault, slideCount: slides.length, createdAt, updatedAt,
      brandPrimary: brand?.primary || null,
      brandLogoBase64: brand?.logoBase64 || null
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // POST /api/templates — create a new template
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

  // GET /api/templates/:id — get full template (no auth required)
  if (req.method === 'GET' && req.url.startsWith('/api/templates/')) {
    const id = req.url.slice('/api/templates/'.length);
    const t = _templates.find(t => t.id === id);
    if (!t) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(t));
    return;
  }

  // PUT /api/templates/:id — update a template
  if (req.method === 'PUT' && req.url.startsWith('/api/templates/')) {
    if (!isAuthenticated(req)) { rejectUnauth(res); return; }
    const id = req.url.slice('/api/templates/'.length);
    const idx = _templates.findIndex(t => t.id === id);
    if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const patch = JSON.parse(body);
      _templates[idx] = { ..._templates[idx], ...patch, updatedAt: new Date().toISOString() };
      await persistTemplates();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // DELETE /api/templates/:id — delete a template
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

  // Token health check
  if (req.method === 'GET' && req.url === '/api/token-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getTokenStatus()));
    return;
  }

    // GET /api/operator-notes/:operator
    if (req.method === 'GET' && req.url.startsWith('/api/operator-notes/')) {
      const op = decodeURIComponent(req.url.slice('/api/operator-notes/'.length));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ notes: _operatorNotes[op] || '' }));
      return;
    }

    // PUT /api/operator-notes/:operator
    if (req.method === 'PUT' && req.url.startsWith('/api/operator-notes/')) {
      if (!isAuthenticated(req)) { rejectUnauth(res); return; }
      const op = decodeURIComponent(req.url.slice('/api/operator-notes/'.length));
      let body = '';
      req.on('data', c => {
        body += c;
        if (body.length > 32768) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Notes too large' }));
          req.destroy();
        }
      });
      req.on('end', async () => {
        try {
          const { notes } = JSON.parse(body);
          if (notes && notes.trim()) {
            _operatorNotes[op] = notes.trim();
          } else {
            delete _operatorNotes[op];
          }
          await persistOperatorNotes();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/share') {
      if (!isAuthenticated(req)) { rejectUnauth(res); return; }
      let body = '';
      req.on('data', c => {
        body += c;
        if (body.length > 10 * 1024 * 1024) { res.writeHead(413); res.end(JSON.stringify({ error: 'Too large' })); req.destroy(); }
      });
      req.on('end', async () => {
        try {
          const { operator, slides } = JSON.parse(body);
          const id = Math.random().toString(36).slice(2, 10);
          _shares[id] = { id, operator: escHtml((operator || 'Operator').slice(0, 200)), createdAt: new Date().toISOString(), slides: slides || [] };
          await persistShares();
          const host = req.headers.host || 'localhost:3001';
          const protocol = req.headers['x-forwarded-proto'] || 'https';
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id, url: `${protocol}://${host}/share/${id}` }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request' }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/presentations') {
      if (!isAuthenticated(req)) { rejectUnauth(res); return; }
      let body = '';
      req.on('data', c => {
        body += c;
        if (body.length > 10 * 1024 * 1024) { res.writeHead(413); res.end(JSON.stringify({ error: 'Too large' })); req.destroy(); }
      });
      req.on('end', async () => {
        try {
          const { operator, slides, brief } = JSON.parse(body);
          const id = 'pres_' + Date.now();
          const entry = {
            id,
            operator: (operator || 'Operator').slice(0, 200),
            date: new Date().toISOString(),
            slideCount: (slides || []).length,
            title: (brief?.context || brief?.angle || 'QBR').slice(0, 200),
            brief: { context: brief?.context || '', angle: brief?.angle || '', ask: brief?.ask || '' },
            slides: (slides || []).map(s => ({ html: s.html || '', notes: s.notes || '' }))
          };
          _presentationHistory.unshift(entry);
          if (_presentationHistory.length > 50) _presentationHistory = _presentationHistory.slice(0, 50);
          await persistHistory();
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request' }));
        }
      });
      return;
    }

    if (req.method === 'DELETE' && req.url.startsWith('/api/presentations/')) {
      if (!isAuthenticated(req)) { rejectUnauth(res); return; }
      const id = req.url.slice('/api/presentations/'.length);
      _presentationHistory = _presentationHistory.filter(p => p.id !== id);
      await persistHistory();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/presentations')) {
      if (!isAuthenticated(req)) { rejectUnauth(res); return; }
      const urlObj = new URL(req.url, 'http://localhost');
      const operator = urlObj.searchParams.get('operator');
      if (urlObj.pathname === '/api/presentations') {
        const list = _presentationHistory
          .filter(p => !operator || p.operator === operator)
          .map(({ id, operator, date, slideCount, title, brief }) => ({ id, operator, date, slideCount, title, brief }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
      }
      const id = urlObj.pathname.slice('/api/presentations/'.length);
      const pres = _presentationHistory.find(p => p.id === id);
      if (!pres) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pres));
      return;
    }

  res.writeHead(404); res.end('Not found');
});

// ── #8 — Sanitize error responses in production ──────────────────────────────
// Wrap the server handler so any unhandled throw returns a generic 500,
// not a stack trace.
const _originalHandler = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', async (req, res) => {
  try {
    await _originalHandler(req, res);
  } catch (err) {
    console.error('[server] Unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: IS_PROD ? 'Internal server error.' : err.message
      }));
    }
  }
});

// Catch unhandled promise rejections — log but don't crash
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
  // Don't exit — let Render's health checks decide if restart is needed
});

// ── Graceful shutdown — notify browser before Render kills the process ───────
process.on('SIGTERM', () => {
  console.log('[jedify] SIGTERM received — notifying active SSE clients and shutting down...');

  // Cancel any running Jedify inquiry
  if (_cancelToken) _cancelToken.cancelled = true;

  // Notify every connected browser so they show a helpful message instead of silence
  const msg = JSON.stringify({
    type: 'error',
    error: 'Server is restarting (new deploy). Please wait ~30 seconds then run again.'
  });
  for (const client of _activeSSeClients) {
    try { client.write(`data: ${msg}\n\n`); client.end(); } catch (_) {}
  }
  _activeSSeClients.clear();

  // Give in-flight responses a moment to flush, then exit
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
});

// ── Boot ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await initMCP();
    mcpReady = true;
  } catch (e) {
    console.error('[jedify] Init failed:', e.message);
    console.error('[jedify] Make sure JEDIFY_REFRESH_TOKEN env var is set.');
    process.exit(1);
  }

  server.timeout = 180000; // 3-minute request timeout (18-slide AI generation can take ~60s)
  server.listen(PORT, () => {
    console.log(`\n[jedify] Server running → http://localhost:${PORT}`);
    console.log(`[jedify] Mode: direct HTTP${process.env.JEDIFY_REFRESH_TOKEN ? ' (cloud)' : ' (local)'}`);
  });
})();
