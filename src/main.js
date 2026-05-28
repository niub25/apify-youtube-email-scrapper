/**
 * YouTube Channel Email Scraper
 * ─────────────────────────────
 * Scrapes the "business email" hidden behind a reCAPTCHA on YouTube channel pages.
 * Requires valid YouTube session cookies (logged-in account).
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

// ─── Helpers ────────────────────────────────────────────────────────────────

const cleanHandle = (h) => h.replace(/^@/, '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function saveDebugScreenshot(page, label) {
    try {
        const buf = await page.screenshot({ fullPage: false });
        await Actor.setValue(`screenshot-${label}`, buf, { contentType: 'image/png' });
        log.info(`📸 Debug screenshot saved → Key-Value store: screenshot-${label}`);
    } catch (_) {}
}

async function solveWith2Captcha(page, apiKey) {
    log.info('Attempting 2captcha solve...');
    let siteKey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]') || document.querySelector('.g-recaptcha');
        return el?.getAttribute('data-sitekey') ?? null;
    });

    if (!siteKey) {
        const src = await page.locator('iframe[src*="recaptcha"]').first().getAttribute('src').catch(() => null);
        const m = src?.match(/[?&]k=([^&]+)/);
        if (!m) { log.warning('No reCAPTCHA site key found'); return null; }
        siteKey = m[1];
    }

    const pageUrl = page.url();
    try {
        const res = await fetch(`https://2captcha.com/in.php?key=${apiKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`);
        const data = await res.json();
        if (data.status !== 1) { log.error('2captcha submit failed', data); return null; }

        const id = data.request;
        log.info(`2captcha task id=${id}, polling...`);
        for (let i = 0; i < 36; i++) {
            await sleep(5000);
            const r = await (await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${id}&json=1`)).json();
            if (r.status === 1) { log.info('2captcha solved!'); return r.request; }
            if (r.request !== 'CAPCHA_NOT_READY') { log.error('2captcha error', r); return null; }
        }
        log.error('2captcha timed out'); return null;
    } catch (err) { log.error('2captcha threw', { message: err.message }); return null; }
}

async function injectCaptchaToken(page, token) {
    await page.evaluate((t) => {
        const area = document.querySelector('#g-recaptcha-response');
        if (area) {
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(area, t);
            area.dispatchEvent(new Event('input', { bubbles: true }));
        }
        try {
            if (window.___grecaptcha_cfg?.clients) {
                const find = (obj, d = 0) => {
                    if (d > 5 || !obj || typeof obj !== 'object') return null;
                    for (const k of Object.keys(obj)) {
                        if (k === 'callback' && typeof obj[k] === 'function') return obj[k];
                        const f = find(obj[k], d + 1); if (f) return f;
                    }
                    return null;
                };
                for (const ck of Object.keys(window.___grecaptcha_cfg.clients)) {
                    const cb = find(window.___grecaptcha_cfg.clients[ck]);
                    if (cb) { cb(t); return; }
                }
            }
        } catch (_) {}
    }, token);
}

async function pushResult(handle, channelUrl, email, status) {
    await Dataset.pushData({ handle: `@${cleanHandle(handle)}`, channelUrl, email, status, scrapedAt: new Date().toISOString() });
}

// ─── Main ────────────────────────────────────────────────────────────────────

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

if (!channelHandles.length) throw new Error('"channelHandles" is empty');
if (!cookies.length) log.warning('No cookies — email button only shows to logged-in users');

const proxyConfiguration = proxyConfigInput ? await Actor.createProxyConfiguration(proxyConfigInput) : undefined;

const sameSiteMap = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax', '': 'Lax' };

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency,
    navigationTimeoutSecs: 120,
    requestHandlerTimeoutSecs: 300,

    // Force domcontentloaded — YouTube never fires the 'load' event cleanly
    preNavigationHooks: [
        async (_ctx, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 120_000;
        },
    ],

    launchContext: {
        useChrome: Actor.isAtHome(),
        launchOptions: {
            headless: true,
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800'],
        },
    },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: { fingerprintGeneratorOptions: { browsers: ['chrome'], operatingSystems: ['windows', 'macos'] } },
    },

    async requestHandler({ page, request, log: reqLog }) {
        const { handle } = request.userData;
        const ch = cleanHandle(handle);
        const channelUrl = `https://www.youtube.com/@${ch}`;
        reqLog.info(`▶ Processing @${ch}`);

        // ── 1. Inject cookies ────────────────────────────────────────────────
        if (cookies.length) {
            const normalised = cookies.map((c) => {
                const raw = (c.sameSite ?? '').toLowerCase();
                const sameSite = sameSiteMap[raw] ?? (['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'None');
                return { name: c.name, value: c.value, domain: c.domain ?? '.youtube.com', path: c.path ?? '/', secure: c.secure ?? true, httpOnly: c.httpOnly ?? false, sameSite };
            });
            await page.context().addCookies(normalised);
            reqLog.info(`Injected ${normalised.length} cookies`);
        }

        // ── 2. Passive network monitor ────────────────────────────────────────
        // Listen to YouTube API responses only — no re-fetching, no timeouts
        let interceptedEmail = null;
        page.on('response', async (response) => {
            try {
                const url = response.url();
                if (!url.includes('youtubei/v1/')) return;
                const ct = response.headers()['content-type'] ?? '';
                if (!ct.includes('application/json')) return;
                const body = await response.text().catch(() => '');
                if (interceptedEmail || !body.includes('@')) return;
                const m = body.match(/[a-zA-Z0-9._%+\-]+@(?!youtube\.|google\.|gstatic\.|googleapis\.|w3\.|schema\.|gzip\.|example\.|sentry\.)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
                if (m) { interceptedEmail = m[0]; reqLog.info(`📡 Intercepted email from API: ${interceptedEmail}`); }
            } catch (_) {}
        });

        // ── 3. Navigate ───────────────────────────────────────────────────────
        await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await sleep(3000);

        const isLoggedIn = await page.evaluate(() =>
            !!document.querySelector('#avatar-btn') || document.cookie.includes('SID')
        );
        reqLog.info(isLoggedIn ? '✅ Logged in' : '⚠️  Not logged in');

        await saveDebugScreenshot(page, `${ch}-01-after-load`);

        // ── 4. Open the channel info popup ────────────────────────────────────
        //
        // YouTube shows the info popup (with "View email address") when you click
        // on specific areas of the channel header. We try many selectors in order.
        //
        const panelTriggers = [
            // 2024-2026 YouTube UI — metadata row
            'ytd-channel-about-metadata-renderer',
            '#channel-header-container #channel-handle',
            // Subscriber count area
            '#subscriber-count',
            'yt-formatted-string#subscriber-count',
            // Channel name
            '#channel-name yt-formatted-string#text',
            'ytd-channel-name #text',
            // Inner header
            '#inner-header-container',
            // Links / external link section (clicking here sometimes opens popup)
            '#links-section',
            '#link-list-container',
            // Tagline
            '#channel-tagline',
            'ytd-channel-tagline-renderer',
            // About tab
            'a[tab-title="About"]',
            'tp-yt-paper-tab:has-text("About")',
            'yt-tab-shape:has-text("About")',
        ];

        let panelOpened = false;
        for (const sel of panelTriggers) {
            try {
                const el = page.locator(sel).first();
                if (await el.isVisible({ timeout: 1500 })) {
                    await el.click({ timeout: 3000 });
                    await sleep(2000);
                    // Check if the popup appeared (contains "View email" or "More info")
                    const popupVisible = await page.locator('text=View email address, text=More info').first().isVisible({ timeout: 2000 }).catch(() => false);
                    if (popupVisible) {
                        reqLog.info(`✅ Info panel opened via: ${sel}`);
                        panelOpened = true;
                        break;
                    }
                }
            } catch (_) {}
        }

        await saveDebugScreenshot(page, `${ch}-02-after-panel-attempt`);

        if (!panelOpened) {
            reqLog.info('Panel not opened via header — trying /about sub-page...');
            await page.goto(`${channelUrl}/about`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await sleep(3000);
            await saveDebugScreenshot(page, `${ch}-03-about-page`);
        }

        // ── 5. Find "View email address" button ───────────────────────────────
        const emailBtnLocators = [
            page.getByRole('button', { name: /view email address/i }),
            page.getByText('View email address', { exact: true }),
            page.locator('yt-button-renderer:has-text("View email address")'),
            page.locator('button:has-text("View email address")'),
            page.locator('[aria-label*="View email" i]'),
            page.locator('#email-section button'),
            page.locator('ytd-channel-about-metadata-renderer button'),
        ];

        let emailBtnClicked = false;
        for (const loc of emailBtnLocators) {
            try {
                if (await loc.first().isVisible({ timeout: 3000 })) {
                    await loc.first().click({ timeout: 5000 });
                    reqLog.info('✅ Clicked "View email address" button');
                    emailBtnClicked = true;
                    await sleep(2500);
                    break;
                }
            } catch (_) {}
        }

        await saveDebugScreenshot(page, `${ch}-04-after-btn-click`);

        if (!emailBtnClicked) {
            reqLog.warning(`❌ "View email address" button not found for @${ch}`);
            // Log all visible text to help debug selector issues
            const visibleText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
            reqLog.info('Page text snapshot:', { text: visibleText });
            await pushResult(handle, channelUrl, null, 'email-button-not-found');
            return;
        }

        // ── 6. Handle reCAPTCHA ───────────────────────────────────────────────
        const captchaPresent = await page.locator('iframe[src*="recaptcha"]').first().isVisible({ timeout: 4000 }).catch(() => false);

        if (captchaPresent) {
            reqLog.info('reCAPTCHA detected — trying checkbox click...');
            const captchaFrame = page.frameLocator('iframe[src*="recaptcha"]').first();
            try {
                await captchaFrame.locator('#recaptcha-anchor').click({ timeout: 5000 });
                await sleep(3500);
                const passed = await captchaFrame.locator('#recaptcha-anchor[aria-checked="true"]').isVisible({ timeout: 4000 }).catch(() => false);

                if (passed) {
                    reqLog.info('✅ reCAPTCHA checkbox passed!');
                    await page.locator('button:has-text("Submit"), input[type="submit"]').first().click({ timeout: 5000 }).catch(() => null);
                    await sleep(3000);
                } else if (twoCaptchaApiKey) {
                    const token = await solveWith2Captcha(page, twoCaptchaApiKey);
                    if (token) {
                        await injectCaptchaToken(page, token);
                        await sleep(1500);
                        await page.locator('button:has-text("Submit"), input[type="submit"]').first().click({ timeout: 5000 }).catch(() => null);
                        await sleep(3000);
                    }
                } else {
                    reqLog.warning('Image challenge shown — add "twoCaptchaApiKey" to solve automatically');
                }
            } catch (err) {
                reqLog.warning('CAPTCHA interaction error:', { message: err.message });
            }
        } else {
            reqLog.info('No reCAPTCHA frame — email may appear directly');
            await sleep(2000);
        }

        await saveDebugScreenshot(page, `${ch}-05-after-captcha`);

        // ── 7. Extract email ──────────────────────────────────────────────────
        let domEmail = null;
        const bodyText = await page.evaluate(() => document.body.innerText);
        const m = bodyText.match(/[a-zA-Z0-9._%+\-]+@(?!youtube\.|google\.|gstatic\.|googleapis\.|w3\.|schema\.|gzip\.|example\.)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
        if (m) domEmail = m[0];

        const finalEmail = interceptedEmail ?? domEmail;

        if (finalEmail) reqLog.info(`✅ Email for @${ch}: ${finalEmail}`);
        else reqLog.warning(`❌ No email found for @${ch}`);

        await pushResult(handle, channelUrl, finalEmail, finalEmail ? 'success' : 'email-not-found');
        await sleep(delayBetweenRequests);
    },

    failedRequestHandler({ request }) {
        const { handle } = request.userData;
        return pushResult(handle, `https://www.youtube.com/@${cleanHandle(handle)}`, null, 'request-failed');
    },
});

const requests = channelHandles.map((handle) => ({
    url: `https://www.youtube.com/@${cleanHandle(handle)}`,
    userData: { handle },
    uniqueKey: `yt-email-${cleanHandle(handle)}`,
}));

log.info(`Starting scrape of ${requests.length} channel(s)...`);
await crawler.run(requests);
log.info('Done! Check Dataset for results. Check Key-Value Store for debug screenshots.');
await Actor.exit();
