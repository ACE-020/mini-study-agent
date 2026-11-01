# 知错 · 接口使用指南

面向第三方接入者（脚本、桌面客户端、其他语言的服务）的一步步操作手册。
概念与目录划分见 [PROJECT_LAYOUT.md](./PROJECT_LAYOUT.md)，字段级定义见 [openapi.json](./openapi.json)。

> 本文所有示例都用 **PowerShell 7（pwsh）** 编写。用 Windows PowerShell 5.1 时，
> 把 `Invoke-RestMethod` 调用里的 `-Form` 换成 `curl.exe -F`（见附录 B）。
> 示例里的中文不会被当成命令执行，可以直接复制。

---

## 0. 一分钟上手

```powershell
# ① 启动服务（另开一个终端窗口，保持运行）
cd "D:\DSH workplace\mini-study-agent-main"
python web.py --port 8765

# ② 在第一个终端里：建立会话并查看状态
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$base = 'http://127.0.0.1:8765'
Invoke-RestMethod "$base/api/status" -WebSession $s | Format-List

# ③ 配置模型（已配置过就跳过）
Invoke-RestMethod "$base/api/settings" -Method Post -WebSession $s -ContentType 'application/json' -Body (@{
    base_url = 'https://api.deepseek.com'; model = 'deepseek-v4-pro'
    api_key = '<你的 Key>'; ocr_model = 'deepseek-flash'
} | ConvertTo-Json)

# ④ 问一句
Invoke-RestMethod "$base/api/chat" -Method Post -WebSession $s -ContentType 'application/json' `
    -Body (@{ message = '你好'; view = 'organize'; request_id = [guid]::NewGuid().ToString() } | ConvertTo-Json)
```

---

## 1. 准备工作

### 1.1 服务地址

| 运行方式 | 地址 | 端口从哪来 |
|---|---|---|
| 源码：`python web.py --port 8765` | `http://127.0.0.1:8765` | 启动参数 |
| 桌面版 `知错.exe` | `http://127.0.0.1:<随机端口>` | 数据目录下 `desktop-instance.json` 的 `port` 字段 |

服务**只监听本机回环地址**，不对局域网开放；也没有对外网暴露的鉴权，请勿做端口转发。

### 1.2 三个必须知道的约定

1. **Cookie 会话**：第一次请求会下发 `session` Cookie，之后每个请求都要带上它。
   Cookie 决定“你是谁”——对话上下文、临时图片、待确认方案都按会话隔离。
2. **统一信封**：
   ```json
   { "ok": true,  "answer": "……" }
   { "ok": false, "error": "可以直接展示给用户的中文原因" }
   ```
   部分接口返回 `{ "ok": true, "data": { … } }`。HTTP 状态码同时表达类别（见第 4 节）。
3. **request_id**：所有耗时接口都接受一个自选编号（≤100 字符）。同一个编号可用于
   ① 停止请求 ② 轮询进度。不传也可以，只是无法中途停止。

### 1.3 模型配置（只做一次）

`GET /api/status` 的 `configured` 为 `false` 时，对话类接口会失败。配置有两种途径：

- 网页右上角“模型设置”（推荐）；
- 接口 `POST /api/settings`（API Key 在 Windows 上用当前用户 DPAPI 加密保存，响应永不回显）：

```powershell
Invoke-RestMethod "$base/api/settings" -Method Post -WebSession $s -ContentType 'application/json' -Body (@{
    base_url   = 'https://api.deepseek.com'
    model      = 'deepseek-v4-pro'
    ocr_model  = 'deepseek-flash'
    ocr_backend= 'auto'          # auto / remote（云端识图）/ local（本机 GLM-OCR）
    api_key    = '<你的 Key>'
    ocr_api_key= ''              # 留空表示与 api_key 相同
} | ConvertTo-Json)
```

也可以不写配置文件，改用环境变量：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、`OCR_*`。

### 1.4 网络与跨域

- 服务端会校验 `POST` 请求的 `Origin` 头：带了且与 `127.0.0.1:<端口>` 不一致 → **403**。
  命令行工具（curl / Invoke-RestMethod）默认不带 `Origin`，无需处理。
- 从浏览器页面（`file://` 或其他站点）直接 fetch 会被跨域限制；推荐用后端脚本或 CLI 调用。
- 所有 `/api/*` 响应带 `Cache-Control: no-store`。

---

## 2. 公共行为速查

