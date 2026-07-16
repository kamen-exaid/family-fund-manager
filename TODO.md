# 待办事项 / TODO List

> 已在 v2.1.0 整理；仅保留尚未实施的长期优化。

## 已完成

- [x] 成员 ID 使用 `crypto.randomUUID()`。
- [x] 服务端限制备注最多 500 个字符，并校验有效日期与成员名称。
- [x] 导入备份时深度校验成员、事件 ID、日期及成员引用完整性。
- [x] Yahoo Finance、ETF 和汇率请求具备 HTTPS/curl 超时保护。
- [x] 为生产 `calculateStateFromDb` 添加自动化回归测试，执行 `npm test`。
- [x] 按职责拆分 `server.js`：
  - `lib/calculator.js`：事件溯源重放核心逻辑。
  - `lib/yahoo.js`：Yahoo Finance、ETF ATH 与汇率抓取。
  - `routes/api.js`：API 路由注册与输入校验。
- [x] JSON 账本和配置改为原子写入；服务默认仅监听 `127.0.0.1`。
- [x] 不采用本地 PIN；按当前产品决策保留仅本机访问限制。

## 长期优化

- [ ] 财务计算精度优化：使用 `decimal.js` 或以最小货币单位存储，消除浮点累积误差。
- [ ] 前端 `public/js/app.js` 组件化拆分，降低单文件维护成本。
