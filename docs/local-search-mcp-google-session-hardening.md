# local-search-mcp：Google 个人使用场景会话稳定性改造方案

> 适用项目：`miemiekurisu/local-search-mcp`
>
> 目标场景：个人、本地/内网部署；通过 noVNC 直接操作可见 Chromium 登录 Google；允许首次出现 CAPTCHA/Robot Verification 时人工完成验证；验证完成后尽可能长期复用同一浏览器身份与会话。
>
> 本文目标不是实现 CAPTCHA 自动求解或规避人工验证，而是减少自动化框架自身造成的异常指纹、会话抖动和无意义重复访问，让已经人工建立信任的 profile 尽可能稳定。

---

## 1. 结论摘要

当前架构其实已经具备最重要的基础条件：

- Docker 中长期运行可见 Chromium；
- `VISIBLE_BROWSER_PROFILE_DIR=/data/browser-profile` 持久化浏览器 profile；
- Playwright 通过 CDP 接入已经运行的 Chromium；
- noVNC 可以人工登录 Google、处理 CAPTCHA；
- Google 搜索固定使用 `sessionKey: 'google'`；
- 命中 CAPTCHA 时会保留页面并提示人工处理。

在“首次验证一次、后续通常稳定”的前提下，推荐的改造原则是：

1. **CDP + 持久化 Chrome profile 是主路径，不要再伪造浏览器身份。**
2. **Google 已经通过人工验证后，优先保持 profile、IP、locale、时区、浏览器版本等身份稳定。**
3. **CAPTCHA 作为正常的 `HUMAN_REQUIRED` 状态处理，不做自动求解。**
4. **验证码恢复页面必须加载图片、字体、媒体等必要资源。**
5. **减少重复 Google 请求，比继续增加鼠标轨迹、随机等待更值得做。**
6. **Patchright / Rebrowser 等框架只作为后续 A/B 实验，不作为第一阶段依赖。**
7. **Google 长驻 tab 可以做，但在当前“只验证一次”的现状下不是必须项。**

推荐优先级：

```text
P0  CDP 模式禁用自制 stealth
P0  CAPTCHA/noVNC 恢复路径完整加载资源
P0  固定并保护 browser-profile
P1  Google 请求缓存 + 串行/低并发 + 统一速率限制
P1  增加 Google session/reputation 运行指标
P2  优化 Google page 生命周期，必要时改成复用 page
P3  Patchright / Rebrowser A-B 测试
```

---

# 2. 当前实现中最值得修改的地方

## 2.1 当前真实浏览器链路是正确的

`docker-compose.yml` 当前已经使用：

```yaml
USE_EXISTING_CHROME=true
CDP_URL=http://127.0.0.1:9224
VISIBLE_BROWSER_PROFILE_DIR=/data/browser-profile
SEARCH_HEADLESS=false
```

整体链路相当于：

```text
/data/browser-profile
        │
        ▼
Visible Chromium
        │
        ├── noVNC：人工登录 / CAPTCHA
        │
        └── CDP :9224
              │
              ▼
        PlaywrightPool
              │
              ▼
           Google
```

这是应该保留的核心架构。

对于个人使用，它比“每次启动一个全新的隐身浏览器”更合理，因为 Google 最终看到的是一个长期存在的浏览器身份，而不是不断重建的新身份。

---

## 2.2 最大问题：CDP 接入真实浏览器后仍然注入自制 stealth

当前 `PlaywrightPool.withPage()` 中已经明确识别：

```js
const isCdpMode = Boolean(this.connectedBrowser);
```

但新 page 创建以后仍然无条件执行：

```js
await stealthPlugin(page);
```

这意味着实际流程是：

```text
真实 Chromium
    ↓
真实 persistent profile
    ↓
真实 Google 登录态
    ↓
Playwright CDP attach
    ↓
再次使用 JS 篡改 navigator/chrome/plugins 等信息
```

这一步没有必要，而且可能损害已经稳定的浏览器身份一致性。

当前 stealth 中存在明显的身份组合风险，例如：

- 删除/覆盖 `navigator.webdriver`；
- 自己实现 `chrome.runtime`；
- `chrome.runtime.getPlatformInfo()` 固定返回 macOS；
- `navigator.languages` 固定为 `['en-US', 'en']`；
- `navigator.hardwareConcurrency` 固定为 8；
- `navigator.deviceMemory` 固定为 8；
- `navigator.maxTouchPoints` 固定为 0；
- 非 CDP context 又会随机设置 UA、locale、viewport、DPR、touch；
- UA 集合里混有 Chromium、Firefox、Safari；
- UA 版本还是 Chrome 124/125/126 等旧版本。

