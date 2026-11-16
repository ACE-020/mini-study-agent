# 把核心服务接到微信小程序：操作手册

这份文档回答一个问题：**现有的网页版学习整理助手，怎么让微信小程序用起来。**

结论先说：核心（`agent.py` / `tools.py` / `llm.py`）不用改。要补的是它外面那层"外壳"——网页版那层外壳是为"本机、单用户、浏览器、长请求"设计的，小程序要求"公网、多用户、无 Cookie、会超时"。这个仓库已经把外壳写好了，你只需要按下面的步骤部署和配置。

---

## 1. 三条路线，先选一条

| 路线 | 需要什么 | 改动量 | 适合 |
| --- | --- | --- | --- |
| **A. 自建服务器 + 备案域名** | 一台云服务器、已备案域名、HTTPS 证书 | 最小（本仓库的 `wx_api.py` 直接跑） | 已有服务器/域名，或打算长期做 |
| **B. 微信云托管**（CloudBase Run） | 微信云开发环境，按量付费 | 更小（推镜像即可，**不用备案域名、不用配合法域名**） | 想最快让审核通过、不想折腾备案 |
| **C. 云函数重写** | Node.js/Python 云函数 | 大（要拆掉 Flask 与本地文件依赖） | 不推荐，除非只想留一个很轻的接口 |

**建议**：先用 **B** 跑通上线（省掉备案和域名白名单两件事），用户量起来后再迁到 **A**。两条路用的是同一份 `wx_api.py`，切换只改小程序 `config.js` 的三行。

```
微信小程序
   │  ①wx.login → code           ②Bearer token（或云托管注入 openid）
   ▼
wx_api.py（Flask）
   ├─ 鉴权 / 按 openid 分目录 / 202+任务轮询
   ├─ StudyAgent（原核心，未改动）
   │     └─ ModelClient → 模型 API（Key 只在服务端）
   └─ wx-data/users/<openid 摘要>/{notes,mistakes,exercises}.json
```

---

## 2. 网页版和小程序的差距（以及本仓库怎么补的）

| 环节 | 网页版 `web.py` | 小程序需要 | 现在的实现 |
| --- | --- | --- | --- |
| 登录 | 浏览器 Cookie 会话 | 无 Cookie，要自己发令牌 | 路线 A：`wx.login` → `code2session` → HMAC Bearer token；路线 B：信 `X-WX-OPENID` |
| 用户 | 单用户，`data/` 一个目录 | 每人一份数据 | `users/<sha256(openid)[:32]>/`，JSON 格式和网页版一致 |
| 对话 | 同步 POST，最长几分钟 | 小程序单次请求容易超时 | `POST /chat` 返回 202 + `task_id`，客户端轮询 |
| 并发 | 全局一把锁 | 不同用户不能互相排队 | 每个用户一把锁；同一用户同时只跑一轮 |
| 模型 Key | Windows DPAPI 本机加密 | 只能在服务端 | 服务器环境变量，永不下发 |
| 图片 | `multipart` 上传 | `wx.uploadFile`（自建）/ 无 multipart（云托管） | `POST /uploads` 或 `POST /uploads/base64`，1–4 张，存内存待用 |
| 内容安全 | 不需要 | 审核要求 | `WX_CONTENT_CHECK=1` → 官方 `msg_sec_check` |
| 页面 | Jinja 模板 + JS | WXML | `miniprogram/` 两个页面 |

**没做的**：token 级流式输出（现在只有阶段进度）、作答照片的 OCR、PDF 下载、支付。见第 8 节。

---

## 3. 五分钟跑通本地链路（还不需要 AppID）

前置：Python 环境已按 `WEB_GUIDE.md` 建好（`.venv` 存在），并且配了模型 Key。

```powershell
# 1) 起接口服务（脚本里已带 WX_DEV_LOGIN=1，只用于本地）
.\start_wx_api.cmd
# 等价于：.\.venv\Scripts\python.exe wx_api.py --host 0.0.0.0 --port 8766
```

```text
# 2) 用 curl 先确认服务活着
curl http://127.0.0.1:8766/healthz
# 3) 假登录拿令牌
curl -X POST http://127.0.0.1:8766/api/v1/auth/login ^
     -H "Content-Type: application/json" -d "{\"code\":\"dev:me\"}"
```

4) 微信开发者工具 → 导入项目 → 目录选 **`miniprogram/`** → AppID 选"测试号"。
5) 开发者工具「详情 → 本地设置」勾选 **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**。
6) 改 `miniprogram/config.js`：

