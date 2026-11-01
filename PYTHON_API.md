# 知错 · Python API 使用文档

`study_api` 是给 Python 调用者的接口包，把项目的前后端都变成可编程的：

| 层 | 入口 | 适合谁 | 需要先启动服务吗 |
|---|---|---|---|
| **后端（进程内）** | `StudyService` | 脚本、定时任务、自己的 Web 框架、批处理 | 不需要 |
| **前端（HTTP 调用）** | `HttpApiClient` | 已有 UI 想接后端、或用 Python 复刻网页调用 | 需要 `python web.py` |

它不新增一套“平行实现”：`StudyService` 直接组合 `agent.py`、`tools.py`、`materials.py`、`library.py`
等已有的业务模块，行为与网页一致（模型只提议、写库由服务端完成、删除合并需确认）。

另外两份文档按需参考：

- [API_USAGE.md](./API_USAGE.md)：面向 HTTP 接入者的操作指南（curl / PowerShell 示例）
- [PROJECT_LAYOUT.md](./PROJECT_LAYOUT.md)：目录与模块职责
- [openapi.json](./openapi.json)：字段级 HTTP 接口定义

---

## 目录

1. [安装与环境](#1-安装与环境)
2. [五分钟上手](#2-五分钟上手)
3. [StudyService 完整参考](#3-studyservice-完整参考)
4. [数据模型](#4-数据模型)
5. [异常与错误处理](#5-异常与错误处理)
6. [离线测试与自研模型](#6-离线测试与自研模型)
7. [HttpApiClient：HTTP 调用](#7-httpapiclienthttp-调用)
8. [典型组合场景](#8-典型组合场景)
9. [与网页版的行为差异](#9-与网页版的行为差异)
10. [API 速查表](#10-api-速查表)

---

## 1. 安装与环境

`study_api` 与项目其他模块同级，直接 `import` 即可，不需要打包安装。要求：

- Python 3.10+（项目使用 3.12 验证）
- 依赖与项目一致：`pip install -r requirements.txt`（Flask、Pillow、PyMuPDF、playwright 等）

运行位置有两种，先选择一种：

```powershell
# 项目自带的虚拟环境（推荐，开发/测试时）
cd "D:\DSH workplace\mini-study-agent-main"
.\.venv\Scripts\python.exe your_script.py

# 或使用系统 Python（需自己安装依赖）
python your_script.py
```

在 `mini-study-agent-main` 目录里运行脚本时，`import study_api` 直接可用。

> **环境变量优先**：服务会自动读取当前用户注册表与环境变量里的 `LLM_API_KEY`、`LLM_BASE_URL`、
> `LLM_MODEL`、`OCR_*`，它们的优先级高于网页/接口保存的配置。做测试或切换账号时，先清掉这些变量
> （或构造 `AppConfig(load_user_environment=False)`）。

---

## 2. 五分钟上手

```python
from study_api import AppConfig, StudyService

# ① 指定数据目录（不指定则使用项目 data/ 或桌面版用户目录）
config = AppConfig(data_dir=r"D:\study-data", settings_path=r"D:\study-data\settings.json")
service = StudyService(config)

# ② 配置模型（第一次）；之后会自动读取配置文件
service.configure_model(base_url="https://api.deepseek.com",
                        api_key="<你的 Key>",
                        model="deepseek-v4-pro",
                        ocr_model="deepseek-flash")

# ③ 看看状态
print(service.status())
# {'ok': True, 'configured': True, 'model': 'deepseek-v4-pro', 'data_dir': ..., 'version': ...}

# ④ 直接保存一条错题（不经过模型）
service.save_mistake(question="求 x² 的导数。", user_answer="x", correct_answer="2x",
                     reason="漏掉系数 2", topic="导数")

# ⑤ 与学习助手对话（会调用模型；笔记/错题由模型调用工具保存）
result = service.chat("请整理下面这道错题：求 x³ 的导数。我的答案 x²，正确答案 3x²。",
                      view="organize")
print(result.answer)                    # 展示给用户的回答
for tool in result.tools():             # 本轮执行了哪些工具、是否成功
    print(tool.name, tool.ok, tool.data)
print(result.saved_records())           # 真正写入的 note / mistake 记录

service.close()
```

推荐用 `with` 管理生命周期（退出时自动停止本机 OCR 运行时与后台线程）：

```python
with StudyService(AppConfig(data_dir=r"D:\study-data")) as service:
    print(service.list_notes())
```

---

## 3. StudyService 完整参考

### 3.1 构造与生命周期

```python
StudyService(config=None, settings=None, backend=None)
```

| 参数 | 说明 |
|---|---|
| `config` | `AppConfig`；不传时用默认路径（`runtime_paths`） |
| `settings` | 自定义配置存储（默认 `SettingsStore(config.settings_path)`） |
| `backend` | 模型后端；不传用 `LocalBackend`（读本机配置） |

| 方法 | 说明 |
|---|---|
| `close()` | 停止本机 OCR 与后台任务，可重复调用 |
| `reset()` | 清空对话上下文与待确认方案，**不删除**任何已保存记录 |
| `with` 语句 | 等价于结束时自动 `close()` |

`AppConfig` 字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `data_dir` | 项目 `data/`（桌面版为 `%LOCALAPPDATA%\ZhicuoStudy\data`） | 笔记/错题/题库/导出文件 |
| `settings_path` | `.local-settings.json` | 模型配置（密钥 DPAPI 加密） |
| `max_rounds` | `6` | 单轮对话最多模型往返次数 |
| `load_user_environment` | `True` | 是否读取当前用户的 `LLM_*` / `OCR_*` 环境变量 |
| `local_ocr` | `None` | `True` 强制用本机 GLM-OCR；`False` 强制云端；`None` 跟随设置 |
| `allowed_views` | 全部四个视图 | 限制可用的 `view`（例如只开放 `review`） |

### 3.2 配置与状态

#### `configure_model(base_url, api_key, model, ocr_model="", ocr_base_url="", ocr_api_key="", ocr_backend="auto")`

保存模型配置，返回可展示的配置（不含密钥）。切换服务地址时必须重新提供 Key（否则 `ConfigurationError`）。

```python
service.configure_model("https://api.deepseek.com", "<Key>", "deepseek-v4-pro",
                        ocr_model="deepseek-flash", ocr_backend="remote")
```

#### `settings_public()`

返回当前配置（无密钥）：

```python
{'base_url': ..., 'model': ..., 'ocr_model': ..., 'ocr_backend': 'remote',
 'configured': True, 'key_saved': True, 'ocr_key_saved': True, 'storage': 'Windows 当前用户加密保存'}
```

#### `status()`

```python
{'ok': True, 'configured': True, 'model': 'deepseek-v4-pro', 'ocr_model': 'deepseek-flash',
 'ocr_backend': 'remote', 'data_dir': r'D:\study-data', 'settings_path': r'D:\study-data\settings.json',
 'version': 'workspace-v20-python-api-1', 'backend': 'LocalBackend'}
```

#### `test_connection(base_url="", api_key="", model="")`

用给定（或已保存的）配置发一次极小请求。成功返回一句中文，失败抛 `ModelFailure`。

#### `prompts() -> dict` / `tool_schemas() -> list[str]`

- `prompts()`：实际生效的提示词（教学、出题、图片作答、拆题、笔记规则）
- `tool_schemas()`：模型可见的工具白名单，如 `['search_notes', 'save_mistake', 'pick_exercise', 'save_note', ...]`

### 3.3 笔记

| 方法 | 返回 | 说明 |
|---|---|---|
| `list_notes()` | `list[Note]` | 新在前 |
| `get_note(note_id)` | `Note` | 不存在抛 `NotFoundError` |
| `search_notes(query, limit=5)` | `list[Note]` | 空格/逗号分隔多关键词 |
| `save_note(topic, content, cancel_token=None)` | `dict` | 同内容不重复入库；同时导出 md/pdf |
| `export_note(note_id)` | `dict` | 重新导出，`{'md': {...}, 'pdf': {...}}` |
| `delete_note(note_id)` | `dict` | 走“预览→确认”，进入 `trash.json` |

```python
saved = service.save_note("导数", "## 幂函数求导\n\n$(x^n)'=nx^{n-1}$。")
# {'saved': True, 'duplicate': False,
#  'note': {'id': '...', 'topic': '导数', 'content': ...},
#  'exports': {'md': {'ok': True, 'path': ...}, 'pdf': {'ok': True, 'path': ...}}}

print(service.search_notes("幂函数 求导")[0].topic)
```

**注意**：正文里出现 `[无法辨认]`、`[待确认]` 等占位符时拒绝保存（抛 `ApiError`），与网页一致。

### 3.4 错题

| 方法 | 返回 | 说明 |
|---|---|---|
| `save_mistake(question, user_answer, correct_answer, reason, topic)` | `dict` | 题目 + 用户答案相同视为重复 |
| `list_mistakes(limit=None)` | `list[Mistake]` | 默认最多 200 条，按知识点频次排序 |
| `mistake_summary(topic=None, limit=5)` | `dict` | `total` / `topic_counts` / `mistakes` |
| `get_mistake(mistake_id)` | `Mistake` | 不存在抛 `NotFoundError` |

```python
service.save_mistake(question="求 x² 的导数。", user_answer="x",
                     correct_answer="2x", reason="漏掉系数", topic="导数")
print(service.mistake_summary()["topic_counts"])   # {'导数': 1}
```

### 3.5 题库与复习

| 方法 | 返回 | 说明 |
|---|---|---|
| `list_exercises()` | `list[Exercise]` | 全部题目 |
| `get_exercise(exercise_id)` | `Exercise` | 不存在抛 `NotFoundError` |
| `import_exercises(source, exercises, job_id=None, confirmed=False)` | `dict` | 必须 `confirmed=True`；重复题目不重复写入 |
| `organize_exercises(items, paper=None, tags=None, confirmed=False)` | `dict` | 批量设置试卷/细标签（带 revision 乐观锁） |
| `update_exercise(identity, source, item, revision, confirmed=False)` | `dict` | 修改一道题，revision 不匹配抛 `ApiError(409)` |
| `review_catalog(source="any")` | `dict` | 知识点 → 细分标签 → 数量 |
| `select_review(category="", tag="", source="any")` | `ReviewSelection` | 本地选题，不调用模型 |

`select_review` 里 `category` 既可以是一级目录（`导数与微分`），也可以是具体知识点（`导数`）；
两者都匹配不到时返回 `current_question=None`（该范围暂无题目）。

```python
imported = service.import_exercises("2025 高数期末", [
    {"number": "二、2", "topic": "导数", "question": "求 $x^5$ 的导数。", "answer": "$5x^4$"},
], confirmed=True)
print(imported)             # {'added': 1, 'duplicates': 0, 'total': 1}

liked = service.select_review(category="导数")
print(liked.answer)                     # 给用户看的选题说明（题干已原样拼入）
print(liked.current_question.question)  # 当前题（白名单字段，不含答案）
```

### 3.6 对话（核心）

```python
chat(message, *, view="organize", scope="current", intent=None, topic=None,
     exercise_id=None, new_problem=False, selection=None,
     cancel_token=None, max_rounds=None) -> ChatResult
```

| 参数 | 说明 |
|---|---|
| `message` | 1–80000 字 |
| `view` | `organize`（整理混合原稿并保存）/ `notes`（只整理笔记）/ `review`（复习答疑）/ `analysis`（分析勾选记录） |
| `scope` | `current`（围绕当前题）/ `history`（明确的历史复习） |
| `intent` | `"practice"` 表示“出一道练习题”（从题库选题，没有题时会提示上传资料） |
| `topic` | 指定知识点（`scope="history"` 时可限定复习方向） |
| `exercise_id` | 直接练习题库里的某道题（自动切到 `review`） |
| `new_problem` | `True` 开始一道新题（清空上一题知识点） |
| `selection` | 仅 `analysis`：本轮勾选的记录 `[{"kind": "note", "id": "..."}]` |
| `cancel_token` | `CancellationToken`，可被其它线程 `cancel()` |
| `max_rounds` | 覆盖配置中的单轮模型往返上限 |

返回 `ChatResult`：

| 属性/方法 | 说明 |
|---|---|
| `answer` | 展示给用户的 Markdown 回答 |
| `events` | 事件流：`请求模型` / `工具请求` / `工具结果` |
| `proposals` | 需要用户再次确认的删除/合并方案（带 `id`，可直接 `confirm_proposal`） |
| `current_question` | 当前题的 `CurrentQuestion`（对话推进时自动更新） |
| `tools()` | 本轮的 `ToolResult` 列表（`name` / `ok` / `data`） |
| `saved_records()` | 本轮真正写入的 `[("note", {...}), ("mistake", {...})]` |
| `to_dict()` | 转回原始字典，便于日志/序列化 |

```python
result = service.chat("这题我还不会，给我下一步提示", view="review")
for event in result.events:
    if event.event == "工具结果":
        print(event.tool_name, event.ok)
```

**判断是否保存成功要以 `events` 为准**，不要只看 `answer` 的文字。

### 3.7 图片与原始读取

| 方法 | 说明 |
|---|---|
| `recognize_image(raw: bytes)` | 单张图片转文字（不解题、不入库） |
| `prepare_image(raw: bytes)` | 校验/规范化图片，返回 `data:image/jpeg;base64,...` |
| `read_documents(files, page_range="", include_images=True)` | 读取 1–20 个文件（`FileStorage` 或带 `filename`/`read` 的对象） |
| `capture_materials(files, page_range="", max_pages=20)` | 转成“原页图像 + 版面标签”，供视觉模型拆题 |

`read_documents` 返回 `{'text', 'images', 'pages', 'image_texts'}`。

### 3.8 资料整理：同步

| 方法 | 说明 |
|---|---|
| `parse_material_text(text)` | 一段资料同步拆题，返回预览（`exercises/warnings/issues`），不入库 |
| `import_exercises(...)` | 见 3.5，用户核对后入库 |

### 3.9 资料整理：后台任务

| 方法 | 说明 |
|---|---|
| `submit_material_job(source, text="", documents=None, metadata=None, source_files=None)` | 提交任务，立即返回 `MaterialJobResult` |
| `get_material_job(job_id)` / `list_material_jobs()` | 查询状态 |
| `cancel_material_job(job_id)` / `retry_material_job(job_id)` / `remove_material_job(job_id)` | 停止 / 只重试失败页 / 移除 |
| `wait_material_job(job_id, timeout=600, interval=1.0)` | 阻塞轮询到结束 |

```python
job = service.submit_material_job("高数期末", text=open("期末.txt", encoding="utf-8").read())
done = service.wait_material_job(job.id)
print(done.status, len(done.exercises), done.warnings)
if done.result.get("failures"):
    service.retry_material_job(job.id)
```

### 3.10 删除与合并（两段式）

| 方法 | 说明 |
|---|---|
| `preview_delete(items)` | 生成删除预览（带 `id`），**不删除** |
| `preview_merge(items, topic, content)` | 生成合并预览，**不写入** |
| `confirm_proposal(proposal_or_id, remove_source_notes=False, note=None)` | 真正执行 |

```python
proposal = service.preview_delete([{"kind": "note", "id": note_id}])
service.confirm_proposal(proposal["id"])          # 或直接传整个 proposal

merged = service.preview_merge([{"kind": "note", "id": a}, {"kind": "note", "id": b}],
                               "导数：合并笔记", "## 合并正文")
service.confirm_proposal(merged, remove_source_notes=True)   # 合并后删掉原笔记
```

方案 15 分钟内有效，过期或不存在抛 `ApiError(409)`。

### 3.11 导出

| 方法 | 说明 |
|---|---|
| `export_collection(items, fmt, cancel_token=None, max_chars=None)` | 返回 `bytes`；`fmt` 为 `md`/`pdf`/`json`；默认不限制字数 |

```python
data = service.export_collection([{"kind": "note", "id": note_id}], "md")
open("合集.md", "wb").write(data)
```

### 3.12 模型后端

| 方法 | 说明 |
|---|---|
| `use_backend(backend)` | 传入 `ScriptedBackend` / 自定义 `ModelBackend`。直接调用 → 永久替换；`with` → 退出后恢复 |
| `use_scripted_model(complete, reader=None, complete_with_tools=None)` | 便捷入口 |

```python
with service.use_backend(my_backend):
    service.chat("你好")
```

---

## 4. 数据模型

所有模型都是 dataclass，带 `from_dict()` / `to_dict()`。

### Note

| 字段 | 说明 |
|---|---|
| `id` | 内容哈希前 16 位 |
| `topic` | 知识点（≤120 字） |
| `content` | 原始 Markdown（保存与导出的唯一来源） |
| `created_at` | ISO 时间 |

### Mistake

`id`、`question`、`user_answer`、`correct_answer`、`reason`、`topic`（均为字符串）、`created_at`。

### Exercise

`Exercise.data` 里是原始字典；常用属性 `id`、`topic`、`question`、`answer`、`tags`。
题库里还有 `source`、`number`、`paper`、`page_index`、`origin_regions`、`provenance` 等。
**注意**：选题/当前题接口会剔除 `answer`。

### CurrentQuestion

`id`（形如 `exercise:xxx` / `mistake:xxx` / `generated`）、`kind`、`topic`、`question`、`tags`、`source`、`number`、`paper`。

### StudyEvent

`event` ∈ `请求模型` / `工具请求` / `工具结果`；`value` 为原始负载。
便捷属性：`tool_name`（工具名）、`ok`（工具是否成功）。

### ToolResult

`name`、`ok`、`data`；`record` 快速取出 `note`/`mistake`/`exercise` 本体。

### ChatResult

`answer`、`events`、`proposals`、`current_question`；方法 `tools()`、`saved_records()`、`to_dict()`。

### ReviewSelection

`answer`、`selection`、`current_question`、`matched`。

### MaterialJobResult

`id`、`status`（`queued/running/ready/failed/cancelled`）、`source`、`progress`、`error`、
`exercises`、`warnings`、`issues`、`failures`、`raw`；`finished` 表示已结束。

---

## 5. 异常与错误处理

所有异常继承 `ApiError`（带 `message`、`status`、`events`）：

| 异常 | 何时抛出 | 建议处理 |
|---|---|---|
| `ConfigurationError` | 未配置模型、配置非法、密钥不可解密 | 提示用户配置模型 |
| `DataFileError` | `notes.json`/`mistakes.json`/`exercises.json` 结构损坏 | 不要自动覆盖，提示检查原文件 |
| `ModelFailure` | 模型/识图服务不可用、返回格式不符、超时 | 稍后重试或换模型 |
| `NotFoundError` | 记录、批次、题目、方案不存在或过期 | 刷新列表 / 重新预览 |
| `CancelledError` | 调用了 `cancel_token.cancel()` | 已写入不回滚；`context_retained` 表示可继续 |
| `ApiError` | 参数非法、未确认、并发冲突等 | 把 `message` 直接展示给用户 |

```python
from study_api import ApiError, ModelFailure, NotFoundError

try:
    service.chat("整理原稿")
except ModelFailure as exc:
    print("模型不可用：", exc.message)
except ApiError as exc:
    print("失败：", exc.message, "状态码：", exc.status)
```

`CancelledError` 示例（另一个线程停止）：

```python
import threading, time
from cancellation import CancellationToken

token = CancellationToken()
threading.Timer(1.0, token.cancel).start()
try:
    service.chat("整理这份很长的原稿", cancel_token=token)
except CancelledError as exc:
    print("已停止；上下文保留：", exc.context_retained)
```

---

## 6. 离线测试与自研模型

`ScriptedBackend` 让你不联网就能驱动整个 Agent 循环：

```python
import json
from study_api import AppConfig, ScriptedBackend, StudyService

def call(name, args, call_id="call_1"):
    return {"role": "assistant", "content": None, "tool_calls": [{
        "id": call_id, "type": "function",
        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}

replies = [
    call("save_mistake", {"question": "求 x² 的导数。", "user_answer": "x",
                          "correct_answer": "2x", "reason": "漏系数", "topic": "导数"}),
    {"role": "assistant", "content": "已记录，先想想系数从哪里来？"},
]

def complete(messages, tools=None):
    return replies.pop(0)          # 按顺序吐出预设回复

service = StudyService(AppConfig(data_dir="tmp/data", load_user_environment=False),
                       backend=ScriptedBackend(complete))
result = service.chat("整理这道错题")
print(result.saved_records())
```

`ScriptedBackend` 的可选参数：

| 参数 | 签名 | 用途 |
|---|---|---|
| `complete` | `(messages, tools=None) -> dict` | 与 `ModelClient.complete` 同签名（拆题、校正等单次调用） |
| `complete_with_tools` | `(messages, tool_names) -> dict` | Agent 循环专用：拿到本轮允许使用的工具名 |
| `reader` | `(raw, cancel_token=None) -> str` | 图片转写替身 |

自研模型同样接入：实现 `ModelBackend`（`new_client()` / `new_reader()`），或用
`service.use_scripted_model(complete=..., complete_with_tools=...)` 包装成 `ModelClient` 形状。

---

## 7. HttpApiClient：HTTP 调用

用于：服务已通过 `python web.py`（或桌面版 exe）启动，你想从 Python 调用与网页完全相同的接口。

```python
from study_api import HttpApiClient

with HttpApiClient("http://127.0.0.1:8765", timeout=120) as api:
    print(api.status()["configured"])

    # 读取原稿：直接上传文件，自动保存 Cookie 会话
    read = api.read_intake([r"D:\homework\作业1.jpg"], page_range="", request_id="r1")
    print(read["text"][:50], read["image_ids"])

    # 对话
    reply = api.chat("请整理这份原稿", view="organize", image_ids=read["image_ids"])
    print(reply["answer"])

    # 后台整理并轮询
    job = api.submit_material_job("高数期末", files=[r"D:\试卷\期末.pdf"], page_range="1-8")
    while (state := api.material_job(job["id"]))["status"] in ("queued", "running"):
        import time; time.sleep(1)
    print(state["status"], len(state["result"]["exercises"]))
```

### 7.1 方法一览

| 分类 | 方法 |
|---|---|
| 底层 | `request(method, path, json_body=None, form=None, raw=False) -> (status, data)` |
| 系统 | `status`、`settings`、`save_settings(**values)`、`switch_model(model)`、`test_connection(**values)`、`prompts`、`operation(request_id)`、`cancel(request_id=None, steer=False)`、`reset` |
| 对话 | `chat(message, **options)`、`upload_review_images(paths)` |
| 读取 | `read_intake(paths, page_range="", keep_image_ids=None)`、`read_note_source(path)`、`recognize_image(path)`、`set_ocr_backend(backend)` |
| 数据 | `notes`、`download_note(id, kind)`、`export_note(id)`、`mistakes`、`exercises`、`import_exercises`、`organize_exercises`、`update_exercise` |
| 复习 | `review_catalog(source)`、`select_review(category, tag, source)` |
| 资料 | `submit_material_job`、`material_jobs`、`material_job`、`material_job_action`、`material_page`、`material_text`、`parse_material`、`revise_material` |
| 跨库 | `preview_delete(items)`、`confirm(proposal_id, ...)`、`export_collection(items, fmt)` |
| 预览 | `upload_preview(path)`、`preview_page(document_id, page)` |

### 7.2 约定

- Cookie 会话自动保存并回放；每个客户端实例 = 一个会话（与浏览器隔离）。
- 返回：200/202 返回解析后的 JSON；`raw=True` 的下载接口返回 `bytes`。
- 错误：HTTP 状态码映射到 `study_api.errors`（499 → `CancelledError`，404 → `NotFoundError`，
  502 → `ModelFailure`，500 → `DataFileError`，其余 → `ApiError`）。
- 上传：`form` 参数里传 `Path` 或路径字符串即为文件上传；列表表示同名多文件（`files`）。

```python
try:
    api.cancel("req-1", steer=True)
    api.chat("原请求", request_id="req-1")
except CancelledError as exc:
    print(exc.context_retained)
```

---

## 8. 典型组合场景

### 8.1 批量整理一份试卷并入库（离线可用）

```python
from study_api import AppConfig, StudyService

with StudyService(AppConfig(data_dir="tmp/data")) as service:
    text = open("期末试卷.txt", encoding="utf-8").read()
    preview = service.parse_material_text(text)
    for index, item in enumerate(preview["exercises"], 1):
        print(index, item["number"], item["topic"], item["question"][:40])
    print("需要核对：", preview["warnings"])

    # 假设用户已核对
    service.import_exercises("2025 期末", preview["exercises"], confirmed=True)
```

### 8.2 只做本地数据整理，不调用模型

```python
service = StudyService()
print(service.search_notes("极限"))
print(service.mistake_summary())
print(service.review_catalog("exercise"))
selected = service.select_review(category="极限", tag="等价无穷小")
print(selected.answer)
```

### 8.3 定时任务：每天导出笔记

```python
import datetime
from study_api import StudyService

service = StudyService()
items = [{"kind": "note", "id": note.id} for note in service.list_notes()]
data = service.export_collection(items, "md") if items else b""
name = "笔记合集-%s.md" % datetime.date.today().isoformat()
open(name, "wb").write(data)
print("已导出", name, len(data), "字节")
service.close()
```

### 8.4 在自己的 Web 框架里包一层

```python
# FastAPI 示例
from fastapi import FastAPI, HTTPException
from study_api import ApiError, StudyService

app = FastAPI()
service = StudyService()

@app.post("/ask")
def ask(payload: dict):
    try:
        result = service.chat(payload["message"], view=payload.get("view", "organize"))
        return {"answer": result.answer, "saved": [kind for kind, _ in result.saved_records()]}
    except ApiError as exc:
        raise HTTPException(status_code=exc.status or 400, detail=exc.message)
```

`StudyService` 自带锁保护内部状态；但在多线程并发调用同一个视图的 `chat` 时，
建议每个请求用独立实例或在 3.x 的“同一会话同时只允许一个请求”约束下自行排队。

---

## 9. 与网页版的行为差异

| 方面 | 网页版 | `StudyService` |
|---|---|---|
| 会话隔离 | Cookie，每个浏览器一个会话 | 一个实例一个会话（可自行建多个实例） |
| 图片输入 | 上传后带 `image_ids` | 直接传 `bytes`（`recognize_image` / `prepare_image`）或自行读文件 |
| 停止 | `POST /api/cancel` + request_id | `CancellationToken` 直接传入 |
| 进度 | `GET /api/operation` | `MaterialJobResult.progress`；对话无轮询（同步返回） |
| 错误 | JSON `{ok:false,error}` + 状态码 | 异常（含 `status`，与 HTTP 对应） |
| 确认 | 网页弹窗二次确认 | `confirmed=True` / `confirm_proposal()` |
| 视图切换 | 每个页面一个对话 | `chat(view=...)`，每个 view 独立上下文 |

---

## 10. API 速查表

```text
study_api
├── AppConfig(data_dir, settings_path, max_rounds, load_user_environment, local_ocr, allowed_views)
├── StudyService(config=None, settings=None, backend=None)
│   ├── 生命周期 : close(), reset(), with 语句
│   ├── 配置     : configure_model(), settings_public(), status(), test_connection(),
│   │              prompts(), tool_schemas()
│   ├── 模型后端 : use_backend(), use_scripted_model()
│   ├── 笔记     : list_notes, get_note, search_notes, save_note, export_note, delete_note
│   ├── 错题     : save_mistake, list_mistakes, mistake_summary, get_mistake
│   ├── 题库     : list_exercises, get_exercise, import_exercises, organize_exercises, update_exercise
│   ├── 复习     : review_catalog, select_review
│   ├── 对话     : chat
│   ├── 图片     : recognize_image, prepare_image, read_documents, capture_materials
│   ├── 资料     : parse_material_text, submit_material_job, get_material_job, list_material_jobs,
│   │              cancel_material_job, retry_material_job, remove_material_job, wait_material_job
│   ├── 确认     : preview_delete, preview_merge, confirm_proposal
│   └── 导出     : export_collection
├── HttpApiClient(base_url, timeout)      # 见第 7 节
├── 模型         : Note, Mistake, Exercise, CurrentQuestion, StudyEvent, ToolResult,
│                  ChatResult, ReviewSelection, MaterialJobResult
├── 后端         : ModelBackend, LocalBackend, ScriptedBackend
└── 异常         : ApiError, ConfigurationError, DataFileError, ModelFailure, NotFoundError, CancelledError
```

---

## 相关文档

- [API_USAGE.md](./API_USAGE.md) — HTTP 接入指南（curl / PowerShell / 错误码 / FAQ）
- [PROJECT_LAYOUT.md](./PROJECT_LAYOUT.md) — 前后端划分与模块职责
- [openapi.json](./openapi.json) — 字段级 HTTP 接口定义
- [README.md](./README.md) — 项目总览与启动
