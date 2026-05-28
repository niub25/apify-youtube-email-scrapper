/**
 * YouTube Channel Email Scraper
 * ─────────────────────────────
 * Scrapes the "business email" hidden behind a reCAPTCHA on YouTube channel pages.
 *
 * HOW THE POPUP WORKS:
 * On the channel page, clicking "...more" in the description area opens a popup.
 * That popup has a "More info" section containing the "View email address" button.
 * This button is only visible to logged-in users — valid session cookies required.
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
        log.info(`📸 Screenshot saved: screenshot-${label}`);
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
    await Dataset.pushData({
        handle: `@${cleanHandle(handle)}`,
        channelUrl,
        email,
        status,
        scrapedAt: new Date().toISOString(),
    });
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

const proxyConfiguration = proxyConfigInput
    ? await Actor.createProxyConfiguration(proxyConfigInput)
    : undefined;

const sameSiteMap = {
    no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax', '': 'Lax',
};

// ─── Crawler ─────────────────────────────────────────────────────────────────

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency,
    navigationTimeoutSecs: 120,
    requestHandlerTimeoutSecs: 300,

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
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--window-size=1280,800',
            ],
        },
    },

    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: { browsers: ['chrome'], operatingSystems: ['windows', 'macos'] },
        },
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
                const sameSite = sameSiteMap[raw] ??
                    (['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'None');
                return {
                    name: c.name, value: c.value,
                    domain: c.domain ?? '.youtube.com', path: c.path ?? '/',
                    secure: c.secure ?? true, httpOnly: c.httpOnly ?? false, sameSite,
                };
            });
            await page.context().addCookies(normalised);
            reqLog.info(`Injected ${normalised.length} cookies`);
        }

        // ── 2. Passive network monitor ───────────────────────────────────────
        let interceptedEmail = null;
        page.on('response', async (response) => {
            try {
                const url = response.url();
                if (!url.includes('youtubei/v1/')) return;
                const ct = response.headers()['content-type'] ?? '';
                if (!ct.includes('application/json')) return;
                const body = await response.text().catch(() => '');
                if (interceptedEmail || !body.includes('@')) return;
                const m = body.match(
                    /[a-zA-Z0-9._%+\-]+@(?!youtube\.|google\.|gstatic\.|googleapis\.|w3\.|schema\.|gzip\.|example\.|sentry\.)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/
                );
                if (m) {
                    interceptedEmail = m[0];
                    reqLog.info(`📡 Intercepted email from API: ${interceptedEmail}`);
                }
            } catch (_) {}
        });

        // ── 3. Navigate with cookies ─────────────────────────────────────────
        await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await sleep(4000); // let YouTube's JS fully render

        const isLoggedIn = await page.evaluate(() =>
            !!document.querySelector('#avatar-btn') || document.cookie.includes('SID')
        );
        reqLog.info(isLoggedIn ? '✅ Logged in' : '⚠️  Not logged in');
        await saveDebugScreenshot(page, `${ch}-01-loaded`);

        // ── 4. Click "...more" to open the channel info popup ─────────────────
        //
        // The popup with "View email address" opens when you click "...more"
        // in the channel description area on the channel home page.
        //
        const moreButtonSelectors = [
            // The expandable description "...more" button
            'ytd-text-inline-expander tp-yt-paper-button#expand',
            'ytd-text-inline-expander #expand',
            '#description-container #expand',
            'tp-yt-paper-button#expand',
            // Text-based fallbacks
            'button:has-text("more")',
            '[aria-label="See more"]',
            // The channel metadata / about section itself
            'ytd-channel-about-metadata-renderer',
            '#channel-metadata-editor',
            // Clicking the description text area
            '#channel-description-container',
            '#description',
        ];

        let popupOpened = false;
        for (const sel of moreButtonSelectors) {
            try {
                const el = page.locator(sel).first();
                if (await el.isVisible({ timeout: 2000 })) {
                    await el.click({ timeout: 4000 });
                    reqLog.info(`Clicked: ${sel}`);
                    await sleep(2500);

                    // Check if popup with "View email address" appeared
                    const emailBtnVisible = await page
                        .getByRole('button', { name: /view email address/i })
                        .first()
                        .isVisible({ timeout: 2000 })
                        .catch(() => false);

                    if (emailBtnVisible) {
                        reqLog.info(`✅ Popup opened and email button visible via: ${sel}`);
                        popupOpened = true;
                        break;
                    }

                    // Also check for "More info" text as a proxy
                    const moreInfoVisible = await page
                        .getByText('More info', { exact: true })
                        .first()
                        .isVisible({ timeout: 1500 })
                        .catch(() => false);

                    if (moreInfoVisible) {
                        reqLog.info(`✅ "More info" section visible via: ${sel}`);
                        popupOpened = true;
                        break;
                    }
                }
            } catch (_) {}
        }

        await saveDebugScreenshot(page, `${ch}-02-after-more-click`);

        if (!popupOpened) {
            // Log all buttons on page to help identify the correct selector
            const allButtons = await page.evaluate(() =>
                Array.from(document.querySelectorAll('button, tp-yt-paper-button, yt-button-renderer'))
                    .map(el => ({ tag: el.tagName, id: el.id, text: el.innerText?.slice(0, 50), aria: el.getAttribute('aria-label') }))
                    .filter(b => b.text || b.aria)
                    .slice(0, 30)
            );
            reqLog.info('All buttons found on page:', { buttons: JSON.stringify(allButtons) });
            await pushResult(handle, channelUrl, null, 'popup-not-opened');
            return;
        }

        // ── 5. Click "View email address" ────────────────────────────────────
        const emailBtnLocators = [
            page.getByRole('button', { name: /view email address/i }),
            page.getByText('View email address', { exact: true }),
            page.locator('yt-button-renderer:has-text("View email address")'),
            page.locator('button:has-text("View email address")'),
            page.locator('[aria-label*="View email" i]'),
        ];

        let emailBtnClicked = false;
        for (const loc of emailBtnLocators) {
            try {
                if (await loc.first().isVisible({ timeout: 3000 })) {
                    await loc.first().click({ timeout: 5000 });
                    reqLog.info('✅ Clicked "View email address"');
                    emailBtnClicked = true;
                    await sleep(2500);
                    break;
                }
            } catch (_) {}
        }

        await saveDebugScreenshot(page, `${ch}-03-after-email-btn`);

        if (!emailBtnClicked) {
            reqLog.warning(`❌ "View email address" button not clickable for @${ch}`);
            await pushResult(handle, channelUrl, null, 'email-button-not-found');
            return;
        }

        // ── 6. Handle reCAPTCHA ───────────────────────────────────────────────
        const captchaPresent = await page
            .locator('iframe[src*="recaptcha"]').first()
            .isVisible({ timeout: 4000 }).catch(() => false);

        if (captchaPresent) {
            reqLog.info('reCAPTCHA detected — trying checkbox click...');
            const captchaFrame = page.frameLocator('iframe[src*="recaptcha"]').first();
            try {
                await captchaFrame.locator('#recaptcha-anchor').click({ timeout: 5000 });
                await sleep(3500);
                const passed = await captchaFrame
                    .locator('#recaptcha-anchor[aria-checked="true"]')
                    .isVisible({ timeout: 4000 }).catch(() => false);

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
            reqLog.info('No reCAPTCHA — email may appear directly');
            await sleep(2000);
        }

        await saveDebugScreenshot(page, `${ch}-04-after-captcha`);

        // ── 7. Extract email ──────────────────────────────────────────────────
        let domEmail = null;
        const bodyText = await page.evaluate(() => document.body.innerText);
        const m = bodyText.match(
            /[a-zA-Z0-9._%+\-]+@(?!youtube\.|google\.|gstatic\.|googleapis\.|w3\.|schema\.|gzip\.|example\.)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/
        );
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
log.info('Done! Check Dataset for results and Key-Value Store for screenshots.');
await Actor.exit();