这类 JS spoof 最大的问题并不是“伪装得不够复杂”，而是：

> **页面 JavaScript 看到的身份，可能与 Chrome 实际网络栈、Client Hints、TLS、渲染特征、系统环境和长期 profile 中形成的历史不一致。**

因此第一阶段应该做减法。

---

# 3. P0：CDP 模式禁用 stealth

## 3.1 最小修改方案

建议先增加配置：

```env
BROWSER_STEALTH=true
BROWSER_STEALTH_ON_CDP=false
```

默认策略：

```text
Playwright 自己启动的临时 context：可以暂时保留旧 stealth
CDP 接入 persistent Chromium：默认不注入 stealth
```

伪代码：

```js
const ENABLE_STEALTH = process.env.BROWSER_STEALTH !== 'false';
const ENABLE_STEALTH_ON_CDP = process.env.BROWSER_STEALTH_ON_CDP === 'true';

async function applyStealthIfNeeded(page, { isCdpMode }) {
  if (!ENABLE_STEALTH) return;
  if (isCdpMode && !ENABLE_STEALTH_ON_CDP) return;

  await stealthPlugin(page);
}
```

然后把：

```js
await stealthPlugin(page);
```

改为：

```js
await applyStealthIfNeeded(page, { isCdpMode });
```

`openSessionPage()` 同样处理。

由于 `openSessionPage()` 当前会根据 `this.connectedBrowser` 判断是否属于 `shared-cdp`，建议在那里同样计算：

```js
const isCdpMode = Boolean(this.connectedBrowser);
```

再决定是否注入。

---

## 3.2 更推荐的最终策略

如果实际测试证明 CDP persistent profile 非常稳定，可以进一步变成：

```text
Google + CDP         stealth = OFF
ChatGPT + CDP        stealth = OFF
Bing + CDP           stealth = OFF
临时 browser context stealth = optional
```

也就是说：

> **只要是在连接真实长期 Chromium，就尽量不修改浏览器原生 fingerprint。**

---

## 3.3 不建议继续完善当前 stealthPlugin

不建议继续投入时间去修：

```text
fake chrome.runtime
fake plugins
fake mimeTypes
fake hardwareConcurrency
fake deviceMemory
fake language
fake WebGL
fake touch
随机 UA
随机 viewport
```

因为你的使用场景不是大规模匿名 scraper，而是：

```text
一个用户
一个 Chrome
一个 Google 账号
一个长期 profile
一个基本稳定的网络
```

这个场景最重要的是**一致性**，不是“随机性”。

---

# 4. P0：保留并保护 Google browser profile

## 4.1 `/data/browser-profile` 应视为重要持久数据

当前：

```yaml
VISIBLE_BROWSER_PROFILE_DIR=/data/browser-profile
```

这个目录应该作为 Google browser identity 的核心状态。

建议明确：

```text
/data/browser-profile
```

不得在以下操作中自动删除：

- Docker image 更新；
- npm 更新；
- MCP 服务重启；
- Chromium 重启；
- parser 更新；
- session storageState 清理；
- 普通异常恢复。

只有用户明确执行“重建浏览器身份”时才删除。

---

## 4.2 browser profile 与 storageState 不应混为一谈

当前项目还有：

```text
/data/browser-state
```

以及 `context.storageState()`。

在 CDP 模式下，真正重要的是 Chromium 自己的 persistent profile：

```text
Cookies
Local Storage
IndexedDB
Service Worker
Google Account state
浏览历史相关状态
站点权限
浏览器内部状态
```

`storageState()` 可以继续保留作为兼容机制，但**不要把它当成 persistent Chrome profile 的替代品**。

建议代码注释明确：

```text
CDP mode:
  browser profile = source of truth
  storageState    = supplementary compatibility snapshot

non-CDP mode:
  storageState    = session persistence mechanism
```

---

# 5. P0：CAPTCHA 作为正常状态，而不是异常浏览器崩溃

现有 Google 逻辑已经比较接近正确方向：

```text
ENGINE_BLOCKED
  + session: google
  + current_url
  + retry_hint
  + keepPageOpen = true
```

