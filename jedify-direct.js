/**
 * jedify-direct.js
 * Direct MCP HTTP client — replaces subprocess-based @jedify/mcp-auth
 * with direct HTTPS requests to Jedify's MCP endpoint.
 *
 * Manages OAuth tokens internally via Descope refresh-token flow.
 * Uses only Node.js built-ins (https, http, url, querystring, crypto).
 */

'use strict';

const https = require('https');
const querystring = require('querystring');
const { URL } = require('url');

// ── Configuration ─────────────────────────────────────────────────────────────

const JEDIFY_REFRESH_TOKEN = process.env.JEDIFY_REFRESH_TOKEN || '';
const DESCOPE_PROJECT_ID = process.env.DESCOPE_PROJECT_ID || 'P2fGtsAm5ziAZr0swDyMDO7Tce87';
const REMOTE_MCP_URL = process.env.REMOTE_MCP_URL || 'https://be.jedify.com/mcp/sse';

// ── State ─────────────────────────────────────────────────────────────────────

let accessToken = null;
let refreshToken = JEDIFY_REFRESH_TOKEN;
let tokenExpiresAt = 0;       // epoch ms
let lastRefreshAt = 0;
let refreshCount = 0;
let refreshErrors = 0;

let mcpReady = false;
let sessionId = null;
let _sessionVersion = 0;  // increments every time a new MCP session is established
let messageEndpoint = null;    // full URL for POST /mcp/message?sessionId=xxx
let msgId = 1;

const pendingRequests = new Map(); // id -> { resolve, reject, timer }
let sseRequest = null;            // the live SSE ClientRequest
let sseBuffer = '';               // partial SSE data buffer

let tokenRefreshInterval = null;

// ── Token Management ──────────────────────────────────────────────────────────

/**
 * Refresh the access token via Descope OAuth2 endpoint.
 */
async function refreshAccessToken() {
  const body = querystring.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  const result = await new Promise((resolve, reject) => {
    const req = https.request('https://api.descope.com/oauth2/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${DESCOPE_PROJECT_ID}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Descope token refresh failed: ${res.statusCode} ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Descope token parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  // Prefer id_token over access_token (Descope convention for MCP)
  accessToken = result.id_token || result.access_token;
  if (!accessToken) {
    throw new Error('Descope response missing both id_token and access_token');
  }

  // Handle token rotation — Descope may issue a new refresh token
  if (result.refresh_token) {
    refreshToken = result.refresh_token;
  }

  const expiresIn = result.expires_in || 180; // ~3 min default
  tokenExpiresAt = Date.now() + expiresIn * 1000;
  lastRefreshAt = Date.now();
  refreshCount++;

  console.log(`[jedify-direct] Token refreshed (#${refreshCount}), expires in ${expiresIn}s`);
  return accessToken;
}

/**
 * Ensure we have a valid access token, refreshing if needed.
 */
async function ensureToken() {
  // Refresh if no token or within 30s of expiry
  if (!accessToken || Date.now() > tokenExpiresAt - 30000) {
    try {
      await refreshAccessToken();
    } catch (e) {
      refreshErrors++;
      throw e;
    }
  }
  return accessToken;
}

/**
 * Return token health info.
 */
function getTokenStatus() {
  const now = Date.now();
  return {
    hasToken: !!accessToken,
    expiresIn: accessToken ? Math.max(0, Math.round((tokenExpiresAt - now) / 1000)) : 0,
    lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
    refreshCount,
    refreshErrors,
    hasRefreshToken: !!refreshToken
  };
}

// ── SSE Connection ────────────────────────────────────────────────────────────

/**
 * Open an SSE connection to the MCP endpoint.
 * Returns a promise that resolves once the `endpoint` event is received.
 */
function openSSE(token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(REMOTE_MCP_URL);

    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          reject(new Error(`SSE connect failed: ${res.statusCode} ${body}`));
        });
        return;
      }

      console.log('[jedify-direct] SSE connection established');
      sseBuffer = '';
      let gotEndpoint = false;

      res.on('data', (chunk) => {
        sseBuffer += chunk.toString();
        processSSEBuffer();

        // Check if we've received the endpoint event (resolve the promise)
        if (!gotEndpoint && messageEndpoint) {
          gotEndpoint = true;
          resolve();
        }
      });

      res.on('end', () => {
        console.warn('[jedify-direct] SSE connection closed by server');
        handleSSEClose();
      });

      res.on('error', (err) => {
        console.error('[jedify-direct] SSE stream error:', err.message);
        handleSSEClose();
      });
    });

    req.on('error', (err) => {
      reject(new Error(`SSE request error: ${err.message}`));
    });

    // Keep-alive timeout: 5 minutes (server should send heartbeats)
    req.setTimeout(300000, () => {
      console.warn('[jedify-direct] SSE connection timeout, reconnecting...');
      req.destroy();
    });

    sseRequest = req;
    req.end();
  });
}

