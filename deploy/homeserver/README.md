# LibreTV 正式站：家用伺服器（homeserver）部署

> 这个目录是**伺服器 `/opt/libretv` 上实际在用的部署文件的副本**（2026-11-14 从伺服器拷下）。
> 秘密（密码、token、API key）**不在仓库里**，只在伺服器 `/opt/libretv/.env`（权限 600），变量名见 `.env.example`。
> 改了伺服器上的部署文件，请同步更新这里；改了这里，也要拷回伺服器才会生效。

## 1. 一眼看懂

| 项目 | 内容 |
|---|---|
| 正式网址 | **https://qingran-libretv.duckdns.org** |
| 备份网址 | https://libre-tv-dusky-delta.vercel.app （Vercel，推 `main` 自动部署；设定档存在它自己的 Upstash，和家里**不同步**） |
| 机器 | 旧 ASUS VivoBook X540UP 改的伺服器：i5-7200U（2 核 4 线程）、12 GB、256 GB SSD、2.4G Wi-Fi（约 72 Mbps）、电池已坏 |
| 系统 | Debian 13 (trixie)，无桌面 |
| 登录 | 家里内网 `ssh qingran@192.168.31.76`；外面用 Tailscale `100.95.85.48`。`qingran` 有免密码 sudo，在 `docker` 组 |
| 部署目录 | `/opt/libretv`（Docker Compose：`libretv` + `libretv-caddy`） |
| 代码 | `/opt/libretv/src` = GitHub `csh0503/LibreTV` 的 `main`，**在伺服器上自己 build**，推送后**不会**自动更新 |
| 设定档数据 | `/opt/libretv/data/`（挂到容器 `/app/.data`，`syncStorage` = `file`） |

## 2. 请求怎么走

```
浏览器 ──HTTPS 443──> 小米路由器（端口转发 TCP 443 → 192.168.31.76:443）
        ──> libretv-caddy（Caddy 2.11.6 + DuckDNS 模块，证书走 DNS 验证，80 端口不用开）
        ──> libretv:8080（Next.js，image libretv-local:main）
```

- 同一个 Caddy 也代理伺服器上其他服务（CUHK VPN 网页、OpenMausBot），见 `Caddyfile`。那些服务的代码不在这个仓库。
- `http://192.168.31.76:8080` 只限内网、没有 HTTPS，**设定档功能在这里会坏**（浏览器在非安全来源下没有 `crypto.randomUUID` / `crypto.subtle`），只用来排错。

## 3. 目录里的文件

| 文件 | 在伺服器上的位置 | 作用 |
|---|---|---|
| `docker-compose.yml` | `/opt/libretv/docker-compose.yml` | 两个容器 |
| `Caddyfile` | `/opt/libretv/Caddyfile` | HTTPS 与反向代理 |
| `caddy/Dockerfile` | `/opt/libretv/caddy/Dockerfile` | 编 Caddy + `caddy-dns/duckdns` |
| `.env.example` | `/opt/libretv/.env`（真的那份不进仓库） | 变量名说明 |
| `default-sources.json` | 写在 `.env` 的 `DEFAULT_SOURCES`（压成一行） | 26 个预设点播源（2026-11-09 删掉了 8 个成人源） |
| `scripts/duckdns-update.sh` | `/opt/libretv/duckdns-update.sh` | 每 5 分钟把 DuckDNS 域名指向家里当前公网 IP |
| `scripts/libretv-duckdns.cron` | `/etc/cron.d/libretv-duckdns` | 上面那个的 cron |
| `scripts/backup-data.sh` | `/opt/libretv/backup-data.sh` | 每日自动备份设定档（保留最近 14 天） |
| `scripts/libretv-backup.cron` | `/etc/cron.d/libretv-backup` | 上面那个的 cron（每天 03:40） |
| `scripts/set-password.sh` 等 `set-*.sh` | `/opt/libretv/` | 隐藏输入改秘密（站点密码、DuckDNS token、TMDB key、VPN 页面密码） |
| `scripts/import-profiles.sh` | `/opt/libretv/` | 一次性：从 Vercel 的 Upstash（只读 token）把设定档搬到本机（2026-11-08 已用过） |

## 4. 常用操作（先 `ssh qingran@192.168.31.76`）