建议正式把它抽象成 Google session 状态。

## 5.1 建议状态机

```text
UNKNOWN
   │
   ▼
READY
   │
   │ Google detects verification
   ▼
HUMAN_REQUIRED
   │
   │ 用户打开 noVNC
   │ 登录 / CAPTCHA
   ▼
VERIFYING
   │
   │ Google search/result page becomes normal
   ▼
READY
```

另外两个状态：

```text
PROFILE_UNAVAILABLE
BROWSER_UNAVAILABLE
```

不要把 CAPTCHA 与 browser crash 混在一起。

---

## 5.2 MCP 错误返回建议

当前的错误提示可以继续，但建议结构化一点：

```json
{
  "code": "HUMAN_REQUIRED",
  "engine": "google",
  "session": "google",
  "reason": "captcha_or_robot_verification",
  "current_url": "...",
  "recovery": "novnc",
  "retryable": true
}
```

文本提示：

```text
Google requires manual verification.
Open the existing Chromium session through noVNC, complete the verification,
then retry the same MCP request.
```

关键点：

> 不新建 profile，不换浏览器，不清 cookie，不重置 session。

---

# 6. P0：CAPTCHA 页面禁止屏蔽图片等资源

当前 `openSessionPage()` 中有：

```js
await page.route(/\.(png|jpg|jpeg|gif|svg|webp|ico)(\?|$)/i,
  route => route.abort().catch(() => {}));
```

这对于普通网页提速可以接受，但对于 Google CAPTCHA / reCAPTCHA 恢复页面不合理。

如果验证码需要图片网格，这个 route 会直接让人工验证不可用或异常。

## 6.1 推荐修改

资源阻断应该支持模式：

```text
normal
human-recovery
```

例如：

```js
async function setupResourcePolicy(page, mode = 'normal') {
  if (mode === 'human-recovery') {
    return;
  }

  await page.route(/\.(png|jpg|jpeg|gif|svg|webp|ico)(\?|$)/i,
    route => route.abort().catch(() => {}));
}
```

但更推荐：

**Google session 本身不做图片屏蔽。**

个人 Google 搜索的流量并不值得为了省一点图片带宽而增加 CAPTCHA/页面兼容风险。

普通 fetch/browser rendering 路径仍可继续拦图片。

---

# 7. P1：Google 请求应串行或极低并发

当前 `MAX_CONCURRENT_PAGES` 默认是 2，但这属于整个 BrowserPool 的并发限制，不代表 Google 应该并发 2。

对于个人 Google profile，建议：

```text
GLOBAL browser pages: 2~3
Google:               1
Bing:                  independent
Web fetch:             independent
```

即：Google 自己加一个 mutex/queue。

示例概念：

```js
let googleQueue = Promise.resolve();

function runGoogleSerialized(fn) {
  const run = googleQueue.then(fn, fn);
  googleQueue = run.catch(() => {});
  return run;
}
```

更规范可以实现一个 `AsyncMutex`。

原因不是为了“模拟人”，而是为了避免：

- 同一 profile 同时开多张 Google SERP；
- research agent 在短时间内产生 burst；
- 多个 MCP call 同时修改 `lastRequestTime`；
- CAPTCHA 时多个页面同时进入 verification；
- 人工恢复期间新的 Google 请求继续冲击 Google。

---

# 8. P1：把速率限制从固定 3 秒改成“个人使用保护阀”

当前：

```js
const MIN_INTERVAL_MS = 3000;
```

这个只是两个请求之间最小 3 秒。

建议增加一个简单滑动窗口：

```env
GOOGLE_MIN_INTERVAL_MS=3000
GOOGLE_MAX_REQUESTS_PER_MINUTE=8
```

个人使用推荐默认：

```text
3~5 秒最小间隔
6~10 次 / 分钟软上限
Google 并发 = 1
```

不要无限 sleep。

如果 Agent 突然发出大量 query，可以返回：

```json
{
  "code": "RATE_LIMITED",
  "retry_after_ms": 8500
}
```

MCP agent 可以随后重试。

---

# 9. P1：加搜索缓存，减少无意义重复 Google 搜索

这是非常值得做的一项。

Agent 做 deep research 时经常出现：

```text
query A
query B
query A
query A slightly rewritten
query B
```

其中完全相同的请求没有必要重新访问 Google。

## 9.1 建议缓存 key

```text
engine + normalized_query + limit + locale
```

