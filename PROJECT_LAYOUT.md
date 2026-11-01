# 项目结构：前后端划分与接口接入

本文面向接手本项目的开发者，说明：

1. 哪些文件属于**后端**、哪些属于**前端**；
2. 前后端之间唯一的契约是什么；
3. 后端开发者可以怎样调用这些接口（curl / PowerShell / 浏览器 / OpenAPI）。

仓库里另有一份机器可读的接口定义：[`openapi.json`](./openapi.json)（OpenAPI 3.1）。
它由 [`tools/generate_openapi.py`](./tools/generate_openapi.py) 从 `web.py` 的路由生成，
`python tools/generate_openapi.py --check` 会校验它是否过期（单元测试 `tests/test_openapi.py` 也会跑这一步）。

---

## 1. 一句话架构

```
浏览器（HTML/CSS/JS，无构建步骤）
        │   HTTP + Cookie 会话，JSON 信封 {ok:…}
        ▼
Flask 应用（web.py：路由、鉴权、会话、取消）
        │   Python 函数调用
        ▼
业务与存储（agent / tools / materials / library / settings …）
        │
        ├── 本地 JSON：data/*.json（笔记、错题、题库、导出文件）
        ├── 本机 GLM-OCR 或云端识图（模型 API）
        └── 文字模型 API（DeepSeek 兼容 Chat Completions）
```

前后端**完全解耦**：前端只通过 `/api/*` 交换数据，不读服务器文件、不假设 Python 内部结构；
后端不关心谁在调用（网页、脚本、其他客户端都可以）。

---

## 2. 后端（Backend）

### 2.1 入口与运行方式

| 文件 | 作用 |
|---|---|
| [`web.py`](./web.py) | Web 服务：`create_app()` 组装应用，全部 `/api/*` 路由 |
| [`desktop.py`](./desktop.py) | Windows 桌面启动器（exe）：选择空闲端口、单实例锁、Tk 小窗口 |
| `start_web.cmd` / `start_cli.cmd` | 一键启动脚本 |
| `main.py` | 命令行版本（不经过 HTTP） |

启动源码版服务：

```powershell
cd "D:\DSH workplace\mini-study-agent-main"
python web.py --port 8765          # 默认 8765，只监听 127.0.0.1
```

### 2.2 业务模块（按职责）

| 模块 | 职责 | 是否依赖模型 |
|---|---|---|
| [`agent.py`](./agent.py) | 最小 Agent 循环：模型提议工具 → 程序执行 → 结果回填；拦截越权调用 | 是 |
| [`llm.py`](./llm.py) | 兼容 Chat Completions 的 HTTP 客户端（重试、退避、取消） | 是 |
| [`tools.py`](./tools.py) | 白名单工具：检索笔记、保存错题/笔记、选题、生成删除/合并预览 | 否 |
| [`materials.py`](./materials.py) | 资料拆题、分块、按页拆题、校正、题库读写 | 是 |
| [`material_locations.py`](./material_locations.py) | 试卷身份、题号归一、原页坐标绑定、整批答案对账 | 否 |
| [`material_sources.py`](./material_sources.py) | 原页采集（PDF 渲染、图片压缩、版面锚点） | 否 |
| [`material_jobs.py`](./material_jobs.py) | 后台整理队列（隔离、可取消、可只重试失败页） | 是 |
| [`document_input.py`](./document_input.py) | 统一读取图片 / PDF / TXT，文字型 PDF 本地提取 | 部分 |
| [`ocr.py`](./ocr.py) / [`local_ocr.py`](./local_ocr.py) / [`local_materials.py`](./local_materials.py) | 图片转写：云端识图 / 本机 GLM-OCR | 是 |
| [`library.py`](./library.py) / [`library_export.py`](./library_export.py) | 跨库选择、待确认删除/合并、事务日志、合集导出 | 否 |
| [`review_catalog.py`](./review_catalog.py) | 只读复习目录（知识点 → 细分标签）与选题 | 否 |
| [`note_exports.py`](./note_exports.py) / [`note_pdf.py`](./note_pdf.py) / `skills/` | 笔记导出 Markdown / PDF | 否 |
| [`materials.py` 中的 `QuestionBank`](./materials.py) | 已确认题目的题库（`data/exercises.json`） | 否 |
| [`settings.py`](./settings.py) | 本机配置（DPAPI 加密密钥、环境变量优先级） | 否 |
| [`cancellation.py`](./cancellation.py) | 取消令牌、可中断的网络等待 | 否 |
| [`classification.py`](./classification.py) / [`math_text.py`](./math_text.py) / [`prompts.py`](./prompts.py) / [`note_skill.py`](./note_skill.py) | 标签归一、公式兼容显示、提示词、笔记规则 | 否 |
| [`material_files.py`](./material_files.py) / [`file_preview.py`](./file_preview.py) | 会话内临时原文件与 PDF 预览缓存 | 否 |
| [`runtime_paths.py`](./runtime_paths.py) | 只读资源目录与用户数据目录 | 否 |
| [`build_windows.py`](./build_windows.py) | 打包 exe 与发布 zip | 否 |