```js
baseUrl: 'http://192.168.1.23:8766',  // 你电脑的局域网 IP，别写 127.0.0.1
devLogin: true                        // 配合服务端 WX_DEV_LOGIN=1
```

7) 编译预览。手机和电脑连同一个 Wi-Fi，点"预览"扫码即可真机测试。

> 这一步只验证链路（登录、任务轮询、渲染）。真机上 `http://` 局域网地址只在"预览/开发版"可用，正式版必须 HTTPS。
>
> 走路线 B 的话，本地还按上面的方式联调（先用 HTTP 把业务逻辑跑通），云托管的容器在控制台「本地调试」里也能把本地端口映射进 `callContainer`；两条路的业务代码完全一样，最后只改 `config.js` 的三行。

---

## 4. 正式上线

### 4.1 两条路都要先做的

1. **注册小程序**：[mp.weixin.qq.com](https://mp.weixin.qq.com)，选主体（个人 / 企业）并完成认证。云托管的开通也要求主体已认证。
2. **定类目**：教育类目对资质有要求（如"教育信息服务"通常要企业主体）。个人主体可选范围窄，先确认功能能落在哪个类目再投入。
3. **小程序备案**：在微信后台提交，通信管理局审核，通常 1–20 个工作日。**没备案不能发布**。
4. **隐私保护指引**：收集 openid、学习内容（题目 / 笔记 / 错题）、图片，用途写"提供学习整理服务"，并写明会把内容发送给第三方模型服务。
5. 拿 `AppSecret`：「开发管理 → 开发设置」，只填到服务端，不要进小程序代码。

> 只有路线 A 才需要额外做域名 ICP 备案；路线 B 不需要域名，也不需要配 request 合法域名。

### 4.2 路线 B：微信云托管（推荐）

这条路的形状是：**把仓库打成镜像 → 推到腾讯云镜像仓库 → 云托管按镜像跑容器 → 小程序用 `wx.cloud.callContainer` 调它**。调用走微信内部链路，不用备案域名，也不用在后台登记合法域名。

#### 第 1 步：开通环境

「微信公众平台 → 云服务 → 云托管」→ 开通，创建环境（例如 `prod`）。记下**环境 ID**，小程序端要填。

#### 第 2 步：构建并推送镜像

云托管只认镜像或"本地代码上传"。镜像方式最可控，`Dockerfile` 和 `deploy/start.sh` 已经在仓库里，直接构建即可：

```bash
docker build -t study-agent-wx:1 .
```

推送按控制台「镜像仓库」页给的地址操作（每个环境的地址不同）：

```bash
docker tag study-agent-wx:1 <镜像仓库地址>/study-agent:1
docker login <镜像仓库地址>          # 用控制台给的临时口令
docker push <镜像仓库地址>/study-agent:1
```

不想装 Docker，也可以在控制台用「本地代码上传」，它会读仓库根目录的 `Dockerfile` 在云端构建；构建慢一些，但省掉本地环境。

#### 第 3 步：创建服务

- 服务名填 `study-agent`（小程序端 `baseUrl` 要跟它一致）；
- 部署方式选「镜像」，选上一步推的 `study-agent:1`；
- **容器端口填 `80`**（`deploy/start.sh` 默认监听 80，云托管也会注入 `PORT=80`）；
- 健康检查路径填 `/healthz`。

#### 第 4 步：配环境变量

在「服务设置 → 环境变量」里加：

| 变量 | 值 |
| --- | --- |
| `WX_TRUST_CLOUD_HEADER` | `1`（信任平台注入的 `X-WX-OPENID`，这是免 `wx.login` 的关键） |
| `LLM_API_KEY` | 你的模型密钥 |
| `LLM_MODEL` / `LLM_BASE_URL` | 可选，默认 `deepseek-v4-pro` / `https://api.deepseek.com` |
| `OCR_MODEL` / `OCR_API_KEY` | 可选，识图用 |
| `WX_TOKEN_SECRET` | `openssl rand -base64 48` 生成；换掉等于所有会话失效 |
| `WX_API_DATA_DIR` | `/data` |
| `WX_CONTENT_CHECK` | `1`，但它依赖 `WX_APPID` + `WX_SECRET`（要换 `access_token`）；这两个不配，内容安全会静默关闭 |
| `WX_DEV_LOGIN` | **`0`，绝不能是 1** |

`WX_APPID` / `WX_SECRET` 在路线 B 里**不是身份认证必需的**：身份由 `X-WX-OPENID` 提供。但**内容安全必须要它们**，所以建议一并配上。配了之后同一套代码也能走 `wx.login`（以后接 H5 或自建端会用到）。

云托管调用依赖较新的基础库：`app.js` 会检测 `wx.cloud`，`utils/api.js` 会检测 `wx.cloud.callContainer`，低版本微信上会直接提示"请升级微信"，不会白屏。

#### 第 5 步：把持久存储挂到 /data

**这一步不做，用户数据会在每次发布后全部消失。** 容器本身是临时的，`/data` 必须挂到云托管提供的文件存储（CFS）。

「服务设置 → 存储挂载」→ 新建文件存储 → 挂载路径填 `/data`。挂好之后重新部署一次，验证方式见第 7 步。

#### 第 6 步：实例数与访问方式

- **最小实例数 1、最大实例数 1**。原因：任务表在进程内存里，多实例会让"提交任务"和"轮询任务"落到不同实例上，轮询直接 404。缩容到 0 也一样会丢正在跑的任务（数据不会丢，只是这一轮要重发）。
- 规格 0.5 核 / 1G 起步足够（模型调用是出站请求，不占容器算力）。
- **关闭公网访问**（如果控制台提供这个开关）。公网入口虽然没 openid 会被 401，但会白白消耗实例和流量。云托管只允许小程序内调用最安全。

#### 第 7 步：验证

1. 「服务日志」里应看到 `启动 study-agent-wx: port=80 data=/data`，且没有"数据目录不可写"的告警。
2. 小程序端打开首页，"记录"页数字为 0、能发一轮对话，说明通了。
3. **持久化验证**：发一轮对话让助手存一条笔记 → 控制台「重新部署」→ 再看记录页，笔记还在，说明 CFS 挂对了。
4. 在容器「登录实例」里 `ls /data/users`，能看到按摘要命名的目录。

#### 云托管的三个代价

1. **要常驻 1 个实例**才能保证任务不丢，等于有基础费用（按控制台计费页的价格算，不要按"请求数"估）。
2. **请求体不宜过大**：图片走 `POST /api/v1/uploads/base64`，小程序端会先 `wx.compressImage` 压到 70 质量再传，单张上限 4 MB。不要指望传扫描版 PDF。
3. **冷启动**：实例重启后第一轮对话会慢几秒（要重新加载 Python 和依赖）。

### 4.3 路线 A：自建服务器（备选）

最低配置：1 核 2G、40G 盘、Ubuntu 22.04。

```bash
git clone <你的仓库> /opt/study-agent && cd /opt/study-agent
cp deploy/env.example deploy/.env      # 填 4.1 与 4.2 第 4 步的变量，再加 WX_APPID / WX_SECRET
docker compose up -d

# Nginx + 证书
sudo certbot --nginx -d study.example.com
sudo cp deploy/nginx.conf /etc/nginx/conf.d/study-agent.conf   # 改域名和证书路径
sudo nginx -t && sudo systemctl reload nginx
```

要点：

- 只开 **80 / 443**；`8766` 只监听 `127.0.0.1`；
- 证书链要完整，TLS 1.2 以上（`deploy/nginx.conf` 已配好）；
- 微信要求 **HTTPS + 443 + 已备案域名**，不能是 IP；
- 后台「开发管理 → 开发设置 → request 合法域名」填 `https://study.example.com`（不能带端口和路径，一个月修改次数有限）。

不用 Docker 的话，用 `deploy/study-agent-wx.service`（systemd）+ 虚拟环境，二选一。

### 4.4 小程序端配置（两条路只差三行）

先把 `miniprogram/project.config.json` 的 `"appid": "touristappid"` 换成真实 AppID，`"urlCheck"` 改成 `true`。

**路线 B（云托管）** —— 改 `miniprogram/config.js`：

```js
module.exports = {
  baseUrl: 'study-agent',   // 云托管服务名，必须和创建服务时填的一致
  apiPrefix: '/api/v1',
  useCloudContainer: true,
  cloudEnv: 'prod',         // 云托管环境 ID
  cloudAuth: true,          // 不调 wx.login，身份由 X-WX-OPENID 提供
  devLogin: false
};
```

**路线 A（自建）**：

```js
baseUrl: 'https://study.example.com',
useCloudContainer: false,
devLogin: false
```

云托管模式下 `app.js` 会先 `wx.cloud.init({env})`，然后所有请求走 `wx.cloud.callContainer`；`utils/api.js` 已经把这个分支写好了，页面代码不用改。

### 4.5 提审

- **体验版**先真机跑通：进首页、发一轮对话、看记录页、杀掉小程序再进来。
- 版本描述写清功能；截图不要出现"题库""考试"等可能触发类目复核的字眼，除非类目允许。
- 生成式 AI：审核可能要求说明模型来源与备案情况。国内合规的大模型（DeepSeek、通义、豆包等）已完成相应备案；隐私政策里写明"会把内容发送给第三方模型服务"。如果做的是面向公众的 AI 生成功能，按《生成式人工智能服务管理暂行办法》可能还需要算法/大模型备案，**按当前监管口径单独确认，别等提审才发现**。
- 常见被拒：类目不符、隐私政策与实际收集不一致、诱导分享、AI 生成内容没有标识。

---

## 5. 上线前必须补的六件事

| # | 事项 | 现在的情况 | 要做什么 |
| --- | --- | --- | --- |
| 1 | 用户数据删除 | 已实现 | `POST /api/v1/account/delete`（要 `{"confirm":true}`），小程序「记录」页底部有入口；可选加 30 天冷静期或"先导出再删" |
| 2 | 备份 | 未做 | 云托管：CFS 上定时打包到对象存储；自建：定时 `tar` 到对象存储。JSON 是原子替换写，单文件损坏风险低，但盘会坏 |
| 3 | 限流 | 只做了"同一用户单任务" | 网关层按 IP / openid 限速，防刷模型费用 |
| 4 | 日志脱敏 | 已做（任务只记 id 与异常类型） | 别把 access log 里的 query 打成明文；模型密钥永不入日志 |
| 5 | 内容安全 | 已接微信接口，默认关 | 上线务必 `WX_CONTENT_CHECK=1`，并考虑对**模型输出**也抽样检测 |
| 6 | 未成年人 | 未处理 | 教育类小程序若面向 K12，审核会看未成年人保护措施（时长、内容、家长同意） |

---

## 6. 限制与扩容路线

**为什么只开 1 个 worker？**
任务表在进程内存里（`TaskStore`），轮询请求必须打到同一个进程。所以 `gunicorn --workers 1 --threads 16`。

- 1 进程 16 线程，够 **几十到一两百** 个日活；
- 一轮对话最长约 4 分钟（模型 6 轮 + 重试），并发上限受模型 API 的 QPS 限制，通常先撞模型限流而不是服务器；
- 云托管上这条规则变成"**最小实例 1、最大实例 1**"：多开实例会让轮询打到别的实例，缩容到 0 会丢掉正在跑的任务（数据不丢，只是这一轮要重发）；
- 真要扩容：把 `TaskStore` 换成 Redis（接口只有 `start/get/by_request/running/finish` 五个方法），就能开多 worker、多实例；或者把"跑 agent"拆成独立队列进程。

**其它已知边界**

- 单张图片 8 MB、整批 512 MB、文本 8 万字；云托管的 base64 通道单张限 4 MB、整包 20 MB；
- 前端轮询 4 分钟超时（`utils/api.js` 的 `pollTask`），超时不会中断服务端任务；
- 服务重启会丢"正在处理"的轮询句柄，但**已保存的笔记、错题不会丢**（写盘是原子替换）。

---

## 7. 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 存活检查（不需要令牌） |
| POST | `/api/v1/auth/login` | `{code}` → `{token, expires_at}` |
| GET | `/api/v1/status` | 是否配好模型、题库规模 |
| POST | `/api/v1/uploads` | `multipart` 字段 `files`，1–4 张，返回 `image_ids`（路线 A） |
| POST | `/api/v1/uploads/base64` | `{images:[{data}]}`，1–4 张、单张 4 MB（云托管用，`callContainer` 不能发 multipart） |
| POST | `/api/v1/chat` | `{message, view, request_id?, image_ids?}` → 202 `{task_id}` |
| GET | `/api/v1/tasks/<id>` | `status`: `running` / `done` / `error` / `cancelled` |
| POST | `/api/v1/tasks/<id>/cancel` | 停止这一轮 |
| POST | `/api/v1/conversation/reset` | 清空当前对话上下文（不动已存记录） |
| POST | `/api/v1/account/delete` | `{confirm:true}` → 删除该用户全部数据，不可恢复 |
| GET | `/api/v1/notes` · `/notes/<id>` | 笔记列表 / 单篇全文 |
| GET | `/api/v1/mistakes` | 错题列表 |
| GET | `/api/v1/review/catalog` · `/review/progress` | 复习范围树 / 进度 |
| POST | `/api/v1/review/select` | 按知识点挑一道原题（同步，不调模型） |

`view` 取值：`organize`（整理）、`notes`（笔记）、`review`（复习）。

一次性验证脚本：

```bash
BASE=https://study.example.com
TOKEN=$(curl -s -X POST $BASE/api/v1/auth/login -H 'Content-Type: application/json' \
        -d "{\"code\":\"$CODE\"}" | python -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s $BASE/api/v1/status -H "Authorization: Bearer $TOKEN"
TASK=$(curl -s -X POST $BASE/api/v1/chat -H "Authorization: Bearer $TOKEN" \
       -H 'Content-Type: application/json' -d '{"message":"2+2 等于几","view":"organize"}' \
       | python -c 'import sys,json;print(json.load(sys.stdin)["task_id"])')
curl -s $BASE/api/v1/tasks/$TASK -H "Authorization: Bearer $TOKEN"
```

---

## 8. 还没做（按优先级）

1. **作答照片 OCR**：现在复习只能文字作答。网页版已有 `make_reader()` 的完整链路，挪到 `wx_api.py` 即可，主要是把 `review_images` 那段搬过来。
2. **流式输出**：`wx.request` 的 `enableChunked` + `onChunkReceived`，或 `wx.connectSocket`。当前模型是整段返回，价值主要在"等待时的细节进度"，现阶段的轮询已经能用。
3. **笔记 PDF / Markdown 下载**：小程序打开 PDF 体验差，建议改成"复制 Markdown"（已实现）或生成分享图。
4. **订阅消息**：长任务完成提醒（要走订阅消息授权，不是随手就能推）。
5. **多端同步**：同一份数据在网页版和小程序都能看。现在两边目录不同（网页版 `data/`，小程序 `data/users/...`），要对齐得先统一用户体系。
6. **支付/额度**：免费试用额度、按次计费。

---

## 9. 文件说明

| 文件 | 作用 |
| --- | --- |
| `wx_api.py` | 小程序 API：鉴权、用户隔离、任务轮询、上传 |
| `wx_security.py` | 微信内容安全（`msg_sec_check`），默认关闭 |
| `tests/test_wx_api.py` | 接口回归测试（登录、幂等、取消、跨用户隔离、错误脱敏） |
| `miniprogram/` | 小程序端：`utils/api.js` 封装请求与轮询，两个页面（整理 / 记录） |
| `Dockerfile` · `deploy/start.sh` | 容器入口：统一按 `$PORT` 监听（云托管 80，自建 8766），只开 1 worker |
| `docker-compose.yml` · `deploy/env.example` | 自建部署的环境变量模板，`/data` 必须挂卷 |
| `.dockerignore` | 构建时排除 `.venv`、`data/`、`.tools/`，否则镜像会大几百 MB |
| `deploy/nginx.conf` | HTTPS 反代与上传体积配置 |
| `deploy/study-agent-wx.service` | 不用 Docker 时的 systemd 单元 |
| `requirements-server.txt` | 服务端依赖（比网页版少了浏览器自动化） |
| `start_wx_api.cmd` | Windows 本地联调启动脚本（带 `WX_DEV_LOGIN=1`） |

> 服务端不装 playwright 时，笔记能正常保存，但 PDF 导出会返回"未完成"。小程序端本来也不提供 PDF，忽略即可。

---

## 10. 验收清单

上线前逐条打勾：

- [ ] `curl /healthz` 返回 200
- [ ] `WX_DEV_LOGIN` 已关闭，真实 `code` 能换到 token
- [ ] 未带令牌访问任一接口返回 401
- [ ] 两个不同微信号的数据互不可见（A 的笔记在 B 的记录页里看不到）
- [ ] 同一用户连点两次发送，第二次被拒或复用同一个任务
- [ ] 中途点"停止"，任务变成 `cancelled`，已保存记录还在
- [ ] 杀掉小程序再进，登录态仍在（token 未过期）
- [ ] 手机 4G（非 Wi-Fi）下能正常用——这条能提前发现域名/证书问题
- [ ] 上传 4 张大图不报 413
- [ ] 服务重启后，笔记和错题还在
- [ ] `WX_CONTENT_CHECK=1` 时，敏感输入被拦住
- [ ] 「记录」页底部「删除我的全部数据」能删掉，删完后记录页归零
- [ ] 隐私保护指引与实际收集字段一致

**云托管专项**

- [ ] 容器日志里有 `data=/data`，且没有"数据目录不可写"告警
- [ ] `/data` 挂的是文件存储（CFS），不是容器临时盘
- [ ] 最小/最大实例数都是 1（避免轮询 404）
- [ ] 重新部署一次后，之前保存的笔记和错题还在
- [ ] 公网访问已关闭（只允许小程序内调用）
- [ ] `WX_TRUST_CLOUD_HEADER=1`，且没有同时开 `WX_DEV_LOGIN`
