# YouTube Channel Email Scraper

Scrapes the **business email** that YouTube hides behind a reCAPTCHA on channel pages.
The email is only shown to logged-in YouTube users and requires solving a reCAPTCHA — this actor automates the entire flow.

---

## How it works

1. Navigates to `youtube.com/@handle`
2. Opens the channel info panel (subscriber count / metadata area)
3. Clicks **"View email address"**
4. Solves the reCAPTCHA:
   - **Strategy A** — Clicks the "I'm not a robot" checkbox. With a valid logged-in session + stealth browser this often passes instantly (~70% of the time). No extra cost.
   - **Strategy B** — If an image challenge appears and a 2captcha API key is provided, the service solves it and injects the token automatically.
5. Intercepts the YouTube API network response that carries the email (most reliable extraction path)
6. Falls back to DOM text extraction if needed

---

## Input

| Field | Required | Description |
|---|---|---|
| `channelHandles` | ✅ | Array of handles e.g. `["@Drberg", "@MrBeast"]` |
| `cookies` | ✅ | Your YouTube session cookies as JSON array (see below) |
| `twoCaptchaApiKey` | ❌ | API key from 2captcha.com — needed only when image challenge appears |
| `proxyConfiguration` | ❌ | Proxy settings — Apify residential proxies improve CAPTCHA pass rate |
| `maxConcurrency` | ❌ | Default `1`. Keep low to avoid bot detection |
| `delayBetweenRequests` | ❌ | Default `2000` ms |

---

## How to get your YouTube cookies

1. Open **Chrome** and log into YouTube
2. Open **DevTools** (`F12` or `Cmd+Opt+I`)
3. Go to **Application** → **Storage** → **Cookies** → `https://www.youtube.com`
4. Click **Export cookies** (or use the [EditThisCookie](https://chrome.google.com/webstore/detail/editthiscookie/fngmhnnpilhplaeedifhccceomclgfbg) extension)
5. Paste the JSON array into the `cookies` input field

The most important cookies to include: `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `__Secure-1PSID`, `__Secure-3PSID`, `__Secure-3PAPISID`, `LOGIN_INFO`

---

## Output

Each result is pushed to the **Dataset** with this shape:

```json
{
  "handle": "@Drberg",
  "channelUrl": "https://www.youtube.com/@Drberg",
  "email": "genbusiness@drberg.com",
  "status": "success",
  "scrapedAt": "2025-01-01T12:00:00.000Z"
}
```

Possible `status` values:
- `success` — email found
- `email-not-found` — button was clicked and CAPTCHA solved but no email visible (channel may not have set one)
- `email-button-not-found` — button not visible (likely not logged in, or channel has no email)
- `request-failed` — page failed to load after retries

---

## CAPTCHA notes

- **Without 2captcha** — The actor clicks the checkbox. With a real, aged Google account cookie set this passes silently most of the time. Younger/suspicious accounts may get an image challenge.
- **With 2captcha** — Fully automatic. Costs ~$2.99 per 1000 solves. Get a key at [2captcha.com](https://2captcha.com).
- **Residential proxy** — Using Apify residential proxies (`useApifyProxy: true`, group `RESIDENTIAL`) significantly improves pass rates.

---

## Local development

```bash
npm install
# Create .actor/input.json with your input
npm start
```

Deploy to Apify:
```bash
apify push
```
