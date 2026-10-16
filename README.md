# 无用文明 · Useless Civilization

一座漂浮在夜空中的共享小镇，六位性格不同的 AI 居民。居民的行动、对白和公开行动说明来自真实模型，没有脚本对白或失败时的预设回复。

所有访客匿名围观和参与同一座小镇：聊天、事件和居民回应公开；服务器串行执行操作并通过 SSE 实时同步。**一台支持 Node.js 24 的阿里云轻量服务器即可运行，SQLite 随应用保存数据，不需要云数据库。** 当前代码在 `~/code/useless-civilization`，已部署到轻量服务器；公网域名仍等待备案/接入和 DNS 配置，详见 [部署记录](deploy/production.md)。

## 本地运行

需要 Node.js **24.15.0 或更新的 24.x**、npm 和现代浏览器。使用 [Node.js 内置 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)，没有额外数据库服务或原生 npm 数据库依赖。

```sh
cd ~/code/useless-civilization
npm ci
cp .env.example .env # 仅首次；已有文件不要覆盖
# 编辑 .env，填写模型密钥和随机 ADMIN_TOKEN
chmod 600 .env
npm run dev
```

打开 http://127.0.0.1:4180 。本机已有用户提供的 Token Plan 配置，模型默认 `qwen3.8-flash`，Responses API，Bearer 认证，`reasoning.effort=none`、`store=false`。没有自动切换模型。`LLM_WIRE_API=chat` 可兼容支持 `enable_thinking=false` 的 Chat Completions 服务。

```dotenv
LLM_BASE_URL=https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen3.8-flash
LLM_WIRE_API=responses
LLM_API_KEY=填写你的密钥
ADMIN_TOKEN=填写随机管理员令牌
DATABASE_PATH=data/town.sqlite
MODEL_CALLS_PER_MINUTE=6
MODEL_CALLS_PER_DAY=500
TOWN_INTERVAL_MS=20000
HOST=127.0.0.1
PORT=4180
```

可用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成管理员令牌。它与模型密钥分开，只用于管理 API。更改服务器代码或环境变量后需要重启。

## 怎么玩

- 拖动旋转浮岛、滚轮缩放，点击居民查看对话或档案。移动端支持纵向布局；设备不支持 WebGL 时显示轻量地图。
- 投放事件或直接聊天，无需先暂停。Enter 发送、Shift+Enter 换行；中文输入法选词不会误发送。每位居民的草稿独立保存在本页内存；公开消息显示匿名访客编号。
- 人类操作优先于自动决策；已经开始的人类操作按全站 FIFO 队列完成。只能取消自己的等待项。关闭页面不会丢弃已被服务器接受的操作。
- 小镇动态从上往下阅读，最新内容在底部；翻历史时保持阅读位置，并显示未读数。
- 暂停观察、回放、昼夜灯光、镜头和居民选择只影响自己。恢复观察时跳到当前共享世界；刷新后恢复服务器存档，不会新建世界。
- 默认全站每 20 秒尝试一次自动决策，有未完成操作或额度不足时等待。只有存在可见且正在观看实时世界的窗口时才自动推进；无人观看时暂停。个人页面暂停后仍可互动，成功提交会恢复实时观看。
- 管理员可暂停整个小镇、重置或导入世界。访客只可导出回放；页面不提供管理密钥输入框。
- 模型失败时保留已投放事件/人类问题，不生成替代对白；失败者可手动重试或跳过，不阻塞其他访客。自动决策失败时停止自动推进，新的人工互动可恢复，管理员也可 resume。

## 匿名身份与限额

服务器签发带签名的随机身份 Cookie：HttpOnly、SameSite=Lax，HTTPS 站点还会设置 Secure。Cookie 只含匿名标识，不能由客户端随意伪造。它不是实名身份，清 Cookie 可以换身份，因此同时检查来源 IP 与全站额度。

| 层级         | 默认限制                                                             |
| ------------ | -------------------------------------------------------------------- |
| 每位匿名访客 | 每 10 秒一次操作，每小时 20 次，每 UTC 自然日 60 次；最多 2 项未完成 |
| 每个来源 IP  | 滚动一小时 100 次操作                                                |
| 全站操作队列 | 最多 20 项未完成，按接受顺序执行                                     |
| 全站模型调用 | 滚动一分钟 6 次，每 UTC 自然日 500 次，自动推进与聊天/事件共同计数   |
| 在线连接     | 最多 200 个窗口，同一 IP 最多 8 个窗口                               |