例如：

```js
const key = [
  'google',
  normalizeQuery(query),
  limit,
  GOOGLE_LOCALE
].join('|');
```

## 9.2 建议 TTL

个人搜索建议：

```env
GOOGLE_SEARCH_CACHE_TTL_MS=3600000
```

即默认 1 小时。

如果目标是普通资料研究，可以甚至：

```text
6h / 24h
```

对于明显时效性 query，可让调用方：

```text
fresh=true
```

绕过缓存。

---

# 10. P1：增加 Google session telemetry

不要只记录“成功/失败”。

建议至少记录以下指标：

```text
google.search.total
google.search.success
google.search.blocked
google.search.parse_failed
google.search.rate_limited
google.search.cache_hit
google.search.cache_miss

google.session.human_required
google.session.recovered
google.session.profile_age

google.browser.cdp_connected
google.browser.cdp_reconnect
```

其中最关键的是：

```text
CAPTCHA / 100 searches
CAPTCHA / browser restart
CAPTCHA / profile age
```

因为你的实际目标不是追求“bot detector 100% pass”，而是：

> **人工验证一次以后，一个 profile 能稳定使用多久。**

这才是应该测的指标。

---

# 11. P1：健康检查中暴露 Google 状态

建议 `/health` 增加：

```json
{
  "google": {
    "state": "READY",
    "cdp": true,
    "profile": "/data/browser-profile",
    "active_requests": 0,
    "queue_depth": 0,
    "last_success_at": "...",
    "last_blocked_at": "...",
    "captcha_count": 1,
    "search_count": 357,
    "cache_hits": 82
  }
}
```

注意不要输出：

- Google cookie；
- 登录邮箱；
- profile 内敏感 token；
- DevTools websocket URL 到公网接口。

---

# 12. P2：是否需要 Google 长驻 Page

之前一个直觉优化是：

```text
每次 search 新建 page
```

改成：

```text
长期复用同一 Google page
```

但结合你现在的真实情况：

> CAPTCHA 基本只在开始验证一次，后面并不反复出现。

因此这项**不必作为 P0/P1**。

## 12.1 当前方案可以继续保留

现在 Google：

```js
withPage({
  sessionKey: 'google',
  reuseSession: true,
  closeDelayMs: [2500, 6000]
})
```

虽然最终 page 会 `about:blank → close`，但浏览器 context/profile 仍然保持。

如果实测：

```text
首次 CAPTCHA 后连续数百次搜索正常
```

那么没必要仅为了“更像人”重构 page 生命周期。

---

## 12.2 什么时候才值得改成长驻 Page

只有以下情况才建议做：

- 每次 `newPage()` 都明显增加 CAPTCHA；
- Chrome CPU/内存创建页面开销明显；
- Google 首屏加载耗时成为主要延迟；
- 需要连续搜索体验；
- 需要把人工 CAPTCHA 页面原地继续作为搜索 worker。

如果做，建议新增：

```text
GooglePageWorker
```

而不是修改整个通用 `PlaywrightPool`。

结构：

```text
PlaywrightPool
     │
     ├── generic withPage()
     │
     └── GooglePageWorker
             │
             ├── single page
             ├── mutex
             ├── READY
             ├── HUMAN_REQUIRED
             └── recycle on crash only
```

这样不会把 Google 的特殊策略污染其他 browser engine。

---

# 13. Google 搜索行为：现有 human-like 可以保留，但不要继续扩张

当前已有：

- 进入 Google homepage；
- 等待 1.5~4 秒；
- click 搜索框；
- 逐字符输入，40~110ms delay；
- 输入中随机停顿；
- Enter；
- SERP 等待；
- 搜索后 mouse move；
- scroll；
- linger。

这些已经足够作为轻量行为模拟。

建议：

```text
保留：typing delay
保留：合理的短等待
保留：轻量 scroll

不新增：复杂 Bezier mouse trajectory
不新增：随机误点
不新增：假装阅读几十秒
不新增：随机点击搜索结果再返回
不新增：人工行为模型/强化学习 agent
```

原因：这些东西复杂度高，却不解决 persistent identity 的核心问题。

此外，等待时间越多也会直接降低 MCP research 效率。

---

# 14. 建议固定 locale / language，而不是随机

CDP 模式下不要覆盖浏览器 locale。

Chromium 启动时保持固定配置即可。

例如长期使用：

