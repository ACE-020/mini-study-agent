# 部署核对清单：设置页 / 默认账号 / 个人模型 Key

对应提交：`5206ae8`（分支 `codex/wechat-miniprogram-fixes`）
适用版本：本次新增了 `/api/v1/me/profile`、`/me/avatar`、`/me/model*` 与第三个 tab。**旧容器上这些接口是 404**，所以部署前后要按下面逐条核对。

> 全程不需要数据库迁移；新增的 `model.json`、`avatar.img` 都在每个用户自己的目录里，`profile.json` 只做合并写入，旧字段（`openid` 等）原样保留。

---

## 0. 部署前先决定两件事

- [ ] **加密主密钥**：给生产环境单独生成 `WX_SETTINGS_SECRET`，**在用户开始保存个人 Key 之前**设好。
  ```bash
  openssl rand -base64 48
  ```
  留空时会从 `WX_TOKEN_SECRET` 派生，功能可用；但以后**轮换 `WX_TOKEN_SECRET` 会连带让已保存的个人 Key 解不开**（用户会看到“个人 API Key 无法读取，请重新保存”，不会静默失败）。设了 `WX_SETTINGS_SECRET` 后也**不要再改**。
- [ ] **确认发布内容**：镜像基于本分支 `5206ae8` 构建。`requirements-server.txt` 已含 `cryptography>=42,<47`，旧镜像没有它 → 保存 Key 会返回 503“服务端还没有安装加密组件”。

---

## 1. 构建（二选一）

**云托管（路线 B）**
- [ ] 用仓库 `Dockerfile` 重新构建并发布一个新版本（控制台「版本管理 → 新建版本」，或你的 CI）。
- [ ] 新版本的环境变量按下表补齐（新增的只有可选 `WX_SETTINGS_SECRET`）。
- [ ] 端口保持平台注入的 `$PORT`（容器内 80），**只开 1 个 worker**（`deploy/start.sh` 已处理；任务表在进程内存）。

**自建（路线 A）**
- [ ] `git pull` 到 `5206ae8`，然后在服务器上：
  ```bash
  docker compose build
  docker compose up -d
  # 或不用 Docker：pip install -r requirements-server.txt && systemctl restart study-agent-wx
  ```
- [ ] `/data` 仍挂载持久卷（每个微信用户一个子目录，删容器不能删数据）。

---

## 2. 环境变量核对

| 变量 | 必须 | 说明 |
| --- | --- | --- |
| `WX_APPID` / `WX_SECRET` | 是 | 登录与内容安全 |
| `WX_TOKEN_SECRET` | 是 | 会话签名；轮换=所有用户重新登录（并且会影响未单独设置 settings secret 时的个人 Key） |
| `WX_SETTINGS_SECRET` | 建议 | 个人 Key 加密主密钥；生成后固定不变 |
| `LLM_API_KEY` / `LLM_MODEL` | 建议 | 管理员共享模型；**只配它也能用**（用户不填个人 Key 时走它） |
| `OCR_API_KEY` / `OCR_MODEL` | 按需 | 图片识别；只配 OCR 的老部署带图仍可用 |
| `WX_TRUST_CLOUD_HEADER=1` | 云托管 | 信任平台注入的 `X-WX-OPENID` |
| `WX_TRUST_CLOUD_SOURCE` | 云托管建议 | 如 `wx_client`，收紧来源 |
| `WX_DEV_LOGIN` | 否 | **生产必须为 0/未设置** |
| `WX_CONTENT_CHECK` | 建议 1 | 昵称等用户自填内容也走内容安全 |

- [ ] 生产环境 `WX_DEV_LOGIN` 已关闭。
- [ ] 公网访问已关闭（云托管）；`/data` 是文件存储（CFS），不是容器临时盘。
- [ ] 最小/最大实例数都是 1（否则轮询会打到别的实例）。

---

## 3. 部署后 60 秒验证

把 `$BASE` 换成分发地址（云托管可用控制台域名；自建用 HTTPS 域名）：

```bash
curl -sS $BASE/healthz
# 期望：{"ok":true,...}

curl -sS -X POST $BASE/api/v1/auth/login \
     -H 'Content-Type: application/json' -d '{"code":"<一次性 code>"}'
# 真机 code 只能换一次；本地验证可用 WX_DEV_LOGIN=1 + "dev:xx"
```

拿到 token 后（`$TOKEN`）：

```bash
curl -sS $BASE/api/v1/status -H "Authorization: Bearer $TOKEN"
# 期望 ok:true，并出现 key_source（user/server）、ocr_configured 字段

curl -sS -o /dev/null -w '%{http_code}\n' $BASE/api/v1/me/profile -H "Authorization: Bearer $TOKEN"
# 期望 200 —— 这是“新版本真的上线了”的判定；仍是 404 说明容器还是旧版本
```