额度、命令和调用记录保存在 SQLite，进程重启不会重置。HTTP 回执丢失时使用相同请求编号重试，不会重复排队或扣额；同一编号不能替换内容。失败任务的显式重试计为新操作，保留原来的事件/问题进度。

**模型额度在开始调用供应商前扣除，失败、超时、被中止的自动请求都计入。** 单轮六位居民共用一次请求，输出上限 1,800 tokens，聊天上限 300 tokens。页面显示的 token 用量只包括成功返回并应用的响应，不能作为供应商账单；失败或中断可能也计费。每日调用上限控制请求总数，不是人民币金额保证，供应商侧也应配置预算。

达到模型额度后，不执行新模型请求，已有队列等待额度恢复，仍可看当前世界和历史。UTC 零点恢复每日额度；滑动窗口自动过期。管理员 reset 不清空用量或重置访客额度。共用出口 IP 的用户会共用 IP 限额；匿名访问不能彻底防止分布式刷请求，全站硬上限负责兜底。

## 数据与一致性

- 服务器是世界状态的唯一写入方，浏览器只能提交严格校验的操作，不能上传整份世界覆盖别人。
- SQLite 使用 WAL、事务和同步写盘，保存当前世界、最近 120 个快照、最近 120 条独立聊天、待处理命令、签名随机盐与额度记录。操作记录保留至少 7 天，失败项保留供重试；调用记录保留用于用量统计。
- 事件/问题准备阶段与命令进度在同一事务写入；模型完成后世界、命令状态和用量一起提交。中止或重置前的迟到响应不会写回。
- 重启后未开始的命令继续排队；已开始的命令标记失败，需要手动重试，避免不知情地重复消耗模型额度。可能已收到但尚未落盘的模型回复无法恢复。
- 浏览器没有 localStorage、sessionStorage 或 IndexedDB 世界存档，只使用匿名身份 Cookie。草稿与个人镜头状态仍是页内内存，刷新会丢失。
- 来源 IP 使用服务器随机盐做 HMAC 后存储，不保存原始 IP。服务默认不信任转发头；仅显式开启 `TRUST_PROXY=1` 且直连来自本机时信任反向代理覆盖的 `X-Real-IP`。反向代理本身仍可能记录 IP，请按需要配置其日志。
- 模型密钥和管理员令牌仅在服务器环境，不进入页面、数据库、Git 或回放。世界、记忆、最近动态和输入对话会发送给配置的模型供应商；`store=false` 不是供应商绝不记录的保证。请勿输入私人信息。
- 前端没有外部 CDN 或分析服务。模型输出作为文本显示，不执行代码。所有对话和事件公开，匿名身份不代表私密聊天。

**仅支持单个 Node 进程维护一座小镇。** 不要使用 PM2 cluster、多个应用副本或共享磁盘多进程运行，否则内存队列会分叉。SQLite 文件放在服务器本地磁盘；单机故障时服务不可用，恢复依赖备份。

## 阿里云轻量服务器部署

架构：`浏览器 → HTTPS / Caddy → 本机 Node :4180 → SQLite 本地磁盘 + 模型 API`。Caddy 自动申请证书，数据库无需开放端口。应用包含 Node 后端，GitHub Pages 无法单独承载。

