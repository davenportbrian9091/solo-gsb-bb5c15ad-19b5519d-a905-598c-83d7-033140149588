'use strict';
// 浏览器回归测试（Playwright + Chromium，真实浏览器环境）：
//
//   1. 粘贴含未知视型的合法 JSON：具体错误持续可见、求解按钮禁用
//      （回归：清理旧结果时不得隐藏 parseError）；
//   2. 修正输入后：错误清除、锁定/视型面板与求解按钮恢复；
//   3. 异步乱序：示例请求在途时用户输入新内容，迟到的示例响应不得覆盖输入；
//   4. 异步乱序：求解响应返回前输入已变更，过期响应不得渲染旧结果；
//   5. 服务端 400 错误持续可见，且求解按钮恢复可用；
//   6. 文件导入含未知视型的 JSON：与粘贴一致的统一提交行为。
//
// 运行前需要：npm install && npx playwright install chromium
// 测试服务使用独立端口（默认 3100，可用 TEST_PORT 覆盖），不影响 3000 端口的现有启动方式。

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (err) {
  console.error('未找到 playwright，请先运行: npm install && npx playwright install chromium');
  process.exit(1);
}

const PORT = Number(process.env.TEST_PORT) || 3100;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- 测试数据 ----------

const VALID_JSON = JSON.stringify(
  {
    name: '回归测试主题',
    tokens: [
      { name: 'bg', color: '#ffffff', locked: true },
      { name: 'text', color: '#777777' },
    ],
    candidates: ['#000000', '#333333'],
    constraints: [{ foreground: 'text', background: 'bg', minContrast: 4.5 }],
  },
  null,
  2
);

// 与 VALID_JSON 不同但同样合法的输入（用于求解途中改写）。
const VALID_JSON_V2 = JSON.stringify(
  {
    name: '回归测试主题 v2',
    tokens: [
      { name: 'bg', color: '#ffffff', locked: true },
      { name: 'text', color: '#777777' },
      { name: 'accent', color: '#2563eb' },
    ],
    candidates: ['#000000', '#333333'],
    constraints: [{ foreground: 'text', background: 'bg', minContrast: 4.5 }],
  },
  null,
  2
);

// 合法 JSON，但包含未知视型。
const UNKNOWN_PROFILE_JSON = JSON.stringify(
  {
    tokens: [
      { name: 'bg', color: '#ffffff' },
      { name: 'text', color: '#777777' },
    ],
    candidates: ['#000000'],
    constraints: [{ foreground: 'text', background: 'bg', minContrast: 4.5 }],
    profiles: ['normal', 'achromatopsia'],
  },
  null,
  2
);

// 能通过前端轻量校验、但被服务端拒绝的输入（令牌名为空白字符）→ 真实 400。
const SERVER_400_JSON = JSON.stringify(
  {
    tokens: [{ name: ' ', color: '#ffffff' }],
    candidates: ['#000000'],
    constraints: [],
  },
  null,
  2
);

// ---------- 工具函数 ----------

function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch (_) {
        /* 服务尚未就绪 */
      }
      if (Date.now() > deadline) {
        return reject(new Error('等待测试服务启动超时: ' + url));
      }
      setTimeout(attempt, 150);
    };
    attempt();
  });
}

const parseError = (page) => page.locator('#parseError');
const solveBtn = (page) => page.locator('#solveBtn');

async function assertErrorVisible(page, ...fragments) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('parseError');
      return el && !el.hidden && el.textContent.length > 0;
    },
    null,
    { timeout: 5000 }
  );
  const text = await parseError(page).textContent();
  for (const f of fragments) {
    assert.ok(text.includes(f), `错误提示应包含 "${f}"，实际为: "${text}"`);
  }
}

async function assertErrorHidden(page) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('parseError');
      return el && el.hidden;
    },
    null,
    { timeout: 5000 }
  );
}

// ---------- 用例 1+2：未知视型错误持续可见；修正后清错恢复 ----------

