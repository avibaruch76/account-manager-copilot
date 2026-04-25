# Presentation Builder — Design Spec
**Date:** 2026-04-25  
**Status:** Approved  
**Feature:** Generate SCR-structured .pptx presentations from analysis results

---

## Overview

After an analysis completes, account managers can generate a professional PowerPoint presentation directly from the tool. The narrative follows the **Situation → Complication → Resolution (SCR)** structure used in McKinsey decks and TED talks. The AM shapes the story angle through a brief before generating. Slides use the team's brand colours extracted from an uploaded .pptx template stored on the server.

No external presentation tools required. No manual copy-paste. The .pptx downloads directly from the browser.

---

## User Flow (6 Steps)

### Step 1 — Trigger
After analysis completes, a **"✦ Create Presentation"** button appears in the output toolbar alongside the existing PDF and Word buttons. Clicking it opens the Presentation Builder panel (slides in from the right, full-height overlay).

### Step 2 — Section Picker
A grid of cards, one per check that ran in the analysis. The client identifies which checks ran by reading `window._currentRunCheckIds` (already populated by `fetchJedifyAnalysis`). Each card shows:
- Check name (from `_checks` array) and one-line description
- Pre-ticked for all checks by default — AM unchecks anything irrelevant to this meeting
- The full report text is sent as `content` for each selected check; the server prompt instructs Claude to extract the relevant finding from it

The section picker is shown first so the AM's selections can inform the Story Brief (choosing "Benchmark Gap" over "Promo Impact" already signals the narrative angle).

### Step 3 — Story Brief
Three inputs, all optional but strongly encouraged:

1. **Angle (free text)** — Plain English paragraph describing the story the AM wants to tell. Example: *"Strong growth but only 12% of market potential. Frame as opportunity. Competitor PlayAGS at 31%."*
2. **Tone pill** — Single-select: 🚀 Opportunity · ⚠️ Risk · 📈 Growth Story · 🔄 Recovery
3. **The Ask** — One sentence: what does the AM need from this meeting? Example: *"Approve 3 studio launches this quarter."*

All three are concatenated into a framing instruction prepended to the Claude prompt.

### Step 4 — Claude API Generation (~5 seconds)
A new server endpoint `/api/generate-slides` receives:
- `sections`: array of `{ checkId, checkName, content }` for each ticked section
- `brief`: `{ angle, tone, ask }`
- `operator`: entity name and date range

Brand colours are NOT sent to the server — they are applied entirely client-side by PptxGenJS. Claude only generates text and structure.

The server calls Claude API (`claude-3-5-haiku-20241022` for speed and cost) with a structured prompt instructing it to return a JSON array of slide objects with no markdown wrapping. Each slide object:

```json
[
  { "type": "title",        "headline": "...", "subtitle": "...",                              "notes": "..." },
  { "type": "situation",   "title": "...",    "bullets": ["..."],                             "notes": "..." },
  { "type": "complication","title": "...",    "bullets": ["..."],   "dataPoint": "...",       "notes": "..." },
  { "type": "supporting",  "title": "...",    "bullets": ["..."],                             "notes": "..." },
  { "type": "resolution",  "title": "...",    "actions": [{ "label": "...", "outcome": "..." }], "notes": "..." },
  { "type": "ask",         "cta": "...",      "next_steps": ["..."],                          "notes": "..." }
]
```

`notes` is a 2–3 sentence talking track for every slide, readable in PowerPoint Presenter View.

Supporting slides (one per major selected section) are inserted between Complication and Resolution. Slide count: 5–8 depending on sections selected.

### Step 5 — HTML Preview
The client receives the slide JSON and renders an HTML preview:
- **Thumbnail strip** across the top (click to navigate)
- **Active slide** below, full-width, using brand colours
- **"← Edit Brief"** button — returns to Step 3 with fields pre-populated
- **"⬇ Download .pptx"** button — proceeds to Step 6

The HTML preview uses inline CSS matching the brand colour palette. It is not the .pptx — it is a faithful visual representation for review only.

### Step 6 — .pptx Download
PptxGenJS runs entirely in the browser. It reads the slide JSON and the brand template (colours + logo image fetched from server) and generates a real Office Open XML `.pptx` file. Download is triggered automatically.

Filename format: `{OperatorName}_QBR_{MonthYear}.pptx` (e.g. `Codere_MX_QBR_Apr2026.pptx`).

---

## Brand Template System

