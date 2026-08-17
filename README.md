# 🎮 Pella 自动续期

使用 Playwright + GitHub Actions 每天自动续期 Pella 免费服务器。

## ⚙️ 配置步骤

### 1️⃣ Fork 或上传此仓库到 GitHub

### 2️⃣ 添加 Secrets

进入仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**：

| 🔑 Secret 名称 | 📝 格式 | ✅ 必填 |
|---|---|---|
| `PELLA_ACCOUNT` | `email,password` | ✅ |
| `TG_BOT` | `chat_id,bot_token` | ✅ |
| `NODE_LINK` | v2ray 分享链接，如 `vless://` `vmess://` `trojan://` `hysteria2://` `tuic://` `anytls://` `socks5://`，不配置则直连 | 可选 |

### 为什么需要 NODE_LINK（代理）

GitHub Actions 的运行器使用数据中心 IP，Cloudflare Turnstile 不会为机房 IP 渲染验证码，导致续期流程卡在验证码一步。配置 `NODE_LINK` 后，workflow 会自动用 **sing-box** 搭建本地代理（同 Auto-Renew-HidenCloud 项目的方式），浏览器流量从你的节点 IP 出去，验证码才能正常渲染。**请使用注册 Pella 账号时的节点**（确认在 v2rayN 里能正常连接）。

### 3️⃣ 启用 Actions

进入 **Actions** 标签页，点击 **Enable GitHub Actions**。

### 4️⃣ 手动触发测试

**Actions** → **🎮 Pella 自动续期** → **Run workflow**

## 🕐 运行时间

每天 **UTC 01:00**（北京时间 09:00）自动运行。

可在 `.github/workflows/pella_renew.yml` 的 `cron` 表达式中修改。

## 📊 续期结果说明

| 状态 | 说明 |
|---|---|
| ✅ passed | 续期成功，TG 已推送通知 |
| ⚠️ 无可用链接 | 今日已续期或暂不需要续期 |
| ❌ failed | 登录失败或脚本异常，查看 debug-screenshots |