```text
zh-CN
Asia/Shanghai
```

或者你实际浏览器本来的环境。

关键不是选择哪个，而是：

```text
不要每次随机变化。
```

同理：

```text
timezone
Accept-Language
viewport
DPR
OS
UA
```

都以真实 Chrome 为准。

---

# 15. 网络策略

个人使用不建议为 Google 搜索做频繁 proxy rotation。

如果当前家庭/办公室出口稳定，建议：

```text
Google profile A
   ↕
固定网络出口
```

而不是：

```text
同一个 Google profile
   ↕
proxy A / B / C / D 不断切换
```

这不是说“代理一定不好”，而是你的目标是长期身份连续性。

如果确实必须走代理，则至少做到：

```text
一个 profile 长期绑定一个固定 proxy
```

而不是 per-request 切换。

---

# 16. CAPTCHA 恢复流程建议

推荐最终用户体验：

```text
MCP Google search
       │
       ▼
Google normal SERP?
       │
   ┌───┴───┐
   │ yes   │ no
   ▼       ▼
return   HUMAN_REQUIRED
results      │
             ▼
     keep current page open
             │
             ▼
       user opens noVNC
             │
             ▼
    login / solve CAPTCHA
             │
             ▼
      click retry in Agent
             │
             ▼
          READY
```

重点：

1. CAPTCHA 时**不要 close page**；
2. 不清 cookies；
3. 不重新创建 browser-profile；
4. 不自动打开第二个 Chrome profile；
5. 不做 solver；
6. 验证页面必须加载完整资源；
7. 人工验证期间 Google queue 暂停。

---

# 17. 建议增加 CAPTCHA recovery mutex

虽然当前个人使用并发不高，但 Agent 有可能同时触发两个 Google 请求。

如果两个请求都命中 CAPTCHA，不应该让两个页面同时进入人工恢复。

建议：

```js
let googleRecoveryPromise = null;
```

进入 HUMAN_REQUIRED 时：

```text
没有 recovery：创建 recovery 状态
已有 recovery：其他 Google 请求立即返回 HUMAN_REQUIRED
```

或者排队等待，但 MCP 通常不适合无限阻塞，因此更推荐 fail-fast。

---

# 18. 不建议在第一阶段引入 Patchright

Patchright / Rebrowser 的确在研究 Playwright/CDP automation leak，包括 `Runtime.Enable` 等问题。

但你当前已经有一个很重要的现实观察：

```text
人工验证一次
→ profile 后续基本稳定
```

这说明当前系统并不存在严重的“每次请求都会因为 Playwright 被识别而 CAPTCHA”的问题。

因此现阶段加入 Patchright 可能产生：

- Playwright 升级复杂度；
- Chromium compatibility 风险；
- API 行为差异；
- debug 难度增加；
- 新框架自己的 fingerprint；
- 未来维护成本。

推荐顺序：

```text
先移除 CDP stealth
       ↓
运行 1~2 周/足够搜索量
       ↓
观察 CAPTCHA rate
       ↓
如果仍明显恶化
       ↓
再测试 Patchright/Rebrowser
```

---

# 19. 如果以后测试 Patchright，必须做 A/B，而不是直接替换

建议保留环境变量：

```env
BROWSER_DRIVER=playwright
```

实验时支持：

```env
BROWSER_DRIVER=patchright
```

测试指标：

```text
A = Chromium + CDP + Playwright + no custom stealth
B = Chromium + Patchright
```

至少比较：

```text
CAPTCHA / 100 searches
首次 profile CAPTCHA 情况
验证后再次 CAPTCHA 的间隔
浏览器 crash rate
页面解析失败率
平均 search latency
CPU / RAM
Chrome restart 后成功率
```

只要 A 已经非常稳定，就没有换 B 的必要。

---

# 20. 推荐增加环境变量

建议：

```env
# Persistent Chrome / CDP
USE_EXISTING_CHROME=true
VISIBLE_BROWSER_PROFILE_DIR=/data/browser-profile
CDP_URL=http://127.0.0.1:9224

# Fingerprint policy
BROWSER_STEALTH=true
BROWSER_STEALTH_ON_CDP=false

# Google session
GOOGLE_MAX_CONCURRENCY=1
GOOGLE_MIN_INTERVAL_MS=3000
GOOGLE_MAX_REQUESTS_PER_MINUTE=8

# Google cache
GOOGLE_SEARCH_CACHE_ENABLED=true
GOOGLE_SEARCH_CACHE_TTL_MS=3600000
GOOGLE_SEARCH_CACHE_MAX_ENTRIES=500

# Human recovery
GOOGLE_HUMAN_RECOVERY=novnc
GOOGLE_KEEP_BLOCKED_PAGE=true

# Optional page worker, initially false
GOOGLE_REUSE_PAGE=false
```

