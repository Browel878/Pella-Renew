// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;

// ── 广告拦截脚本（油猴 5.0 完整版，最早注入）────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';

    // ===== document-start 阶段：拦截广告脚本加载 =====
    const blockedScriptDomains = ['madurird.com', 'crn77.com', 'fqjiujafk.com'];
    new MutationObserver(mutations => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.tagName === 'SCRIPT' && node.src) {
                    if (blockedScriptDomains.some(d => node.src.includes(d))) {
                        node.remove();
                        console.log('[AdBlock] 已拦截广告脚本:', node.src);
                    }
                }
            });
        });
    }).observe(document.documentElement, { childList: true, subtree: true });

    // ===== DOM 加载后执行 =====
    function init() {
        // 1. 选择性拦截 window.open（仅拦截广告弹窗，放行合法链接如 pella.app/renew）
        const blockedOpenDomains = ['crn77.com', 'madurird.com', 'tinyurl.com', 'popads', 'avnsgames.com', 'fqjiujafk.com'];
        const originalWindowOpen = window.open;
        window.open = function (url, ...args) {
            const u = String(url || '');
            if (!u || blockedOpenDomains.some(d => u.includes(d))) {
                console.log('[AdBlock] 拦截广告弹窗:', u);
                return null;
            }
            return originalWindowOpen.call(this, u, ...args);
        };

        // 2. 拦截广告链接点击
        document.addEventListener('click', e => {
            const a = e.target.closest('a');
            if (!a) return;
            const href = a.href || '';
            if (
                href.includes('crn77.com') ||
                href.includes('madurird.com') ||
                href.includes('tinyurl.com') ||
                href.includes('popads') ||
                href.includes('avnsgames.com') ||
                href.includes('fqjiujafk.com')
            ) {
                e.stopPropagation();
                e.preventDefault();
                console.log('[AdBlock] 拦截广告链接:', href);
            }
        }, true);

        // 3. 持续清理广告元素
        function removeAds() {
            // 移除按钮上的广告 onclick
            document.querySelector('#continue')?.removeAttribute('onclick');
            document.querySelector('#submit-button')?.removeAttribute('onclick');
            document.querySelector('#getnewlink')?.removeAttribute('onclick');
            document.querySelectorAll('[onclick*="crn77"],[onclick*="madurird"]').forEach(el => el.removeAttribute('onclick'));

            // 移除广告链接
            document.querySelectorAll([
                'a[href*="crn77.com"]',
                'a[href*="madurird.com"]',
                'a[href*="tinyurl.com"]',
                'a[href*="avnsgames.com"]',
                'a[href*="popads"]',
                'script[src*="madurird.com"]',
                'script[src*="fqjiujafk.com"]',
            ].join(',')).forEach(el => el.remove());

            // 移除所有 netpub 广告元素
            document.querySelectorAll([
                'iframe[id*="netpub"]',
                'div[id*="netpub_ins"]',
                'div[id*="netpub_banner"]',
                'div[class*="eldhywa"]',
                'iframe[height="0"]',
                'iframe[style*="display: none"]'
            ].join(',')).forEach(el => el.remove());
        }

        removeAds();
        new MutationObserver(removeAds).observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
`;

// ── CF Turnstile token 监听脚本 ─────────────────────────────
const CF_TOKEN_LISTENER_JS = `
(function() {
    if (window.__cf_token_listener_injected__) return;
    window.__cf_token_listener_injected__ = true;
    window.__cf_turnstile_token__ = '';
    window.addEventListener('message', function(e) {
        if (!e.origin || !e.origin.includes('cloudflare.com')) return;
        var d = e.data;
        if (!d || d.event !== 'complete' || !d.token) return;
        console.log('[TokenCapture] token length:', d.token.length);
        window.__cf_turnstile_token__ = d.token;
        var inputs = document.querySelectorAll('input[name="cf-turnstile-response"]');
        for (var i = 0; i < inputs.length; i++) {
            try {
                var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                nativeSet.call(inputs[i], d.token);
                inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
                inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
            } catch(err) { inputs[i].value = d.token; }
        }
    });
    console.log('[TokenCapture] listener injected');
})();
`;

// ── 工具函数 ────────────────────────────────────────────────
function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ── 判断是否为 pella renew 地址（兼容 /renew/xxx、/renew?xxx）─────
function isRenewUrl(url) {
    return /pella\.app\/[^?#]*renew/i.test(url || '');
}

// ── 等待任意标签页到达 pella.app/renew ─────────────────────────
async function waitForAnyRenewPage(context, timeout = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        for (const p of context.pages()) {
            try {
                if (!p.isClosed() && isRenewUrl(p.url())) return p;
            } catch (e) {}
        }
        await sleep(500);
    }
    return null;
}

// ── 通用：查找并点击 Continue/继续 按钮 ────────────────────────
async function clickContinue(page) {
    const selectors = [
        '#continue',
        '#submit-button',
        '#continue-button',
        'p.getmylink',
        'span.wp2continuelink',
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Continue")',
        'a:has-text("Continue")',
        'span:has-text("Continue")',
        'button:has-text("继续")',
        'a:has-text("继续")',
        '[class*="continue" i]',
        '[id*="continue" i]',
    ];
    for (const sel of selectors) {
        try {
            if ((await page.locator(sel).count()) === 0) continue;
            await page.click(sel, { timeout: 2000 });
            console.log(`  ✅ 点击 Continue 按钮: ${sel}`);
            return true;
        } catch (e) {}
    }
    // 兜底：按文本匹配可见的按钮/链接
    try {
        const clicked = await page.evaluate(`
            (function(){
                var els = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]'));
                for (var i = 0; i < els.length; i++) {
                    var t = (els[i].textContent || '').trim().toLowerCase();
                    var v = (els[i].value || '').toLowerCase();
                    if ((t.includes('continue') || t.includes('继续') || v.includes('continue')) && els[i].offsetParent !== null) {
                        els[i].click();
                        return true;
                    }
                }
                return false;
            })()
        `);
        if (clicked) {
            console.log('  ✅ 已通过文本匹配点击 Continue');
            return true;
        }
    } catch (e) {}
    return false;
}

// ── 通用：查找并点击 renew 按钮/链接（在页面内执行点击）────────
async function clickRenewButton(page) {
    return await page.evaluate(`
        (function(){
            var hrefRe = /pella\\.app\\/[^?#]*renew/i;
            var els = Array.from(document.querySelectorAll('a, button'));
            // 1) 指向 pella.app/renew 的链接
            for (var i = 0; i < els.length; i++) {
                var h = els[i].href || '';
                if (hrefRe.test(h) && els[i].offsetParent !== null && !els[i].disabled) {
                    els[i].click();
                    return { found: true, clicked: true, disabled: false, href: h };
                }
            }
            // 2) 常见 get-link 类按钮
            var sels = ['a.btn.btn-success.btn-lg.get-link', 'a.get-link', '#getnewlink'];
            for (var j = 0; j < sels.length; j++) {
                var el = document.querySelector(sels[j]);
                if (el && el.offsetParent !== null) {
                    if (el.disabled) return { found: true, clicked: false, disabled: true, href: el.href || '' };
                    el.click();
                    return { found: true, clicked: true, disabled: false, href: el.href || '' };
                }
            }
            // 3) 文本匹配 renew / get link / 续期 / 获取链接
            var txtRe = /renew|get link|续期|获取链接/i;
            for (var k = 0; k < els.length; k++) {
                var t = (els[k].textContent || '').trim();
                if (txtRe.test(t) && t.length < 60 && els[k].offsetParent !== null) {
                    if (els[k].disabled) return { found: true, clicked: false, disabled: true, href: els[k].href || '' };
                    els[k].click();
                    return { found: true, clicked: true, disabled: false, href: els[k].href || '' };
                }
            }
            return { found: false, clicked: false, disabled: false, href: '' };
        })()
    `);
}

function sendTG(result, extra = '') {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }
        const lines = [
            `🎮 Pella 续期通知`,
            `🕐 运行时间: ${nowStr()}`,
            `🖥 服务器: Pella Free`,
            `📊 续期结果: ${result}`,
        ];
        if (extra) lines.push(extra);
        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: lines.join('\n') });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            console.log(res.statusCode === 200 ? '📨 TG 推送成功' : `⚠️ TG 推送失败：HTTP ${res.statusCode}`);
            resolve();
        });
        req.on('error', e => { console.log(`⚠️ TG 推送异常：${e.message}`); resolve(); });
        req.setTimeout(15000, () => { console.log('⚠️ TG 推送超时'); req.destroy(); resolve(); });
        req.write(body);
        req.end();
    });
}

// ── Turnstile 点击位置候选（viewport 坐标，供 page.mouse 使用）──
async function getTurnstileClickPoints(page) {
    const pts = await page.evaluate(`
        (function(){
            var out = [];
            // 1) turnstile/cloudflare iframe（复选框通常在 iframe 内左侧）
            var iframes = Array.from(document.querySelectorAll('iframe'));
            for (var i = 0; i < iframes.length; i++) {
                var src = iframes[i].src || '';
                if (src.indexOf('cloudflare') >= 0 || src.indexOf('turnstile') >= 0) {
                    var r = iframes[i].getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) {
                        out.push({ x: Math.round(r.x + 30), y: Math.round(r.y + r.height / 2) });
                        out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
                    }
                }
            }
            // 2) .cf-turnstile 容器
            var c = document.querySelector('.cf-turnstile');
            if (c) {
                var rc = c.getBoundingClientRect();
                if (rc.width > 0 && rc.height > 0) {
                    out.push({ x: Math.round(rc.x + 30), y: Math.round(rc.y + rc.height / 2) });
                    out.push({ x: Math.round(rc.x + rc.width / 2), y: Math.round(rc.y + rc.height / 2) });
                    out.push({ x: Math.round(rc.x + 368), y: Math.round(rc.y + rc.height / 2) });
                }
            }
            return out;
        })()
    `);
    const seen = new Set();
    const unique = [];
    for (const p of pts) {
        const k = p.x + ',' + p.y;
        if (!seen.has(k)) { seen.add(k); unique.push(p); }
    }
    return unique;
}

// ── CF token 检测 ────────────────────────────────────────────
async function checkCFToken(page) {
    try {
        const inputOk = await page.evaluate(`
            (function(){
                var input = document.querySelector('input[name="cf-turnstile-response"]');
                return input && input.value && input.value.length > 20;
            })()
        `);
        if (inputOk) return true;
    } catch (e) {}
    try {
        const token = await page.evaluate('window.__cf_turnstile_token__ || ""');
        if (token && token.length > 20) return true;
    } catch (e) {}
    return false;
}

// ── 处理 CF Turnstile ────────────────────────────────────────
async function solveTurnstile(page) {
    await page.evaluate(`
        (function() {
            var turnstileInput = document.querySelector('input[name="cf-turnstile-response"]');
            if (!turnstileInput) return;
            var el = turnstileInput;
            for (var i = 0; i < 20; i++) {
                el = el.parentElement;
                if (!el) break;
                var style = window.getComputedStyle(el);
                if (style.overflow === 'hidden') el.style.overflow = 'visible';
                el.style.minWidth = 'max-content';
            }
        })()
    `);

    await page.evaluate(CF_TOKEN_LISTENER_JS);
    console.log('📡 开始监控 Cloudflare Turnstile Token...');

    if (await checkCFToken(page)) {
        console.log('✅ 验证已自动通过');
        return true;
    }

    await page.evaluate(`
        var c = document.querySelector('.cf-turnstile');
        if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    `);
    await sleep(1500);

    const points = await getTurnstileClickPoints(page);
    if (points.length === 0) {
        console.log('❌ 验证码位置获取失败');
        await page.screenshot({ path: 'turnstile_no_coords.png' });
        return false;
    }

    // 用 Playwright 鼠标事件点击（CDP 可信事件，能命中 iframe 内复选框，无需 xdotool/真实屏幕坐标）
    for (const pt of points) {
        try {
            await page.mouse.click(pt.x, pt.y);
            console.log(`🖱️ 点击验证码位置 (${pt.x}, ${pt.y})`);
        } catch (e) {
            console.log(`⚠️ 点击失败: ${e.message}`);
        }
        for (let i = 0; i < 40; i++) {
            await sleep(500);
            if (await checkCFToken(page)) {
                const token = await page.evaluate('window.__cf_turnstile_token__ || ""');
                console.log(`✅ Cloudflare Turnstile 验证通过！token：${token.substring(0, 50)}...`);
                return true;
            }
        }
    }

    console.log('❌ 人机验证超时');
    await page.screenshot({ path: 'turnstile_fail.png' });
    return false;
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 自动续期', async () => {
    if (!PELLA_EMAIL || !PELLA_PASSWORD) {
        throw new Error('❌ 缺少 PELLA_ACCOUNT，格式: email,password');
    }

    // ── 代理检测 ─────────────────────────────────────────────
    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) {
        try {
            await new Promise((resolve, reject) => {
                const req = http.request(
                    { host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 },
                    () => resolve()
                );
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.end();
            });
            proxyConfig = { server: 'http://127.0.0.1:8080' };
            console.log('🛡️ 本地代理连通，使用 GOST 转发');
        } catch {
            console.log('⚠️ 本地代理不可达，降级为直连');
        }
    }

    // ── 启动浏览器 ───────────────────────────────────────────
    console.log('🔧 启动浏览器...');
    const browser = await chromium.launch({
        headless: false,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext();
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    console.log('🚀 浏览器就绪！');

    try {
        // ── 出口 IP 验证 ──────────────────────────────────────
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
            const body = await res.text();
            const ip = JSON.parse(body).ip || body;
            const masked = ip.replace(/(\d+\.\d+\.\d+\.)\d+/, '$1xx');
            console.log(`✅ 出口 IP 确认：${masked}`);
        } catch {
            console.log('⚠️ IP 验证超时，跳过');
        }

        // ── 登录 pella.app ────────────────────────────────────
        console.log('🔑 打开 Pella 登录页...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'domcontentloaded' });

        console.log('✏️ 填写邮箱...');
        await page.waitForSelector('#identifier-field', { timeout: 15000 });
        await page.fill('#identifier-field', PELLA_EMAIL);

        console.log('📤 点击 Continue...');
        await page.click('span.cl-internal-2iusy0');
        await sleep(2000);

        console.log('✏️ 填写密码...');
        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.fill('input[name="password"]', PELLA_PASSWORD);

        console.log('📤 提交登录...');
        await page.click('span.cl-internal-2iusy0');

        console.log('⏳ 等待登录跳转...');
        await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 30000 });
        console.log(`✅ 登录成功！当前：${page.url()}`);

        // ── 等待 Clerk session 加载 ───────────────────────────
        console.log('⏳ 等待 Clerk session...');
        for (let i = 0; i < 20; i++) {
            const ready = await page.evaluate('!!(window.Clerk && window.Clerk.session)');
            if (ready) break;
            await sleep(500);
        }

        // ── 获取 JWT token ────────────────────────────────────
        console.log('🔑 获取 JWT token...');
        const token = await page.evaluate('window.Clerk.session.getToken()');
        if (!token) throw new Error('❌ 无法获取 Clerk token');
        console.log('✅ Token 获取成功');

        // ── 获取续期链接 ──────────────────────────────────────
        console.log('🔍 获取服务器续期链接...');
        const serversRes = await page.evaluate(async (t) => {
            const res = await fetch('https://api.pella.app/user/servers', {
                headers: { 'Authorization': `Bearer ${t}` }
            });
            return await res.json();
        }, token);

        const servers = serversRes.servers || [];
        if (servers.length === 0) throw new Error('❌ 未找到服务器');

        let renewLink = null;
        for (const server of servers) {
            const unclaimed = (server.renew_links || []).filter(l => l.claimed === false);
            if (unclaimed.length > 0) {
                renewLink = unclaimed[0].link;
                console.log(`✅ 找到续期链接: ${renewLink} (服务器 ${server.ip})`);
                break;
            }
        }

        if (!renewLink) {
            await sendTG('⚠️ 无可用续期链接，今日已续期或暂不需要续期');
            console.log('⚠️ 无可用续期链接，退出');
            return;
        }

        // ── 访问广告链接（短链中转）────────────────────────────
        console.log(`🌐 访问广告链接: ${renewLink}`);
        await page.goto(renewLink, { waitUntil: 'domcontentloaded' });
        await sleep(3000);
        console.log(`📄 当前页面: ${page.url()}`);

        // ── 通用穿站流程：Continue → Turnstile → 跳转，可多轮，直至出现并点击 renew 按钮 ──
        console.log('🔄 开始穿站流程（可能多轮 Continue / Turnstile / 倒计时）...');
        const knownPages = context.pages();
        const maxRounds = 25;
        let curPage = page;

        for (let round = 0; round < maxRounds; round++) {
            // 接管新弹出的标签页
            const fresh = context.pages().filter(p => !knownPages.includes(p) && !p.isClosed());
            if (fresh.length > 0) {
                curPage = fresh[fresh.length - 1];
                knownPages.push(curPage);
                try { await curPage.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch (e) {}
                console.log(`📄 接管新标签页: ${curPage.url()}`);
            }
            if (curPage.isClosed()) {
                curPage = context.pages().find(p => !p.isClosed()) || page;
            }

            const curUrl = curPage.url();
            console.log(`  [第 ${round + 1}/${maxRounds} 轮] ${curUrl}`);

            // 1) 已到达 pella.app/renew → 成功
            if (isRenewUrl(curUrl)) break;

            // 2) 出现 renew 按钮/链接 → 点击
            const rb = await clickRenewButton(curPage).catch(() => ({ found: false, clicked: false, disabled: false, href: '' }));
            if (rb.found && rb.clicked) {
                console.log(`✅ 已点击 renew 按钮${rb.href ? ': ' + rb.href : ''}`);
                await sleep(3000);
                continue; // 可能同页跳转或弹窗，下一轮重新判断
            }
            if (rb.found && rb.disabled) {
                console.log('⏳ 检测到 renew 按钮但未激活（倒计时中），等待...');
                await sleep(2000);
                continue;
            }

            // 3) Turnstile 验证 → 点击通过
            const hasCf = await curPage.evaluate(
                '!!document.querySelector("input[name=\'cf-turnstile-response\']")'
            ).catch(() => false);
            if (hasCf) {
                console.log('🛡️ 检测到 CF Turnstile，开始处理...');
                await solveTurnstile(curPage);
                await sleep(2000);
                continue;
            }

            // 4) Continue / 继续 按钮 → 点击进入下一步
            if (await clickContinue(curPage)) {
                await sleep(2500);
                continue;
            }

            // 5) 本轮无操作目标，等待页面加载/倒计时结束
            await sleep(1500);
        }

        // ── 确认到达 pella.app/renew（同页跳转或 popup）────────
        console.log('⏳ 等待续期完成...');
        const renewPage = await waitForAnyRenewPage(context, 25000);
        const finalUrl = renewPage ? renewPage.url() : page.url();
        console.log(`📄 最终地址: ${finalUrl}`);
        await page.screenshot({ path: 'final_result.png' }).catch(() => {});

        // ── 结果判断 ──────────────────────────────────────────
        if (renewPage && isRenewUrl(finalUrl)) {
            console.log('🎉 续期成功！');
            await sendTG('✅ 续期成功！', `🔗 最终URL: ${finalUrl}`);
        } else {
            console.log(`⚠️ 续期结果未知: ${finalUrl}`);
            await sendTG('⚠️ 续期结果未知', `🔗 最终URL: ${finalUrl}`);
        }

    } catch (e) {
        await page.screenshot({ path: 'error.png' }).catch(() => {});
        await sendTG(`❌ 脚本异常：${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
