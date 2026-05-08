# Plan: Models / Agents / AI-Decided Presentations

**Status**: design locked, not yet built
**Date**: 2026-05-08
**Context**: Phase 2 of the deck-generation system. Phase 1 (fixed 13-slide
QBR + per-operator manual data + per-Agent slide_list + heading-regex
classifier) is shipped and working.

---

## Vocabulary (final)

```
Model        = the FAMILY / template / look
               ├── brand (logo, colors, footer)
               ├── catalog of *available* slides for this kind of deck
               └── default check pool

Agent        = an instance under a Model
               ├── checks (which to run)
               ├── PRESENTATION = chosen slides + their order +
               │                  per-slide data binding + per-slide type
               ├── prompts / tone overrides
               └── manual_data lookup key

Generated .pptx = ephemeral output (Analysis × Agent → render)
```

**Hard rules:**

- Agent always has a Model (no modelless agents). A built-in `Custom`
  Model exists for true snowflake agents — the requirement feels invisible.
- "Presentation" is a property of the Agent (not the Model). Two Agents under
  the same QBR Model can ship completely different slide lists.
- `Generated .pptx` is ephemeral; only the **Agent** is persistent
  configuration.

---

## Phase 1 status (shipped)

- ✅ Per-Agent `slide_list` (checkbox grid in Save Agent modal)
- ✅ Browser sends `slide_include` to deck-service; service skips unselected
- ✅ Per-operator Manual Data with conflict prompt vs Jedify
- ✅ MANUAL DATA pill on slides whose data came from manual entry
- ✅ Slide-type primitives (early): table renderer, chart_retention (real),
  chart_max_bet (3-strip), chart_segments (4-panel adaptive)
- ✅ Heading-regex classifier (`classifyScrapedTable`) maps Jedify research
  sections to slot keys. This is the proto-AI-mapper.
- ✅ History modal grouped by operator (📁), alphabetical, dates
  newest-first within each folder

What's missing for Phase 2: the Model layer, the unified Agent editor with
add/remove/reorder slides, the AI mapper, and the slide-type primitive
library as a first-class catalog.

---

## Phase 2 build sequence

Each step ships independently and leaves the system in a working state.

### Phase 2.0 — Seed Agent from research (Auto Mode)

When user clicks Generate Deck and **no Agent is active**, auto-build a
draft Agent: one slide per Jedify research section, default mappings.
Most of the rendering already exists (slide_appendix, generic table
derivation). Browser-side: a "Quick Deck" button or fall-through behavior.

**Cost**: ~2h. Highest ROI for AMs running first-time analyses on new
operators where no curated Agent exists yet.

### Phase 2.2 — Slide-type primitive library + schema

Generalize today's slide functions into a small catalog of typed
primitives, each with a JSON schema describing required data shape:

| Primitive          | Data shape                          | Example       |
|---|---|---|
| `table`            | rows of dict                        | promo rounds  |
| `bar_chart`        | rows × (label, ≥1 metric)           | KPIs over time |
| `line_chart`       | rows × (label, ≥1 metric, ordered)  | retention     |
| `comparison`       | 2 sources × N rows                  | op vs market  |
| `findings`         | text + bullets + Signal/Action/Impact| narrative slide |
| `stat_cards`       | 1-3 rows × (label, big_number, sub) | summary cards |

Each primitive defines:
- name + display label
- expected data schema (JSON)
- render function in deck-service

This catalog is what the AI mapper binds against. It's also the
"Add slide" picker in the editor.

**Cost**: ~5h. Prerequisite for the AI mapper.

### Phase 2.0a — AI Mapper

One LLM call per analysis producing JSON:
```json
{
  "slides": [
    {
      "slide_type": "line_chart",
      "section_binding": "Retention by cohort",
      "title": "Day-7 retention drops 11pts cohort-over-cohort",
      "confidence": 0.92,
      "reasoning": "4 cohort rows × 5 sequential day-buckets..."
    },
    ...
  ],
  "order_rationale": "Volume → engagement → opportunity → action"
}
```

Behavior:
- **High confidence (>0.85)**: auto-applied, green ✓ chip
- **Medium (0.5–0.85)**: auto-applied, yellow ⚠ chip + "Review" button
- **Low (<0.5)**: NOT auto-applied; slide marked "AI couldn't decide" with
  "Help me choose" button

Caching: result saved on the Agent. Re-running same analysis pulls from
cache. User clicks "Re-decide with AI" to force refresh.

Fallback: if LLM call errors, drop to today's heading-regex classifier.
System never gets stuck.

**Cost**: ~6h (mostly prompt engineering and the JSON schema validation).
Cost per analysis: ~$0.02–0.05.

### Phase 2.1 — Unified Agent Editor

The one screen for adding / removing / reordering / re-binding slides.
Same editor used for hand-crafted Agents AND auto-seeded Agents.