### Upload (Admin one-time setup)
A **"Brand Template"** section in the Settings/Config screen allows uploading a `.pptx` file. The file is read in the browser using **JSZip**:
- `ppt/theme/theme1.xml` → extract colour scheme (dk1, dk2, lt1, lt2, accent1–6)
- `ppt/media/` → extract logo image (largest image file, assumed to be the logo)
- `ppt/slideMasters/slideMaster1.xml` → extract font names (latin typeface)

Extracted data is shown as an editable preview (colour swatches, logo thumbnail, font names). Each colour swatch is clickable to adjust. After confirmation, the data is POSTed to `/api/upload-template` and stored server-side.

### Server Storage
Render's filesystem is ephemeral — files written to disk are wiped on every redeploy. The brand template is therefore stored as a `BRAND_TEMPLATE` environment variable on Render (a JSON string). The server reads it at startup and holds it in memory. Uploading a new template POSTs to `/api/upload-template`, which writes the JSON string back to the env var via the Render API (requires a `RENDER_API_KEY` and `RENDER_SERVICE_ID` env var), then updates the in-memory value immediately so the change takes effect without a redeploy.

In-memory shape (same as what's returned by `/api/get-template`):
```json
{
  "primary":    "#1E2761",
  "accent":     "#7C3AED",
  "background": "#FFFFFF",
  "highlight":  "#F59E0B",
  "text":       "#1E293B",
  "logoBase64": "data:image/png;base64,...",
  "fontHeading": "Calibri",
  "fontBody":    "Calibri",
  "uploadedAt": "2026-04-25T10:00:00Z"
}
```

### Retrieval
`GET /api/get-template` returns the in-memory template JSON. Called by the client when the Presentation Builder panel opens. If `BRAND_TEMPLATE` env var is not set, a hardcoded default colour scheme is returned so the feature works out of the box.

---

## New Server Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/generate-slides` | POST | Calls Claude API, returns slide JSON array |
| `/api/upload-template` | POST | Saves extracted brand template to `brand-template.json` |
| `/api/get-template` | GET | Returns current brand template JSON |

### `/api/generate-slides` detail
- Requires auth (same Bearer token as all other endpoints)
- Body: `{ sections, brief, operator, dateRange }`
- Calls `claude-3-5-haiku-20241022` via Anthropic SDK
- Returns: `{ slides: [...] }` or `{ error: "..." }`
- Timeout: 30 seconds
- The Claude prompt instructs strict JSON output only (no markdown wrapping)

**Requires:** `ANTHROPIC_API_KEY` environment variable set on Render.

---

## Client Architecture

All presentation builder code lives in a single self-contained `<script>` block and a `<div id="presentation-builder-overlay">` in `insight-loop-prototype.html`. No new files.

Key functions:
- `openPresentationBuilder()` — opens panel, loads template from server, renders section picker
- `buildStoryBrief()` — renders Step 3 UI, returns `{ angle, tone, ask }`
- `generateSlides(sections, brief)` — POSTs to `/api/generate-slides`, shows spinner
- `renderSlidePreview(slides, template)` — renders HTML preview with thumbnail strip
- `downloadPptx(slides, template)` — uses PptxGenJS to generate and trigger download

PptxGenJS loaded via CDN on demand (only when Presentation Builder is first opened, not on page load).

---

## Slide Design System

Each slide type has a fixed layout implemented in both the HTML preview and PptxGenJS:

| Slide type | Layout |
|------------|--------|
| `title` | Full-bleed brand primary colour, logo top-left, headline centred, subtitle below |
| `situation` | White background, brand primary header bar, headline + 3 bullets |
| `complication` | White background, accent-coloured left border, bold data point highlighted in accent colour |
| `supporting` | White background, standard header, bullet list with brand accent bullets |
| `resolution` | Split: left panel (brand primary) with action labels, right panel (white) with outcomes |
| `ask` | Full-bleed brand primary, large CTA text centred, next steps in smaller text below |

---

## What Is Not In Scope

- Editing individual slide text after generation (PowerPoint handles that)
- Multiple saved templates (one brand template per deployment)
- Sharing or emailing the deck from within the app
- Presenter mode or slideshow within the browser
- Any changes to the existing analysis pipeline

---

## Files Changed

| File | Change |
|------|--------|
| `insight-loop-prototype.html` | Add presentation builder overlay, CSS, and JS functions |
| `jedify-server.js` | Add `/api/generate-slides`, `/api/upload-template`, `/api/get-template` |
| `brand-template.json` | Created on first template upload (gitignored) |

**No changes to:** `research-checks.js`, existing API endpoints, auth system.
