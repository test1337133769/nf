# Netflix Token Generator API

## Deploy to Railway (Free)

### Step 1 — GitHub
1. Create a new repo on github.com (free account)
2. Upload these files:  server.js  package.json  railway.toml  .gitignore

### Step 2 — Railway
1. Go to railway.app → Login with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repo
4. Railway auto-detects Node.js and deploys

### Step 3 — Set Secret Key
1. In Railway dashboard → your project → "Variables"
2. Add variable:  SECRET_KEY = anything you want (e.g. mykey123)
3. Railway redeploys automatically

### Step 4 — Get your URL
Railway gives you a URL like:
  https://netflix-api-production-xxxx.up.railway.app

Your API endpoint:
  POST https://your-url.up.railway.app/api/gen

---

## API Usage

### Request
POST /api/gen
Content-Type: application/json

{
  "netflix_id": "v%3D3%26ct%3D...",
  "secret_key": "mykey123"
}

### Success Response
{
  "success": true,
  "login_url": "https://www.netflix.com/unsupported?nftoken=...",
  "pc_url": "https://netflix.com/account?nftoken=...",
  "nftoken": "c1.timestamp.token==",
  "account": {
    "email": "user@gmail.com",
    "status": "CURRENT_MEMBER",
    "country": "PH"
  }
}

### Test with curl
curl -X POST https://your-url.up.railway.app/api/gen \
  -H "Content-Type: application/json" \
  -d '{"netflix_id":"YOUR_ID","secret_key":"mykey123"}'

### Test with Python
import requests
r = requests.post("https://your-url.up.railway.app/api/gen",
    json={"netflix_id": "YOUR_ID", "secret_key": "mykey123"})
print(r.json().get("login_url"))
