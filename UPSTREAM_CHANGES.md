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
| 6 | `worker/package.json` | ⑧ dependencies 新增 `mail-parser-wasm-worker`（WASM 解析） | 特性启用 | 极低。上游升级该包后需重新验证 Node 下 `.wasm` binary loader 打包 |

## 二、新增文件（上游没有，合并不冲突，但升级后需确认依赖的上游接口没变）

| 文件 | 用途 | 依赖的上游接口 |
|------|------|----------------|
| `server/` 整个目录 | **Node 运行时**：`entry.ts`(启动)、`config.ts`、`d1.ts`(D1→better-sqlite3 适配)、`kv.ts`(KV→SQLite)、`ai.ts`(Workers AI→REST)、`ratelimit.ts`、`assets.ts`(前端静态)、`smtp.ts`(25 端口收信)、`build.mjs`(esbuild 打包，`.wasm` 用 binary loader) | D1 的 `prepare/bind/first/all/run/batch`；`env.AI.run(model, inputs)`；`email(message, env, ctx)`；`scheduled(event, env, ctx)`。**上游若改这些签名需同步** |
| `server/src/sendmail.ts` | **发件组件**：SEND_MAIL 绑定替代品（nodemailer 直投 MX 或经 SEND_RELAY_* 中继），处理结构化对象与 EmailMessage 实例两种形态；启动时生成 DKIM 密钥并对全部外发签名 | `c.env.SEND_MAIL.send(...)` 的两种入参形状（admin_api/send_mail.ts、mails_api/send_mail_api.ts） |
| `server/src/submit.ts` | **SMTP 提交服**（隐式 SSL，465）：邮箱地址+地址密码登录（SHA-256 比对），信封 from 必须等于认证地址，消息交给同一 nodemailer transporter（带 DKIM） | `address.password` 的存储格式（前端 SHA-256 hex） |
| `server/src/imap.ts` | **IMAP 服务**（隐式 SSL，993）：只读最小命令集（LOGIN/AUTHENTICATE PLAIN/LIST/SELECT/STATUS/SEARCH ALL/FETCH/IDLE/LOGOUT），直接读 SQLite，自动解压 raw_blob。npm 无维护良好的 IMAP 服务端包，此为自实现 | `raw_mails` 表结构、`raw_blob` gzip（魔法数 1f 8b 判断） |
| `worker/src/addy_api.ts` | Bitwarden/Addy.io 兼容模块：`POST /api/v1/aliases`（Bearer `ADDY_AUTH_TOKEN`，返回 `{"data":{"email":...}}`），内部复用上游 `newAddress()` / `generateRandomName()` | 上游 `common.ts` 的 `newAddress/getAddressPrefix/generateRandomName` 签名 |
| `server/smoke_test.py` `smoke_features.py` `smoke_mailcli.py` `check_gzip.mjs` `sink_smtp.mjs` | 本地烟测与功能验证辅助 | — |
| `server/vps_deploy.sh` `update_ai_tg.sh`（密钥走环境变量） | VPS 部署/配置更新脚本 | — |
| `server/temp-email.service` `server/VPS_DEPLOY.md` | systemd 单元 + 部署文档 | — |
| `Dockerfile` `docker-compose.yml` `.dockerignore` `.github/workflows/docker-publish.yml` | 容器化 + ghcr.io 自动发布 | — |

### 新增依赖包（server/package.json）

| 包 | 用途 | 备注 |
|----|------|------|
| `smtp-server` ^3.13.6 | SMTP 协议服务端（25 收信 + 465 提交） | Nodemailer 官方包，纯 JS |
| `nodemailer` ^7 | 外发投递（直投 MX / 中继）+ DKIM 签名 | 465=隐式 SSL、587=STARTTLS（`secure: port===465`） |
| `better-sqlite3` | SQLite 驱动（D1/KV 存储） | 运行时装，带编译工具 |
| `mail-parser-wasm-worker`（worker/） | WASM 邮件解析 | esbuild binary loader 内联 |
| `@hono/node-server` | Hono 的 Node HTTP 适配 | — |

## 三、配置项（`server/config.json`，等价 wrangler.toml [vars]）

| 变量 | 当前值 | 说明 |
|------|--------|------|
| `ENABLE_WEBHOOK` | `true` | **本次启用**。webhook 推送（需 KV，已用 SQLite 模拟实现） |
| `FRONTEND_URL` | `https://mail.266666.best` | **本次设置**。webhook 邮件链接指向的前端地址 |
| `ENABLE_MAIL_GZIP` | `true` | **本次启用**。新邮件 gzip 压缩进 `raw_blob` 列（schema 已含该列；旧明文数据仍可读） |
| `ADDY_AUTH_TOKEN` | （随机串，见 VPS config.json） | **本次新增**。Bitwarden 用户名生成器（Addy.io 协议）的鉴权 token；留空则端点 403 关闭 |
| `SMTP_SSL_PORT` / `IMAP_SSL_PORT` | `465` / `993` | **本次新增**。SMTP 提交服与 IMAP 服务端口（均隐式 SSL；置 0 关闭） |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | `/root/ssl/zerossl.crt` / `.key` | 465/993 的证书；缺省时自动生成自签证书 |
| `DKIM_SELECTOR` | `smtp` | DKIM 选择器；DNS 需有 `smtp._domainkey.266666.best` TXT |
| `SEND_RELAY_HOST` 等 | 空 | 留空=直投 MX；配置后经 smarthost 中继（`SEND_RELAY_TLS_INSECURE` 可容自签） |
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