- [ ] `/api/v1/me/profile` 返回 200（不是 404“接口不存在”）。
- [ ] `/api/v1/status` 里能看到 `key_source`。
- [ ] 响应里搜不到任何 Key 原文：
  ```bash
  curl -sS $BASE/api/v1/me/model -H "Authorization: Bearer $TOKEN" | grep -i 'sk-' || echo "no key leaked"
  ```

> **不要**在命令行里粘贴真实 API Key（会进 shell 历史/终端日志）。个人 Key 的保存与试连请在小程序「设置」里点按钮完成。

---

## 4. 小程序端验收（真机，正式版或体验版）

- [ ] 首次进「设置」：不需要填手机号/密码/头像，直接显示圆形头像 + 稳定默认昵称（形如 `学习者xxxx`）。
- [ ] 点圆形头像 → 选微信头像 → 自动保存并显示新头像（没有额外“保存头像”按钮）。
- [ ] 点昵称 → 选微信推荐昵称或手输 → 离开输入框自动保存；清空不会被保存。
- [ ] 不设置任何资料，直接回「整理」聊天：正常可用（走管理员共享模型）。
- [ ] 在「设置」填个人 Key + 模型名 →「保存并使用」→「测试连接」显示连接正常。
- [ ] 回「整理」发一条消息 → 成功；服务端日志里对应请求使用的是个人模型（可临时在 `/status` 看 `key_source: "user"`）。
- [ ] 「清除个人 Key」→ 再发消息仍可用，`/status` 回到 `key_source: "server"`。
- [ ] 没有 Key 且没有共享 Key 时：整理页出现「还差一步：配置模型 API Key」横幅，点「去设置」能进入设置页，草稿保留。
- [ ] 图片消息仍走管理员 OCR 配置（只配了 `OCR_API_KEY` 的部署，带图也能提交）。
- [ ] 「设置 → 删除我的全部数据」：二次确认后，笔记/错题/做题记录/头像/个人 Key 都清掉，记录页归零。

---

## 5. 安全与日志抽查

- [ ] 任意接口响应、`docker logs`、访问日志里都搜不到 `sk-` 开头的真实 Key。
- [ ] 小程序本地缓存（开发者工具 Storage）里没有 API Key。
- [ ] `PUT /api/v1/me/profile` 提交超长/空白昵称被 400 拦截；`POST /api/v1/me/model` 提交 `base_url` 被 400 拦截。
- [ ] 上传非图片字节作为头像被 400 拦截。
- [ ] 两个微信号：A 保存的个人 Key 在 B 的账号下 `key_saved=false`，聊天不会用到 A 的 Key。
- [ ] 删除进行中（保存设置/对话未结束时）再删会返回 409，稍后重试成功。

---

## 6. 回滚与故障对照

**回滚**：把云托管版本切回旧版本（或 `docker compose` 用旧镜像）即可。旧代码不读 `model.json`、只读 `profile.json` 的 `openid`，**新增文件不会导致旧版本异常**；个人 Key 保留在原目录，重新部署新版本后仍可用（同一 `WX_SETTINGS_SECRET`）。

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 设置页提示“服务端还是旧版本，缺少账号与设置接口” | 容器还是旧镜像 | 按第 1 步重新发布，再点「重试」 |
| 保存 Key 返回 503“服务端还没有安装加密组件” | 镜像没装 `cryptography` | 用本分支 `requirements-server.txt` 重建镜像 |
| “个人 API Key 无法读取，请重新保存” | `WX_SETTINGS_SECRET` 或 `WX_TOKEN_SECRET` 变过 / `model.json` 损坏 | 让用户在设置页重新保存；或清除个人 Key 回共享模型 |
| 部署后 `/data` 写入报错 | 容器用户与卷权限不匹配 | 以 root 运行容器（`Dockerfile` 现有做法），或修正卷权限 |
| 云托管上 401 且日志提示来源被拒 | `WX_TRUST_CLOUD_SOURCE` 配错 | 改成 `wx_client` 或留空 |
| 图片消息提示“需要管理员配置 OCR” | 未配 `OCR_API_KEY` 且主 Key 为空 | 配 `OCR_API_KEY` 或 `LLM_API_KEY` |

---

## 7. 本次不包含（不要误验）

- 记录页对比、LaTeX/公式渲染、`markdown.js`、网页版交互 —— 后续单独任务。
- 「助手规则」不迁移到小程序。
- 小程序端仍不支持作答照片 OCR（复习只能文字作答）。