| 场景 | 做法 | 结果 |
|---|---|---|
| 建立会话 | 先调用任意接口（建议 `GET /api/status`） | 响应 `Set-Cookie: session=...` |
| 停止请求 | `POST /api/cancel {"request_id":"..."}` | 目标请求很快以 **499** 结束 |
| 先停后发 | 先 `cancel` 再发同一个 `request_id` | 新请求一开始就被取消，返回 499 |
| 停止并补充 | `POST /api/cancel {"request_id":"...","steer":true}` | 499 + `context_retained:true`，下一轮沿用上下文 |
| 查进度 | `GET /api/operation?request_id=...` | `{ok, active, progress:{phase,message,completed,total}}` |
| 同时两个请求 | 同一会话未结束时再发下一个 | **409**（先停止或等待） |
| 清空会话 | `POST /api/reset` | 上下文、临时图片、待确认方案全部清空；已保存记录保留 |

### 2.1 取消返回体示例

```json
{
  "ok": false,
  "error": "已停止本次处理，可以修改原内容后重新提交。已保存的错题和笔记保留。",
  "cancelled": true,
  "context_retained": false,
  "events": [ { "event": "工具结果", "value": { "ok": true, "data": { … } } } ]
}
```

**重要**：`cancelled` 只表示“这一轮没走完”，已成功的工具写入（保存的笔记、错题）**不会回滚**，
`events` 里能看到已经发生的写入。

---

## 3. 完整实战流程

下面是四条最常见的接入路径。每一步都给出请求与响应的关键字段。

### 流程 A：整理一条文字/图片原稿并保存（最常用）

```powershell
$base = 'http://127.0.0.1:8765'
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod "$base/api/status" -WebSession $s | Out-Null      # 建立会话

# ① 读取原稿文字（图片、PDF、TXT 可混合上传）
$read = Invoke-RestMethod "$base/api/intake/read" -Method Post -WebSession $s `
    -Form @{ files = Get-Item '作业.jpg'; request_id = 'req-read-1' }
# 返回：{ ok, text, image_ids:["…"], pages:[{source,page,method}] }

# ② 让助手整理（笔记与错题会自动分流保存）
$chat = Invoke-RestMethod "$base/api/chat" -Method Post -WebSession $s -ContentType 'application/json' `
    -Body (@{
        message    = '请把这张原稿里的笔记和错题分别整理保存。'
        view       = 'organize'
        image_ids  = $read.image_ids
        new_problem= $true
        request_id = 'req-chat-1'
    } | ConvertTo-Json)

$chat.answer            # 展示给用户的回答（Markdown）
$chat.events            # 每一步工具调用与结果
$chat.proposals         # 需要用户再次确认的删除/合并方案（这里通常为空）
```

判断“保存成功”时**不要只看 `answer` 文字**，请检查 `events`：

```powershell
$chat.events | Where-Object { $_.event -eq '工具结果' } | ForEach-Object { $_.value.ok, $_.value.data }
# save_note 成功 → { saved: true, duplicate: false, note: {…}, exports: { md:{ok:true,path}, pdf:{ok:true} } }
# save_mistake 成功 → { saved: true, duplicate: false, mistake: {id,topic,…} }
```

### 流程 B：把一份试卷整理成题目并入库

大文件请用**后台任务**接口，避免长时间占用：

```powershell
# ① 提交（表单方式：直接上传 PDF）
$submit = Invoke-RestMethod "$base/api/materials/jobs" -Method Post -WebSession $s `
    -Form @{ files = Get-Item '高数期末.pdf'; page_range = '1-8'; source = '2025 高数期末' }
$jobId = $submit.job.id        # HTTP 202，任务在后台执行
# 也可以不传文件，只提交已读到的文字：
#   Invoke-RestMethod … -ContentType 'application/json' -Body (@{ source='习题'; text=$text } | ConvertTo-Json)

# ② 轮询，直到 status 不是 queued/running
do {
    Start-Sleep -Seconds 2
    $job = (Invoke-RestMethod "$base/api/materials/jobs/$jobId" -WebSession $s).job
} until ($job.status -in 'ready','failed','cancelled')
$job.status                     # ready / failed / cancelled
$job.result.exercises           # 拆出的题目（预览，尚未入库）
$job.result.warnings            # 需要人工核对的疑点
$job.result.failures            # 失败的页组（failed 时才有）