其中核心默认值：

```text
BROWSER_STEALTH_ON_CDP=false
GOOGLE_MAX_CONCURRENCY=1
GOOGLE_HUMAN_RECOVERY=novnc
GOOGLE_KEEP_BLOCKED_PAGE=true
GOOGLE_REUSE_PAGE=false
```

---

# 21. 推荐代码结构

不建议大规模重写。

第一阶段只需要：

```text
src/
├── browser/
│   └── playwrightPool.js
│
├── engines/
│   └── google.js
│
├── common/
│   ├── asyncMutex.js          # 可选
│   └── ttlCache.js            # 可选
│
└── ...
```

如果未来做 Google 专用 page worker，再增加：

```text
src/browser/googlePageWorker.js
```

不要第一版就拆很多模块。

---

# 22. `playwrightPool.js` 建议改动清单

## 必做

### A. CDP 模式关闭 stealth

从：

```js
await stealthPlugin(page);
```

改成条件调用。

### B. `openSessionPage()` 同样处理

不要人工打开 Google session 时又注入 fake fingerprint。

### C. human recovery 不拦图片

尤其 Google session 页面。

### D. 日志输出当前模式

启动时打印一次：

```text
[browser] mode=cdp
[browser] persistent-profile=/data/browser-profile
[browser] stealth=disabled-for-cdp
```

方便确认实际运行路径。

---

## 暂时不要改

```text
不要删除通用 BrowserPool
不要马上删除全部 stealthPlugin 代码
不要马上换 Patchright
不要修改 parser
不要马上做 Google long-lived page
```

先把变量隔离出来，便于回滚和 A/B。

---

# 23. `google.js` 建议改动清单

## 23.1 将常量环境变量化

当前：

```js
const MIN_INTERVAL_MS = 3000;
```

改成：

```js
const MIN_INTERVAL_MS = envInt('GOOGLE_MIN_INTERVAL_MS', 3000, 0);
const MAX_REQUESTS_PER_MINUTE = envInt('GOOGLE_MAX_REQUESTS_PER_MINUTE', 8, 1);
```

---

## 23.2 Google concurrency = 1

在 `searchGoogleBrowser()` 外层加 Google 专用 mutex。

不要依赖 BrowserPool 的全局 page concurrency。

---

## 23.3 CAPTCHA 后立即停止自动 retry

当前：

```text
ENGINE_BLOCKED → break
```

方向正确。

继续保持：

```text
CAPTCHA 不自动连续刷新
CAPTCHA 不切 direct URL 再试
CAPTCHA 不重新开新 page 重试
```

因为人工恢复才是预期路径。

---

## 23.4 `keepPageOpen` 保留

这是目前非常重要的设计。

Google CAPTCHA page 应继续：

```js
err.keepPageOpen = true;
```

---

## 23.5 human-like 不再升级复杂度

现有：

```text
typeLikeHuman()
humanGlance()
```

先保留。

但建议配置化：

```env
GOOGLE_HUMANLIKE_MODE=light
```

支持：

```text
off
light
```

暂时不要做 advanced。

---

# 24. 推荐缓存执行位置

缓存最好放在：

```text
searchGoogle()
```

而不是 parser 或 browser 层。

流程：

```text
searchGoogle(query)
       │
       ▼
normalize cache key
       │
   ┌───┴────┐
 hit       miss
  │          │
return    browser search
             │
             ▼
          results
             │
             ▼
           cache
```

如果结果是：

```text
ENGINE_BLOCKED
SERP_PARSE_FAILED
BROWSER_UNAVAILABLE
```

不要缓存。

---

# 25. Profile bootstrap 建议写进 README

建议 README 明确一个“Google 初始化”步骤：

```text
1. docker compose up
2. 打开 noVNC
3. 在 Chromium 中访问 google.com
4. 登录个人 Google 账号（可选但推荐保持和日常使用一致）
5. 手工搜索 1~2 次
6. 如果出现 Robot Verification / CAPTCHA，人工完成一次
7. 关闭 noVNC 页面即可，不关闭 Chromium
8. 开始使用 MCP Google search
```

