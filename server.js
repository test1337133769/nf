require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const cors       = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Secret key for API authentication ──
const SECRET_KEY = process.env.SECRET_KEY || 'netflix2026';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════

function decodeNetflixId(raw) {
  let str = raw.trim();
  // Strip NetflixId= prefix
  if (/^netflixid=/i.test(str)) str = str.replace(/^netflixid=/i, '');
  // URL decode
  try { str = decodeURIComponent(str); } catch(e) {}
  // Parse fields
  const params = {};
  str.split('&').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > 0) params[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return params;
}

function validateFields(f) {
  const errors = [];
  if (!f.ct || f.ct.length < 80)  errors.push('ct missing or too short');
  if (!f.v)                        errors.push('v field missing');
  if (!f.pg || !/^[A-Z0-9]{10,}$/.test(f.pg)) errors.push('pg missing or invalid');
  if (!f.ch || f.ch.length < 20)   errors.push('ch missing or too short');
  return errors;
}

function buildCookieVal(f) {
  return encodeURIComponent(`v=${f.v}&ct=${f.ct}&pg=${f.pg}&ch=${f.ch}`);
}

function extractAuthUrl(html) {
  // authURL in Netflix reactContext = the nftoken
  const patterns = [
    /"authURL"\s*:\s*"([^"]{10,})"/,
    /"authUrl"\s*:\s*"([^"]{10,})"/,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) {
      // Decode JS escape sequences
      return m[1]
        .replace(/\\x3D/g, '=').replace(/\\x3d/g, '=')
        .replace(/\\x2F/g, '/').replace(/\\x2f/g, '/')
        .replace(/\\x2B/g, '+').replace(/\\x2b/g, '+')
        .replace(/\\u003D/g, '=').replace(/\\u002F/g, '/');
    }
  }
  return null;
}

function extractAccountInfo(html) {
  const get = (pat) => { const m = html.match(pat); return m ? m[1].replace(/\\x40/g,'@').replace(/\\x2E/g,'.') : null; };
  return {
    email:            get(/"emailAddress"\s*:\s*"([^"]+)"/),
    membershipStatus: get(/"membershipStatus"\s*:\s*"([^"]+)"/),
    country:          get(/"countryOfSignup"\s*:\s*"([^"]+)"/),
    plan:             get(/"videoQuality"\s*:\s*"([^"]+)"/),
    memberSince:      get(/"memberSince"\s*:\s*"([^"]+)"/),
  };
}

// ════════════════════════════════════════════════
//  CORE: Fetch nftoken from Netflix
// ════════════════════════════════════════════════

async function fetchNftoken(fields) {
  const jar    = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true }));

  const HEADERS = {
    'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0',
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':           'en-US,en;q=0.9',
    'Accept-Encoding':           'gzip, deflate, br',
    'Connection':                'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'none',
    'Sec-Fetch-User':            '?1',
  };

  const cookieVal = buildCookieVal(fields);

  // Set initial cookie
  await jar.setCookie(`NetflixId=${cookieVal}; Domain=.netflix.com; Path=/`, 'https://www.netflix.com');

  // ── Step 1: GET /bd/ → collect SecureNetflixId + nfvdid + flwssn ──
  await client.get('https://www.netflix.com/bd/', {
    headers: HEADERS,
    maxRedirects: 5,
    validateStatus: s => s < 500,
  });

  // ── Step 2: GET /unsupported → extract authURL (nftoken) from HTML ──
  const r2 = await client.get('https://www.netflix.com/unsupported', {
    headers: HEADERS,
    maxRedirects: 3,
    validateStatus: s => s < 500,
  });

  const html = r2.data;

  // Check if redirected to login (expired)
  if (typeof html === 'string' && (html.includes('bd/login') || html.includes('ap/signin'))) {
    throw new Error('INVALID_NETFLIX_ID');
  }

  const authUrl = extractAuthUrl(html);
  if (!authUrl) throw new Error('NFTOKEN_NOT_FOUND');

  const account = extractAccountInfo(html);

  return { nftoken: authUrl, account };
}

