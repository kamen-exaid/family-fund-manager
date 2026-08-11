# 家庭基金账目管理系统 — 严肃架构与代码审查

> 审查范围：全部后端 (`server.js`, `lib/`, `routes/`)、前端结构 (`public/`)、数据层 (`data/`)、测试 (`test/`)
> 代码规模：~16,200 行（含测试），3 个 npm 依赖
> 审查日期：2026-08-10

---

## 总体评价

这是一个**远超"家庭项目"水准**的系统。在以下方面做得相当出色：

| 维度 | 评分 | 说明 |
|------|------|------|
| 业务建模精度 | ⭐⭐⭐⭐⭐ | 事件溯源 + Decimal.js 精确计算，份额/净值零滑点 |
| 数据安全性 | ⭐⭐⭐⭐⭐ | 原子写入 + 事务日志 + 滚动快照 + 账本丢失保护 |
| 算法版本管理 | ⭐⭐⭐⭐⭐ | v1/v2/v3 冻结重放 + 快照校验迁移，极为罕见的严谨度 |
| 输入校验 | ⭐⭐⭐⭐ | 全字段白名单校验，导入校验极其细致 |
| 测试覆盖 | ⭐⭐⭐⭐ | 19 个测试文件，覆盖计算器/API/前端语法/组件 |
| 可维护性 | ⭐⭐⭐ | 部分模块职责过重，代码重复较多 |
| 安全性 | ⭐⭐⭐ | 本地部署场景足够，但存在可加固点 |

**一句话：这个系统的财务精度和数据保护设计已经达到了准生产级金融软件的标准。** 下面的批评都是在这个高水准基础上的进一步挑剔。

---

## 🟢 架构亮点（值得称赞的设计）

### 1. 事件溯源架构选型精准

```
入金/出金/估值/转让/结算 → 不可变事件流 → 全量重放 → 派生状态
```

对于家庭基金这个场景，事件溯源是**最优解**：
- 任何历史事件的修改/删除都能触发全链条级联重算
- 审计追溯性天然具备
- 结算锁账通过时间线切分实现，逻辑清晰

### 2. 三文件原子事务提交 ([storage.js](file:///Volumes/生涯/code/基金账目管理系统/lib/storage.js#L336-L452))

`writeSnapshot` 的实现令人印象深刻：
- 先 `prepareTempFile` 写入临时文件 → `fsync` → rename（原子）
- 写入前持久化事务日志（`SNAPSHOT_JOURNAL_FILE`）
- 任何一步失败都有完整回滚路径
- 进程崩溃后 `recoverInterruptedSnapshot` 自动恢复

这个设计在纯 Node.js + JSON 文件存储的约束下，**已经逼近了数据库级别的 ACID 保证**。

### 3. 结算算法版本冻结 ([settlement-ledger.js](file:///Volumes/生涯/code/基金账目管理系统/lib/settlement-ledger.js))

这是整个系统**最精巧的设计**：
- 每笔已确认的结算记录携带 `algorithmVersion` + `snapshot`
- 历史重放严格按记录自身版本调用冻结算法
- 无版本旧记录通过快照比对自动迁移，不可唯一确认则拒绝
- 冲销（reversal）不删除原记录，而是追加审计条目

> [!TIP]
> 这种设计在真正的对冲基金管理系统中也不常见。多数系统选择"迁移所有历史数据"的策略，而这里选择了"冻结旧算法 + 新算法并存"，对历史一致性的保护更强。

### 4. Decimal.js 全链路精确计算 ([calculator.js](file:///Volumes/生涯/code/基金账目管理系统/lib/calculator.js#L1-L9))

```js
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
```

所有份额、净值、金额的中间计算全部用 `Decimal`，只在 API 输出边界才 `toNumber()`。这消除了 IEEE 754 浮点数在财务计算中的经典误差累积问题。

---

## 🔴 严重问题

### S1. 零认证零授权 — 所有 API 完全暴露

> [!CAUTION]
> 当前所有 API 端点（包括删除事件、导入数据、结算确认）都不需要任何认证。虽然绑定 `127.0.0.1`，但同一局域网的任何人通过端口扫描即可完全操控账本。

**影响**：同一台机器上的任何进程、任何浏览器标签页都可以随意调用 `DELETE /api/event/:id` 或 `POST /api/backup/import` 覆盖全部数据。

