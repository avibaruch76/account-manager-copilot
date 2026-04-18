# Data Agent Builder — Design Spec
**Date:** 2026-04-18  
**Status:** Approved for implementation planning

---

## Context

The Account Manager Copilot (QBR tool) proved the concept: connect a research config to Jedify and get structured, persona-formatted output. The organisation now wants to extend this to ~100 users across Finance, Commercial, Operations and other functions — each with different analytical lenses and different Jedify research needs.

Rather than forcing all users into a QBR-shaped tool, the platform splits into two products sharing one server:

1. **QBR Copilot** — the existing app, unchanged, focused on Account Managers  
2. **Data Agent Builder** — a new app where any team can define their own research agents (groups of modes, each with their own checks and output format)

---

## What We're NOT Changing

The existing `insight-loop-prototype.html` (QBR Copilot) is left as-is. It continues to live at its current URL. No migration required. The shared `jedify-server.js` backend serves both apps.

---

## Product 1 — QBR Copilot (existing)
- File: `insight-loop-prototype.html`
- No changes planned in this phase
- Continues to use the existing single-mode research config

---

## Product 2 — Data Agent Builder (new)
- File: `data-agent-builder.html`  
- Same `jedify-server.js` backend, same `/api/research` endpoint
- Same auth system (shared password, Bearer token)

---

## Data Model

### 3-Tier Hierarchy

```
Global Rules  (apply to every run, every group)
  └── Group  (e.g. Finance, Commercial, Operations)
        ├── Group Rules  (apply to all modes in this group)
        └── Mode  (e.g. CFO Review, QBR Prep, AM Weekly)
              ├── Mandatory Checks
              ├── Agent-Decided Checks
              └── Output Prompt  (how Jedify formats results)
```

### ResearchGroup
```js
{
  id: string,           // 'finance', 'commercial', 'operations'
  name: string,         // 'Finance'
  icon: string,         // '📁'
  color: string,        // accent colour for UI
  groupRules: string,   // plain-English rules for all modes in this group
  pinned: boolean,      // shown as top-level tab without overflow
  order: number
}
```

### ResearchMode
```js
{
  id: string,           // 'cfo_review', 'qbr_prep'
  groupId: string,      // parent group
  name: string,         // 'CFO Review'
  icon: string,         // '💰'
  pinned: boolean,      // shown as pill without "More ▾"
  checks: {
    mandatory: Check[],
    optional: Check[]
  },
  outputPrompt: string, // persona prompt sent to Jedify
  order: number
}
```

### Check (unchanged from QBR tool)
```js
{
  id, name, description, type, enabled, builtin,
  triggers, question, why, order
}
```

All data persisted to **localStorage** — no backend database needed.

---

## Built-in Groups & Modes

### 📁 Commercial
**Group Rules:** "Always benchmark against global top 5 games. Prioritise our latest 3 released games if relevant."

| Mode | Icon | Mandatory Checks |
|------|------|-----------------|
| QBR Prep | 📊 | GGR 6-Month Trend, Concentration Risk, Hidden Gems, Benchmark Gap, New Launches, Open Scan |
| AM Weekly | ⚡ | GGR Trend (lightweight), Top Game Movement |
| Product Launch | 🎯 | New Game Adoption, Benchmark Gap, Hidden Gems |

### 📁 Finance
**Group Rules:** "Always focus on revenue quality and forecast accuracy. Flag any metric deviating >10% from forecast."

| Mode | Icon | Mandatory Checks |
|------|------|-----------------|
| CFO Review | 💰 | Revenue Forecast, Margin Trend, Churn Risk, Pipeline Coverage |
| Churn Watch | ⚠️ | Player Retention, VIP Behaviour, Revenue Leakage |

### 📁 Operations
**Group Rules:** "Flag RTP anomalies and configuration issues before anything else."

| Mode | Icon | Mandatory Checks |
|------|------|-----------------|
| RTP Audit | 🔧 | RTP Outlier Detection, Game Config Check |
| Downtime Impact | 📉 | Availability vs GGR correlation |

### 🔬 Data Analyst (special)
- Not part of any group
- Receives Global Rules only (no group rules)
- Always runs full raw output + download options

---

## UI Architecture

### Run Screen

```
[ Operator / Date selector ]

Group selector (tabs + More ▾):
  [ 📁 Commercial ]  [ 📁 Finance ]  [ 📁 Operations ]  [ More ▾ ]

Mode selector (pills, filtered to selected group + More ▾):
  [ 📊 QBR Prep ]  [ ⚡ AM Weekly ]  [ More ▾ ]

[ Run Analysis button ]
```

- Selecting a group filters the mode pills to that group's modes
- "All Groups" option runs all pinned modes across all groups (power users)
- Pinned = shown in pills. Unpinned = in "More ▾" dropdown

### Research Config Screen

```
Global Rules box  (top, always visible)

Group tabs (+ More ▾):
  [ Commercial ]  [ Finance ]  [ Operations ]  [ + New Group ]

  ↳ Group Rules textarea  (for selected group)

  Mode tabs (+ More ▾):
    [ QBR Prep ]  [ AM Weekly ]  [ + New Mode ]

    ↳ Mandatory Checks list
    ↳ Agent-Decided Checks list
    ↳ Add New Check panel
    ↳ Output Prompt textarea
```

### Output Screen

```
Tabs (one per mode run this session + Analysis Results):
  [ 📊 Analysis Results ]  [ 💰 CFO Review ]  [ 📊 QBR Prep ]

Analysis Results tab: full raw Jedify data + download buttons
Mode tabs: mode-specific formatted output using that mode's output prompt
```

---

## Server Integration

`jedify-server.js` requires **no changes** for this phase.

The Data Agent Builder sends the same payload shape as the QBR tool:
```js
{
  entity, scope, dateRange,
  enabledChecks: string[],
  checkDefinitions: { [id]: { name, question } },
  globalRules: string,        // Global Rules + Group Rules concatenated
  customPrompt: string,       // mode's outputPrompt
  persona: string,
  noSSE: boolean
}
```

Group Rules and Global Rules are concatenated into `globalRules` before sending — no server changes needed.

---

## What's New vs QBR Tool

| Feature | QBR Tool | Data Agent Builder |
|---------|----------|--------------------|
| Research modes | 1 (fixed) | Many (user-defined) |
| Check ownership | Global | Per-mode |
| Rules | One global textarea | Global + per-group |
| Groups | None | Finance, Commercial, Operations + custom |
| Output tabs | Fixed (QBR, AM, Detailed) | Dynamic (one per mode run) |
| Users | AM team | Any function, ~100 users |
| File | `insight-loop-prototype.html` | `data-agent-builder.html` |

---

## Out of Scope (this phase)

- User accounts / per-user role assignment (use shared password for now)
- Cross-user config sync (localStorage only, per-browser)
- Backend persistence of group/mode configs
- Mobile-optimised layout

---

## Verification

1. Open `data-agent-builder.html` in browser
2. Select Finance group → CFO Review mode → run on a test operator
3. Confirm CFO checks fire (Revenue Forecast, Margin, Churn Risk)
4. Confirm Group Rules + Global Rules appear in the preview prompt
5. Confirm output appears in "CFO Review" tab
6. Confirm QBR tool (`insight-loop-prototype.html`) is unaffected
7. Confirm both apps share the same server auth token