async function testUnknownProfileFlow(browser) {
  const page = await browser.newPage();
  try {
    await page.goto(BASE);
    // 初始状态：无错误、求解禁用、面板提示未载入。
    await assertErrorHidden(page);
    assert.ok(await solveBtn(page).isDisabled(), '初始求解按钮应禁用');

    // 粘贴含未知视型的合法 JSON。
    await page.fill('#jsonInput', UNKNOWN_PROFILE_JSON);
    await assertErrorVisible(page, '未知视型', 'achromatopsia');
    assert.ok(await solveBtn(page).isDisabled(), '无效输入时求解按钮应禁用');
    assert.ok(
      (await page.locator('#tokenLocks').textContent()).includes('尚未载入有效数据'),
      '无效输入时锁定面板应显示空态提示'
    );
    // 视型面板复选框应被禁用。
    const profileBoxes = page.locator('#profileList input[type="checkbox"]');
    assert.strictEqual(await profileBoxes.count(), 4);
    for (let i = 0; i < 4; i++) {
      assert.ok(await profileBoxes.nth(i).isDisabled(), `无效输入时视型复选框 ${i} 应禁用`);
    }

    // 关键回归断言：错误提示必须持续可见（此前会被 clearResults 瞬间隐藏）。
    await page.waitForTimeout(400);
    await assertErrorVisible(page, '未知视型', 'achromatopsia');
    assert.ok(await solveBtn(page).isDisabled(), '无效输入时求解按钮应持续禁用');

    // 修正输入：移除未知视型 → 清错、面板与按钮恢复。
    await page.fill('#jsonInput', VALID_JSON);
    await assertErrorHidden(page);
    assert.ok(await solveBtn(page).isEnabled(), '修正后求解按钮应恢复可用');
    assert.strictEqual(await page.locator('#tokenLocks .lock-item').count(), 2, '锁定面板应列出 2 个令牌');
    assert.ok(
      (await page.locator('#inputMeta').textContent()).includes('2 个令牌'),
      '输入元信息应统计令牌数'
    );
    for (let i = 0; i < 4; i++) {
      assert.ok(await profileBoxes.nth(i).isEnabled(), `修正后视型复选框 ${i} 应恢复可用`);
    }
  } finally {
    await page.close();
  }
  console.log('✓ 未知视型：错误持续可见并禁用求解，修正后清错恢复面板');
}

// ---------- 用例 3：迟到的示例响应不得覆盖更新的输入 ----------

async function testStaleSampleResponse(browser) {
  const page = await browser.newPage();
  try {
    let releaseSample;
    const sampleGate = new Promise((resolve) => {
      releaseSample = resolve;
    });
    await page.route('**/sample-palette.json', async (route) => {
      await sampleGate; // 挂起示例响应，模拟慢速请求
      await route.continue();
    });

    await page.goto(BASE);
    await page.click('#loadSampleBtn'); // 示例请求发出，被 gate 挂起

    // 请求在途时用户粘贴了含未知视型的输入。
    await page.fill('#jsonInput', UNKNOWN_PROFILE_JSON);
    await assertErrorVisible(page, '未知视型');

    // 放行迟到的示例响应。
    releaseSample();
    await page.waitForTimeout(400);

    // 断言：用户输入未被覆盖，错误仍可见，求解仍禁用。
    const text = await page.locator('#jsonInput').inputValue();
    assert.ok(text.includes('achromatopsia'), '迟到的示例响应不得覆盖用户输入');
    await assertErrorVisible(page, '未知视型', 'achromatopsia');
    assert.ok(await solveBtn(page).isDisabled(), '过期示例响应不得恢复求解按钮');
  } finally {
    await page.close();
  }
  console.log('✓ 异步乱序：迟到的示例响应被丢弃，用户输入与错误提示保持不变');
}

// ---------- 用例 4：过期的求解响应不得渲染旧结果 ----------