### 2.3 数据文件

| 路径 | 内容 | 是否入 git |
|---|---|---|
| `data/notes.json` | 笔记（`content` 是唯一来源） | 否 |
| `data/mistakes.json` | 错题 | 否 |
| `data/exercises.json` | 已确认题目 | 否 |
| `data/trash.json` / `data/library.transaction.json` | 删除备份 / 批量操作事务日志 | 否 |
| `data/note_exports/` | 导出的 md / pdf | 否 |
| `.local-settings.json` | 本机配置（密钥加密） | 否 |
| `demo-data/` | 离线演示数据 | 否 |

### 2.4 测试与验收（全部是后端测试）

`tests/` 下的 `test_*.py` 使用 Flask 测试客户端直接调用接口，不启动浏览器；
启动浏览器级验收时用 `tests/serve_*_fixture.py` 起假模型服务。

```powershell
cd "D:\DSH workplace\mini-study-agent-main\tests"
$env:PYTHONPATH = "D:\DSH workplace\mini-study-agent-main"
..\.venv\Scripts\python.exe -m unittest discover -s . -p "test_*.py"
```

---

## 3. 前端（Frontend）

前端是**无需构建**的原生 HTML/CSS/JS，由 Flask 直接托管。

| 文件 | 职责 |
|---|---|
| [`templates/index.html`](./templates/index.html) | 唯一页面：导航、各视图骨架、对话框 |
| [`static/app.js`](./static/app.js) | 全局状态、`api()` 请求封装、对话、错题本渲染 |
| [`static/library.js`](./static/library.js) | 笔记库、勾选记录、删除/合并确认、合集导出 |
| [`static/materials.js`](./static/materials.js) | 资料导入区、预览核对、后台任务列表 |
| `static/material-*.js` | 资料读取、位置高亮、校正、容错重试 |
| `static/notes.js` / `static/review.js` / `static/settings.js` | 笔记、复习、模型设置 |
| `static/chat-*.js` | 输入框、消息队列（排队/停止并补充） |
| `static/file-preview.js` / `static/ocr-*.js` / `static/exercise-math.js` | PDF 预览、识图方式与进度、公式渲染 |
| `static/*.css` | 样式 |
| `static/vendor/` | 第三方库：marked、DOMPurify、KaTeX（离线分发） |

前端的约束：

- 所有请求都走 `api(path, options)`（`app.js` 顶部），它负责解析统一信封、把 `error` 抛成可展示的消息；
- 任何长请求都生成 `request_id`，用于 `/api/cancel` 停止与 `/api/operation` 轮询进度；
- 不直接读写文件，不信任服务端返回值以外的数据。

---

## 4. 接口契约（后端开发者重点）

### 4.1 通用约定

