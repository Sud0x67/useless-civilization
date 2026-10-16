# 部署与运维

本指南使用一台支持 systemd 的 Linux 服务器、Node.js 24.15+、Caddy 和本地 SQLite。仅运行一个应用进程，无需另外购买云数据库。

```text
浏览器 → Caddy / HTTPS → Node.js 127.0.0.1:4180 → SQLite + 模型 API
```

## 1. 安装与构建

安装系统级 Node.js 24.15+ 和 [Caddy](https://caddyserver.com/docs/install)。服务通过 `/usr/local/bin:/usr/bin:/bin` 查找 Node，并启用了 `ProtectHome`，请不要依赖家目录中的 nvm 安装。

将仓库放在 `/opt/useless-civilization`，以下命令假设你有 sudo 权限：

```sh
sudo git clone https://github.com/Sud0x67/useless-civilization.git /opt/useless-civilization
cd /opt/useless-civilization
sudo npm ci
sudo npm run build
sudo useradd --system --home /opt/useless-civilization --shell /usr/sbin/nologin civilization
sudo install -m 600 -o root -g root .env.example /etc/useless-civilization.env
sudoedit /etc/useless-civilization.env
```

已有服务用户或配置时，不要重复创建或覆盖。应用文件应由维护账号管理，并对 `civilization` 用户可读；数据库不放进静态资源目录。

## 2. 生产配置

在 `/etc/useless-civilization.env` 填写自己的模型配置和随机管理员令牌，并确认这些值：

```dotenv
LLM_BASE_URL=https://your-provider.example/v1
LLM_MODEL=your-model
LLM_WIRE_API=responses
LLM_API_KEY=your-api-key
ADMIN_TOKEN=your-random-admin-token
HOST=127.0.0.1
PORT=4180
DATABASE_PATH=/var/lib/useless-civilization/town.sqlite
PUBLIC_ORIGIN=https://your-domain.example
TRUST_PROXY=1
MODEL_CALLS_PER_MINUTE=6
MODEL_CALLS_PER_DAY=500
TOWN_INTERVAL_MS=20000
```

模型服务需支持项目使用的请求格式，详见主 README。不要在生产环境启用 `LOCAL_PREVIEW`。注意把 `.env.example` 中的相对 `DATABASE_PATH` 改成上面的绝对路径；否则会覆盖 systemd 模板提供的路径。

环境文件仅 root 可读，systemd 会在启动服务前加载它；应用本身以无登录权限的 `civilization` 用户运行。`StateDirectory` 自动创建数据目录，目录权限为 700，数据库文件为 600。

## 3. 启动服务与 HTTPS

```sh
cd /opt/useless-civilization
sudo cp deploy/useless-civilization.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now useless-civilization
curl -fsS http://127.0.0.1:4180/api/status
```

把自己的域名 A 记录指向服务器公网 IP。Caddy 模板使用 `useless-llm.com`，请先替换成自己的域名，再安装配置。已有 Caddy 站点时合并站点块，避免覆盖其他网站。

```sh
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

开放 80、443 和管理所需的 SSH 端口，保持 4180 仅监听本机。DNS 和端口可达后，Caddy 会申请、续期证书，并把 HTTP 跳转到 HTTPS。

模板显式覆盖 `X-Real-IP`，仅适用于浏览器直接访问 Caddy 的场景。若额外接入 CDN，需要另行配置可信代理范围和真实客户端 IP，避免所有用户共用一个代理 IP 的额度。

**实时连接不要压缩。** `/api/stream` 在模板中被排除在 `encode` 之外；部分 Caddy 版本会缓冲压缩后的事件流，导致浏览器一直等待第一条状态。SSE 使用默认即时刷新机制，不添加 `flush_interval -1`，以便浏览器关闭时及时取消上游连接。

上线后检查：

- 首页、静态资源和 `/api/status` 正常，HTTP 跳转 HTTPS。
- 两个独立浏览器能收到相同的小镇状态，刷新后保留历史。
- 匿名 Cookie 包含 Secure、HttpOnly，未向浏览器返回模型密钥。
- 关闭浏览器后在线连接释放，无访客观看时不再自动推进。

## 4. 管理命令

下面的命令在服务器项目目录中执行，root 读取生产环境文件；令牌不会放入 URL 或命令参数：

```sh
cd /opt/useless-civilization
sudo /usr/bin/env node --env-file=/etc/useless-civilization.env server/admin.mjs pause
sudo /usr/bin/env node --env-file=/etc/useless-civilization.env server/admin.mjs resume
sudo /usr/bin/env node --env-file=/etc/useless-civilization.env server/admin.mjs reset
sudo /usr/bin/env node --env-file=/etc/useless-civilization.env server/admin.mjs import replay.json
```

`pause` 停止开始新操作；已经开始的模型请求可能仍会完成。`reset` 和 `import` 会取消未完成命令并暂停全镇，操作前先备份，之后用 `resume` 恢复。导入只取回放最后一个世界，不修改累计额度。

## 5. 每日备份

```sh
sudo install -d -o civilization -g civilization -m 700 /var/backups/useless-civilization
sudo cp deploy/useless-civilization-backup.service deploy/useless-civilization-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now useless-civilization-backup.timer
sudo systemctl start useless-civilization-backup.service
sudo systemctl list-timers useless-civilization-backup.timer
```

定时器每天 UTC 03:30 后随机 15 分钟内执行，即北京时间 11:30–11:45；错过执行窗口后会补跑。脚本通过 SQLite backup API 在线备份，运行 `PRAGMA integrity_check`，校验通过后保留最近 7 个日期的文件：

```text
/var/backups/useless-civilization/town-YYYY-MM-DD.sqlite
```

同一天再次执行会更新当天备份。备份包含世界、公开聊天、匿名签名盐和额度记录，不包含环境文件中的模型密钥或管理员令牌。请另行保存受控的异机副本；同服务器备份不能抵御整机或磁盘丢失。

手动创建额外备份：

```sh
cd /opt/useless-civilization
sudo env DATABASE_PATH=/var/lib/useless-civilization/town.sqlite /usr/bin/env node server/backup.mjs /var/backups/useless-civilization/manual.sqlite
```

不要只复制运行中的 `.sqlite` 主文件，因为最新数据可能还在 WAL 中。

## 6. 恢复与迁移

1. 暂停全镇，等当前请求完成，再生成一致性备份；迁移期间停止旧实例写入。
2. 停止目标应用服务，把备份放到 `/var/lib/useless-civilization/town.sqlite`；移走旧的同名 `-wal`、`-shm` 文件。
3. 设置文件所有者为 `civilization:civilization`、权限为 600，数据目录为 700。
4. 启动目标服务，核对世界、聊天和额度，再恢复全镇运行。
5. 确认迁移成功后停用旧实例；保持只有一个实例写入。

恢复旧备份会回退额度记录，需同时核对供应商用量。备份不包含 `.env`，新服务器还需要安全传输生产配置。

## 7. 更新和排查

```sh
cd /opt/useless-civilization
sudo git pull --ff-only
sudo npm ci
sudo npm run build
sudo systemctl restart useless-civilization
sudo systemctl status useless-civilization caddy
sudo journalctl -u useless-civilization -n 100 --no-pager
sudo journalctl -u useless-civilization-backup.service -n 30 --no-pager
```

更新时保留生产环境文件、数据库和备份目录。更改 Caddy 后先校验再 reload；更改应用服务器代码或模型配置后需要重启应用服务。GitHub Actions 只执行检查，不自动部署。
