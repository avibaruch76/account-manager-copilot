#!/usr/bin/env node
/**
 * capture-token.js
 * One-time local script to capture a Descope refresh token.
 *
 * Usage: node capture-token.js
 * Opens browser for Descope login, captures refresh token, prints it.
 * Paste the token into Render's JEDIFY_REFRESH_TOKEN env var.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { exec } = require('child_process');
const querystring = require('querystring');

const DESCOPE_PROJECT_ID = 'P2fGtsAm5ziAZr0swDyMDO7Tce87';
const CALLBACK_PORT = 8765;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function httpsPost(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': headers['Content-Type'] || 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, err => { if (err) console.error('Could not open browser:', err.message); });
}

async function main() {
  const { verifier, challenge } = generatePKCE();
  const state = base64url(crypto.randomBytes(16));

  console.log('\n🔐 Jedify Token Capture Tool\n');
  console.log('This will open your browser for Descope login.');
  console.log('After login, the refresh token will be printed here.\n');

  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/callback')) {
      res.writeHead(404); res.end('Not found'); return;
    }

    const params = new URL(req.url, `http://localhost:${CALLBACK_PORT}`).searchParams;
    const code = params.get('code');
    const returnedState = params.get('state');

    if (returnedState !== state) {
      res.writeHead(400); res.end('State mismatch — possible CSRF attack.');
      return;
    }

    if (!code) {
      res.writeHead(400); res.end('No authorization code received.');
      return;
    }

    console.log('✅ Authorization code received. Exchanging for tokens...\n');

    try {
      const tokenBody = querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier
      });

      const tokenResp = await httpsPost('https://api.descope.com/oauth2/v1/token', {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${DESCOPE_PROJECT_ID}`
      }, tokenBody);

      if (tokenResp.status !== 200) {
        console.error('❌ Token exchange failed:', tokenResp.body);
        res.writeHead(500); res.end('Token exchange failed. Check console.');
        server.close(); process.exit(1);
        return;
      }

      const data = JSON.parse(tokenResp.body);

      if (!data.refresh_token) {
        console.error('❌ No refresh token received. Response:', JSON.stringify(data, null, 2));
        console.error('\nNote: Descope may not issue refresh tokens without offline_access scope.');
        res.writeHead(200); res.end('No refresh token received. Check console.');
        server.close(); process.exit(1);
        return;
      }

      console.log('═══════════════════════════════════════════════════');
      console.log('✅ REFRESH TOKEN CAPTURED SUCCESSFULLY');
      console.log('═══════════════════════════════════════════════════\n');
      console.log('Your refresh token:\n');
      console.log(data.refresh_token);
      console.log('\n═══════════════════════════════════════════════════');
      console.log('\n📋 Next steps:');
      console.log('  1. Copy the refresh token above');
      console.log('  2. Go to your Render dashboard → Environment');
      console.log('  3. Add variable: JEDIFY_REFRESH_TOKEN = <paste token>');
      console.log('  4. Redeploy your service\n');

      if (data.access_token || data.id_token) {
        console.log(`Access token expires in: ${data.expires_in || '?'}s`);
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family:system-ui;text-align:center;padding:60px;">
          <h1>✅ Token Captured!</h1>
          <p>Check your terminal for the refresh token.</p>
          <p>You can close this tab.</p>
        </body></html>
      `);

      setTimeout(() => { server.close(); process.exit(0); }, 1000);

    } catch (err) {
      console.error('❌ Error:', err.message);
      res.writeHead(500); res.end('Error: ' + err.message);
      server.close(); process.exit(1);
    }
  });

  server.listen(CALLBACK_PORT, () => {
    const authParams = querystring.stringify({
      response_type: 'code',
      client_id: DESCOPE_PROJECT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'openid offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state
    });
    const authUrl = `https://api.descope.com/oauth2/v1/authorize?${authParams}`;

    console.log(`Callback server listening on port ${CALLBACK_PORT}`);
    console.log('Opening browser...\n');
    openBrowser(authUrl);
  });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