/**
 * Parse the SSE buffer for complete events.
 * SSE format: "event: <type>\ndata: <value>\n\n"
 */
function processSSEBuffer() {
  // Split on double-newline (event boundary)
  const parts = sseBuffer.split('\n\n');
  // Last part may be incomplete — keep it in the buffer
  sseBuffer = parts.pop() || '';

  for (const raw of parts) {
    if (!raw.trim()) continue;

    let eventType = 'message';
    let dataLines = [];

    const lines = raw.split('\n');
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      } else if (line.startsWith(':')) {
        // Comment / heartbeat — ignore
      }
    }

    const data = dataLines.join('\n');
    handleSSEEvent(eventType, data);
  }
}

/**
 * Handle a parsed SSE event.
 */
function handleSSEEvent(eventType, data) {
  // Try parsing as JSON-RPC first (Jedify sends JSON-RPC messages on the SSE stream)
  let jsonMsg = null;
  try { jsonMsg = JSON.parse(data); } catch (_) {}

  // Handle endpoint event — can be plain path or JSON-RPC
  if (eventType === 'endpoint' || (jsonMsg && jsonMsg.method === 'endpoint')) {
    const parsed = new URL(REMOTE_MCP_URL);
    let endpointPath;

    if (jsonMsg && jsonMsg.params && jsonMsg.params.endpoint) {
      // JSON-RPC format: {"jsonrpc":"2.0","method":"endpoint","params":{"endpoint":"/mcp/message"}}
      endpointPath = jsonMsg.params.endpoint;
    } else {
      // Plain path format: /mcp/message?sessionId=xxx
      endpointPath = data.trim();
    }

    messageEndpoint = `${parsed.protocol}//${parsed.host}${endpointPath}`;
    try {
      sessionId = new URL(messageEndpoint).searchParams.get('sessionId');
    } catch (_) {
      sessionId = null;
    }
    console.log(`[jedify-direct] Got MCP endpoint: ${messageEndpoint}`);
    return;
  }

  // Handle JSON-RPC responses for pending requests
  if (jsonMsg && jsonMsg.id !== undefined && pendingRequests.has(jsonMsg.id)) {
    const { resolve, timer } = pendingRequests.get(jsonMsg.id);
    clearTimeout(timer);
    pendingRequests.delete(jsonMsg.id);
    resolve(jsonMsg);
    return;
  }

  // Unknown event type — log for debugging
  if (data) {
    console.log(`[jedify-direct] SSE event '${eventType}': ${data.slice(0, 200)}`);
  }
}

/**
 * Handle SSE connection closure — reject pending requests and attempt reconnect.
 */
function handleSSEClose() {
  mcpReady = false;
  messageEndpoint = null;
  sessionId = null;
  sseRequest = null;

  // Reject all pending requests
  for (const [id, { reject, timer }] of pendingRequests) {
    clearTimeout(timer);
    reject(new Error('SSE connection closed'));
  }
  pendingRequests.clear();

  // Auto-reconnect after delay
  console.log('[jedify-direct] Will attempt reconnect in 5s...');
  setTimeout(async () => {
    try {
      await initMCP();
      console.log('[jedify-direct] Reconnected successfully');
    } catch (e) {
      console.error('[jedify-direct] Reconnect failed:', e.message);
    }
  }, 5000);
}

// ── MCP Communication ─────────────────────────────────────────────────────────

/**
 * Send a JSON-RPC 2.0 message to the MCP endpoint.
 * Returns a promise that resolves with the response.
 */
