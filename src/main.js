/**
 * YouTube Channel Email Scraper
 * ─────────────────────────────
 * Scrapes the "business email" that YouTube hides behind a reCAPTCHA on channel pages.
 * The email is only visible to logged-in users. You must supply valid session cookies.
 *
 * Flow per channel:
 *   1. Navigate to youtube.com/@handle
 *   2. Open the channel info popup (click on subscriber count / metadata area)
 *   3. Find and click "View email address"
 *   4. Solve the reCAPTCHA  →  try checkbox click first; fall back to 2captcha if key supplied
 *   5. Intercept the YouTube API response that carries the email (most reliable method)
 *      OR extract from the DOM after CAPTCHA is solved
 *   6. Push result to Apify Dataset
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Normalise a handle → strip leading @ so we can build URLs cleanly */
function cleanHandle(handle) {
    return handle.replace(/^@/, '').trim();
}

/** Sleep helper */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Solve a reCAPTCHA v2 on the current page using the 2captcha service.
 * Returns the g-recaptcha-response token on success, null on failure.
 */
async function solveWith2Captcha(page, apiKey) {
    log.info('Attempting to solve reCAPTCHA with 2captcha...');

    // Grab the site key from the page DOM
    const siteKey = await page.evaluate(() => {
        const el =
            document.querySelector('[data-sitekey]') ||
            document.querySelector('.g-recaptcha');
        return el ? el.getAttribute('data-sitekey') : null;
    });

    if (!siteKey) {
        // Try to find it inside the reCAPTCHA iframe src
        const iframeSrc = await page
            .locator('iframe[src*="recaptcha"]')
            .first()
            .getAttribute('src')
            .catch(() => null);

        if (!iframeSrc) {
            log.warning('Could not locate reCAPTCHA site key — skipping 2captcha solve');
            return null;
        }

        const match = iframeSrc.match(/[?&]k=([^&]+)/);
        if (!match) return null;
        // Re-use with extracted key — fall through below with it embedded in URL
    }

    const pageUrl = page.url();
    const key = siteKey;

    // Submit task to 2captcha
    let captchaId;
    try {
        const submitUrl =
            `https://2captcha.com/in.php` +
            `?key=${apiKey}` +
            `&method=userrecaptcha` +
            `&googlekey=${key}` +
            `&pageurl=${encodeURIComponent(pageUrl)}` +
            `&json=1`;

        const res = await fetch(submitUrl);
        const data = await res.json();

        if (data.status !== 1) {
            log.error('2captcha submit failed', { response: data });
            return null;
        }
        captchaId = data.request;
        log.info(`2captcha task submitted, id=${captchaId}`);
    } catch (err) {
        log.error('2captcha submit threw:', { message: err.message });
        return null;
    }

    // Poll for result (up to 3 minutes)
    for (let attempt = 0; attempt < 36; attempt++) {
        await sleep(5000);
        try {
            const res = await fetch(
                `https://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`
            );
            const data = await res.json();

            if (data.status === 1) {
                log.info('2captcha solved!');
                return data.request; // the token
            }
            if (data.request !== 'CAPCHA_NOT_READY') {
                log.error('2captcha returned error', { response: data });
                return null;
            }
        } catch (err) {
            log.warning('2captcha poll error:', { message: err.message });
        }
    }

    log.error('2captcha timed out after 3 minutes');
    return null;
}

/**
 * Inject a solved reCAPTCHA token into the page and trigger the callback.
 */