以支持 systemd 的 Linux 为例，先安装 Node.js 24.15+ 和 [Caddy](https://caddyserver.com/docs/install)，把项目复制到 `/opt/useless-civilization`：

```sh
cd /opt/useless-civilization
npm ci
npm run build
sudo useradd --system --home /opt/useless-civilization --shell /usr/sbin/nologin civilization
sudo install -m 600 -o root -g root .env.example /etc/useless-civilization.env
sudoedit /etc/useless-civilization.env
```

服务器配置中填写真实密钥、管理员令牌，并设置：

```dotenv
PUBLIC_ORIGIN=https://useless-llm.com
TRUST_PROXY=1
```

`deploy/useless-civilization.service` 固定数据目录 `/var/lib/useless-civilization/town.sqlite`，由 systemd 创建并授予服务用户。环境文件不要覆盖此路径；`ExecStart` 从 `/usr/local/bin`、`/usr/bin` 或 `/bin` 查找 Node，请确认系统安装的是 Node 24.15+；服务启用了 `ProtectHome`，不要依赖用户家目录中的 nvm 安装。构建文件需可由服务用户读取，数据和密钥不进入静态文件目录。

```sh
sudo cp deploy/useless-civilization.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now useless-civilization
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

如果服务器已有 Caddy 站点，将本项目的站点块合并到配置，不要覆盖其他站点。DNS 将 `useless-llm.com` 的 A 记录指向服务器公网 IP；安全组开放 80、443 和所需 SSH 端口，**不要开放 4180**。Caddy 必须覆盖客户端传入的 `X-Real-IP`，示例已配置；不要把不可信代理放到此信任链中。SSE 已关闭代理缓冲，慢连接超过发送缓冲上限会断开并自动重连。

排查：`systemctl status useless-civilization`、`journalctl -u useless-civilization -n 100`。更新代码后重新 `npm ci && npm run build`，再 `sudo systemctl restart useless-civilization`，保留环境文件和 `/var/lib/useless-civilization`。不要把数据库放到临时目录或在更新时删除。

## 管理和备份

本地管理命令读取 `.env`，凭据不放 URL：

```sh
node --env-file=.env server/admin.mjs pause
node --env-file=.env server/admin.mjs resume
node --env-file=.env server/admin.mjs reset
node --env-file=.env server/admin.mjs import replay.json
node --env-file=.env server/backup.mjs backups/town.sqlite
```

生产环境可使用 `/etc/useless-civilization.env`，例如：

```sh
sudo /usr/bin/env node --env-file=/etc/useless-civilization.env server/admin.mjs pause
```

环境文件默认仅 root 可读，管理脚本由 root 执行。生产备份脚本显式指定 `DATABASE_PATH=/var/lib/useless-civilization/town.sqlite`，因为该路径平时由 systemd 设置，环境文件不一定包含。

```sh
sudo env DATABASE_PATH=/var/lib/useless-civilization/town.sqlite /usr/bin/env node --env-file=/etc/useless-civilization.env server/backup.mjs /var/backups/useless-civilization/town-2026-10-16.sqlite
```

备份脚本使用 SQLite backup API，允许在线一致性备份；不要只复制运行中的 `.sqlite` 主文件而遗漏 WAL。`deploy/useless-civilization-backup.service` 和 `.timer` 提供每日自动备份，保留最近 7 个日期的备份；先创建服务用户可写的 `/var/backups/useless-civilization`（700 权限），安装 unit 并启用 timer。当前服务器已启用。请另行保存异机副本，同服务器备份不能抵御磁盘丢失。备份含公开对话与匿名额度数据，按私有文件保存。

恢复时先停止服务，将备份替换为数据目录中的 `town.sqlite`，同时移走旧的 `town.sqlite-wal` 和 `town.sqlite-shm`，恢复 `civilization` 所有权及 600 权限，再启动服务。恢复旧备份也会回退额度记录，请在维护期间暂停参与并核对用量。

reset/import 会取消未完成命令并暂停全镇，之后用 resume 恢复。导入只恢复回放的最后一个世界，不导入凭据或更改累计限额；reset/import 不可撤回，操作前先备份。

## 模型与世界规则

模型决定行动、地点、对白、公开行动说明和社交意图。所有输出通过 Zod 校验，不请求或展示隐藏思考过程。程序只执行物理后果：需求变化、工作与休息、食物、金币、关系、值班镇长及事件到期。禁止开会时拒绝对应提案，不生成替代对白；夸奖货币期间，市场进食要求向奥托发出夸奖互动。

## 开发与验证

React 19、TypeScript、Vite 8、Three.js、Node.js HTTP/SSE 和内置 SQLite。场景为本地几何体与 SVG。

```sh
npm test
npm run build
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e
npm run format:check
npm start # 先构建
```

旧单人交互回归测试使用 `LOCAL_PREVIEW=1`，此模式仅允许监听本机，默认运行和生产部署都使用共享模式。共享浏览器测试单独启动隔离的真实 HTTP/SSE 后端，模拟模型响应，验证两个独立匿名浏览器共同参与。所有自动化测试均不消耗真实模型额度。

主要文件：

- `server/town.mjs`：共享队列、限额、身份、模型执行、广播和管理。
- `server/store.mjs`：SQLite 表、事务、快照和在线备份。
- `server/app.mjs`：同源 API、SSE 和生产静态文件。
- `server/model.mjs`：模型协议、提示词、超时与校验。
- `src/hooks/useSharedTown.ts`：实时连接、存在状态、幂等提交。
- `src/App.tsx`：观察台、个人回放和交互界面。
- `src/world/engine.ts`：纯函数世界规则。

CI 只运行检查和测试，不部署，也不需要模型密钥。