| 约定 | 说明 |
|---|---|
| 地址 | 只监听 `127.0.0.1`；桌面版端口随机，见数据目录下的 `desktop-instance.json` |
| 会话 | Cookie `session`（Flask 签名会话）。所有数据按会话隔离；先调用一次 `/api/status` 建立会话 |
| 成功 | `{ "ok": true, ... }`（部分接口是 `{ "ok": true, "data": {...} }`） |
| 失败 | `{ "ok": false, "error": "给用户看的中文原因" }`，HTTP 状态码表达类别 |
| 鉴权 | 无 API Key 鉴权（仅本机使用）；POST 会校验 `Origin`，跨站请求返回 403 |
| 请求编号 | 长请求都接受 `request_id`（≤100 字符），用于停止与轮询 |
| 停止 | 被取消的请求返回 **499**，响应体带 `cancelled: true`；`context_retained: true` 表示上下文已保留，可继续对话 |
| 并发 | 同一会话同时只允许一个前台请求，冲突返回 **409** |
| 大小上限 | 单张图片 8 MB、单个 PDF 256 MB、整批 512 MB、单次文字 80000 字；超出返回 413 |
| 缓存 | `/api/*` 响应头 `Cache-Control: no-store` |

错误状态码一览：`400` 参数非法、`403` 跨站请求、`404` 不存在、`409` 冲突（处理中/已变更/已过期）、
`413` 请求过大、`499` 用户停止、`500` 本地数据文件异常、`502` 模型服务异常、`503` 会话过多。

### 4.2 典型流程

**A. 首次接入**

```powershell
# 1) 建立会话并查看状态（-c 保存 Cookie）
curl.exe -c cookies.txt http://127.0.0.1:8765/api/status
# 2) 保存模型配置（密钥只会加密保存，响应不回显）
curl.exe -b cookies.txt -c cookies.txt -X POST http://127.0.0.1:8765/api/settings `
  -H "Content-Type: application/json" `
  -d '{"base_url":"https://api.deepseek.com","model":"deepseek-v4-pro","api_key":"<你的 Key>","ocr_model":"deepseek-flash"}'
```

**B. 整理一份原稿（同步接口示例）**

```powershell
# 1) 上传并读取（图片 / PDF / TXT）
curl.exe -b cookies.txt -X POST http://127.0.0.1:8765/api/intake/read -F "files=@作业.jpg" -F "request_id=req-1"
# 返回 { ok, text, image_ids, pages }
# 2) 对话整理（view=organize，带图片 id）
curl.exe -b cookies.txt -X POST http://127.0.0.1:8765/api/chat `
  -H "Content-Type: application/json" `
  -d '{"message":"请整理这份原稿","view":"organize","image_ids":["<上一步的 id>"],"request_id":"req-2"}'
# 返回 { ok, answer, events, proposals, current_question }
```

**C. 后台整理试卷（推荐给大文件）**

```
POST /api/materials/jobs（multipart 或 JSON）  → 202 { ok, job }
GET  /api/materials/jobs                     → 任务列表
GET  /api/materials/jobs/<id>                → 详情与预览（含 exercises / warnings / failures）
POST /api/materials/jobs/<id>/retry          → 只重试失败页
POST /api/exercises {confirmed:true, ...}    → 用户核对后入库
```

**D. 停止与“停止并补充”**

```
POST /api/cancel {"request_id":"req-2"}           → 立即停止（下一轮从原内容重新编辑）
POST /api/cancel {"request_id":"req-2","steer":true} → 停止但保留上下文，下一轮继续
GET  /api/operation?request_id=req-2             → 轮询进度
```

**E. 勾选记录的删除 / 合并（两段式确认）**

```
POST /api/library/delete-preview {"items":[{"kind":"note","id":"..."}]}  → 返回 proposal.id
POST /api/library/confirm {"proposal_id":"...","confirmed":true}         → 真正执行
```

### 4.3 接口索引（按标签）