async function injectCaptchaToken(page, token) {
    await page.evaluate((t) => {
        // Set the hidden textarea value YouTube reads
        const area = document.querySelector('#g-recaptcha-response');
        if (area) {
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
                .set.call(area, t);
            area.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Fire the registered reCAPTCHA callback (works for v2 checkbox)
        try {
            if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
                for (const clientKey of Object.keys(window.___grecaptcha_cfg.clients)) {
                    const client = window.___grecaptcha_cfg.clients[clientKey];
                    // Traverse the nested object to find a callback function
                    const findCallback = (obj, depth = 0) => {
                        if (depth > 5 || !obj || typeof obj !== 'object') return null;
                        for (const k of Object.keys(obj)) {
                            if (k === 'callback' && typeof obj[k] === 'function') return obj[k];
                            const found = findCallback(obj[k], depth + 1);
                            if (found) return found;
                        }
                        return null;
                    };
                    const cb = findCallback(client);
                    if (cb) { cb(t); return; }
                }
            }
        } catch (_) { /* ignore */ }
    }, token);
}

// ─── Main actor ─────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput() ?? {};

const {
    channelHandles = [],
    cookies = [],
    twoCaptchaApiKey = '',
    proxyConfiguration: proxyConfigInput,
    maxConcurrency = 1,
    delayBetweenRequests = 2000,
} = input;

if (!channelHandles.length) {
    throw new Error('Input error: "channelHandles" array is empty. Provide at least one handle.');
}
if (!cookies.length) {
    log.warning('No cookies provided — the "View email address" button is only shown to logged-in users. Add your YouTube session cookies.');
}

const proxyConfiguration = proxyConfigInput
    ? await Actor.createProxyConfiguration(proxyConfigInput)
    : undefined;

