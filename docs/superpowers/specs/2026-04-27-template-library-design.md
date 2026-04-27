# Template Library — Design Spec

## Context
The Account Manager Copilot presentation builder has hardcoded slide definitions and a single brand template upload. This feature replaces both with a named template library — shared server-side, visible to all team members. The current hardcoded slides become the built-in "RubyPlay Default" template. A new Step 0 is added to the wizard for template selection. Step 3 (Preview) gains per-slide editing.

## Template Data Model

```js
{
  id: string,           // uuid or 'default'
  name: string,         // e.g. "RubyPlay Default", "BetPlay QBR"
  isDefault: boolean,   // true = built-in, cannot be deleted
  slides: [{ title: string, description: string }],
  brand: {
    primary: string, accent: string, background: string,
    highlight: string, text: string,
    fontHeading: string, fontBody: string,
    logoBase64: string | null  // in-memory only, not persisted
  },
  createdAt: string,
  updatedAt: string
}
```

**Storage:** In-memory array + `TEMPLATES_JSON` Render env var (logos excluded to avoid size limits).

## Server Endpoints

| Method | URL | Purpose |
|--------|-----|---------|
| GET | `/api/templates` | List all (summary: id, name, slideCount, updatedAt) |
| GET | `/api/templates/:id` | Full template including slides + brand |
| POST | `/api/templates` | Create new template |
| PUT | `/api/templates/:id` | Update (rename, edit slides) |
| DELETE | `/api/templates/:id` | Delete (403 if isDefault) |
| POST | `/api/regenerate-slide` | Regenerate a single slide (streaming) |

`/api/generate-slides` updated to accept `templateId` and use that template's slides + brand.

## .pptx Parsing (client-side, JSZip)

Extends existing `_pptxHandleFile`. Phase 4 added after existing color/font/logo extraction:

For each `ppt/slides/slide{N}.xml`:
- **Title**: text from `<p:sp>` where `<p:ph type="title">` or `<p:ph type="ctrTitle">`
- **Description**: text from all other `<p:sp>` text runs, trimmed to 300 chars
- Skip slides with no title

Stored as `_pptxExtracted.slides = [{ title, description }]`.

## Wizard: 4-Step Flow

`0 TEMPLATE → 1 STORY BRIEF → 2 SLIDE PLAN → 3 PREVIEW`

### Step 0 — Template Picker
- Lists all templates (name, slide count, updated date)
- "RubyPlay Default" has ★, no delete button
- Each custom template: Rename (inline), Delete (with confirm)
- Upload new .pptx → name it → POST /api/templates
- Edit button → inline slide editor (title + description per slide, reorder, add, remove)
- "Next →" carries selectedTemplateId into Steps 1–3

### Step 1 — Story Brief
Unchanged.

### Step 2 — Slide Plan
- No more Standard/Template toggle — one active template defines the slide list
- Shows template slides with checkboxes (enable/disable per run)
- Custom slides section unchanged

### Step 3 — Preview + Edit

**Thumbnail strip:** drag to reorder, × to remove, + to add

**Right-side action panel (per slide):**
- ✏️ Edit text — DOM-parse slide HTML, show text elements as inputs, re-inject on Apply
- ↺ Regenerate — instructions textarea → POST /api/regenerate-slide → update that slide only
- 🗑 Remove — remove from _pptxSlides array
- Presenter notes — editable textarea

## Removed
- Existing "Brand Template" section (HTML lines 744–786) — absorbed into Step 0
- `/api/upload-template` and `/api/get-template` server endpoints

## Logo Persistence Note
Logos are kept in memory only. Not written to TEMPLATES_JSON env var (too large). Lost on server restart; user re-uploads .pptx when needed.

## Verification Checklist
1. Step 0 shows "RubyPlay Default" selected on open
2. Upload branded .pptx → slide count extracted correctly
3. Edit template → change description → save → persists
4. Select custom template → generate → uses template brand + slides
5. Step 3 drag reorder → download → new slide order in .pptx
6. Regenerate one slide → only that slide changes
7. Edit text → Apply → slide preview updates
8. Delete template → reverts to Default
9. Try delete Default → blocked (403)
10. Server restart → templates still present (env var)
