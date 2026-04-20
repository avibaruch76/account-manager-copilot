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
const crypto = require('crypto');
const jedify = require('./jedify-direct');

const PORT = process.env.PORT || 3001;

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
};

// Checks that are skipped in prototype (need different data source)
const SKIPPED_CHECKS = new Set(['vip_behavior', 'revenue_leakage']);

async function runAnalysis(selection) {
  const sf = scopeFilter(selection);
  const df = buildDateFilters(selection);

  // Which checks to run — from client payload or default all mandatory
  const defaultChecks = ['ggr_trend', 'concentration', 'hidden_gems', 'benchmark_gap', 'new_launches', 'open_scan'];
  const enabledChecks = (selection.enabledChecks && selection.enabledChecks.length > 0)
    ? selection.enabledChecks.filter(id => !SKIPPED_CHECKS.has(id))
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
function buildResearchPrompt(entity, scope, dateRange, enabledOptionalIds, persona, globalRules) {
  const checks = require('./research-checks');
  const selectedChecks = [
    ...checks.mandatory,
    ...checks.optional.filter(c => enabledOptionalIds.includes(c.id))
  ];

  const bullets = selectedChecks.map(c => `• ${c.query}`).join('\n');
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

async function askJedifyResearch(prompt, onStage, onHeartbeat, cancelToken) {
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
  const sessionVersionAtStart = getSessionVersion();
  console.log(`[jedify-research] Submitted → inquiry_id=${inquiryId}, session=${sessionVersionAtStart}, polling...`);
  if (onStage) onStage(0, RESEARCH_STAGES[0]);

  // Poll until done (max 10 min at 5s intervals = 120 polls)
  const maxPolls = 120;
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
// All active SSE response objects — so SIGTERM can notify them before shutdown
const _activeSSeClients = new Set();

async function runResearch(reqBody, onProgress) {
  const { entity, scope, dateRange, enabledOptionalCheckIds, persona, customPrompt, globalRules } = reqBody;
  const emit = onProgress || (() => {});
  const scopeLabel = scope || 'operator';
  const activePersona = persona || 'am_actions';

  console.log(`[research] Starting research — ${scopeLabel}: "${entity}", persona: ${activePersona}`);

  const prompt = customPrompt || buildResearchPrompt(entity, scopeLabel, dateRange, enabledOptionalCheckIds || [], activePersona, globalRules || '');
  console.log(`[research] Prompt ${customPrompt ? '(custom, user-edited)' : '(auto-built)'} (${prompt.length} chars). Submitting to Jedify...`);

  const onStage = (idx, label) => {
    emit({ type: 'stage', index: idx, total: RESEARCH_STAGES.length, label });
  };

  _cancelToken = { cancelled: false };
  const report = await askJedifyResearch(prompt, onStage, (pollNum) => {
    emit({ type: 'heartbeat', poll: pollNum });
  }, _cancelToken);

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

  // All other /api/* routes require authentication
  if (req.url.startsWith('/api/') && !isAuthenticated(req)) {
    return rejectUnauth(res);
  }

  if (req.method === 'GET' && req.url === '/api/research-status') {
    if (_lastCompletedResult) {
      // Return last completed result (browser can recover if SSE was interrupted)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(_lastCompletedResult));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: !!_activeInquiryId, inquiry_id: _activeInquiryId || null }));
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
        const { entity, scope, dateRange, enabledOptionalCheckIds, persona, globalRules } = JSON.parse(body);
        const prompt = buildResearchPrompt(
          entity || 'Unknown',
          scope || 'operator',
          dateRange || { start: '6 months ago', end: 'current month' },
          enabledOptionalCheckIds || [],
          persona || 'am_actions',
          globalRules || ''
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
          // Plain JSON response — no streaming, no progress events
          const results = await runResearch({ ...reqBody, entity, scope, dateRange, enabledOptionalCheckIds, persona });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(results));
          return;
        }

        // SSE streaming — send progress events as each check completes
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'  // disable nginx buffering if behind proxy
        });

        // Track this client so SIGTERM can notify it
        _activeSSeClients.add(res);
        res.on('close', () => _activeSSeClients.delete(res));

        const onProgress = (evt) => {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        };

        const results = await runResearch({ ...reqBody, entity, scope, dateRange, enabledOptionalCheckIds, persona }, onProgress);
        // Send final result as the last event
        _activeSSeClients.delete(res);
        res.write(`data: ${JSON.stringify({ type: 'result', data: results })}\n\n`);
        res.end();
      } catch (err) {
        console.error('[research] Pipeline error:', err);
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

  // Token health check
  if (req.method === 'GET' && req.url === '/api/token-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getTokenStatus()));
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

  server.listen(PORT, () => {
    console.log(`\n[jedify] Server running → http://localhost:${PORT}`);
    console.log(`[jedify] Mode: direct HTTP${process.env.JEDIFY_REFRESH_TOKEN ? ' (cloud)' : ' (local)'}`);
  });
})();