// ─── Crawler ────────────────────────────────────────────────────────────────

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency,

    // Use full Chrome (not Chromium) and stealth mode to look human
    launchContext: {
        useChrome: Actor.isAtHome(), // real Chrome on Apify platform
        launchOptions: {
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-infobars',
                '--window-size=1280,800',
            ],
        },
    },

    browserPoolOptions: {
        useFingerprints: true, // randomise canvas, fonts, etc.
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: ['chrome'],
                operatingSystems: ['windows', 'macos'],
            },
        },
    },

    // ── Per-request handler ──────────────────────────────────────────────────
    async requestHandler({ page, request, log: reqLog }) {
        const { handle } = request.userData;
        const ch = cleanHandle(handle);
        const channelUrl = `https://www.youtube.com/@${ch}`;

        reqLog.info(`▶ Processing @${ch}`);

        // ── 1. Inject cookies so we're "logged in" ───────────────────────────
        if (cookies.length) {
            // Map browser export sameSite values → Playwright accepted values
const sameSiteMap = {
    'no_restriction': 'None',
    'lax': 'Lax',
    'strict': 'Strict',
    'unspecified': 'Lax',
    '': 'Lax',
};

const normalised = cookies.map((c) => {
    const raw = (c.sameSite ?? '').toLowerCase();
    const sameSite = sameSiteMap[raw] ?? (
        ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'None'
    );
    return {
        name: c.name,
        value: c.value,
        domain: c.domain ?? '.youtube.com',
        path: c.path ?? '/',
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false,
        sameSite,
    };
});
            await page.context().addCookies(normalised);
            reqLog.info(`Injected ${normalised.length} cookies`);
        }

        // ── 2. Set up network interception BEFORE navigation ─────────────────
        //
        // When the "View email address" button is clicked and reCAPTCHA solved,
        // YouTube calls an internal API that returns the email. We intercept it.
        // Observed endpoint pattern: /youtubei/v1/...  or browse2 continuation
        // The email shows up in the JSON body as a plain string matching an
        // email regex. We capture ANY response body containing an @ sign.
        //
        let interceptedEmail = null;

        await page.route('**/*', async (route) => {
            const response = await route.fetch();
            try {
                const ct = response.headers()['content-type'] ?? '';
                if (ct.includes('application/json') || ct.includes('text/')) {
                    const body = await response.text();
                    if (interceptedEmail === null && body.includes('@')) {
                        // Quick pre-filter before expensive regex
                        const emailMatch = body.match(
                            /[a-zA-Z0-9._%+\-]+@(?!youtube|google|gstatic|googleapis|schema|w3)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/
                        );
                        if (emailMatch) {
                            interceptedEmail = emailMatch[0];
                            reqLog.info(`📡 Intercepted email from network: ${interceptedEmail}`);
                        }
                    }
                }
            } catch (_) { /* non-text body — ignore */ }
            await route.fulfill({ response });
        });

        // ── 3. Navigate ──────────────────────────────────────────────────────
        await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await sleep(2500);

        // Check login state
        const isLoggedIn = await page.evaluate(() => {
            return document.querySelector('ytd-masthead #avatar-btn, ytd-topbar-logo-renderer + * [id="avatar-btn"]') !== null
                || document.cookie.includes('SID');
        });
        reqLog.info(isLoggedIn ? '✅ Logged in' : '⚠️  Not logged in — email button may be hidden');

        // ── 4. Open the channel info panel ───────────────────────────────────
        //
        // The popup that contains "View email address" opens when you click on
        // the channel metadata row (subscriber count / handle area).
        // We try several selectors that YouTube has used across UI versions.
        //
        const infoTriggerSelectors = [
            // Current (2024+) channel page metadata
            'ytd-channel-about-metadata-renderer',
            '#channel-header-container ytd-subscribe-button-renderer + *',
            // Subscriber count pill
            '#subscriber-count',
            // Handle / username row
            '#channel-handle',
            // Older "About" tab link
            '[tab-title="About"]',
        ];

        let panelOpened = false;
        for (const sel of infoTriggerSelectors) {
            try {
                const el = page.locator(sel).first();
                if (await el.isVisible({ timeout: 2000 })) {
                    await el.click({ timeout: 3000 });
                    await sleep(1500);
                    panelOpened = true;
                    reqLog.info(`Opened info panel via: ${sel}`);
                    break;
                }
            } catch (_) { /* try next */ }
        }

        if (!panelOpened) {
            // Fallback: navigate to /about sub-page which sometimes surfaces the button directly
            reqLog.info('Panel trigger not found — trying /about sub-page...');
            await page.goto(`${channelUrl}/about`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await sleep(2000);
        }

        // ── 5. Find and click "View email address" ───────────────────────────
        const emailBtnSelectors = [
            'text=View email address',
            '[aria-label*="email" i]',
            'yt-button-renderer:has-text("email")',
            '#contact-links yt-button-renderer',
        ];

        let emailBtnClicked = false;
        for (const sel of emailBtnSelectors) {
            try {
                const btn = page.locator(sel).first();
                if (await btn.isVisible({ timeout: 3000 })) {
                    await btn.click({ timeout: 5000 });
                    reqLog.info(`Clicked email button via: ${sel}`);
                    emailBtnClicked = true;
                    await sleep(2000);
                    break;
                }
            } catch (_) { /* try next */ }
        }

        if (!emailBtnClicked) {
            reqLog.warning(`Could not find "View email address" button for @${ch} — channel may have no email or login failed`);
            await pushResult(handle, channelUrl, null, 'email-button-not-found');
            return;
        }

        // ── 6. Handle reCAPTCHA ──────────────────────────────────────────────
        //
        // Strategy A: Click the "I'm not a robot" checkbox.
        //   With a valid logged-in session + stealth browser this often passes
        //   instantly (no image puzzle). Google trusts the account.
        //
        // Strategy B: If checkbox didn't pass (image puzzle shown) and the user
        //   supplied a 2captcha key, use it to get a token and inject it.
        //
        // Strategy C: If neither worked but we already intercepted the email
        //   from the network, we still report success.
        //

        const captchaIframeLocator = page.frameLocator('iframe[src*="recaptcha"]').first();

        // Check if CAPTCHA frame is present
        const captchaPresent = await page
            .locator('iframe[src*="recaptcha"]')
            .first()
            .isVisible({ timeout: 4000 })
            .catch(() => false);

        if (captchaPresent) {
            reqLog.info('reCAPTCHA detected — attempting checkbox click...');

            try {
                // Click the checkbox
                await captchaIframeLocator.locator('#recaptcha-anchor').click({ timeout: 5000 });
                await sleep(3000);

                // Check if it passed (aria-checked becomes "true")
                const passed = await captchaIframeLocator
                    .locator('#recaptcha-anchor[aria-checked="true"]')
                    .isVisible({ timeout: 4000 })
                    .catch(() => false);

                if (passed) {
                    reqLog.info('✅ reCAPTCHA checkbox passed instantly!');
                    // Click Submit button
                    await page.locator('button:has-text("Submit"), input[type="submit"]').first().click({ timeout: 5000 }).catch(() => null);
                    await sleep(3000);
                } else {
                    reqLog.warning('Checkbox did not pass — image challenge likely shown');

                    if (twoCaptchaApiKey) {
                        const token = await solveWith2Captcha(page, twoCaptchaApiKey);
                        if (token) {
                            await injectCaptchaToken(page, token);
                            await sleep(1500);
                            await page.locator('button:has-text("Submit"), input[type="submit"]').first().click({ timeout: 5000 }).catch(() => null);
                            await sleep(3000);
                        }
                    } else {
                        reqLog.warning('No 2captcha API key provided — cannot solve image challenge. Add "twoCaptchaApiKey" to input.');
                    }
                }
            } catch (err) {
                reqLog.warning('CAPTCHA interaction error:', { message: err.message });
            }
        } else {
            reqLog.info('No reCAPTCHA frame detected — email may appear directly');
            await sleep(2000);
        }

        // ── 7. Extract email from DOM ────────────────────────────────────────
        //
        // After CAPTCHA is solved YouTube updates the panel in-place.
        // We also check intercepted network responses (set up in step 2).
        //
        let domEmail = null;

        // Look in the info panel area
        const infoPanel = page.locator(
            'ytd-channel-about-metadata-renderer, #channel-about-metadata, #about-description, ytd-engagement-panel-section-list-renderer'
        ).first();

        if (await infoPanel.isVisible({ timeout: 3000 }).catch(() => false)) {
            const panelText = await infoPanel.innerText().catch(() => '');
            const m = panelText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
            if (m) domEmail = m[0];
        }

        // Broader page scan as last resort
        if (!domEmail) {
            const bodyText = await page.evaluate(() => document.body.innerText);
            const m = bodyText.match(
                /[a-zA-Z0-9._%+\-]+@(?!youtube|google|gstatic|googleapi|schema|w3)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/
            );
            if (m) domEmail = m[0];
        }

        const finalEmail = interceptedEmail ?? domEmail;

        if (finalEmail) {
            reqLog.info(`✅ Found email for @${ch}: ${finalEmail}`);
        } else {
            reqLog.warning(`❌ No email found for @${ch}`);
        }

        await pushResult(handle, channelUrl, finalEmail, finalEmail ? 'success' : 'email-not-found');

        // Be polite — wait before the next request
        await sleep(delayBetweenRequests);
    },

    failedRequestHandler({ request, log: reqLog }) {
        const { handle } = request.userData;
        reqLog.error(`Request failed for @${cleanHandle(handle)} after all retries`);
        return pushResult(handle, `https://www.youtube.com/@${cleanHandle(handle)}`, null, 'request-failed');
    },
});

// ─── Push result to Dataset ──────────────────────────────────────────────────

async function pushResult(handle, channelUrl, email, status) {
    await Dataset.pushData({
        handle: `@${cleanHandle(handle)}`,
        channelUrl,
        email,
        status,
        scrapedAt: new Date().toISOString(),
    });
}

// ─── Build requests and run ──────────────────────────────────────────────────

const requests = channelHandles.map((handle) => ({
    url: `https://www.youtube.com/@${cleanHandle(handle)}`,
    userData: { handle },
    uniqueKey: `yt-email-${cleanHandle(handle)}`,
}));

log.info(`Starting scrape of ${requests.length} channel(s)...`);
await crawler.run(requests);
log.info('All done! Check the Dataset tab for results.');

await Actor.exit();