# ③ 只重试失败的页（已成功的页有缓存，不会重做）
if ($job.result.failures) {
    Invoke-RestMethod "$base/api/materials/jobs/$jobId/retry" -Method Post -WebSession $s | Out-Null
}

# ④ 用户核对后入库（必须 confirmed=true）
Invoke-RestMethod "$base/api/exercises" -Method Post -WebSession $s -ContentType 'application/json' -Body (@{
    source = '高数期末'; confirmed = $true; job_id = $jobId
    exercises = $job.result.exercises
} | ConvertTo-Json -Depth 8)
# 返回：{ ok:true, data:{ added:12, duplicates:0, total:… } }
```

其他操作：

```powershell
Invoke-RestMethod "$base/api/materials/jobs"                   -WebSession $s           # 任务列表
Invoke-RestMethod "$base/api/materials/jobs/$jobId/cancel"     -Method Post -WebSession $s   # 停止
Invoke-RestMethod "$base/api/materials/jobs/$jobId/remove"     -Method Post -WebSession $s   # 从列表移除
Invoke-WebRequest  "$base/api/materials/jobs/$jobId/pages/1"   -WebSession $s -OutFile p1.jpg # 原页预览
```

### 流程 C：复习——选题、作答、追问

```powershell
# ① 目录树（知识点 → 细分标签，含数量）
$tree = Invoke-RestMethod "$base/api/review/catalog?source=any" -WebSession $s
$tree.categories | ForEach-Object { $_.category, ($_.children | ForEach-Object { "  - " + $_.tag + " (" + $_.count + ")" }) }

# ② 选一道题（本地读取，不调用模型，也不需要 Key）
$pick = Invoke-RestMethod "$base/api/review/select" -Method Post -WebSession $s -ContentType 'application/json' -Body (@{
    category = '极限'; tag = '等价无穷小'; source = 'any'
} | ConvertTo-Json)
$pick.answer             # 给用户看的选题说明（题干已原样拼入）
$pick.current_question   # { id:"exercise:…", kind:"exercise", topic, question, … } —— 不含答案

# ③ 上传作答图片（可选），然后提问
$up = Invoke-RestMethod "$base/api/chat/attachments" -Method Post -WebSession $s `
    -Form @{ view = 'review'; files = Get-Item '我的第一步.jpg' }

Invoke-RestMethod "$base/api/chat" -Method Post -WebSession $s -ContentType 'application/json' `
    -Body (@{
        message    = '我这样写对不对？下一步呢？'
        view       = 'review'; scope = 'current'
        image_ids  = $up.image_ids
        request_id = [guid]::NewGuid().ToString()
    } | ConvertTo-Json)
# 返回的 current_question 会随每个回答带回，便于前端高亮“当前题”
```

`/api/chat` 的 `view` 含义：

| view | 用途 | 可带图片 |
|---|---|---|
| `organize` | 整理混合原稿（笔记 + 错题），并保存 | 是（≤20 张） |
| `notes` | 只整理笔记 | 是 |
| `review` | 复习答疑，围绕当前题逐步引导；可以附图 | 是（≤20 张，需先选题） |
| `analysis` | 分析本轮勾选的记录，可生成删除/合并**预览** | 否 |

其他 `scope`/`intent` 组合：

- `scope: "history"` 只在用户明确说“从历史错题复习”时使用；
- `intent: "practice"` 表示“出一道练习题”，服务端会从题库选题（没有题目时返回提示，不会编题）；
- `new_problem: true` 开始一道新题（清空上一题知识点与旧图片）。

### 流程 D：删除 / 合并勾选的记录（两段式确认）

```powershell
$items = @(
    @{ kind = 'note';     id = '3f2a…' },
    @{ kind = 'mistake';  id = 'ae10…' }
)

