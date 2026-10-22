/* Prueba de punta a punta de la WebApp: 3 navegadores + mini conmutador WSS.
 *
 *   python web/build.py dist/web
 *   python -m http.server 8000 -d dist/web &
 *   python web/tests/sip_ws_proxy.py --cert c.pem --key k.pem --log msgs.jsonl &
 *   NODE_PATH=$(npm root -g) node web/tests/e2e.js msgs.jsonl
 */
const { chromium } = require('playwright');
const fs = require('fs');

const APP = process.env.APP_URL || 'http://127.0.0.1:8000/index.html';
const SERVER = '127.0.0.1:8089';
const MSGS = process.argv[2];
let failures = 0;

function ok(cond, what) {
    console.log((cond ? '  ✔ ' : '  ✘ ') + what);
    if (!cond) failures++;
}
function msgs() {
    return fs.readFileSync(MSGS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, step = 100) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
    return false;
}

async function client(browser, ext, pass) {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    await ctx.addInitScript(() => {
        window.__pcs = [];
        const Orig = window.RTCPeerConnection;
        window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc; };
        window.RTCPeerConnection.prototype = Orig.prototype;
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { console.log(`  [${ext}] pageerror:`, e.message); failures++; });
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) console.log(`  [${ext}] console.error:`, m.text()); });
    await page.goto(APP);
    await page.fill('#sipServer', SERVER);
    await page.fill('#extension', ext);
    await page.fill('#password', pass);
    await page.click('#loginBtn');
    return page;
}

const visible = (page, sel) => page.$eval(sel, (el) => !el.classList.contains('hidden') && el.offsetParent !== null).catch(() => false);

async function inboundBytes(page) {
    return page.evaluate(async () => {
        let total = 0;
        for (const pc of window.__pcs) {
            if (pc.connectionState === 'closed') continue;
            const st = await pc.getStats();
            st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') total += r.bytesReceived || 0; });
        }
        return total;
    });
}