**建议**：
- 最低限度：添加一个启动时随机生成的 Bearer Token，打印到控制台，前端通过 Token 访问
- 进阶：添加简单的用户名/密码登录 + session cookie

### S2. `calculateState()` 时间复杂度 O(N²) — 隐藏的性能炸弹

[calculator.js](file:///Volumes/生涯/code/基金账目管理系统/lib/calculator.js#L90-L571) 的 `calculateStateFromDb` 每次调用都会：

1. 对全部事件排序 `O(N log N)`
2. 遍历所有事件，每个事件内遍历所有成员 `O(N × M)`
3. 部分出金/转让路径的 `previewDisposalFee` 遍历所有批次 `O(L)`

更严重的是，**单个 API 请求内可能多次调用 `calculateStateFromDb`**：

```
routes/transactions.js:
  accountValueBeforeEvent() → calculateStateFromDb()  // 第 1 次
  findLedgerIssue()        → calculateStateFromDb()  // 第 2 次
  fullExit 分支            → calculateStateFromDb()  // 第 3 次
  writeDb()                → 触发备份                 // 第 4 次（间接）
```

一个修改出金请求最多触发 **3-4 次完整重放**。当事件数达到数百条时，每次请求的延迟将显著增长。

**建议**：
- 短期：在单个请求内复用计算结果，避免重复 `calculateStateFromDb` 调用
- 中期：增量计算 — 只从变更点开始重放，而非每次全量
- 已有的 `_stateCache` 只缓存了 `getState()` 路径，但 `findLedgerIssue` 和 `accountValueBeforeEvent` 绕过了缓存

### S3. `writeDb` 每次写入都创建完整 ZIP 备份

[storage.js#L178-L196](file:///Volumes/生涯/code/基金账目管理系统/lib/storage.js#L178-L196)：

```js
function writeDb(dbData) {
  writeCoreBackup(...)  // 每次写入前都创建 ZIP 快照
  atomicWriteFile(DB_FILE, nextContent);
}
```

后台指数缓存同步（`ensureIndexCache`）最终会调用 `writeDb`，这意味着**每次启动时的 Yahoo 数据同步也会触发一次完整 ZIP 备份**。Yahoo 数据是可重建的市场数据，不应该触发账本级别的备份。

`indexCache` 存储在 `db.json` 内是根本原因 — 一个可丢弃的缓存和不可丢失的账本数据混在同一个文件中。

**建议**：将 `indexCache` 从 `db.json` 中分离出来，像 `ticker-cache.json` 一样独立存储（`ticker-cache.json` 的设计反而是正确的，注释里甚至已经写了正确的理由）。

---

## 🟡 中等问题

### M1. calculator.js 中出金/转让逻辑严重重复

[calculator.js](file:///Volumes/生涯/code/基金账目管理系统/lib/calculator.js) 中 `withdraw` 分支（L175-291）和 `transfer` 分支（L301-429）有**约 70% 的代码几乎逐行相同**：

- 相同的 `previewDisposalFee` 调用
- 相同的 `fullExit` 处理
- 相同的 `takeLotsProRata` / `takeLotsForLegacyDisposal` 分支
- 相同的 `carryShares` 更新逻辑
- 相同的 `gpMember` 份额转移

这种大段复制最大的风险是：**修复一处 bug 时忘记修复另一处**。当前代码已经有细微的不一致（transfer 分支多了 `carryTransferred` 变量而 withdraw 用内联计算）。

**建议**：提取 `processDisposal(member, amount, event, options)` 统一处理出金和转让的份额扣减逻辑。

### M2. transactions.js 中同样存在大段重复

[transactions.js](file:///Volumes/生涯/code/基金账目管理系统/routes/transactions.js) 中 `PUT /api/event/:id` 的处理逻辑（L303-515）长达 **212 行**，其中 deposit/withdraw/valuation/transfer 四种类型的校验逻辑各自内联，与 `POST` 路由的校验逻辑也有大量重复。

### M3. 事件排序依赖 `createdAt` 时间戳的稳定性

[calculator.js#L91-L94](file:///Volumes/生涯/code/基金账目管理系统/lib/calculator.js#L91-L94)：

```js
const sortedEvents = [...db.events].sort((a, b) => {
  const dateCompare = a.date.localeCompare(b.date);
  return dateCompare !== 0 ? dateCompare : a.createdAt - b.createdAt;
});
```

`createdAt` 是 `Date.now()` 毫秒时间戳。如果用户在同一毫秒内通过脚本批量导入同日事件，排序将不确定。更危险的是备份导入场景中事件的 `createdAt` 来自外部数据，可能被篡改以影响重放顺序。

**建议**：添加一个显式的 `sequenceNumber`（单调递增整数）作为同日事件的确定性排序键。

### M4. 全局可变状态与并发风险

[server.js](file:///Volumes/生涯/code/基金账目管理系统/server.js#L40-L42)：

```js
let _stateCache = null;
let _stateDirty = true;
let _settlementLedgerValidated = false;
```

[storage.js](file:///Volumes/生涯/code/基金账目管理系统/lib/storage.js#L48-L50)：

```js
let dbCache = null;
let settlementsCache = null;
let tempFileSequence = 0;
```

Node.js 虽然是单线程，但 Express 的异步请求处理可以交错执行。以下场景可能出问题：

1. 请求 A 执行 `readDb()` 获取数据
2. 请求 A 进入 `await ensureIndexCache()`（让出事件循环）
3. 请求 B 执行 `writeDb()` 修改了数据
4. 请求 A 继续执行，基于过时的数据写入 → **丢失请求 B 的修改**

`ensureIndexCache` 内部就有这个问题 — 它 re-read 了 `latestDb`（[server.js#L206](file:///Volumes/生涯/code/基金账目管理系统/server.js#L206)），但这只防止了自身的覆写，不防止其他路由的竞态。

### M5. `index.html` 单文件 58KB — 前端架构单体化

[public/index.html](file:///Volumes/生涯/code/基金账目管理系统/public/index.html) 有 58,727 字节（~1500 行 HTML）。所有页面的 DOM 结构都写在同一个文件中，通过 CSS class 切换显示/隐藏。

前端 JS 虽然已经拆分到 22 个模块文件（好的），但它们之间通过全局函数和 DOM 查询耦合。例如 `app.js` 有 37,277 字节（~900 行），承担了状态管理、表单处理、页面协调等多重职责。

### M6. 业绩结算参数硬编码

多处硬编码了 `annualRate: 0.06` 和 `feeRate: 0.25`：

- [routes/transactions.js#L78-L79](file:///Volumes/生涯/code/基金账目管理系统/routes/transactions.js#L78-L79)
- [routes/settlements.js#L30](file:///Volumes/生涯/code/基金账目管理系统/routes/settlements.js#L30)
- [routes/members.js#L89](file:///Volumes/生涯/code/基金账目管理系统/routes/members.js#L89)
- [routes/backup.js#L188](file:///Volumes/生涯/code/基金账目管理系统/routes/backup.js#L188)

虽然 `db.performanceFee` 中存储了这些配置，但实际使用时从不读取它们，而是直接写死字面量。如果将来费率变更，需要同时修改至少 **6 处以上**的硬编码。

---

## 🔵 改进建议

### B1. 缺少请求频率限制

所有 API 端点没有 rate limiting。恶意脚本可以高频调用 `POST /api/transaction` 创建海量事件，每次都触发完整重放 + ZIP 备份，可快速耗尽磁盘空间和 CPU。

### B2. 错误处理不区分客户端错误与服务端错误

所有路由的 `catch` 块统一返回 `500`：

```js
} catch (error) {
  res.status(500).json({ success: false, message: error.message });
}
```

业务校验抛出的 `Error`（如"余额不足"）和真正的系统异常（如磁盘写入失败）返回相同的 HTTP 状态码，这对前端的错误处理和运维排查都不友好。

### B3. Yahoo Finance API 依赖脆弱

[yahoo.js](file:///Volumes/生涯/code/基金账目管理系统/lib/yahoo.js) 使用的是 Yahoo Finance 的非官方 API (`query2.finance.yahoo.com/v8/finance/chart`)。该 API：
- 没有 SLA 保证
- Yahoo 随时可能更改端点或增加认证
- User-Agent 欺骗虽然目前能工作，但技术上违反了 ToS

系统对此的处理还算合理（graceful degradation + curl fallback），但应在文档中明确这个风险。

### B4. `db.json` 内含过多职责

当前 `db.json` 同时存储：
- 成员列表（结构数据）
- 事件流（核心账本）
- 汇率（配置参数）
- 基准指数缓存（可丢弃缓存）
- 业绩结算配置（系统参数）

这些数据的变更频率、重要性、备份需求完全不同，但混在一个文件中，导致任何一项变更都触发整个文件的重写和备份。

### B5. 前端无构建工具链

22 个 JS 文件通过 `<script>` 标签直接加载，没有 bundling、minification、tree-shaking。对于当前规模（~160KB JS）尚可接受，但随着功能增长，加载性能和依赖管理会成为问题。

### B6. 测试框架缺失

19 个测试文件直接用 `node` 执行，使用原始的 `assert` 和手写测试框架。没有标准测试运行器（如 Jest/Vitest），导致：
- `package.json` 的 `test` 脚本是 19 个 `&&` 串联，新增测试文件需要手动追加
- 无法方便地运行单个测试文件或测试用例
- 没有覆盖率报告
- 没有 watch 模式

不过，测试本身的**质量很高** — 覆盖了计算模型、API 校验、版本迁移、快照冲突、事务回滚等关键路径。

### B7. 日志可观测性不足

当前日志只有 `console.log/console.error`，没有结构化日志、日志级别、请求 ID。对于一个家庭工具足够，但如果遇到生产问题排查会很困难。

---

## 🔍 安全细节审查

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 命令注入 | ✅ 已修复 | `execFile` 参数化传递，不经过 shell |
| SQL 注入 | N/A | 无 SQL 数据库 |
| XSS | ⚠️ 部分风险 | 前端使用 `innerHTML` 渲染的地方需确认转义 |
| CSRF | ⚠️ 无防护 | 无 CSRF token，但本地部署风险较低 |
| 路径遍历 | ✅ 安全 | ZIP 导入只读取固定路径名 |
| 原型污染 | ✅ 安全 | `JSON.parse` 输入，无 `Object.assign` 用户输入 |
| 正则 DoS | ✅ 安全 | 正则表达式简单，无回溯风险 |
| ZIP 炸弹 | ✅ 已限制 | 10MB 解压上限 |
| ID 碰撞 | ✅ 已修复 | `crypto.randomUUID()` 替代 `Math.random` |

---

## 📊 代码质量度量

| 文件 | 行数 | 圈复杂度评估 | 问题 |
|------|------|-------------|------|
| [calculator.js](file:///Volumes/生涯/code/基金账目管理系统/lib/calculator.js) | 574 | 🔴 高 | `calculateStateFromDb` 单函数 480 行 |
| [transactions.js](file:///Volumes/生涯/code/基金账目管理系统/routes/transactions.js) | 519 | 🔴 高 | `PUT /api/event/:id` 单路由 212 行 |
| [performance-settlement.js](file:///Volumes/生涯/code/基金账目管理系统/lib/performance-settlement.js) | 395 | 🟡 中 | 3 个版本函数结构相似但有意为之 |
| [storage.js](file:///Volumes/生涯/code/基金账目管理系统/lib/storage.js) | 480 | 🟡 中 | `writeSnapshot` 较复杂但逻辑必要 |
| [yahoo.js](file:///Volumes/生涯/code/基金账目管理系统/lib/yahoo.js) | 362 | 🟢 低 | 结构清晰 |
| [backup.js](file:///Volumes/生涯/code/基金账目管理系统/routes/backup.js) | 258 | 🟡 中 | 导入校验虽长但完整必要 |

---

## 🏗️ 重构优先级建议

按投入产出比排序：

| 优先级 | 改动 | 预估工作量 | 收益 |
|--------|------|-----------|------|
| P0 | 将 `indexCache` 从 `db.json` 分离 | 2h | 消除无意义备份，显著降低 I/O |
| P1 | 请求内复用 `calculateStateFromDb` 结果 | 3h | 消除单请求 3-4 次重放 |
| P1 | 提取出金/转让公共逻辑 | 4h | 消除最大的代码重复风险 |
| P2 | 提取费率硬编码为常量/配置 | 1h | 消除散弹式修改风险 |
| P2 | 添加最基础的 Bearer Token 认证 | 2h | 堵住最大安全缺口 |
| P3 | 引入轻量测试框架 | 2h | 改善开发体验 |

---

## 总结

这是一个**设计严谨、工程水准很高**的家庭基金管理系统。它在数据一致性、精确计算、历史可追溯性方面的处理达到了金融级软件的标准。核心的事件溯源架构、算法版本冻结、三文件原子事务等设计决策都非常出色。

主要的改进空间集中在：**代码重复**（calculator 出金/转让）、**性能**（重复重放）、**数据分离**（indexCache 不应触发备份）。这些都是"好代码在长期维护中自然累积的技术债"，不影响系统当前的正确性和可靠性。
