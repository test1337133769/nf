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
  const host = `${req.protocol}://${req.get('host')}`;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Netflix Token Generator API</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Courier New',monospace;background:#0a0a0a;color:#e2e2e2;padding:2rem 1rem;max-width:780px;margin:0 auto;line-height:1.6}
    h1{color:#E50914;font-size:1.8rem;margin-bottom:0.3rem}
    h3{color:#aaa;font-size:0.82rem;letter-spacing:0.12em;text-transform:uppercase;margin:1.5rem 0 0.5rem}
    code{background:#1a1a1a;padding:0.15rem 0.5rem;border-radius:3px;color:#22c55e;font-size:0.82rem}
    pre{background:#111;border:1px solid #222;padding:1rem;border-radius:5px;overflow-x:auto;font-size:0.78rem;line-height:1.7}
    .ok{color:#22c55e}.err{color:#f87171}
    hr{border:none;border-top:1px solid #1e1e1e;margin:2rem 0}
    .test-box{background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:1.5rem;position:relative}
    .test-box::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,#E50914,transparent);border-radius:8px 8px 0 0}
    .field{margin-bottom:1rem}
    .field label{display:block;font-size:0.68rem;letter-spacing:0.12em;text-transform:uppercase;color:#555;margin-bottom:0.4rem}
    .field textarea,.field input{width:100%;background:#090909;border:1px solid #1e1e1e;border-radius:4px;color:#ccc;font-family:'Courier New',monospace;font-size:0.75rem;padding:0.7rem 0.9rem;outline:none;transition:border-color 0.2s;caret-color:#E50914}
    .field textarea{resize:vertical;min-height:85px;line-height:1.6}
    .field textarea:focus,.field input:focus{border-color:#333}
    .field textarea::placeholder,.field input::placeholder{color:#252525}
    .eye-wrap{position:relative}
    .eye-wrap input{padding-right:2.5rem}
    .eye-btn{position:absolute;right:0.7rem;top:50%;transform:translateY(-50%);background:none;border:none;color:#444;cursor:pointer;font-size:0.85rem;padding:0}
    .eye-btn:hover{color:#888}
    .gen-btn{width:100%;background:#E50914;color:#fff;border:none;border-radius:4px;font-family:'Courier New',monospace;font-size:0.88rem;font-weight:bold;letter-spacing:0.1em;padding:0.8rem;cursor:pointer;transition:all 0.15s;text-transform:uppercase}
    .gen-btn:hover:not(:disabled){background:#f40612;box-shadow:0 0 20px rgba(229,9,20,0.3)}
    .gen-btn:disabled{background:#2a0a0a;color:#5a2020;cursor:not-allowed}
    .result{display:none;margin-top:1.2rem;border-radius:4px;padding:1rem;animation:pop 0.2s ease}
    @keyframes pop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
    .result.success{background:#071007;border:1px solid #193a20}
    .result.failure{background:#100707;border:1px solid #381010}
    .result-title{font-size:0.72rem;letter-spacing:0.12em;text-transform:uppercase;font-weight:bold;margin-bottom:0.8rem}
    .result.success .result-title{color:#22c55e}
    .result.failure .result-title{color:#f87171}
    .link-row{margin-bottom:0.7rem}
    .link-label{font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:#555;margin-bottom:0.25rem}
    .link-val{font-size:0.68rem;word-break:break-all;line-height:1.75;padding:0.55rem 0.75rem;border-radius:3px;user-select:all;cursor:text}
    .link-val.phone{background:#050b10;color:#60a5fa;border:1px solid #0f2030}
    .link-val.pc{background:#050802;color:#22c55e;border:1px solid #182510}
    .copy-row{display:flex;gap:0.5rem;margin-top:0.5rem}
    .cbtn{flex:1;background:transparent;border-radius:3px;font-family:'Courier New',monospace;font-size:0.62rem;letter-spacing:0.08em;text-transform:uppercase;padding:0.38rem;cursor:pointer;transition:all 0.15s;border:1px solid}
    .cbtn.phone-btn{border-color:#0f2030;color:#60a5fa}
    .cbtn.phone-btn:hover,.cbtn.phone-btn.done{background:rgba(96,165,250,0.07);border-color:#60a5fa}
    .cbtn.pc-btn{border-color:#182510;color:#22c55e}
    .cbtn.pc-btn:hover,.cbtn.pc-btn.done{background:rgba(34,197,94,0.07);border-color:#22c55e}
    .cbtn.open-btn{border-color:#2a2a2a;color:#888;flex:0 0 auto;padding:0.38rem 0.8rem}
    .cbtn.open-btn:hover{border-color:#444;color:#ccc}
    .acct-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.4rem;margin-top:0.75rem}
    .acct-item{background:#0a0a0a;border:1px solid #1a1a1a;border-radius:3px;padding:0.45rem 0.65rem;font-size:0.63rem}
    .acct-key{color:#444;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:0.15rem}
    .acct-val{color:#aaa}
    .raw-toggle{width:100%;margin-top:0.65rem;background:transparent;border:1px solid #1e1e1e;color:#444;font-family:'Courier New',monospace;font-size:0.62rem;letter-spacing:0.08em;text-transform:uppercase;padding:0.35rem;border-radius:3px;cursor:pointer;transition:all 0.15s}
    .raw-toggle:hover{color:#777;border-color:#333}
    .raw-pre{display:none;margin-top:0.5rem;font-size:0.66rem;color:#777;white-space:pre-wrap;word-break:break-all;background:#080808;border:1px solid #1a1a1a;padding:0.75rem;border-radius:3px;max-height:220px;overflow-y:auto;line-height:1.6}
    .spinner{display:inline-block;width:11px;height:11px;border:2px solid rgba(255,255,255,0.2);border-top-color:#fff;border-radius:50%;animation:spin 0.7s linear infinite;vertical-align:middle;margin-right:0.4rem}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <h1>Netflix Token Generator API</h1>
  <p style="color:#444;font-size:0.78rem;margin-top:0.3rem">POST <code>${host}/api/gen</code></p>

  <hr/>

  <h3>⚡ Generate Token</h3>
  <div class="test-box">

    <div class="field">
      <label>NetflixId Cookie Value</label>
      <textarea id="nfInput" placeholder="Paste your NetflixId here&#10;With or without 'NetflixId=' prefix — both work" spellcheck="false"></textarea>
    </div>

    <div class="field">
      <label>Secret Key</label>
      <div class="eye-wrap">
        <input type="password" id="skInput" placeholder="Enter your secret key" spellcheck="false"/>
        <button class="eye-btn" onclick="toggleEye()">&#128065;</button>
      </div>
    </div>

    <button class="gen-btn" id="genBtn" onclick="generate()">Generate Token</button>

    <div class="result" id="result">
      <div class="result-title" id="resultTitle"></div>

      <div id="successContent" style="display:none">
        <div class="link-row">
          <div class="link-label">&#128241; Phone Link</div>
          <div class="link-val phone" id="phoneUrl"></div>
        </div>
        <div class="link-row">
          <div class="link-label">&#128421; PC Link</div>
          <div class="link-val pc" id="pcUrl"></div>
        </div>
        <div class="copy-row">
          <button class="cbtn phone-btn" id="cpPhone" onclick="copyLink('phone')">Copy Phone</button>
          <button class="cbtn pc-btn"    id="cpPc"    onclick="copyLink('pc')">Copy PC</button>
          <button class="cbtn open-btn"               onclick="openLink()">Open &#x2197;</button>
        </div>
        <div class="acct-grid" id="acctGrid"></div>
        <button class="raw-toggle" onclick="toggleRaw()">Show Raw Response</button>
        <pre class="raw-pre" id="rawPre"></pre>
      </div>

      <div id="errorContent" style="display:none">
        <pre id="errorPre" style="color:#f87171;background:#0d0505;border:1px solid #2a1010;padding:0.7rem;border-radius:3px;font-size:0.72rem"></pre>
      </div>
    </div>
  </div>

  <hr/>

  <h3>API Endpoint</h3>
  <p style="margin-bottom:0.5rem">POST <code>${host}/api/gen</code></p>

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

<script>
  var phoneLink='', pcLink='';

  function toggleEye(){
    var i=document.getElementById('skInput');
    i.type=i.type==='password'?'text':'password';
  }

  function generate(){
    var nf=document.getElementById('nfInput').value.trim();
    var sk=document.getElementById('skInput').value.trim();
    var btn=document.getElementById('genBtn');
    var res=document.getElementById('result');
    if(!nf||!sk){alert('Please fill in both fields');return;}
    btn.disabled=true;
    btn.innerHTML='<span class="spinner"></span>Generating...';
    res.style.display='none';
    phoneLink='';pcLink='';
    fetch('/api/gen',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({netflix_id:nf,secret_key:sk})})
    .then(function(r){return r.json();})
    .then(function(d){
      res.style.display='block';
      document.getElementById('rawPre').textContent=JSON.stringify(d,null,2);
      document.getElementById('rawPre').style.display='none';
      if(d.success){
        res.className='result success';
        document.getElementById('resultTitle').textContent='✓ TOKEN GENERATED SUCCESSFULLY';
        document.getElementById('successContent').style.display='block';
        document.getElementById('errorContent').style.display='none';
        phoneLink=d.login_url||'';pcLink=d.pc_url||'';
        setUrl('phoneUrl',phoneLink);setUrl('pcUrl',pcLink);
        var acct=d.account||{};
        var g=document.getElementById('acctGrid');g.innerHTML='';
        [['Email',acct.email],['Status',acct.status],['Country',acct.country],['Plan',acct.plan]].forEach(function(f){
          if(f[1])g.innerHTML+='<div class="acct-item"><div class="acct-key">'+f[0]+'</div><div class="acct-val">'+f[1]+'</div></div>';
        });
        resetBtn('cpPhone','Copy Phone');resetBtn('cpPc','Copy PC');
      }else{
        res.className='result failure';
        document.getElementById('resultTitle').textContent='✗ FAILED';
        document.getElementById('successContent').style.display='none';
        document.getElementById('errorContent').style.display='block';
        document.getElementById('errorPre').textContent=JSON.stringify(d,null,2);
      }
    })
    .catch(function(e){
      res.style.display='block';res.className='result failure';
      document.getElementById('resultTitle').textContent='✗ REQUEST FAILED';
      document.getElementById('successContent').style.display='none';
      document.getElementById('errorContent').style.display='block';
      document.getElementById('errorPre').textContent='Error: '+e.message;
    })
    .finally(function(){btn.disabled=false;btn.innerHTML='Generate Token';});
  }

  function setUrl(id,url){var e=document.getElementById(id);e.textContent='';e.textContent=url||'—';}

  function copyLink(type){
    var url=type==='phone'?phoneLink:pcLink;
    var id=type==='phone'?'cpPhone':'cpPc';
    var lb=type==='phone'?'Copy Phone':'Copy PC';
    if(!url)return;
    writeClip(url,function(){var b=document.getElementById(id);b.textContent='Copied ✓';b.classList.add('done');setTimeout(function(){resetBtn(id,lb);},2500);});
  }

  function openLink(){if(phoneLink)window.open(phoneLink,'_blank');}

  function toggleRaw(){var p=document.getElementById('rawPre');p.style.display=p.style.display==='none'?'block':'none';}

  function resetBtn(id,lb){var b=document.getElementById(id);b.textContent=lb;b.classList.remove('done');}

  function writeClip(text,cb){
    if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(cb).catch(function(){fb(text,cb);});}
    else{fb(text,cb);}
  }
  function fb(text,cb){var t=document.createElement('textarea');t.value=text;t.style.cssText='position:fixed;top:-9999px;opacity:0;';document.body.appendChild(t);t.focus();t.select();try{document.execCommand('copy');cb();}catch(e){}document.body.removeChild(t);}

  document.addEventListener('keydown',function(e){if(e.ctrlKey&&e.key==='Enter')generate();});
</script>
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