async function testStaleSolveResponse(browser) {
  const page = await browser.newPage();
  try {
    let releaseSolve;
    const solveGate = new Promise((resolve) => {
      releaseSolve = resolve;
    });
    await page.route('**/api/solve', async (route) => {
      await solveGate; // 挂起求解响应，模拟慢速搜索
      await route.continue();
    });

    await page.goto(BASE);
    await page.fill('#jsonInput', VALID_JSON);
    assert.ok(await solveBtn(page).isEnabled());

    await page.click('#solveBtn'); // 求解发出，响应被 gate 挂起
    await page.waitForFunction(() =>
      document.getElementById('resultPlaceholder').textContent.includes('分支定界')
    );

    // 求解在途时用户修改了输入（另一个合法但不同的 JSON）。
    await page.fill('#jsonInput', VALID_JSON_V2);
    assert.ok(await solveBtn(page).isEnabled(), '新输入有效时求解按钮应保持可用');

    // 放行过期的求解响应。
    releaseSolve();
    await page.waitForResponse((res) => res.url().includes('/api/solve'));
    await page.waitForTimeout(300);

    // 断言：过期响应被丢弃——不渲染旧结果，占位符回到默认提示。
    assert.ok(await page.locator('#resultArea').isHidden(), '过期求解响应不得渲染结果区');
    const placeholder = await page.locator('#resultPlaceholder').textContent();
    assert.ok(
      placeholder.includes('运行求解后在此查看结果'),
      `占位符应为默认提示，实际为: "${placeholder}"`
    );
    assert.ok(await solveBtn(page).isEnabled(), '过期响应不得改变求解按钮状态');
    await assertErrorHidden(page);

    //  sanity check：重新求解当前输入，结果正常渲染（版本机制不妨碍新求解）。
    await page.unroute('**/api/solve');
    await page.click('#solveBtn');
    await page.waitForFunction(
      () => !document.getElementById('resultArea').hidden,
      null,
      { timeout: 10000 }
    );
    assert.ok(
      (await page.locator('#tokenTable').textContent()).includes('accent'),
      '新求解结果应对应最新输入'
    );
  } finally {
    await page.close();
  }
  console.log('✓ 异步乱序：过期求解响应被丢弃，重新求解后结果对应最新输入');
}

// ---------- 用例 5：服务端 400 错误持续可见 ----------

async function testServerErrorVisible(browser) {
  const page = await browser.newPage();
  try {
    await page.goto(BASE);
    await page.fill('#jsonInput', SERVER_400_JSON);
    await assertErrorHidden(page); // 前端轻量校验放行（空白令牌名）
    assert.ok(await solveBtn(page).isEnabled());

    await page.click('#solveBtn');
    await assertErrorVisible(page, '非空字符串'); // 服务端 400 的具体错误
    // 持续可见，不被任何清理逻辑隐藏。
    await page.waitForTimeout(400);
    await assertErrorVisible(page, '非空字符串');
    assert.ok(await solveBtn(page).isEnabled(), '400 后求解按钮应恢复可用（输入前端有效）');

    // 修正输入后错误清除。
    await page.fill('#jsonInput', VALID_JSON);
    await assertErrorHidden(page);
  } finally {
    await page.close();
  }
  console.log('✓ 服务端 400：具体错误持续可见，修正输入后清除');
}

// ---------- 用例 6：文件导入同样走统一提交（未知视型持续报错） ----------

async function testFileImportFlow(browser) {
  const page = await browser.newPage();
  const tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'palette-test-')),
    'unknown-profile.json'
  );
  fs.writeFileSync(tmpFile, UNKNOWN_PROFILE_JSON);
  try {
    await page.goto(BASE);
    await page.setInputFiles('#fileInput', tmpFile);
    await assertErrorVisible(page, '未知视型', 'achromatopsia');
    assert.ok(await solveBtn(page).isDisabled(), '文件导入无效 JSON 时求解按钮应禁用');
    // 持续可见。
    await page.waitForTimeout(400);
    await assertErrorVisible(page, '未知视型');

    // 再导入合法文件 → 清错恢复。
    fs.writeFileSync(tmpFile, VALID_JSON);
    await page.setInputFiles('#fileInput', tmpFile);
    await assertErrorHidden(page);
    assert.ok(await solveBtn(page).isEnabled(), '导入合法文件后求解按钮应恢复');
    assert.strictEqual(await page.locator('#tokenLocks .lock-item').count(), 2);
  } finally {
    await page.close();
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  }
  console.log('✓ 文件导入：未知视型持续报错，导入合法文件后清错恢复');
}

// ---------- 主流程 ----------

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  let browser;
  try {
    await waitForServer(`${BASE}/api/health`);
    browser = await chromium.launch({ args: ['--no-sandbox'] });

    await testUnknownProfileFlow(browser);
    await testStaleSampleResponse(browser);
    await testStaleSolveResponse(browser);
    await testServerErrorVisible(browser);
    await testFileImportFlow(browser);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log('全部浏览器回归测试通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
