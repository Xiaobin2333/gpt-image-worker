# GPT Image Worker

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-TypeScript-E36002)](https://hono.dev/)

GPT 兼容图像生成面板的 Cloudflare Workers 重写版。  
A Cloudflare Workers rewrite of a GPT-compatible image generation panel.

中文 | [English](#english)

> 本项目从 [Z1rconium/gpt-image-linux](https://github.com/Z1rconium/gpt-image-linux)（FastAPI + Docker 版本）移植到 Cloudflare Workers，并在原项目功能基础上扩展了图生图、双语界面、动态访问保护、按浏览器私密图库、SSE 流式生成、批量删除、运行时参数管理等能力。
>
> 感谢原作者 [@Z1rconium](https://github.com/Z1rconium) 的 UI 设计、生成参数模型、Lightbox 与尺寸校正逻辑。本仓库与上游一致采用 [CC BY-NC 4.0](./LICENSE) 许可，**仅限非商业使用**，并保留对上游项目的署名。

---

## 🚀 性能与体验

- **同步 + 异步双轨**：1–3 分钟级生成走 SSE（Server-Sent Events）实时推送 + Cron 兜底，浏览器关闭也能恢复任务
- **并行生成**：`/v1/responses` 路径下 `n>1` 自动并发 3 路；`/v1/images/generations` 单次批量请求；上游若误把 `n` 截成 1 会自动补齐
- **任务去重**：D1 存 `produced_ids`，断网重连不会重复生成已产出的图像
- **预览 / Lightbox 缩放**：滚轮 / 双击 / +−/1:1 / 拖拽 / 触摸捏合 全支持
- **公开图片绕过 Worker**：配置 `R2_PUBLIC_DOMAIN` 后，公开图直接由 R2 自定义域服务，节省 Worker Free 套餐请求数
- **图库批量删除**：管理员悬停图卡左上勾选，胶囊浮条一键批删
- **拖拽 / 粘贴 / 上传 参考图**：三种入口同步生效

## ☁️ Cloudflare Workers Free 优化

针对 100 K Worker 请求 / 1 K KV 写 / 100 K D1 写 / 10 ms CPU 等限制做了系统级削减：

| 项 | 策略 |
|---|---|
| KV 写 | 仅 `SETTINGS` 一项（非热路径），cacheTtl=300 |
| D1 写 | 单图任务跳过 `produced_ids`；多图任务才记录恢复点 |
| 公开图片带宽 | 通过 R2 自定义域名直出，0 Worker 请求 |
| Cron | 每 5 分钟一次仅扫 D1 pending 队列，空载早退 |
| 轮询兜底 | 首次延迟 30 s，间隔 20 s/30 s/45 s，请求量较旧版减半 |
| SSE heartbeat | 25 s → 45 s |

## ✨ 功能

### 生成
- 单文件 SPA 前端，部署在 Workers Assets 上
- 图生图：`/v1/images/generations`、`/v1/images/edits`、`/v1/responses` 三种上游路径都支持
- 参考图：拖拽 / 粘贴 / 上传，最多 16 张、单张可达 50 MB（管理员可调）
- 实时计时器（100 ms 更新）+ 缩略图条切换 n>1 多图

### 安全
- **管理员 vs 访客** 拆分：`ADMIN_KEY` 登录管理员 / `ACCESS_KEY` 站点访问保护
- **Cloudflare Turnstile**：管理员可启用，非管理员每次生成需通过验证（默认关闭）
- **D1 速率限制**：管理员可调每秒/分钟次数（默认关闭，管理员豁免）
- **私密图归属**：基于匿名 cookie + localStorage 双轨，跨设备失败时也能保留
- **HMAC 签名 cookie**：admin/access 使用独立 key
- **文件名校验 + IP 白名单 + IP 限额** 等多重边界

### 管理
- 设置面板分组折叠：上游 API / 访问保护 / 人机验证 / 速率限制 / 运行参数 / 维护
- **运行参数**全部可改且后台保存即生效（无需重新部署）：
  - R2 公开域名
  - Prompt 最大字符（100–20000）
  - 单次 n（1–20，管理员永远 20）
  - 参考图数量（0–16）/ 单张大小（1–50 MB）
  - 生成图最大体积（1–100 MB）
  - `/v1/responses` 模型
  - 访问 / 管理员会话时长（5–10080 分钟）
- 图库管理：管理员可按"默认/全部"切换 scope，多选批删，孤儿 R2 对象一键清理
- 图库一键编辑：把任意一张图作为参考图载入 + 自动回填 prompt / 尺寸 / 质量 / 格式 / 压缩 / 数量 / 模型

### UI
- 中英双语切换，localStorage 持久化，默认中文
- 暗色主题，Tailwind via CDN，无前端构建步骤
- 完整交互提示：超限提示 / Prompt 为空提示 / Captcha 未完成时滚动+闪烁定位

---

## 项目结构

```
src/
  index.ts        Hono 路由 + SSE + Cron
  auth.ts         HMAC cookie / 访问 / 管理员 / IP 白名单
  proxy.ts        上游 API 客户端 + R2 写入 + 并行/串行调度
  storage.ts      D1 jobs/gallery + 孤儿清理
  settings.ts     KV 配置（API + 访问 + Turnstile + RateLimit + Limits）
  validate.ts     /api/generate body 校验（动态阈值）
  ratelimit.ts    D1-backed rate limit
  turnstile.ts    Cloudflare Turnstile 验证
  types.ts        共享类型
static/
  index.html      SPA（i18n 字典 + 全部交互逻辑）
migrations/
  0001_init.sql           jobs / gallery 表
  0002_ratelimit.sql      rate_limits 表
  0003_jobs_produced.sql  jobs.produced_ids 列
wrangler.toml
LICENSE
```

---

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Xiaobin2333/gpt-image-worker)

> ⚠️ 一键部署后仍需要手动执行：
>
> ```bash
> npx wrangler secret put ADMIN_KEY
> npx wrangler d1 migrations apply gpt-image-db --remote
> ```

---

## 手动部署

### 前置条件

- Node.js 18+
- Cloudflare 账号
- 已登录 wrangler：`npx wrangler login`
- 一个 GPT 兼容的图像 API（URL + Key）

### 1. 克隆 + 安装

```bash
git clone https://github.com/Xiaobin2333/gpt-image-worker.git gpt-image-worker
cd gpt-image-worker
npm install
```

### 2. 创建 R2 / KV / D1 资源

```bash
npx wrangler r2 bucket create gpt-image-bucket
npx wrangler kv namespace create SETTINGS
npx wrangler d1 create gpt-image-db
```

把 `kv namespace` 与 `d1 create` 输出的 ID 粘贴到 `wrangler.toml` 中：

```toml
[[kv_namespaces]]
binding = "SETTINGS"
id = "<SETTINGS_KV_ID>"

[[d1_databases]]
binding = "DB"
database_name = "gpt-image-db"
database_id = "<D1_DATABASE_ID>"
```

### 3. 应用 D1 迁移

```bash
npx wrangler d1 migrations apply gpt-image-db --remote
```

会依次执行 `0001_init.sql` / `0002_ratelimit.sql` / `0003_jobs_produced.sql`。

### 4. 设置管理员密钥

```bash
npx wrangler secret put ADMIN_KEY
```

输入一个高强度字符串。它既是登录后台的密码，也是 cookie HMAC 的签名密钥。

> 如果首次部署希望站点出厂就开启访问保护，可同时设置 `ACCESS_KEY`：`npx wrangler secret put ACCESS_KEY`。该值仅在第一次访问时被读入 KV 作为初始访问密钥；之后所有变更都通过后台设置面板进行。

### 5. （可选）绑定 R2 公开域名

在 Cloudflare 控制台 → R2 → 你的 bucket → Settings → Public Access → Connect Custom Domain，绑定一个子域（如 `img.example.com`）。然后把它填入 `wrangler.toml`：

```toml
R2_PUBLIC_DOMAIN = "img.example.com"
```

公开图片将直接由 R2 域名服务，**完全跳过 Worker**，对 Free 套餐请求量帮助最大。

### 6. 本地开发

```bash
npm run dev
# 默认 http://localhost:8787
```

`wrangler dev` 用 miniflare 模拟 R2 / KV / D1。

### 7. 部署

```bash
npm run deploy
```

部署成功后会输出 `https://<name>.<subdomain>.workers.dev`。

### 8. 首次配置

1. 打开站点 → 右上角点击「管理员登录」 → 输入第 4 步设置的 `ADMIN_KEY`
2. 点击齿轮图标 → 设置面板：
   - **上游 API**：填入 Base URL（不含 path）/ Key / 选择 path
   - **访问保护**（可选）：开启后访客需输入访问密钥才能进入
   - **人机验证**（可选）：填 Site Key + Secret Key 即可启用 Turnstile
   - **速率限制**（可选）：每窗口次数
   - **运行参数**：所有上限/默认值的运行时调节
3. 保存。普通访客即可访问 + 生成。

---

## 配置参考

### `wrangler.toml` `[vars]`（部署时种子值）

| 变量 | 默认 | 说明 |
|------|------|------|
| `DEFAULT_API_URL` | 空 | 首次启动预填的 API Base URL |
| `DEFAULT_API_PATH` | `/v1/images/generations` | 默认上游路径 |
| `DEFAULT_RESPONSES_MODEL` | `gpt-5.4` | `/v1/responses` 顶层模型（运行时可覆盖） |
| `ACCESS_KEY_COOKIE_NAME` | `gpt_image_access` | 访问会话 cookie 名 |
| `ACCESS_KEY_SESSION_MINUTES` | `180` | 访问会话有效期（运行时可覆盖） |
| `ADMIN_KEY_COOKIE_NAME` | `gpt_image_admin` | 管理员会话 cookie 名 |
| `ADMIN_KEY_SESSION_MINUTES` | `180` | 管理员会话有效期（运行时可覆盖） |
| `OWNER_COOKIE_NAME` | `gpt_image_owner` | 匿名访客身份 cookie |
| `IP_ALLOWLIST` | 空 | 逗号分隔的 IP/CIDR 白名单 |
| `TRUST_PROXY_HEADERS` | `false` | 是否信任 `X-Forwarded-For` |
| `MAX_FILE_SIZE_MB` | `50` | 单张图最大体积（运行时可覆盖） |
| `R2_PUBLIC_DOMAIN` | 空 | R2 自定义域名（公开图绕过 Worker） |

### Secrets（`wrangler secret put`）

- `ADMIN_KEY`（**必需**）：管理员登录密码 + cookie HMAC 签名密钥
- `ACCESS_KEY`（可选）：仅作为「访问保护」首次启用时的初始密钥
- `DEFAULT_API_KEY`（可选）：API Key 预填值

---

## 端点

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| `GET`    | `/health`                       | —              | 健康检查 |
| `GET`    | `/api/session`                  | —              | 会话状态 + 运行时 limits + Turnstile site key |
| `POST`   | `/api/access`                   | —              | 用访问密钥解锁 |
| `POST`   | `/api/admin/login`              | —              | `ADMIN_KEY` 登录 |
| `POST`   | `/api/admin/logout`             | —              | 退出管理员 |
| `GET/POST` | `/api/admin/access-lock`      | admin          | 访问保护开关 |
| `GET/POST` | `/api/admin/turnstile`        | admin          | Turnstile 配置 |
| `GET/POST` | `/api/admin/rate-limit`       | admin          | 速率限制配置 |
| `GET/POST` | `/api/admin/limits`           | admin          | 运行参数（n / 参考图 / 文件大小 / 会话…） |
| `POST`   | `/api/admin/cleanup-orphans`    | admin          | 清理 R2 孤儿对象 |
| `POST`   | `/api/admin/gallery/delete`     | admin          | 批量删除图库（最多 100 条/次） |
| `GET/POST` | `/api/settings`               | admin          | API URL / Key / Path |
| `POST`   | `/api/generate`                 | —              | 创建生成任务，返回 `job_id` |
| `GET`    | `/api/generate/:id/stream`      | — / owner / admin | SSE 推送生成进度，结束推 `done` |
| `GET`    | `/api/generate/:id`             | — / owner / admin | 同步轮询任务状态 |
| `GET`    | `/api/gallery`                  | —              | 公开 + 本浏览器私密；admin 加 `?scope=all` 看全部 |
| `DELETE` | `/api/gallery/:id`              | admin          | 删除单条 |
| `GET`    | `/api/image/:filename`          | — / owner / admin | 访问图片（私密图仅创建者本浏览器或 admin 可见） |
| `GET`    | `/api/download/:filename`       | — / owner / admin | 下载图片 |

---

## 私密图归属说明

无账号体系。当访客生成图像时：

- 后端为该浏览器签发匿名 cookie `gpt_image_owner`（UUID）+ localStorage 镜像
- 私密图（`is_public=false`）记录其 `owner_id`
- 私密图：仅同浏览器（cookie 或 header `X-Owner-Id` 匹配）或管理员可见
- 清除浏览器存储或更换设备会失去对该图的访问权

---

## 与原项目的差异

| 维度 | 原项目（FastAPI） | 本项目（Workers） |
|------|------------------|------------------|
| 运行环境 | 本机 / Docker | Cloudflare Workers |
| 图像存储 | 本地文件系统 | R2 |
| 任务/图库元数据 | `data/gallery.json` + 进程内 dict | D1 `jobs` / `gallery` |
| 生成流程 | `asyncio.create_task` + 轮询 | SSE 主路径 + Cron 兜底 |
| 鉴权角色 | 单一 `ACCESS_KEY` | `ADMIN_KEY` + 可选 `ACCESS_KEY` 拆分 |
| 访问保护开关 | 部署级 env | KV，运行时切换 |
| 图生图 | — | 三种上游路径均支持 + 拖拽/粘贴 |
| 私密图 | — | 按浏览器 owner cookie + localStorage |
| 图库一键编辑 | — | 参考图 + 全参数回填 |
| 批量删除 | — | 多选浮条，最多 100 条/次 |
| Turnstile / 速率限制 | — | 管理员可调，默认关闭 |
| i18n | — | 中 / 英切换 |
| 前端构建 | 无 | 无 |

---

## 致谢

- 原项目：[Z1rconium/gpt-image-linux](https://github.com/Z1rconium/gpt-image-linux) — UI 设计、生成参数、Lightbox、尺寸校正逻辑
- 路由框架：[Hono](https://hono.dev/)
- UI：Tailwind CSS（CDN）

## 许可

[CC BY-NC 4.0](./LICENSE)

- ✅ 允许复制、修改、再发布、二次创作
- ✅ 必须保留对原作者 [@Z1rconium](https://github.com/Z1rconium) 与本仓库的署名
- ❌ **禁止商业用途**
- 如需商业使用，请先获得原作者与本仓库 contributors 的授权

---

## English

A Cloudflare Workers rewrite of a GPT-compatible image generation panel.

> Ported from [Z1rconium/gpt-image-linux](https://github.com/Z1rconium/gpt-image-linux) (FastAPI + Docker), with extra capabilities: image-to-image, bilingual UI, runtime access lock, per-browser private gallery, SSE streaming, batch delete, runtime parameter admin. Credit to the original author [@Z1rconium](https://github.com/Z1rconium). Released under [CC BY-NC 4.0](./LICENSE) — same as upstream — for **non-commercial use only**.

### 🚀 Performance & UX

- **Hybrid sync/async**: 1–3 minute generations stream over SSE with a Cron fallback; jobs resume after browser reload
- **Parallel `n>1`**: capped 3-way concurrency on `/v1/responses`; batched single call on `/v1/images/generations`; auto top-up if upstream silently caps `n`
- **Resume-safe**: `produced_ids` in D1 prevents duplicate generation after reconnect
- **Preview/Lightbox zoom**: wheel / double-click / +−/1:1 / drag / pinch
- **Public images bypass the Worker** when `R2_PUBLIC_DOMAIN` is set
- **Batch delete** for admins: hover top-left checkmark + capsule action bar
- **Drag / paste / upload** reference images

### ☁️ Cloudflare Workers Free optimizations

| Item | Strategy |
|---|---|
| KV writes | only `SETTINGS`, cached 300 s |
| D1 writes | skip `produced_ids` for n=1; record only on n>1 |
| Public image bandwidth | served via R2 custom domain — zero Worker calls |
| Cron | every 5 min, scans D1 pending queue, early-return when idle |
| Polling fallback | first poll 30 s, intervals 20/30/45 s — ~50% fewer requests |
| SSE heartbeat | 25 s → 45 s |

### ✨ Features

- **Generation**: single-file SPA, image-to-image on three upstream paths, drag/paste/upload references, real-time elapsed timer, n>1 thumbnail strip
- **Security**: admin vs visitor split, Cloudflare Turnstile (admin-toggleable), D1 rate limit, private images per-browser via signed cookie + localStorage, IP allowlist
- **Admin**: collapsible settings (Upstream API / Access Lock / Turnstile / Rate Limit / Runtime Params / Maintenance); every runtime parameter editable without redeploy
- **Gallery**: scope toggle, multi-select batch delete (≤100 per request), one-click "Edit" with full param prefill, orphan R2 cleanup
- **UI**: zh/en with localStorage, dark theme, Tailwind via CDN, no frontend build step

### One-click Deploy

Click the **Deploy to Cloudflare** badge above. After the deploy flow:

```bash
npx wrangler secret put ADMIN_KEY
npx wrangler d1 migrations apply gpt-image-db --remote
```

### Manual Deploy

```bash
git clone https://github.com/Xiaobin2333/gpt-image-worker.git gpt-image-worker
cd gpt-image-worker
npm install

# Resources
npx wrangler r2 bucket create gpt-image-bucket
npx wrangler kv namespace create SETTINGS
npx wrangler d1 create gpt-image-db
# Paste the printed namespace/database IDs into wrangler.toml.

# D1 migrations
npx wrangler d1 migrations apply gpt-image-db --remote

# Admin secret (also used as cookie HMAC key)
npx wrangler secret put ADMIN_KEY

# Optional: R2 custom domain in Cloudflare dashboard, then set R2_PUBLIC_DOMAIN

# Run locally
npm run dev

# Deploy
npm run deploy
```

Then open the printed URL → admin login with `ADMIN_KEY` → fill in API Base URL / Key / Path. Optional: enable access lock, Turnstile, rate limit, or tune runtime parameters from the settings panel.

### Differences from upstream

| Aspect | Upstream (FastAPI) | This project (Workers) |
|--------|-------------------|------------------------|
| Runtime | local / Docker | Cloudflare Workers |
| Image storage | local FS | R2 |
| Job/gallery metadata | JSON + in-memory dict | D1 `jobs` / `gallery` |
| Generation flow | asyncio + polling | SSE + Cron fallback |
| Auth roles | single `ACCESS_KEY` | `ADMIN_KEY` + optional `ACCESS_KEY` (split) |
| Access lock toggle | deploy-time env | KV-backed, runtime |
| Image-to-image | — | three upstream paths + drag/paste/upload |
| Private images | — | per-browser owner cookie + localStorage |
| Edit-from-gallery | — | reference + full param prefill |
| Batch delete | — | multi-select capsule bar (≤100/request) |
| Turnstile / Rate limit | — | admin-toggleable, default off |
| Runtime parameter admin | — | every limit editable without redeploy |
| i18n | — | zh / en |
| Frontend build | none | none |

### Credit & License

- Upstream: [Z1rconium/gpt-image-linux](https://github.com/Z1rconium/gpt-image-linux)
- [Hono](https://hono.dev/), Tailwind CSS
- Released under [CC BY-NC 4.0](./LICENSE) — non-commercial use only; commercial use requires prior permission from both upstream author and this project's contributors