| 标签 | 接口 |
|---|---|
| 系统 | `GET /api/status`、`GET /api/operation`、`POST /api/cancel`、`GET/POST /api/settings`、`POST /api/settings/model`、`POST /api/settings/test`、`GET /api/prompts`、`POST /api/reset`、`GET /api/desktop/status`（仅桌面版） |
| 学习内容 | `POST /api/intake/read`、`POST /api/intake/prepare`、`POST /api/intake/clear` |
| 笔记 | `GET /api/notes`、`POST /api/notes/read`、`POST /api/notes/<id>/export`、`GET /api/notes/<id>/download/<kind>` |
| 错题 | `GET /api/mistakes` |
| 复习 | `GET /api/review/catalog`、`POST /api/review/select` |
| 资料整理 | `POST/GET /api/materials/jobs`、`GET /api/materials/jobs/<id>`、`POST /api/materials/jobs/<id>/<action>`、`GET /api/materials/jobs/<id>/pages/<index>`、`GET /api/materials/files/<id>/pages/<page>`、`POST /api/materials/read`、`POST /api/materials/parse`、`POST /api/materials/revise`、`POST /api/materials/clear` |
| 资料题库 | `GET/POST /api/exercises`、`POST /api/exercises/organize`、`POST /api/exercises/<id>` |
| 对话 | `POST /api/chat`、`POST /api/chat/attachments` |
| 图片识图 | `POST /api/ocr`、`POST /api/ocr/backend` |
| 跨库操作 | `POST /api/library/delete-preview`、`POST /api/library/confirm`、`POST /api/library/export` |
| 文件预览 | `POST /api/files/preview`、`GET /api/files/preview/<id>/<page>` |

每个接口的字段、必填项、示例与错误码见 `openapi.json`，或直接看 `web.py` 中对应的 `def`。

### 4.4 在浏览器里调试

服务启动后打开：

```
http://127.0.0.1:8765/openapi.json      # 原始 JSON
```

想用 Swagger UI 之类的交互界面时，把该 JSON 导入任意 OpenAPI 工具即可（注意：工具需要能访问本机 127.0.0.1，
且请求要带上浏览器自带的会话 Cookie）；也可以直接用 `curl` / PowerShell 脚本调用。

### 4.5 用生成的 schema 校验

`openapi.json` 的 `components.schemas` 可以直接喂给代码生成器（如 `openapi-generator`、`oapi-codegen`）
生成各语言的客户端类型；请求/响应字段名以它为准。

---

## 5. 扩展指南

- **新增接口**：在 `web.py` 里加路由 → 在 `tools/generate_openapi.py` 的 `PATHS` 表补说明 →
  `python tools/generate_openapi.py` 重新生成 `openapi.json` → 跑 `tests/test_openapi.py`。
  缺少说明时生成器会直接报错，保证文档与代码同步。
- **新增字段**：同步更新 `components.schemas` 里对应的模型（如 `Note`、`Mistake`、`Exercise`）。
- **只能由程序做的写操作**：模型永远只能“提议”（工具返回 `requires_confirmation`），
  真正写库必须经过网页二次确认；新接口也应遵守这个约定。
- **不要在前端拼路径访问文件**：所有文件读写都走接口，导出与下载使用服务端返回的 URL。

---

## 6. 相关文档

- [PYTHON_API.md](./PYTHON_API.md) — Python API（`study_api`）使用文档
- [API_USAGE.md](./API_USAGE.md) — 接口使用指南（接入步骤、完整流程、错误处理、FAQ）
- [README.md](./README.md) — 项目总览与启动
- [WEB_GUIDE.md](./WEB_GUIDE.md) — 网页使用说明
- [MODEL_SETTINGS.md](./MODEL_SETTINGS.md) — 模型配置
- [LOCAL_OCR.md](./LOCAL_OCR.md) — 本机 GLM-OCR
- [SOURCE_AND_TAGS.md](./SOURCE_AND_TAGS.md) — 资料识别与标签
- [TUTORING.md](./TUTORING.md) — 教学规则
- [VALIDATION.md](./VALIDATION.md) — 验收清单