```
┌─ Edit Agent: SilverSocial QBR ───────────────────────────┐
│  Model: 📊 QBR  ▼      [Ship as-is]  [Save Agent]         │
│                                                            │
│  Slides (drag to reorder, ✕ to remove):                   │
│  ⋮⋮ 1. Title slide                                  ✕     │
│  ⋮⋮ 2. KPIs over time                                ✕     │
│       Type: ✨ AI → Bar chart [why?]                       │
│       Bound: ✨ AI → "Monthly Performance" ▾ ✓ high        │
│       Title: ✨ AI → "Bets, GGR, players accelerating" ✏️  │
│  ⋮⋮ 3. Studio mix                                    ✕     │
│  ...                                                       │
│                                                            │
│  [+ Add slide]                                             │
│      Pick a slide type:                                    │
│        ✨ Let AI decide   ← default / recommended          │
│        📊 Table  📈 Bar chart  📉 Line chart               │
│        ⚖️ Comparison  📝 Findings/narrative  🔢 Stat cards │
│        🛠 Custom (advanced)                                │
└────────────────────────────────────────────────────────────┘
```

Every AI decision is a chip → click to override → opens the override picker.

Once user explicitly picks, slide is "pinned" — AI no longer auto-decides
that field on subsequent runs. User can re-enable AI by clicking the chip
again and choosing "✨ Let AI decide".

**Cost**: ~6–8h. Highest UX leverage of the whole sequence.

### Phase 2.3 — Models layer (cosmetic)

Top toolbar gets `🎨 Models` button. Models modal lists built-ins
(QBR, CFO, Ops) + user-uploaded custom Models. Each Model owns:
- name, description
- catalog of available slides (subset of the global primitive library)
- default branding (logo, primary color, footer)
- optional .pptx template (for branding inheritance)

Save Agent form gains a `Based on Model: [...]` dropdown at the top.
Picking a Model pre-fills slide options + checks; user customizes from
there.

**Cost**: ~4h. Lowest urgency — only earns its place once you have ≥3
distinct Models in active use.

---

## Key UX principles agreed

1. **Agent always has a Model.** Hidden behind sensible defaults; user
   never thinks about it unless they want to.

2. **AI decides all by default.** Slide type, data binding, slide title,
   slide order. User overrides any decision with one click.

3. **Radical transparency.** Every AI decision shows its reasoning in a
   "[why?]" affordance. Confidence levels are visible. No silent magic.

4. **One editor, two ways in.** Hand-crafted Agents and auto-seeded
   Agents land in the same editor. Auto-mode just *seeds* — it doesn't
   bypass the system.

5. **Slide-type catalog is small (~7 primitives).** The complexity is in
   data binding, not in inventing new chart types.

6. **Override pins.** Once user explicitly picks a value, AI stops
   auto-deciding that field for that slide. User can re-enable AI per-field.

---

## Open questions (decide later)

1. **Section → multiple slides**: can one research section feed *multiple*
   slides (e.g. KPIs section drives both the bar chart and a stat-cards
   summary)? Implementation says yes; UX needs to confirm it doesn't
   confuse.

2. **Dedupe history entries** (~60 sec same-operator window) — minor; do
   when it actually annoys someone.

3. **LLM-fallback for ambiguous slide-type rules**: keep deterministic-only
   for v1, or wire in LLM for the slide_type decision when shape is
   unclear (e.g. text + table mixed)?

4. **Brand inheritance**: if a Model has a custom .pptx template, does the
   deck-service render *into* that .pptx, or just steal logo/colors? The
   former is more powerful (custom title slide layouts) but harder.

5. **"Re-decide with AI" semantics**: when user clicks it, does AI
   re-decide *all* slides or only un-pinned ones? My instinct: only
   un-pinned, with a "Re-decide everything (clear pins)" power-user option.

6. **Auto-Agent dedup**: if user runs the same analysis twice, do we
   create two draft Agents or update the existing one? Probably update,
   surface a "create new variant" link.

---

## Migration from Phase 1

- Today's Agents have `slide_list` baked in. They migrate to "Custom Model
  Agents" — each Agent points to a `Custom` Model that holds its current
  slide list.
- Or, if an Agent's slide_list matches QBR Model's default exactly, it
  auto-points to QBR Model and clears its local override.
- One-time migration on first load after Phase 2.3 ships. No user action
  required.

---

## Files involved (rough)

**Browser**: `insight-loop-prototype.html`
- Add `_models` state + Models modal
- Add Editor modal (replaces simple Save Agent dialog for in-Agent
  editing)
- Add `slide_type` and `binding` per-slide in Agent record
- Wire AI mapper response into the Agent editor

**Backend**: `jedify-server.js`
- New `POST /api/ai-mapper` endpoint that takes the research output +
  slide catalog + Agent context, calls Anthropic, returns JSON of
  { slide_type, binding, title, confidence, reasoning } per slide
- Caches per-Agent

**Deck-service**: `build_deck.py`
- Generalize today's slide functions into the primitive library
- Each primitive function takes (data, slide_config) and renders
- `generate()` reads the Agent's slide list, dispatches each entry to its
  primitive

---

## Reminder for whoever picks this up

- Phase 1 already ships per-Agent slide_list, manual data, classifier.
  Don't redo. Build on top.
- Heading-regex classifier (`classifyScrapedTable` in
  insight-loop-prototype.html) is the proto-AI-mapper. Keep it as the
  fallback when LLM is unavailable.
- Existing slide functions in `build_deck.py` are *almost* the
  primitives — refactor, don't rewrite.
- The Manual Data feature already covers "Agent needs data Jedify
  doesn't have." Don't add a parallel mechanism.
