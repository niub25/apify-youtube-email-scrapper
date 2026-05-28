/**
 * YouTube Channel Email Scraper
 * ─────────────────────────────
 * Clicks "...more" on the channel page → popup opens → clicks "View email address"
 * → solves reCAPTCHA → extracts email.
 *
 * Cookies are injected BEFORE navigation via preNavigationHooks so the page
 * loads already logged-in — no second page.goto needed.
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

const cleanHandle = (h) => h.replace(/^@/, '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snap(page, label) {
    try {
        await Actor.setValue(`ss-${label}`, await page.screenshot({ fullPage: false }), { contentType: 'image/png' });
        log.info(`📸 ${label}`);
    } catch (_) {}
}

async function pushResult(handle, channelUrl, email, status) {
    await Dataset.pushData({ handle: `@${cleanHandle(handle)}`, channelUrl, email, status, scrapedAt: new Date().toISOString() });
}

async function solveWith2Captcha(page, apiKey) {
    let siteKey = await page.evaluate(() => document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') ?? null);
    if (!siteKey) {
        const src = await page.locator('iframe[src*="recaptcha"]').first().getAttribute('src').catch(() => '');
        const m = src.match(/[?&]k=([^&]+)/);
        if (!m) return null;
        siteKey = m[1];
    }
    const pageUrl = page.url();
    const sub = await (await fetch(`https://2captcha.com/in.php?key=${apiKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`)).json();
    if (sub.status !== 1) return null;
    for (let i = 0; i < 36; i++) {
        await sleep(5000);
        const r = await (await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${sub.request}&json=1`)).json();
        if (r.status === 1) return r.request;
        if (r.request !== 'CAPCHA_NOT_READY') return null;
    }
    return null;
}

// ─── Init ────────────────────────────────────────────────────────────────────

await Actor.init();
const input = await Actor.getInput() ?? {};
const { channelHandles = [], cookies = [], twoCaptchaApiKey = '', proxyConfiguration: proxyConfigInput, maxConcurrency = 1, delayBetweenRequests = 2000 } = input;

if (!channelHandles.length) throw new Error('"channelHandles" is empty');
if (!cookies.length) log.warning('No cookies provided — email button only visible to logged-in users');

const proxyConfiguration = proxyConfigInput ? await Actor.createProxyConfiguration(proxyConfigInput) : undefined;

const sameSiteMap = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax', '': 'Lax' };

function normaliseCookies(raw) {
    return raw.map((c) => {
        const s = (c.sameSite ?? '').toLowerCase();
        return {
            name: c.name, value: c.value,
            domain: c.domain ?? '.youtube.com', path: c.path ?? '/',
            secure: c.secure ?? true, httpOnly: c.httpOnly ?? false,
            sameSite: sameSiteMap[s] ?? (['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'None'),
        };
    });
}

// ─── Crawler ─────────────────────────────────────────────────────────────────

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency,
    navigationTimeoutSecs: 120,
    requestHandlerTimeoutSecs: 300,

    // Inject cookies BEFORE Crawlee navigates — no re-navigation needed
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 120_000;
            if (cookies.length) {
                await page.context().addCookies(normaliseCookies(cookies)).catch(() => {});
            }
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

    async requestHandler({ page, request, log: L }) {
        const { handle } = request.userData;
        const ch = cleanHandle(handle);
        const channelUrl = `https://www.youtube.com/@${ch}`;
        L.info(`▶ @${ch}`);

        // ── Network monitor (passive — no re-fetching) ───────────────────────
        let interceptedEmail = null;
        page.on('response', async (res) => {
            try {
                if (!res.url().includes('youtubei/v1/')) return;
                if (!(res.headers()['content-type'] ?? '').includes('application/json')) return;
                const body = await res.text().catch(() => '');
                if (interceptedEmail || !body.includes('@')) return;
                const m = body.match(/[a-zA-Z0-9._%+\-]+@(?!youtube\.|google\.|gstatic\.|googleapis\.|w3\.|schema\.|gzip\.|example\.|sentry\.)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
                if (m) { interceptedEmail = m[0]; L.info(`📡 Network email: ${interceptedEmail}`); }
            } catch (_) {}
        });

        // ── Wait for YouTube to render channel content ───────────────────────
        // Cookies were already injected before this navigation — no second goto needed
        await sleep(2000);

        // Wait for the channel header or app shell to appear
        await page.waitForSelector('ytd-app, ytd-page-manager', { timeout: 30_000 }).catch(() => null);
        await sleep(3000);

        const isLoggedIn = await page.evaluate(() => !!document.querySelector('#avatar-btn') || document.cookie.includes('SID'));
        L.info(isLoggedIn ? '✅ Logged in' : '⚠️  Not logged in');
        await snap(page, `${ch}-01-loaded`);

        // ── Click "...more" via JavaScript ───────────────────────────────────
        //
        // YouTube's "more" button is a web component (tp-yt-paper-button).
        // We click it via JS to bypass Playwright's visibility requirements.
        // The button is inside ytd-text-inline-expander with id="expand".
        //
        const popupOpened = await page.evaluate(async () => {
            const wait = (ms) => new Promise(r => setTimeout(r, ms));

            // Scroll down slightly so channel description comes into view
            window.scrollBy(0, 300);
            await wait(1000);

            const candidates = [
    // ✅ Confirmed selector from debug log
    document.querySelector('tp-yt-paper-button#more'),
    document.querySelector('ytd-text-inline-expander tp-yt-paper-button#more'),
    // Fallbacks
    document.querySelector('ytd-text-inline-expander #expand'),
    document.querySelector('tp-yt-paper-button#expand'),
    document.querySelector('ytd-channel-about-metadata-renderer'),
    // Any tp-yt-paper-button with "more" or "Read more" text
    ...Array.from(document.querySelectorAll('tp-yt-paper-button')).filter(el =>
        (el.id === 'more' || el.textContent.trim().toLowerCase().includes('read more')) && el.offsetParent !== null
    ),
].filter(Boolean);

            for (const el of candidates) {
                try {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await wait(500);
                    el.click();
                    await wait(2000);

                    // Check if popup appeared — look for "View email address" text
                    const emailBtn = document.body.innerText.toLowerCase().includes('view email address');
                    const moreInfo = document.body.innerText.toLowerCase().includes('more info');
                    if (emailBtn || moreInfo) return `clicked: ${el.tagName}#${el.id}`;
                } catch (_) {}
            }
            return null;
        });

        L.info(popupOpened ? `✅ Popup opened (${popupOpened})` : '❌ Popup not opened');
        await snap(page, `${ch}-02-popup`);

        if (!popupOpened) {
            // Dump all tp-yt-paper-button elements for debugging
            const paperBtns = await page.evaluate(() =>
                Array.from(document.querySelectorAll('tp-yt-paper-button, yt-button-renderer'))
                    .map(el => ({ tag: el.tagName, id: el.id, text: el.textContent?.trim().slice(0, 40) }))
                    .filter(b => b.text)
                    .slice(0, 40)
            );
            L.info('tp-yt-paper-buttons on page:', { btns: JSON.stringify(paperBtns) });
            await pushResult(handle, channelUrl, null, 'popup-not-opened');
            return;
        }

        // ── Click "View email address" via JS ────────────────────────────────
        const emailBtnClicked = await page.evaluate(async () => {
            const wait = (ms) => new Promise(r => setTimeout(r, ms));
            const all = Array.from(document.querySelectorAll('*'));

            for (const el of all) {
                const text = (el.innerText || el.textContent || '').toLowerCase().trim();
                if (text === 'view email address' || text.includes('view email address')) {
                    try {
                        el.scrollIntoView({ block: 'center' });
                        await wait(300);
                        el.click();
                        return el.tagName + '#' + el.id;
                    } catch (_) {}
                }
            }
            return null;
        });

        L.info(emailBtnClicked ? `✅ Clicked email btn (${emailBtnClicked})` : '❌ Email button not found');
        await snap(page, `${ch}-03-email-btn`);

        if (!emailBtnClicked) {
            await pushResult(handle, channelUrl, null, 'email-button-not-found');
            return;
        }

        await sleep(2500);

        // ── Handle reCAPTCHA ─────────────────────────────────────────────────
        const captchaPresent = await page.locator('iframe[src*="recaptcha"]').first().isVisible({ timeout: 4000 }).catch(() => false);

        if (captchaPresent) {
            L.info('reCAPTCHA detected — trying checkbox click...');
            const frame = page.frameLocator('iframe[src*="recaptcha"]').first();
            try {
                await frame.locator('#recaptcha-anchor').click({ timeout: 5000 });
                await sleep(3500);
                const passed = await frame.locator('#recaptcha-anchor[aria-checked="true"]').isVisible({ timeout: 4000 }).catch(() => false);

                if (passed) {
                    L.info('✅ reCAPTCHA passed!');
                    await page.locator('button:has-text("Submit"), input[type="submit"]').first().click({ timeout: 5000 }).catch(() => null);
                    await sleep(3000);
                } else if (twoCaptchaApiKey) {
                    const token = await solveWith2Captcha(page, twoCaptchaApiKey);
                    if (token) {
                        await page.evaluate((t) => {
                            const area = document.querySelector('#g-recaptcha-response');
                            if (area) { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(area, t); area.dispatchEvent(new Event('input', { bubbles: true })); }
                            try {
                                if (window.___grecaptcha_cfg?.clients) {
                                    const find = (obj, d = 0) => { if (d > 5 || !obj || typeof obj !== 'object') return null; for (const k of Object.keys(obj)) { if (k === 'callback' && typeof obj[k] === 'function') return obj[k]; const f = find(obj[k], d + 1); if (f) return f; } return null; };
                                    for (const ck of Object.keys(window.___grecaptcha_cfg.clients)) { const cb = find(window.___grecaptcha_cfg.clients[ck]); if (cb) { cb(t); return; } }
                                }
                            } catch (_) {}
                        }, token);
                        await sleep(1500);
                        await page.locator('button:has-text("Submit"), input[type="submit"]').first().click({ timeout: 5000 }).catch(() => null);
                        await sleep(3000);
                    }
                } else {
                    L.warning('Image challenge shown — add "twoCaptchaApiKey" to input');
                }
            } catch (err) { L.warning('CAPTCHA error:', { message: err.message }); }
        } else {
            L.info('No reCAPTCHA — email may appear directly');
            await sleep(2000);
        }

        await snap(page, `${ch}-04-after-captcha`);

        // ── Extract email ────────────────────────────────────────────────────
        const bodyText = await page.evaluate(() => document.body.innerText);
        const m = bodyText.match(/[a-zA-Z0-9._%+\-]+@(?!youtube\.|google\.|gstatic\.|googleapis\.|w3\.|schema\.|gzip\.|example\.)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
        const domEmail = m?.[0] ?? null;
        const finalEmail = interceptedEmail ?? domEmail;

        L.info(finalEmail ? `✅ Email: ${finalEmail}` : `❌ No email found`);
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

log.info(`Scraping ${requests.length} channel(s)...`);
await crawler.run(requests);
log.info('Done! Check Dataset + Key-Value Store (screenshots).');
await Actor.exit();