```bash
cd /opt/libretv && docker compose ps            # 状态
docker logs --tail 50 libretv                    # 网站记录
docker logs --tail 50 libretv-caddy              # 证书 / 代理记录
cd /opt/libretv && docker compose restart        # 重启

# 正式站换成 GitHub main 最新版（会换线上版本，先问用户）
cd /opt/libretv/src && git pull && docker build -t libretv-local:main . && cd .. && docker compose up -d

# 改秘密（在用户自己的电脑执行，隐藏输入；不要让用户把秘密贴进对话）
ssh -t qingran@192.168.31.76 /opt/libretv/set-password.sh
ssh -t qingran@192.168.31.76 /opt/libretv/set-tmdb-key.sh
ssh -t qingran@192.168.31.76 /opt/libretv/set-duckdns-token.sh

# 备份设定档
sudo tar czf ~/libretv-data-$(date +%F).tar.gz -C /opt/libretv data
```

## 5. 从零重建（伺服器坏了 / 换机器）

1. 装 Debian 13（无桌面，勾 SSH server），装 Docker（官方 apt 源）。把用户加进 `docker` 组。
2. `sudo mkdir -p /opt/libretv && sudo chown $USER: /opt/libretv`，把本目录的文件按第 3 节放到对应位置；`git clone https://github.com/csh0503/LibreTV.git /opt/libretv/src`。
3. `cd /opt/libretv/src && docker build -t libretv-local:main .`
4. 建 `.env`（`umask 077`）：`PROXY_SECRET=$(openssl rand -hex 32)`；`DEFAULT_SOURCES=` 填 `default-sources.json` 压成一行（`jq -c . default-sources.json`）；`SEARCH_SOURCE_TIMEOUT_MS=5000`；其余用 `set-*.sh` 让用户自己输入。
5. `mkdir -p data && sudo chown 100:101 data`（容器里 `nextjs` 用户是 uid 100），恢复设定档备份到 `data/`。
6. 安装 cron：`sudo install -m 644 scripts/libretv-duckdns.cron /etc/cron.d/libretv-duckdns`、`sudo install -m 644 scripts/libretv-backup.cron /etc/cron.d/libretv-backup`。
7. 路由器：DHCP 静态 IP、端口转发 TCP 443 → 伺服器。`docker compose up -d`，等 Caddy 日志出现 `certificate obtained successfully`。

## 6. 踩过的坑

- **非 HTTPS 下设定档坏掉**：「设定档还没准备好」= 用了 `http://IP:8080`。
- **`.env` 里的 bcrypt 哈希要加单引号**：否则 Docker Compose 把 `$2a$14$...` 当变量展开（日志会出现 `The "xxx" variable is not set`）。
- **容器里 `/app` 是 root 的**：不挂 `./data` 卷时设定档写不进去；挂的目录要给 uid 100。
- **伺服器连自己的公网域名会卡**（路由器不支持 NAT 回环给伺服器自己）；内网其他设备访问域名正常。测试请在别的机器上做。
- **Wi-Fi 卡 RTL8723BE 刷 `pcieport AER` 错误**：内核参数加了 `pcie_aspm=off`，驱动参数 `rtl8723be fwlps=0 ips=0`。
- **搜片慢**：基本是个别片源慢或挂了，不是伺服器网速（实测下行约 36 Mbps、上行约 41 Mbps，多数源 1 秒内回应）。靠 `SEARCH_SOURCE_TIMEOUT_MS` 截断。
- **DuckDNS `qingran-hk`**：有别的设备在更新它（指向另一条 HKT 线路），伺服器不碰它。
- **DuckDNS token 被多处共用**（这里、Vikunja、VPN 页面、OpenMausBot），重新生成会让它们的证书续期全部失败。

## 7. 待办

- [ ] 电视 App（`tv/`，分支 `fix/tv-native-ux` / `fix/tv-webview-compat`，未合并进 `main`）还连着 Vercel，要改成正式站网址并重新打包。
- [ ] Vercel 的 Blob 已经没用（设定档在 Upstash，家里不用 Blob），用户准备在 Vercel 删除 Blob 存储并断开连接。
- [ ] 换电池；改用网线（USB 3.0 千兆网卡，换了网卡要改路由器的静态 IP 和端口转发）。