# ① 生成预览（不会删除任何东西）
$proposal = (Invoke-RestMethod "$base/api/library/delete-preview" -Method Post -WebSession $s `
    -ContentType 'application/json' -Body (@{ items = $items } | ConvertTo-Json -Depth 5)).proposal
$proposal.id              # 服务器保存的快照编号，15 分钟内有效
$proposal.items           # 每条记录的完整内容（用于给用户核对）

# ② 用户确认后执行（必须 confirmed = true）
Invoke-RestMethod "$base/api/library/confirm" -Method Post -WebSession $s -ContentType 'application/json' -Body (@{
    proposal_id = $proposal.id; confirmed = $true
} | ConvertTo-Json)
```

合并时在第 ② 步额外传 `note`（可以在预览基础上编辑）和 `remove_source_notes`：

```powershell
Invoke-RestMethod "$base/api/library/confirm" -Method Post -WebSession $s -ContentType 'application/json' -Body (@{
    proposal_id         = $proposal.id
    confirmed           = $true
    note                = @{ topic = '导数：笔记与错因'; content = "## 合并后的正文`n`n…" }
    remove_source_notes = $false           # true 表示合并后删掉被合并的原笔记（错题与练习题始终保留）
} | ConvertTo-Json -Depth 5)
```

合并方案也可以让模型生成：`/api/chat`（`view:"analysis"`，`selection:[…]`）返回的 `proposals` 里就是
同样结构的对象，直接拿它的 `id` 调 `/api/library/confirm` 即可。

### 流程 E：导出

```powershell
# 已保存笔记的 md / pdf
Invoke-WebRequest "$base/api/notes/<note_id>/download/md" -WebSession $s -OutFile '笔记.md'
Invoke-RestMethod "$base/api/notes/<note_id>/export" -Method Post -WebSession $s -ContentType 'application/json' -Body '{}'
# 返回 { ok, note, exports:{ md:{ok,path}, pdf:{ok,error} } }（PDF 失败不影响笔记）

# 勾选内容的合集（md / pdf / json，返回附件下载）
Invoke-WebRequest "$base/api/library/export" -Method Post -WebSession $s -ContentType 'application/json' `
    -Body (@{ items = $items; format = 'md' } | ConvertTo-Json -Depth 5) -OutFile '合集.md'
```

---

## 4. 响应码与错误处理

| 状态码 | 含义 | 典型处理 |
|---|---|---|
| 200 | 成功 | 读 `ok` 与业务字段 |
| 202 | 已排队（后台任务） | 保存 `job.id` 轮询 |
| 400 | 参数不合法 | 直接展示 `error`，修正参数 |
| 403 | 跨站请求 | 去掉或修正 `Origin` 头 |
| 404 | 对象不存在/已过期 | 重新获取 id（预览、任务、图片都会过期） |
| 409 | 冲突 | **有请求正在处理中** 或记录已变更 / 方案已过期；稍后重试或重新预览 |
| 413 | 请求过大 | 压缩图片、拆分批次（单图 8 MB、单 PDF 256 MB、整批 512 MB） |
| 499 | 用户停止 | `cancelled:true`；若是 steer 则 `context_retained:true`，下一轮可继续 |
| 500 | 本地数据异常 | 提示检查 `data/*.json`，原文件不会被覆盖 |
| 502 | 模型/识图服务异常 | 提示稍后重试，检查模型设置 |
| 503 | 会话数过多 | 重启服务或先 `POST /api/reset` |

统一错误体：

```json
{ "ok": false, "error": "上一条请求还在处理中，请稍等。", "events": [] }
```

建议的客户端重试策略：`409/502/503` 可以稍后重试；`400/403/404/413` 重试无意义；
**`499` 绝不自动重试**（用户明确停止）。

---

## 5. 各接口要点

字段完整性以 [openapi.json](./openapi.json) 为准，这里只写“容易踩坑”的部分。

### 5.1 系统

| 接口 | 要点 |
|---|---|
| `GET /api/status` | 先调它建立会话；`configured=false` 时对话接口不可用；`version` 用于前端检测旧后端 |
| `GET /api/operation?request_id=` | `active=true` 才表示该编号正是当前请求 |
| `POST /api/cancel` | `{"request_id":"…","steer":false}`；不带 `request_id` 表示停止当前请求 |
| `GET/POST /api/settings` | 空字符串表示“沿用原值”；换服务地址必须重新输入 Key；有请求进行中返回 409 |
| `POST /api/settings/model` | 只改模型名，其他配置保持不变 |
| `POST /api/settings/test` | 只做连通性测试，不保存配置 |
| `GET /api/prompts` | 返回实际下发的全部提示词，便于核对 |
| `POST /api/reset` | 清会话，**不删除**已保存记录 |

### 5.2 上传类接口（multipart/form-data）

| 接口 | 字段 | 说明 |
|---|---|---|
| `POST /api/intake/read` | `files`（1–20 个）、`page_range`、`keep_image_ids`（JSON 字符串）、`request_id` | 返回文字 + 可复用的 `image_ids` |
| `POST /api/intake/prepare` | 同上 | 只准备原页（不识别），给视觉模型用 |
| `POST /api/notes/read` | `file`（单个）、`keep_image_ids`、`request_id` | 单份笔记原稿 |
| `POST /api/ocr` | `image`、`request_id` | 单张图转写 |
| `POST /api/chat/attachments` | `view=review`、`files`（1–4 张）、`request_id` | 上传阶段不调用模型 |
| `POST /api/materials/jobs` | `files` 或 `text`、`source`、`page_range`、`source_file_ids` | 也支持纯 JSON（`source` 必填） |
| `POST /api/materials/revise` | JSON，或 multipart（`image` + `payload`） | 校正某批预览 |
| `POST /api/files/preview` | `file`（PDF） | 逐页预览，30 分钟过期 |

`page_range` 写法：`1-8`、`1,3,5-8`、留空表示全部（每批最多 20 页）。

### 5.3 数据模型（最常用的几个）

```jsonc
// Note（笔记）
{ "id": "…", "topic": "导数", "content": "## 原始 Markdown", "created_at": "2026-11-01T…Z",
  // 仅列表接口返回：
  "display_content": "公式已转换的展示版", "downloads": { "md": "/api/notes/…/download/md" } }

// Mistake（错题）
{ "id": "…", "question": "原题", "user_answer": "我的答案",
  "correct_answer": "参考答案", "reason": "错因", "topic": "导数", "created_at": "…" }

// Exercise（题库题目）
{ "id": "…", "source": "资料名", "number": "二、2", "paper": "完整试卷标题",
  "topic": "导数", "question": "题干", "answer": "资料中的答案（可能为空）",
  "tags": ["等价无穷小"], "page_index": 3, "origin_regions": [ … ] }

// CurrentQuestion（当前题，白名单视图，不含答案）
{ "id": "exercise:…", "kind": "exercise", "topic": "导数", "question": "题干", "source": "…" }

// StudyEvent（对话事件）
{ "event": "工具请求", "value": { "name": "save_note", "arguments": "{\"topic\":…}" } }
{ "event": "工具结果", "value": { "ok": true, "data": { "saved": true, "note": {…} } } }
```

`events` 中 `event` 取值固定为 `请求模型` / `工具请求` / `工具结果` 三种。

---

## 6. 常见问题（FAQ）

**Q1：调用 `/api/chat` 返回 409“上一条请求还在处理中”。**
同一会话同一时间只允许一个前台请求。先 `POST /api/cancel`，或等上一个请求结束。
不同 `request_id` 不会带来并行能力——这是有意的设计，避免两个对话同时改同一份记录。

**Q2：图片上传后过一会儿再用就 404 / 409。**
临时图片、预览、待确认方案都有生命周期：没有请求在处理时 **1 小时**清理会话，
会话最多 32 个（满后需重置或重启），预览 30 分钟过期，方案 15 分钟过期。
长期使用请把结果保存到笔记/错题/题库。

**Q3：`answer` 里写了“已保存”，但记录没有。**
以 `events` 为准：只有 `save_note` / `save_mistake` 的 `工具结果` 里 `ok=true` 才算写入；
`duplicate=true` 表示内容已存在、未重复写入。

**Q4：服务重启后对话没有了。**
对话上下文只保存在内存里；笔记、错题、题库是磁盘 JSON，会保留。

**Q5：怎样完全不调用模型地使用？**
`/api/review/catalog`、`/api/review/select`、`/api/exercises`、`/api/notes`、`/api/mistakes`、
`/api/library/*`、`/api/materials/files/…` 都是本地读写，不需要 Key。用户明确要求“自己出一道题”时
才会调用模型生成。

**Q6：能不能只导出、不改动任何记录？**
可以：`POST /api/library/export` 只读；`download` 接口只读；所有写操作都有明确的
`confirmed=true` 或保存工具。

---

## 附录 A：curl.exe 等价写法

Windows 自带的 `curl.exe` 可以完成同样的流程（注意 `-c/-b` 保存与回放 Cookie）：

```powershell
$base = 'http://127.0.0.1:8765'
curl.exe -c "$env:TEMP\zx.txt" "$base/api/status"
curl.exe -b "$env:TEMP\zx.txt" -X POST "$base/api/settings" -H "Content-Type: application/json" `
    -d '{\"base_url\":\"https://api.deepseek.com\",\"model\":\"deepseek-v4-pro\",\"api_key\":\"<Key>\",\"ocr_model\":\"deepseek-flash\"}'
curl.exe -b "$env:TEMP\zx.txt" -X POST "$base/api/intake/read" -F "files=@作业.jpg"
curl.exe -b "$env:TEMP\zx.txt" -X POST "$base/api/chat" -H "Content-Type: application/json" `
    -d '{\"message\":\"请整理\",\"view\":\"organize\",\"request_id\":\"r1\"}'
```

## 附录 B：Windows PowerShell 5.1 注意事项

- 5.1 的 `Invoke-RestMethod` **没有** `-Form` 参数：上传文件请用 `curl.exe -F`，
  或自行拼 `multipart/form-data`；
- 5.1 默认按系统编码解码响应，中文可能乱码：先执行
  `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`；
- 实测中 WinPS 的 `ConvertFrom-Json` 解析含中文的大 JSON 可能报错，
  需要解析 `openapi.json` 时请用 Python 或 `pwsh`。

## 附录 C：Python 客户端示例

```python
import uuid
import requests  # 仅示例；也可以直接用标准库 urllib

BASE = "http://127.0.0.1:8765"
session = requests.Session()          # 自动保存并回放 Cookie

status = session.get(f"{BASE}/api/status").json()
if not status["configured"]:
    raise SystemExit("请先配置模型（网页右上角“模型设置”）")

# 对话
answer = session.post(f"{BASE}/api/chat", json={
    "message": "你好",
    "view": "organize",
    "request_id": str(uuid.uuid4()),
}).json()
print(answer["answer"])

# 上传 PDF 并提交后台整理
with open("高数期末.pdf", "rb") as handle:
    submitted = session.post(
        f"{BASE}/api/materials/jobs",
        files={"files": ("高数期末.pdf", handle, "application/pdf")},
        data={"source": "高数期末", "page_range": "1-8"},
    ).json()
job_id = submitted["job"]["id"]

# 轮询
import time
while True:
    job = session.get(f"{BASE}/api/materials/jobs/{job_id}").json()["job"]
    if job["status"] not in ("queued", "running"):
        break
    time.sleep(2)
print(job["status"], len(job.get("result", {}).get("exercises", [])))
```

只需要标准库时，用 `urllib.request` + `http.cookiejar.CookieJar` 构造 opener 即可，
思路与上面的 `requests.Session()` 相同。

---

## 附录 D：实测得到的调用注意点

以下都是在本机对**真实服务**逐条调用后确认的行为（用临时数据目录、假模型配置，不产生 API 费用）：

| 场景 | 实测结果 / 正确用法 |
|---|---|
| 环境变量优先 | 若进程里设置了 `LLM_API_KEY`、`LLM_BASE_URL`（或当前用户注册表里的同名变量），它们**优先于**网页/接口保存的配置。测试或切换账号时注意先清掉这些变量。 |
| 设置接口的返回 | `GET/POST /api/settings` 与 `POST /api/settings/model` 都返回 `{ok:true, settings:{base_url, model, ocr_model, ocr_backend, configured, …}}`，密钥从不回显。 |
| 换服务地址 | 只改 `base_url` 而不重新填 `api_key` 会被 400 拒绝（防止把 A 的密钥发给 B）。 |
| 先停后发 | 先 `POST /api/cancel {"request_id":"x"}` 再发带同一 `request_id` 的 `/api/chat`，请求会立刻以 **499** 返回，不调用模型。 |
| 空知识点选题 | `POST /api/review/select {"category":"","tag":""}` 是合法的（等于“全部知识点”）；返回 `current_question:null` 时表示该范围暂无题目。 |
| 入库确认 | `POST /api/exercises` 不带 `confirmed:true` → 400；题目为空或未核对时不会写入。 |
| 跨站请求 | 带 `Origin: https://其他站点` 的 POST → **403**；命令行调用不带 Origin，不影响。 |
| 任务预览 | 后台任务详情里 `job.result.exercises` 只是预览，`job.result.failures` 非空时先 `retry`，再整体入库。 |

---

## 相关文档

- 目录与模块职责：[PROJECT_LAYOUT.md](./PROJECT_LAYOUT.md)
- 字段级接口定义：[openapi.json](./openapi.json)
- 网页使用说明：[WEB_GUIDE.md](./WEB_GUIDE.md)