## 五、KV 存储实现细节（VPS 专属，上游更新 KV 相关代码时必读）

上游用 Cloudflare KV，本分支用 SQLite 表 `kv_storage` 模拟（`server/src/kv.ts`）。**上游若新增 KV 用法，需确认 shim 是否覆盖：**

| 项 | 说明 |
|----|------|
| 表结构 | `kv_storage(key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` |
| 迁移 | 启动时 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN created_at`（catch 重复列错误）。**旧库自动补列，勿手工删表** |
| 已支持语义 | `get(key[, "json"|"number"])`、`put(key, value, {expirationTtl})`、`delete(key)`、`list({prefix})`；过期在读时惰性删除 |
| 与上游的差异 | KV 最终一致 vs 本地强一致；无 `metadata` 参数；无 `cacheTtl`；大 value 无 25MB 限制（SQLite） |
| 历史 bug（已修，防回归） | ① 建表缺 `created_at` 列但 INSERT 引用 → TG 设置保存 500（commit `8fdfd83`）；② `get(key,"json")` 未实现导致返回字符串而非对象（同 commit） |

## 六、变更历史（按时间顺序，上游更新时逐条核对）

| 提交 | 内容 | 涉及上游文件 |
|------|------|--------------|
| `2898918` | Node 运行时适配层（`server/` 全套：D1/KV/AI/RATE_LIMITER/ASSETS/SMTP）；`common.ts` 加 `fireAndForget` 替换 `executionCtx.waitUntil`；前端同源 `.env.prod` | `common.ts` |
| `e11b9cc` | systemd 单元 + VPS 部署文档 | — |
| `14282b2` | Dockerfile / docker-compose / ghcr.io Actions | — |
| `8fdfd83` | KV 修复：`kv_storage` 补 `created_at` 列（含旧库 ALTER 迁移）、实现 `get(key,"json"/"number")`；TG webhook 域名支持 `TELEGRAM_WEBHOOK_HOST` 覆盖（见五、一#4⑥⑦） | `telegram_api/index.ts`、`types.d.ts` |
| `4c79a21` | VPS 部署脚本（`server/vps_deploy.sh`） | — |
| `bd92b59`→`071e59e` | 部署脚本密钥改为环境变量读取（Push Protection 要求）；CI yaml 修复；runtime 层补 better-sqlite3 编译工具 | `Dockerfile`、`.github/` |
| `affcc9e` / `bf04b9c` | Docker 打包层只装 esbuild（`--ignore-scripts`），避免打包阶段编译 better-sqlite3 | `Dockerfile` |
| `bfbbf31` | **本次功能**：启用 WASM 解析（`common.ts` 取消注释 + 依赖 + `.wasm` binary loader）；配置启用 webhook/gzip；新增 `addy_api.ts`（Bitwarden/Addy.io 兼容）；`worker.ts` 注册路由 + `/api/v1/` 中间件放行；`types.d.ts` 加 `ADDY_AUTH_TOKEN` | `common.ts`、`worker.ts`、`types.d.ts` |
| `4e1aab0` | 本核查文档 | — |
| `796addf` | 文档补全（KV 细节 + 完整历史） | — |
| 本次 | **发件 + 邮件客户端端口**：`sendmail.ts`（SEND_MAIL→MX 路由直投器：`dns.resolveMx` 选 MX + nodemailer 纯客户端 25 端口投递 + DKIM 签名；配置 SEND_RELAY_* 可切 smarthost 中继。注：nodemailer ≥6 已移除内建 `direct:true`，故自实现 MX 路由）、`submit.ts`（465 隐式 SSL 提交，AUTH=地址+地址密码，from 锁定）、`imap.ts`（993 隐式 SSL 只读 IMAP，raw_blob 自动解压）；`build.mjs` 的 EmailMessage stub 携带 from/to/raw；DKIM DNS：`smtp._domainkey.266666.best` TXT（DMARC 沿用上游默认 `_dmarc` p=none + Cloudflare 报告地址）；新增依赖 nodemailer（锁定 ^6，v7+ 直投行为变化） | 无上游文件改动（纯新增组件 + `build.mjs`/`entry.ts`/`config.example.json`） |

## 七、已知与上游行为不一致的点（有意为之）

- `SEND_MAIL` 绑定由 `sendmail.ts` 实现：直投模式依赖 **VPS 出站 25 端口放行**（DartNode 申请中；未放行时发件接口会报 "direct delivery failed ... configure SEND_RELAY_HOST"，配置任意 smarthost 即可绕开）；`HELLO_NAME` 可自定义 EHLO 名（默认 `smtp.<第一个域名>`）
- `RATE_LIMITER` 为进程内固定窗口（重启清零）
- `KV` 存 SQLite 表 `kv_storage`（见第五节）
- 打包时 `cloudflare:sockets` / `cloudflare:email` 用 stub 顶替（EmailMessage stub 携带 from/to/raw，发件路径可用）
- SMTP 收信直接写入 `email()` 处理器，多收件人会各存一份（与 CF Email Routing 行为一致）
- 465=隐式 SSL（`secure:true`，不提供 STARTTLS）；外发中继 587 走标准 STARTTLS 机会升级