同时明确：

```text
不要把 ./data/browser-profile 删除掉，除非你希望重建 Google 浏览器身份。
```

这对于个人部署非常重要。

---

# 26. Docker / Chromium 更新策略

因为 profile 长期存在，所以更新 Chromium 时建议：

```text
允许正常浏览器版本升级
不要人为固定到非常老的 UA
不要 JS spoof 一个旧 Chrome 版本
```

真实浏览器升级后，让：

```text
navigator.userAgent
Client Hints
TLS behavior
browser feature set
```

自然一起升级。

这也是禁用 CDP stealth 的一个直接好处。

---

# 27. 回滚机制

任何此类修改都应该可以快速回滚。

建议：

```env
BROWSER_STEALTH_ON_CDP=true
```

可以恢复旧行为。

Google page worker 如果以后实现：

```env
GOOGLE_REUSE_PAGE=false
```

默认回到原有 per-search page。

缓存：

```env
GOOGLE_SEARCH_CACHE_ENABLED=false
```

可以完全关闭。

---

# 28. 第一阶段建议实际提交内容

建议拆成 4 个 commit。

## Commit 1 — CDP fingerprint consistency

```text
feat(browser): disable custom stealth injection for persistent CDP sessions
```

内容：

- 增加 `BROWSER_STEALTH_ON_CDP`；
- `withPage()` 条件调用 stealth；
- `openSessionPage()` 条件调用 stealth；
- 启动日志显示实际 fingerprint policy。

---

## Commit 2 — Google human recovery hardening

```text
fix(google): preserve full browser resources during manual verification
```

内容：

- Google human recovery 页面不 block image/media/font；
- CAPTCHA 保持 page；
- 增加明确 `HUMAN_REQUIRED` 状态/错误信息；
- Google recovery 期间停止新 Google 请求。

---

## Commit 3 — Google request guard

```text
feat(google): serialize requests and add bounded rate limiting
```

内容：

- Google mutex；
- min interval 配置；
- requests/minute 保护；
- rate-limit 指标。

---

## Commit 4 — Google query cache and telemetry

```text
feat(google): add search cache and session health metrics
```

内容：

- TTL cache；
- `/health` Google section；
- CAPTCHA/search/cache 计数。

---

# 29. 第一阶段验收标准

不要用普通 bot-test 网站是否显示“100% human”作为主要标准。

真正的验收标准：

## 功能

- noVNC 可以正常登录 Google；
- CAPTCHA 图片可以正常显示；
- CAPTCHA 完成后不用重启 MCP；
- CAPTCHA 完成后不用删除 profile；
- MCP retry 后可以继续搜索；
- Docker restart 后 Google 登录态仍存在；
- MCP restart 后 Google 登录态仍存在。

## 稳定性

记录至少：

```text
100 次 Google 搜索
300 次 Google 搜索
Docker restart 后 20 次
隔天继续 20 次
```

观察：

```text
CAPTCHA count
parse failure
browser failure
CDP reconnect
```

理想结果是：

```text
首次 bootstrap CAPTCHA ≈ 0~1
之后长期 CAPTCHA ≈ 0
```

如果已经达到这个状态，就停止继续做 anti-detection 优化。

---

# 30. 第二阶段才考虑的问题

只有第一阶段运行数据显示仍然有明显问题时，再依次研究：

```text
1. Google long-lived page
2. profile warm-up
3. parser self-healing
4. Patchright
5. Rebrowser patches
```

不建议直接研究：

```text
复杂鼠标生成器
机器学习模拟真人轨迹
自动 CAPTCHA solver
代理池轮换
大量浏览器身份随机化
```

这些都不是当前个人使用场景的主要矛盾。

---

# 31. 可选：Google 长驻 Page 的最小设计

如果未来确实需要，可实现：

```js
class GooglePageWorker {
  constructor(browserPool) {
    this.browserPool = browserPool;
    this.page = null;
    this.state = 'UNKNOWN';
    this.lock = new AsyncMutex();
  }

  async getPage() {
    if (this.page && !this.page.isClosed()) return this.page;

    const context = await this.browserPool.getSearchContext();
    this.page = await context.newPage();
    this.page.setDefaultTimeout(CONFIG.browserTimeoutMs);

    // IMPORTANT: no custom stealth in CDP mode.
    return this.page;
  }
}
```