function buildLinks(nftoken) {
  // Properly encode for URL - + and / must be percent-encoded
  const encoded = encodeURIComponent(nftoken)
    .replace(/%3D/g, '=');  // keep = as-is (it's safe in query values)

  return {
    phone: `https://www.netflix.com/unsupported?nftoken=${encoded}`,
    pc:    `https://netflix.com/account?nftoken=${encoded}`,
  };
}

// ════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status:           'ok',
    host:             `${req.protocol}://${req.get('host')}`,
    maintenance_mode: false,
    version:          '1.0.0',
    uptime:           process.uptime(),
  });
});

// Main generate endpoint
app.post('/api/gen', async (req, res) => {
  const { netflix_id, secret_key } = req.body;

  // Validate inputs
  if (!netflix_id)  return res.json({ success: false, error: 'MISSING_NETFLIX_ID' });
  if (!secret_key)  return res.json({ success: false, error: 'MISSING_SECRET_KEY' });
  if (secret_key !== SECRET_KEY) return res.json({ success: false, error: 'INVALID_SECRET_KEY' });

  // Parse and validate NetflixId
  const fields = decodeNetflixId(netflix_id);
  const errors = validateFields(fields);
  if (errors.length > 0) {
    return res.json({ success: false, error: 'INVALID_NETFLIX_ID', details: errors });
  }

  try {
    const { nftoken, account } = await fetchNftoken(fields);
    const links = buildLinks(nftoken);

    return res.json({
      success:   true,
      login_url: links.phone,   // primary — phone link
      pc_url:    links.pc,      // bonus — PC link
      nftoken:   nftoken,
      account: {
        email:  account.email   || null,
        status: account.membershipStatus || null,
        country:account.country || null,
        plan:   account.plan    || null,
      },
    });

  } catch (err) {
    const msg = err.message || 'UNKNOWN_ERROR';

    if (msg === 'INVALID_NETFLIX_ID') {
      return res.json({ success: false, error: 'INVALID_NETFLIX_ID', details: 'Cookie expired or invalid' });
    }
    if (msg === 'NFTOKEN_NOT_FOUND') {
      return res.json({ success: false, error: 'NFTOKEN_NOT_FOUND', details: 'Could not extract token from Netflix response' });
    }

    console.error('[ERROR]', err.message);
    return res.json({ success: false, error: 'SERVER_ERROR', details: msg });
  }
});

// Serve the HTML docs page at root
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Netflix Token API</title>
  <style>
    body { font-family: monospace; background: #0a0a0a; color: #e2e2e2; padding: 2rem; max-width: 700px; margin: 0 auto; }
    h1 { color: #E50914; } code { background: #1a1a1a; padding: 0.2rem 0.5rem; border-radius: 3px; color: #22c55e; }
    pre { background: #111; border: 1px solid #222; padding: 1rem; border-radius: 5px; overflow-x: auto; }
    .ok { color: #22c55e; } .err { color: #f87171; }
  </style>
</head>
<body>
  <h1>Netflix Token Generator API</h1>
  <p>POST <code>${req.protocol}://${req.get('host')}/api/gen</code></p>
  <h3>Request Body (JSON):</h3>
  <pre>{ "netflix_id": "your_netflix_id", "secret_key": "your_secret_key" }</pre>
  <h3>Success Response:</h3>
  <pre class="ok">{
  "success": true,
  "login_url": "https://www.netflix.com/unsupported?nftoken=...",
  "pc_url":    "https://netflix.com/account?nftoken=...",
  "nftoken":   "c1.timestamp.token==",
  "account": { "email": "...", "status": "CURRENT_MEMBER", "country": "PH" }
}</pre>
  <h3>Error Response:</h3>
  <pre class="err">{ "success": false, "error": "INVALID_NETFLIX_ID" }</pre>
  <h3>Error Codes:</h3>
  <pre>MISSING_NETFLIX_ID   — netflix_id not provided
MISSING_SECRET_KEY   — secret_key not provided
INVALID_SECRET_KEY   — wrong secret key
INVALID_NETFLIX_ID   — cookie expired or invalid
NFTOKEN_NOT_FOUND    — Netflix changed their API
SERVER_ERROR         — unexpected error</pre>
</body>
</html>`);
});

// ════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n Netflix Token API running on port ${PORT}`);
  console.log(` POST /api/gen  →  generate nftoken`);
  console.log(` GET  /api/health  →  status\n`);
});
