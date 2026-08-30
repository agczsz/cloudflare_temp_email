# 上游变更核查清单（UPSTREAM CHANGES）

本分支（`vps-node`）在 [agczsz/cloudflare_temp_email](https://github.com/agczsz/cloudflare_temp_email)
之上做了 VPS（DartNode / Node.js + SQLite）自托管重构。**上游更新时，按本清单逐项核对是否需要同步改动。**

> 上游更新操作建议：`git fetch origin && git diff HEAD...origin/main -- worker/src server/src` 对照下表审查，
> 逐条判断"上游的改动是否影响我们的补丁"。

---

## 一、上游文件改动（合并上游时需重点核对的 diff）

| # | 文件 | 改动 | 目的 | 上游更新风险 |
|---|------|------|------|--------------|
| 1 | `worker/src/common.ts` | ① 新增 `fireAndForget()` 辅助函数；② `updateAddressUpdatedAt` / `updateUserAddressesUpdatedAt` 中 `c.executionCtx.waitUntil(...)` 改为 `fireAndForget(c, ...)` | Node 运行时没有 Workers 的 ExecutionContext | 低。若上游在别处新增 `executionCtx.waitUntil`，同样需要替换 |
| 2 | `worker/src/common.ts` | ③ `commonParseMail()` 中取消注释 WASM 解析块（启用 `mail-parser-wasm-worker`，失败时回退 postal-mime） | 更强的邮件解析（官方文档特性，默认关闭） | 极低。上游本身就是注释着的官方代码，取消注释而已 |
| 3 | `worker/src/worker.ts` | ④ 导入并注册 `addy_api` 路由；⑤ `/api/*` JWT 中间件最前面放行 `/api/v1/`（addy 端点自带 Bearer 认证） | Bitwarden（Addy.io 协议）兼容端点 | 中。若上游调整 `/api/*` 中间件结构，需重排放行逻辑 |
| 4 | `worker/src/telegram_api/index.ts` | ⑥ `POST /admin/telegram/init` 的 webhook 域名优先取 `TELEGRAM_WEBHOOK_HOST` 环境变量，缺省回落 `new URL(c.req.url).host` | TLS 反代后 `c.req.url` 是内网地址(:48321)，webhook 会注册成错误端口 | 低 |
| 5 | `worker/src/types.d.ts` | ⑦ `Bindings` 增加 `TELEGRAM_WEBHOOK_HOST`、`ADDY_AUTH_TOKEN` 两个可选字段声明 | 类型完整性 | 极低 |

## 二、新增文件（上游没有，合并不冲突，但升级后需确认依赖的上游接口没变）

| 文件 | 用途 | 依赖的上游接口 |
|------|------|----------------|
| `server/` 整个目录 | **Node 运行时**：`entry.ts`(启动)、`config.ts`、`d1.ts`(D1→better-sqlite3 适配)、`kv.ts`(KV→SQLite)、`ai.ts`(Workers AI→REST)、`ratelimit.ts`、`assets.ts`(前端静态)、`smtp.ts`(25 端口收信)、`build.mjs`(esbuild 打包，`.wasm` 用 binary loader) | D1 的 `prepare/bind/first/all/run/batch`；`env.AI.run(model, inputs)`；`email(message, env, ctx)`；`scheduled(event, env, ctx)`。**上游若改这些签名需同步** |
| `worker/src/addy_api.ts` | Bitwarden/Addy.io 兼容模块：`POST /api/v1/aliases`（Bearer `ADDY_AUTH_TOKEN`，返回 `{"data":{"email":...}}`），内部复用上游 `newAddress()` / `generateRandomName()` | 上游 `common.ts` 的 `newAddress/getAddressPrefix/generateRandomName` 签名 |
| `server/smoke_test.py` `smoke_features.py` `check_gzip.mjs` | 本地烟测（后者两项为功能验证辅助） | — |
| `server/vps_deploy.sh` `update_ai_tg.sh`（密钥走环境变量） | VPS 部署/配置更新脚本 | — |
| `server/temp-email.service` `server/VPS_DEPLOY.md` | systemd 单元 + 部署文档 | — |
| `Dockerfile` `docker-compose.yml` `.dockerignore` `.github/workflows/docker-publish.yml` | 容器化 + ghcr.io 自动发布 | — |

## 三、配置项（`server/config.json`，等价 wrangler.toml [vars]）

| 变量 | 当前值 | 说明 |
|------|--------|------|
| `ENABLE_WEBHOOK` | `true` | **本次启用**。webhook 推送（需 KV，已用 SQLite 模拟实现） |
| `FRONTEND_URL` | `https://mail.266666.best` | **本次设置**。webhook 邮件链接指向的前端地址 |
| `ENABLE_MAIL_GZIP` | `true` | **本次启用**。新邮件 gzip 压缩进 `raw_blob` 列（schema 已含该列；旧明文数据仍可读） |
| `ADDY_AUTH_TOKEN` | （随机串，见 VPS config.json） | **本次新增**。Bitwarden 用户名生成器（Addy.io 协议）的鉴权 token；留空则端点 403 关闭 |
| `TELEGRAM_WEBHOOK_HOST` | `mail.266666.best` | 上一轮新增 |
| `AI_API_KEY` / `AI_ACCOUNT_ID` | 已配置 | Workers AI REST 提取 |
| 其余 | 见 `server/config.example.json` | 与上游 [vars] 一一对应 |

## 四、本次功能变更明细（对应提交）

1. **WASM 邮件解析**（官方特性启用）
   - `worker/package.json` 新增依赖 `mail-parser-wasm-worker`
   - `common.ts` 取消注释 WASM 块（见 #1-③）；`server/build.mjs` 增加 `loader: {".wasm": "binary"}`（wasm 以字节内联，`initSync` 直接编译，Node 可用）
   - 验证：解析成功且日志无 `Failed use mail-parser-wasm-worker`
2. **Webhook + 邮件压缩**（官方文档 worker-vars 特性）
   - 仅配置启用，代码零改动（KV/压缩流在 Node 适配层已就绪）
   - 验证：全局 mail webhook POST 回调收到含正文的消息；新邮件 `raw IS NULL AND length(raw_blob)>0`
3. **Bitwarden 兼容模块**（参考 Yeqingky/Seek2Addy + 官方 new-address-api 文档）
   - Bitwarden「用户名生成器 → Addy.io 自托管」填：Server URL=`https://mail.266666.best`，API Key=`ADDY_AUTH_TOKEN` 的值，Domain=`266666.best`
   - 地址创建走上游同一条 `newAddress()` 校验链（前缀/正则/长度/黑名单全部生效），`source_meta` 记为 `bitwarden-addy`
   - 验证：正确 token 创建成功、错误/缺失 token 401、未配置 token 403

## 五、已知与上游行为不一致的点（有意为之）

- `SEND_MAIL` 绑定不存在 → 发件相关接口返回优雅错误（收件不受影响）
- `RATE_LIMITER` 为进程内固定窗口（重启清零）
- `KV` 存 SQLite 表 `kv_storage`（含 `created_at` 列，勿删）
- 打包时 `cloudflare:sockets` / `cloudflare:email` 用 stub 顶替（仅发件路径会触发）