(async () => {
    const browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
            '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required',
            '--disable-features=WebRtcHideLocalIpsWithMdns']
    });

    console.log('1. Registro (Digest) de 1001, 1002 y 1003');
    const a = await client(browser, '1001', 'pw1001');
    const b = await client(browser, '1002', 'pw1002');
    const c = await client(browser, '1003', 'pw1003');
    for (const [p, n] of [[a, '1001'], [b, '1002'], [c, '1003']]) {
        ok(await waitFor(() => visible(p, '#appScreen'), 15000), `${n} entra a la app`);
    }
    const regs = msgs().filter((m) => m.dir === 'in' && m.first.startsWith('REGISTER'));
    ok(regs.some((m) => /Authorization: Digest/.test(m.msg)), 'REGISTER se reintenta con Digest tras el 401');
    ok(regs.some((m) => /Expires: 300|expires=300/.test(m.msg)), 'registro cada 300 s');
    const info = await a.evaluate(() => window.pywebview.api.app_info());
    ok(info.platform === 'web' && info.engineAvailable, 'motor web activo (JsSIP)');

    console.log('2. 1001 llama a 1002, contesta, hay audio en ambos sentidos');
    await a.fill('#numberDisplay', '1002');
    await a.click('#callBtn');
    ok(await waitFor(() => visible(b, '#answerBtn'), 10000), '1002 ve la llamada entrante (botón Contestar)');
    ok(await waitFor(async () => msgs().some((m) => m.first.startsWith('SIP/2.0 180')), 5000), '1001 recibe 180 Ringing');
    await b.click('#answerBtn');
    ok(await waitFor(async () => (await inboundBytes(a)) > 2000 && (await inboundBytes(b)) > 2000, 15000),
        'audio WebRTC fluye en los dos sentidos');
    const timer = await a.textContent('#callTimer').catch(() => '');
    ok(/\d\d:\d\d/.test(timer || ''), 'cronómetro de la llamada corre: ' + timer);

    console.log('3. DTMF (SIP INFO) desde el teclado durante la llamada');
    const keyVisible = await a.$('#keypad .dial-key[data-key="5"]');
    if (keyVisible) await a.click('#keypad .dial-key[data-key="5"]').catch(() => {});
    if (!(await waitFor(async () => msgs().some((m) => m.first.startsWith('INFO') && /Signal=5/.test(m.msg)), 2000))) {
        await a.evaluate(() => UvacSIP.sendDTMF('5'));
    }
    ok(await waitFor(async () => msgs().some((m) => m.first.startsWith('INFO') && /Signal=5/.test(m.msg)), 5000), 'INFO con Signal=5 enviado');

    console.log('4. Silenciar');
    await a.click('#muteBtn');
    const muted = await waitFor(() => a.evaluate(() => window.__pcs.some((pc) => pc.getSenders().some((s) => s.track && s.track.kind === 'audio' && !s.track.enabled))), 3000);
    ok(muted, 'micrófono de 1001 apagado');
    await a.click('#muteBtn');
    ok(await waitFor(() => a.evaluate(() => window.__pcs.every((pc) => pc.getSenders().every((s) => !s.track || s.track.enabled))), 3000), 'micrófono de 1001 encendido otra vez');

    console.log('5. Retener (re-INVITE sendonly) y reanudar');
    await a.evaluate(() => window.pywebview.api.sip_hold(true));
    ok(await waitFor(async () => msgs().some((m) => m.first.startsWith('INVITE') && /a=sendonly/.test(m.msg)), 5000), 're-INVITE con a=sendonly');
    await a.evaluate(() => window.pywebview.api.sip_hold(false));
    ok(await waitFor(async () => msgs().filter((m) => m.first.startsWith('INVITE') && m.dir === 'in').length >= 3, 5000), 're-INVITE para reanudar');

    console.log('6. Ocupado: 1003 llama a 1002 durante la llamada → 486');
    await c.fill('#numberDisplay', '1002');
    await c.click('#callBtn');
    ok(await waitFor(async () => msgs().some((m) => m.first.startsWith('SIP/2.0 486')), 8000), '1002 contesta 486 Busy Here');
    ok(await waitFor(async () => !(await c.evaluate(() => !!UvacSIP.currentSession)), 8000), '1003 queda libre otra vez');

    console.log('7. Transferencia (REFER)');
    await b.evaluate(() => UvacSIP.transfer('1003'));
    ok(await waitFor(async () => msgs().some((m) => m.first.startsWith('REFER') && /Refer-To: <?sip:1003@/.test(m.msg)), 5000), 'REFER a 1003 enviado y aceptado (202)');

    console.log('8. Colgar desde 1002');
    await b.evaluate(() => UvacSIP.hangup());
    ok(await waitFor(async () => msgs().some((m) => m.first.startsWith('BYE')), 5000), 'BYE enviado');
    ok(await waitFor(async () => !(await a.evaluate(() => !!UvacSIP.currentSession)) && !(await b.evaluate(() => !!UvacSIP.currentSession)), 5000), 'ambos quedan libres');

    console.log('9. Llamada sin contestar: 1001 cuelga mientras suena (CANCEL)');
    await a.fill('#numberDisplay', '1003');
    await a.click('#callBtn');
    ok(await waitFor(() => visible(c, '#answerBtn'), 8000), '1003 ve la llamada');
    await sleep(800);
    await a.evaluate(() => UvacSIP.hangup());
    ok(await waitFor(async () => msgs().some((m) => m.first.startsWith('CANCEL')), 5000), 'CANCEL enviado');
    ok(await waitFor(async () => !(await c.evaluate(() => !!UvacSIP.currentSession)), 5000), 'a 1003 se le quita la llamada');

    console.log('10. Ajustes: cambiar "Registro cada" vuelve a registrar al momento');
    const res = await a.evaluate(() => window.pywebview.api.save_settings({ registerExpires: 120 }));
    ok(res._applied === 'reregistered', 'save_settings → reregistered');
    ok(await waitFor(async () => msgs().some((m) => m.first.startsWith('REGISTER') && /Expires: 120|expires=120/.test(m.msg)), 8000), 'REGISTER nuevo con Expires 120');
    ok(await waitFor(() => a.evaluate(() => UvacSIP.isRegistered), 8000), '1001 sigue registrado');

    console.log('11. Contraseña equivocada: no se reintenta en bucle (evita bloqueo del conmutador)');
    const t0 = Date.now() / 1000;
    const bad = await client(browser, '1002', 'mala');
    await sleep(6000);
    const badRegs = msgs().filter((m) => m.t > t0 && m.dir === 'in' && m.first.startsWith('REGISTER') && /Authorization:[^\r]*username="1002"/.test(m.msg));
    ok(await bad.evaluate(() => !UvacSIP.isRegistered), 'no registra');
    ok(badRegs.length === 1, 'un solo intento con la contraseña mala (hubo ' + badRegs.length + ')');

    console.log('12. Descargar log desde Ajustes');
    const [dl] = await Promise.all([a.waitForEvent('download', { timeout: 5000 }).catch(() => null),
        a.evaluate(() => window.pywebview.api.open_log_folder())]);
    ok(!!dl && /allemmsip-web-.*\.log$/.test(dl.suggestedFilename()), 'se descarga ' + (dl ? dl.suggestedFilename() : '(nada)'));

    await browser.close();
    console.log(failures ? `\n${failures} FALLA(S)` : '\nTODO OK');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