每次搜索：

```text
lock
 ↓
getPage
 ↓
Google homepage/search
 ↓
parse
 ↓
if CAPTCHA:
   state=HUMAN_REQUIRED
   keep page
else:
   state=READY
 ↓
unlock
```

但再次强调：

> 如果当前 profile 验证一次后已经稳定，这部分可以不做。

---

# 32. 最终推荐架构

```text
┌──────────────────────────────────────────────┐
│              local-search-mcp                │
│                                              │
│   DuckDuckGo HTTP        Browser engines     │
│   Wikipedia HTTP               │             │
│   Fetch                         │             │
│                           PlaywrightPool       │
│                                │             │
│                     connectOverCDP()          │
│                                │             │
└────────────────────────────────┼─────────────┘
                                 │
                                 ▼
                    ┌─────────────────────┐
                    │ Visible Chromium    │
                    │                     │
                    │ native fingerprint  │
                    │ persistent profile  │
                    │ Google login        │
                    └─────────┬───────────┘
                              │
                 ┌────────────┴────────────┐
                 │                         │
                 ▼                         ▼
             MCP control                 noVNC
                 │                         │
                 │                   human login
                 │                   CAPTCHA once
                 │                         │
                 └────────────┬────────────┘
                              ▼
                    /data/browser-profile
                              │
                              ▼
                      long-term reuse
```

核心原则：

```text
真实浏览器 > JS 伪装浏览器
稳定身份   > 随机身份
持久 profile > 临时 storageState
人工恢复   > CAPTCHA solver
请求节制   > 更复杂的人类行为模拟
可观测性   > 凭感觉调 stealth
```

---

# 33. 建议实现顺序

实际编码时按下面顺序即可：

```text
[1] BROWSER_STEALTH_ON_CDP=false
        ↓
[2] Google/noVNC recovery 页面解除图片阻断
        ↓
[3] Google mutex，单并发
        ↓
[4] requests/minute rate guard
        ↓
[5] 1h TTL search cache
        ↓
[6] health + captcha/search counters
        ↓
[7] 连续实际使用观察
        ↓
[8] 再决定是否需要 GooglePageWorker
        ↓
[9] 仍不稳定才考虑 Patchright / Rebrowser
```

其中 **1~6 就应该构成第一版改造**。

---

# 34. 参考项目与资料

## 当前项目

- local-search-mcp  
  https://github.com/miemiekurisu/local-search-mcp

重点文件：

```text
src/browser/playwrightPool.js
src/engines/google.js
docker-compose.yml
```

## google-surf-mcp

- https://github.com/HarimxChoi/google-surf-mcp

值得参考的设计思想：

- persistent Chrome profile；
- CAPTCHA 由真人处理；
- human recovery 后继续保留 profile；
- Google 请求 rate limit；
- query cache；
- health/telemetry；
- newer versions use bare Playwright as the first tier and stealth only as fallback；
- CAPTCHA recovery 时解除 image/media/font block。

## Patchright

- https://github.com/Kaliiiiiiiiii-Vinyzu/patchright

用途：未来用于 Playwright/CDP leak 的 A/B 实验，不建议当前直接替换主路径。

## Rebrowser Patches

- https://github.com/rebrowser/rebrowser-patches

用途：研究 Playwright `Runtime.Enable` 等 automation leak，作为后续诊断/实验参考。

---

# 35. 最终判断

以你现在的实际使用情况：

```text
个人本地使用
+ noVNC 可人工登录
+ persistent Chromium profile
+ Google CAPTCHA 基本只需要人工验证一次
+ 验证后没有持续反复出现
```

这个系统其实已经非常接近合理的最终形态。

当前最有价值的改造不是寻找一个“永远不会被 Google 判断为机器人”的框架，而是：

> **不要让 MCP 自己破坏已经由真实 Chrome + Google 登录 + 人工 CAPTCHA 建立起来的浏览器信誉。**

因此第一阶段最重要的一刀就是：

```text
CDP persistent Chromium
        ↓
NO custom stealth injection
        ↓
keep real browser identity untouched
```

然后加上：

```text
单并发
适度 rate limit
query cache
可靠 noVNC human recovery
运行指标
```

如果这些完成以后，CAPTCHA 仍然只是 profile 建立阶段出现一次，那么应该把它视为正常 bootstrap，而不是继续投入工程成本试图消灭它。
