// Native startup acceptance: hold only near tile packs, or fail only optional far packs.
// node --max-old-space-size=2048 scripts/qa/startup-streets.mjs URL ARTIFACT OUT near-delay|far-failure|near-timeout
// Fresh profile, real input, no simulation replacement or teleport. Run under the shared serial QA lock.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('@playwright/test');
const [base = 'http://127.0.0.1:4371/', artifact, out = undefined, scenario = 'near-delay'] = process.argv.slice(2);
if (!artifact || !out)
    throw Error('Usage: node scripts/qa/startup-streets.mjs URL ARTIFACT OUT near-delay|far-failure|near-timeout');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
    throw Error('Use a separately served local candidate');
if (!['near-delay', 'far-failure', 'near-timeout'].includes(scenario))
    throw Error('Unknown scenario');
mkdirSync(out, { recursive: true });
const R = { scenario, url: base, artifact, sourceRevision: process.argv[6] ?? null, browserHeapMB: 1536, viewport: { width: 960, height: 600 }, verifiedFiles: [], requests: [], samples: [], errors: [], expectedNetworkFailures: [], expectedStartupFailures: [], passed: false };
const flush = () => writeFileSync(out + '/proof.json', JSON.stringify(R, null, 2) + '\n');
const assert = (v, m) => {
    if (!v)
        throw Error(m);
};
let browser, release;
const gate = new Promise(r => release = r);
let firstRequest;
const requested = new Promise(r => firstRequest = r);
const limit = setTimeout(() => { release(); browser?.close(); }, 65000);
const hash = x => createHash('sha256').update(x).digest('hex');
const files = ['index.html', 'assets.index.json'];
for (const file of files) {
    const actual = await fetch(new URL(file, base));
    assert(actual.ok, 'HTTP ' + actual.status);
    const bytes = Buffer.from(await actual.arrayBuffer());
    assert(hash(bytes) === hash(readFileSync(artifact + '/' + file)), 'Wrong served ' + file);
    R.verifiedFiles.push({file, bytes: bytes.length, sha256: hash(bytes)});
}
async function observe(page, label) {
    const data = await page.evaluate(() => {
        const h = window.__fogcity, v = window.__fogcityView, game = document.getElementById('game'), hud = document.getElementById('hud');
        const style = game && getComputedStyle(game), loader = hud && getComputedStyle(hud);
        return { ready: !!h?.ready, version: h?.state().version ?? v?.sim?.curr.version, gameVisibility: style?.visibility, busy: game?.getAttribute('aria-busy'), loading: !!hud && hud.classList.contains('loading-screen') && loader.display !== 'none' && !hud.hidden, loadingText: hud?.textContent, resumeMarker: sessionStorage.getItem('fogcity.resume'), hook: !!v, startingSurfaceReady: v?.startupSurfaceReady?.(), tick: h?.state().tick ?? v?.sim?.curr.tick, mode: h?.state().players.p1.mode ?? v?.sim?.curr.players.p1.mode, car: h?.state().players.p1.car ?? v?.sim?.curr.players.p1.car, render: h?.renderInfo() ?? v?.info() };
    });
    R.samples.push({ label, ...data });
    flush();
    await page.screenshot({ path: out + '/' + label + '.png', timeout: 10000 });
    return data;
}
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-webgpu', '--js-flags=--max-old-space-size=1536'] });
    R.browserVersion = browser.version();
    const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 });
    if (scenario === 'near-timeout') {
        // Isolated recovery intent only; no saved progression or simulation is injected.
        await page.addInitScript(() => {
            if (!sessionStorage.getItem('fogcity.qa.resumeSeeded')) {
                sessionStorage.setItem('fogcity.resume', '1');
                sessionStorage.setItem('fogcity.qa.resumeSeeded', '1');
            }
        });
    }
    page.on('pageerror', e => { R.errors.push(String(e)); flush(); });
    page.on('console', m => {
        if (m.type() === 'error') {
            if (scenario === 'near-timeout' && /Starting streets did not finish loading/.test(m.text()))
                R.expectedStartupFailures.push(m.text());
            else if (scenario === 'far-failure' && (/503|Service Unavailable/.test(m.text())))
                R.expectedNetworkFailures.push(m.text());
            else
                R.errors.push(m.text());
            flush();
        }
    });
    if (scenario !== 'far-failure')
        await page.route('**/tiles/sf/packs/tiles-*.pack.gz.b64.txt', async (route) => { R.requests.push(route.request().url()); firstRequest(); flush(); await gate; await route.continue(); });
    if (scenario === 'far-failure')
        await page.route('**/tiles/sf/packs/far-*.pack.gz.b64.txt', async (route) => { R.requests.push(route.request().url()); firstRequest(); flush(); await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Intentional far skyline unavailable in QA' }); });
    const url = new URL(base);
    for (const [k, v] of Object.entries({ renderer: 'webgpu', tod: 'golden', debug: '1', capture: 'stats', radius: '300' }))
        url.searchParams.set(k, v);
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await Promise.race([requested, new Promise((_, r) => setTimeout(() => r(Error('No target asset request')), 20000).unref())]);
    if (scenario !== 'far-failure') {
        await page.keyboard.down('w');
        await page.keyboard.press('f');
        await page.waitForTimeout(800);
        await page.keyboard.up('w');
        const blocked = await observe(page, 'blocked-near-tiles');
        assert(!blocked.ready, 'Game declared ready with starting streets missing');
        assert(blocked.gameVisibility === 'hidden' && blocked.busy === 'true' && blocked.loading, 'Starting water view was exposed');
        assert(blocked.tick === 0 && blocked.mode === 'vehicle', 'Simulation advanced or input accepted during loading');
        R.loadingHeldMs = 800;
        if (scenario === 'near-timeout') {
            assert(blocked.resumeMarker === '1', 'Recovery intent was cleared before starting streets loaded');
            const waitingAt = Date.now();
            await page.getByRole('button', { name: 'Retry', exact: true }).waitFor({ state: 'visible', timeout: 50000 });
            R.retryWaitMs = Date.now() - waitingAt;
            const timedOut = await observe(page, 'timed-out-covered');
            assert(!timedOut.ready && timedOut.gameVisibility === 'hidden' && timedOut.busy === 'true' && timedOut.loading, 'Timeout exposed the missing street');
            assert(timedOut.tick === 0, 'Timeout advanced simulation');
            assert(timedOut.resumeMarker === '1', 'Timeout discarded recovery intent before Retry');
            release();
            await page.waitForTimeout(100);
            await page.getByRole('button', { name: 'Retry', exact: true }).click();
        }
        else
            release();
    }
    await page.waitForFunction(() => window.__fogcity?.ready, null, { timeout: 30000, polling: 'raf' });
    R.firstReady = await page.evaluate(() => {
        const h = window.__fogcity;
        const data = { tick: h.state().tick, hash: h.hash(), car: h.state().players.p1.car };
        h.pause();
        return data;
    });
    const ready = await observe(page, 'ready-street');
    assert(ready.gameVisibility === 'visible' && ready.busy === 'false' && !ready.loading, 'Ready street was not revealed');
    assert(ready.startingSurfaceReady, 'Starting street not ready');
    if (scenario === 'near-timeout') assert(ready.resumeMarker === null, 'Recovery intent did not clear after successful Retry');
    assert(ready.tick < 12, 'Physics caught up across loading delay');
    assert(ready.render.backend === 'webgpu' && !ready.render.graphicsError, 'Native WebGPU failed');
    await page.evaluate(() => window.__fogcity.resume());
    const before = await page.evaluate(() => ({ car: window.__fogcity.state().players.p1.car, tick: window.__fogcity.state().tick }));
    await page.keyboard.down('w');
    await page.waitForTimeout(500);
    await page.keyboard.up('w');
    const moved = await observe(page, 'driven');
    R.drive = { distance: Math.hypot(moved.car.x - before.car.x, moved.car.z - before.car.z), speed: moved.car.speed, ticks: moved.tick - before.tick };
    assert(R.drive.distance > .02 && R.drive.speed > .1, 'Ordinary W input did not drive after load');
    assert(R.errors.length === 0, 'Unexpected errors ' + R.errors.join(' | '));
    R.passed = true;
}
catch (e) {
    R.failure = String(e.stack ?? e);
    process.exitCode = 1;
}
finally {
    clearTimeout(limit);
    release();
    await browser?.close();
    flush();
    console.log(JSON.stringify({ passed: R.passed, scenario: R.scenario, drive: R.drive, samples: R.samples.map(s => ({ label: s.label, ready: s.ready, busy: s.busy, tick: s.tick, visibility: s.gameVisibility, loading: s.loading, tiles: s.render?.tilesLoaded })), failure: R.failure, errors: R.errors }));
}