function sendMCP(message, timeoutMs = 120000) {
  return new Promise(async (resolve, reject) => {
    if (!messageEndpoint) {
      return reject(new Error('MCP not connected — no message endpoint'));
    }

    const id = msgId++;
    message.jsonrpc = '2.0';
    message.id = id;

    let token;
    try {
      token = await ensureToken();
    } catch (e) {
      return reject(new Error(`Token refresh failed: ${e.message}`));
    }

    const body = JSON.stringify(message);
    const parsed = new URL(messageEndpoint);

    // Set up timeout
    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`MCP timeout for id=${id} after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    // Register in pending map (for SSE-delivered responses)
    pendingRequests.set(id, { resolve, reject, timer });

    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          // Immediate JSON response — resolve directly
          try {
            const parsed = JSON.parse(responseData);
            if (pendingRequests.has(id)) {
              clearTimeout(timer);
              pendingRequests.delete(id);
              resolve(parsed);
            }
            // If already resolved via SSE, ignore
          } catch (e) {
            // Not JSON or empty body — wait for SSE
            // (some 200 responses are acknowledgments)
          }
        } else if (res.statusCode === 202) {
          // Accepted — response will arrive via SSE stream
          // Already registered in pendingRequests, just wait
          console.log(`[jedify-direct] Request id=${id} accepted (202), waiting for SSE response...`);
        } else {
          // Error
          if (pendingRequests.has(id)) {
            clearTimeout(timer);
            pendingRequests.delete(id);
            reject(new Error(`MCP POST error: ${res.statusCode} ${responseData}`));
          }
        }
      });
    });

    req.on('error', (err) => {
      if (pendingRequests.has(id)) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(new Error(`MCP POST request error: ${err.message}`));
      }
    });

    req.write(body);
    req.end();
  });
}

/**
 * Fire-and-forget notification (no id, no response expected).
 */
async function notifyMCP(message) {
  if (!messageEndpoint) {
    console.warn('[jedify-direct] Cannot send notification — not connected');
    return;
  }

  message.jsonrpc = '2.0';
  // Notifications have no id

  let token;
  try {
    token = await ensureToken();
  } catch (e) {
    console.error('[jedify-direct] Token refresh failed for notification:', e.message);
    return;
  }

  const body = JSON.stringify(message);
  const parsed = new URL(messageEndpoint);

  const req = https.request({
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + parsed.search,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, (res) => {
    // Consume response to free socket
    res.resume();
    if (res.statusCode !== 200 && res.statusCode !== 202) {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.warn(`[jedify-direct] Notification response: ${res.statusCode} ${data}`);
      });
    }
  });

  req.on('error', (err) => {
    console.error('[jedify-direct] Notification request error:', err.message);
  });

  req.write(body);
  req.end();
}

// ── Initialization ────────────────────────────────────────────────────────────

/**
 * Initialize: refresh token, open SSE session, send MCP handshake.
 */
async function initMCP() {
  if (!refreshToken) {
    throw new Error('JEDIFY_REFRESH_TOKEN environment variable is required');
  }

  console.log('[jedify-direct] Initializing MCP session...');

  // Close existing SSE connection if any
  if (sseRequest) {
    try { sseRequest.destroy(); } catch (_) {}
    sseRequest = null;
  }
  messageEndpoint = null;
  sessionId = null;
  mcpReady = false;

  // 1. Get a fresh access token
  await refreshAccessToken();
  console.log('[jedify-direct] Token acquired');

  // 2. Open SSE connection (waits for endpoint event)
  await openSSE(accessToken);
  console.log('[jedify-direct] SSE connected, endpoint received');

  // 3. Send MCP initialize handshake
  const initResult = await sendMCP({
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'insight-loop-server', version: '1.0.0' }
    }
  });
  console.log('[jedify-direct] MCP initialize response received');

  // 4. Send initialized notification
  await notifyMCP({ method: 'notifications/initialized' });

  mcpReady = true;
  _sessionVersion++;
  console.log('[jedify-direct] MCP session ready.');

  // 5. Set up token auto-refresh every 2 minutes
  if (tokenRefreshInterval) {
    clearInterval(tokenRefreshInterval);
  }
  tokenRefreshInterval = setInterval(async () => {
    try {
      await refreshAccessToken();
    } catch (e) {
      console.error('[jedify-direct] Auto-refresh failed:', e.message);
    }
  }, 120000); // 2 minutes

  return initResult;
}

// ── Accessors ─────────────────────────────────────────────────────────────────

function isMCPReady() {
  return mcpReady;
}

function setMCPReady(v) {
  mcpReady = !!v;
}

function getSessionVersion() {
  return _sessionVersion;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  sendMCP,
  notifyMCP,
  initMCP,
  isMCPReady,
  setMCPReady,
  getSessionVersion,
  getTokenStatus,
  ensureToken,
  refreshAccessToken
};
