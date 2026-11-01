"""生成前端与后端共用的接口描述文件 openapi.json。

用法（在项目根目录执行）：

    python tools/generate_openapi.py            # 重新生成 openapi.json
    python tools/generate_openapi.py --check    # 只比对，不写文件（CI / 单元测试用）

设计原则：
- 只读取 web.py 源码里的路由与文档字符串，不导入 Flask、不启动服务、不调用模型；
- 输出稳定（排序、固定缩进），便于在版本库里审阅差异；
- 每个接口的摘要、标签、请求体/响应模型都写在本文件的 PATHS 表里，
  web.py 新增路由而这里没有补充时，--check 会失败，防止文档过期。
"""

import json
import re
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]          # 项目根目录
WEB = ROOT / "web.py"
OUTPUT = ROOT / "openapi.json"

OK_ENVELOPE = {"$ref": "#/components/schemas/OkEnvelope"}
OK_DATA_ENVELOPE = {"$ref": "#/components/schemas/OkDataEnvelope"}
ERROR = {"$ref": "#/components/schemas/ErrorResponse"}


# ---------------------------------------------------------------------------- 工具函数
def json_body(ref, required=True):
    """JSON 请求体：引用 components.schemas 里的模型。"""
    return {"required": required, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/" + ref}}}}


def form_body(properties, required=()):
    """multipart/form-data 请求体（上传文件、表单字段）。"""
    return {"content": {"multipart/form-data": {"schema": {
        "type": "object", "properties": properties, "required": list(required)}}}}


def ok(description, schema=None, envelope=True, status=200):
    """成功响应：默认是统一信封 {ok:true,...}，也可指定具体模型与状态码。"""
    body = {"description": description}
    if schema is not None:
        body["content"] = {"application/json": {"schema": {"$ref": "#/components/schemas/" + schema}}}
    elif envelope:
        body["content"] = {"application/json": {"schema": OK_ENVELOPE}}
    return {str(status): body}


def err(status, description):
    """错误响应：统一使用 ErrorResponse。"""
    return {str(status): {"description": description, "content": {"application/json": {"schema": ERROR}}}}


def binary(description):
    return {"200": {"description": description, "content": {
        "application/octet-stream": {"schema": {"type": "string", "format": "binary"}},
        "application/pdf": {"schema": {"type": "string", "format": "binary"}},
        "image/jpeg": {"schema": {"type": "string", "format": "binary"}},
        "text/markdown": {"schema": {"type": "string", "format": "binary"}},
        "application/json": {"schema": {"type": "object"}},
    }}}


def param(name, location, description, schema, required=True):
    return {"name": name, "in": location, "description": description, "required": required, "schema": schema}


TEXT = {"type": "string"}
BOOL = {"type": "boolean"}
FORM_FILE = {"type": "string", "format": "binary"}


# ---------------------------------------------------------------------------- 路由说明表
# 键与 web.py 中的装饰器路径一致（含 <参数>）；缺失的路由会被 --check 报错。
PATHS = {
    "/api/status": {
        "get": dict(
            summary="服务与配置状态", tags=["系统"],
            description="前端启动时调用：确认是否已配置模型、当前对话模型、识图方式（本机 GLM / 云端）、版本号。不返回任何密钥。",
            responses={**ok("当前状态", "Status"), **err(500, "本机配置文件损坏")},
        )
    },
    "/api/operation": {
        "get": dict(
            summary="查询进行中请求的进度", tags=["系统"],
            description="长时间请求（识别图片、整理资料）期间轮询。request_id 与当前前台请求一致时返回其进度，否则返回空对象。",
            parameters=[param("request_id", "query", "前端生成的请求编号；不传则只报告是否有请求在运行。", TEXT, required=False)],
            responses={**ok("进度信息", "OperationProgress")},
        )
    },
    "/api/cancel": {
        "post": dict(
            summary="停止当前请求（可选保留上下文）", tags=["系统"],
            description=(
                "停止正在进行的请求。request_id 与当前请求一致时立即停止；若该编号尚未开始（前端先点了停止），"
                "会被记下来，等请求开始时直接返回 499。steer=true 表示“停止并补充”：保留已产生的上下文，"
                "下一轮对话继续同一话题。"
            ),
            requestBody=json_body("CancelRequest"),
            responses={**ok("已发出停止指令"), **err(400, "request_id 或 steer 格式有误"), **err(499, "请求已被停止")},
        )
    },
    "/api/settings": {
        "get": dict(summary="读取模型设置（不含密钥）", tags=["系统"], parameters=[],
                    responses={**ok("当前设置（settings）", "SettingsResponse"), **err(500, "配置文件损坏")}),
        "post": dict(
            summary="保存模型设置", tags=["系统"],
            description="保存接口地址、API Key、模型名称与识图方式。API Key 在 Windows 上用当前用户的 DPAPI 加密存储；响应中永远不会回显密钥。有请求正在处理时返回 409。",
            requestBody=json_body("SettingsInput"),
            responses={**ok("当前设置（settings）", "SettingsResponse"), **err(400, "字段非法"), **err(409, "有请求正在处理中")},
        ),
    },
    "/api/settings/model": {
        "post": dict(
            summary="快速切换对话模型", tags=["系统"],
            description="只修改 model 字段，其余配置（密钥、地址、OCR 设置）保持不变；有请求正在处理时返回 409。",
            requestBody=json_body("ModelSwitch"),
            responses={**ok("当前设置（settings）", "SettingsResponse"), **err(400, "模型名称非法"), **err(409, "有请求正在处理中")},
        )
    },
    "/api/settings/test": {
        "post": dict(
            summary="测试连接", tags=["系统"],
            description="用提交的配置发一次极小的模型请求验证连通性，不保存配置。",
            requestBody=json_body("SettingsInput"),
            responses={**ok("连接结果（message）", "OkEnvelope"), **err(400, "字段非法"), **err(502, "模型服务不可用")},
        )
    },
    "/api/prompts": {
        "get": dict(summary="查看实际下发的提示词规则", tags=["系统"],
                    responses={**ok("各类提示词", "Prompts"), **err(500, "读取失败")}),
    },
    "/api/reset": {
        "post": dict(summary="清除临时会话", tags=["系统"],
                     description="清空本会话的对话上下文、临时图片与待确认方案；已保存的笔记/错题/题库不受影响。请求处理中返回 409。",
                     responses={**ok("已清除"), **err(409, "有请求正在处理中")}),
    },
    "/api/desktop/status": {
        "get": dict(summary="桌面版实例标识（仅 exe 模式）", tags=["系统"],
                    description="由 desktop.py 在 create_app() 之后注册，仅桌面版（exe）提供；源码版 web.py 不提供此接口。重复双击 exe 时用它核对端口上的服务身份。",
                    responses={**ok("实例标识", "DesktopStatus")}),
    },
    "/api/ocr": {
        "post": dict(
            summary="单张作业图片转写", tags=["图片识图", "学习内容"],
            description="把图片转成文字（不解题、不入库）。文字型/扫描型都可用；本机 GLM 模式不消耗 API 额度。",
            requestBody=form_body({
                "image": FORM_FILE,
                "request_id": dict(TEXT, description="前端请求编号，用于停止与轮询进度"),
            }, required=["image"]),
            responses={**ok("转写文本", "OcrText"), **err(400, "没有图片 / 图片无法读取"), **err(409, "有请求正在处理中"),
                       **err(499, "已停止"), **err(502, "识别模型不可用"), **err(413, "请求过大")},
        )
    },
    "/api/ocr/backend": {
        "post": dict(summary="切换识图方式", tags=["图片识图", "系统"],
                     description="local=本机 GLM-OCR（不联网、不消耗额度）；remote=云端识图；auto 由服务端按可用性选择。已有前台请求时返回 409。",
                     requestBody=json_body("OcrBackend"),
                     responses={**ok("切换后的状态", "Status"), **err(400, "取值非法或本机模型未安装"), **err(409, "有请求正在处理中")}),
    },
    "/api/notes": {
        "get": dict(summary="笔记列表（新在前）", tags=["笔记"], responses={**ok("笔记列表", "NoteList"), **err(500, "笔记文件损坏")}),
    },
    "/api/notes/<note_id>/download/<kind>": {
        "get": dict(summary="下载已导出的笔记文件", tags=["笔记"],
                    description="只能下载与当前正文一致的导出版本；内容已变化时返回 409，需重新导出。",
                    parameters=[param("note_id", "path", "笔记 id（sha256 前 16 位）", TEXT),
                                param("kind", "path", "md 或 pdf", {"type": "string", "enum": ["md", "pdf"]})],
                    responses={**binary("笔记文件"), **err(404, "笔记或文件不存在"), **err(409, "导出版本已过期"), **err(500, "读取失败")}),
    },
    "/api/notes/<note_id>/export": {
        "post": dict(summary="重新导出笔记（Markdown/PDF）", tags=["笔记"],
                     description="Markdown 一定可用；PDF 失败时仍返回 200，并在 exports.pdf.ok=false 中给出原因，不会丢笔记。",
                     parameters=[param("note_id", "path", "笔记 id", TEXT)],
                     requestBody=json_body("RequestIdBody", required=False),
                     responses={**ok("导出结果", "ExportResult"), **err(404, "笔记不存在"), **err(409, "有请求正在处理中"),
                                **err(499, "排版已停止")}),
    },
    "/api/notes/read": {
        "post": dict(summary="读取一份笔记原稿（图片/文字）", tags=["笔记"],
                     description="TXT/Markdown 直接按 UTF-8 读取；图片走识图。用于“添加学习内容”页的笔记入口。",
                     requestBody=form_body({
                         "file": FORM_FILE,
                         "keep_image_ids": dict(TEXT, description="JSON 数组字符串：已有的原图 id"),
                         "request_id": dict(TEXT, description="前端请求编号"),
                     }, required=["file"]),
                     responses={**ok("原稿文字", "OcrText"), **err(400, "文件类型或大小不合法"), **err(409, "有请求正在处理中"),
                                **err(499, "已停止"), **err(502, "识别失败")}),
    },
    "/api/mistakes": {
        "get": dict(summary="错题统计与列表", tags=["错题"],
                    responses={**ok("错题数据", "MistakeData"), **err(500, "错题文件损坏")}),
    },
    "/api/exercises": {
        "get": dict(summary="资料题库列表", tags=["资料题库"],
                    responses={**ok("题目列表与版本指纹", "ExerciseList"), **err(500, "题库文件损坏")}),
        "post": dict(
            summary="确认入库题目", tags=["资料题库"],
            description="必须带 confirmed=true（用户核对后）；同来源+同题号+同题干视为重复，不会重复写入。带 job_id 时会把该批次的来源信息一并保存。",
            requestBody=json_body("ExerciseImport"),
            responses={**ok("入库结果", "ExerciseImportResult"), **err(400, "未确认或题目格式有误"), **err(409, "批次已过期")},
        ),
    },
    "/api/exercises/organize": {
        "post": dict(summary="批量设置试卷归属与细题型", tags=["资料题库"],
                     description="带 revision 做乐观锁校验，任一题目版本过期则整批不写。",
                     requestBody=json_body("ExerciseOrganize"),
                     responses={**ok("更新数量", "ExerciseOrganizeResult"), **err(400, "未确认或参数有误"), **err(409, "题目已变更或删除")}),
    },
    "/api/exercises/<identity>": {
        "post": dict(summary="修改一道题", tags=["资料题库"],
                     description="必须带 confirmed=true 与当前 revision；revision 与服务端不一致时返回 409，不会覆盖别人的修改。",
                     parameters=[param("identity", "path", "题目 id", TEXT)],
                     requestBody=json_body("ExerciseEdit"),
                     responses={**ok("修改后的题目与新的 revision", "ExerciseEditResult"), **err(400, "未确认或格式有误"), **err(409, "版本冲突或重复")}),
    },
    "/api/review/catalog": {
        "get": dict(summary="复习目录（知识点 → 细分标签）", tags=["复习"],
                    description="只读投影：把题库与错题按知识点归类，附数量统计。不含参考答案与错因。",
                    parameters=[param("source", "query", "exercise / mistake / any", {"type": "string", "enum": ["any", "exercise", "mistake"]}, required=False)],
                    responses={**ok("目录树", "ReviewCatalog"), **err(400, "source 取值非法")}),
    },
    "/api/review/select": {
        "post": dict(summary="按目录选题", tags=["复习"],
                     description="按知识点/细分标签/来源选出一道原题并设为“当前题”。纯本地读取，不调用模型。",
                     requestBody=json_body("ReviewSelection"),
                     responses={**ok("当前题", "ReviewSelectionResult"), **err(400, "筛选条件非法"), **err(409, "有请求正在处理中"),
                                **err(499, "已停止")}),
    },
    "/api/chat": {
        "post": dict(
            summary="与学习助手对话（核心接口）", tags=["对话"],
            description=(
                "所有对话页共用的接口，按 view 区分：\n"
                "- organize：整理混合原稿（笔记 + 错题），可带图片；\n"
                "- notes：整理笔记；\n"
                "- review：复习答疑，只看当前题，可附图作答；\n"
                "- analysis：分析勾选的笔记/错题/题目，可生成待确认的删除/合并方案。\n"
                "同一会话同时只允许一个请求（否则 409）；用 request_id 停止或轮询进度。"
                "停止返回 499，context_retained=true 表示已保留上下文可继续对话。"
            ),
            requestBody=json_body("ChatRequest"),
            responses={**ok("回答与事件轨迹", "ChatResponse"), **err(400, "参数非法"), **err(404, "指定的题目不存在"),
                       **err(409, "有请求正在处理中 / 图片过期 / 记录已变更"), **err(499, "已停止（可带 context_retained）"),
                       **err(502, "模型服务失败"), **err(503, "会话过多")},
        )
    },
    "/api/chat/attachments": {
        "post": dict(summary="上传复习作答图片", tags=["对话", "图片识图"],
                     description="只在 view=review 时可用，需先选题。上传阶段只做校验与压缩，不调用模型；随后的 /api/chat 才会识别。",
                     requestBody=form_body({
                         "view": dict(TEXT, description="固定为 review", enum=["review"]),
                         "files": {"type": "array", "items": FORM_FILE, "maxItems": 4},
                         "request_id": dict(TEXT, description="前端请求编号"),
                     }, required=["view", "files"]),
                     responses={**ok("暂存成功", "AssignmentUpload"), **err(400, "格式/数量不合法"), **err(409, "尚未选题或暂存已满"),
                                **err(499, "已停止")}),
    },
    "/api/intake/read": {
        "post": dict(summary="统一入口：读取混合原稿", tags=["学习内容"],
                     description="一次上传 1–20 个图片/PDF/TXT/MD，返回合并后的文字、可分页预览的原始图片 id 与每页来源。",
                     requestBody=form_body({
                         "files": {"type": "array", "items": FORM_FILE},
                         "page_range": dict(TEXT, description="PDF 页码范围，如 1-8 或 1,3,5-8"),
                         "keep_image_ids": dict(TEXT, description="JSON 数组字符串：保留的旧图片 id"),
                         "request_id": dict(TEXT, description="前端请求编号"),
                     }, required=["files"]),
                     responses={**ok("读取结果", "IntakeReadResult"), **err(400, "文件或页码非法"), **err(409, "有请求正在处理中"),
                                **err(499, "已停止"), **err(502, "识别失败")}),
    },
    "/api/intake/prepare": {
        "post": dict(summary="统一入口：只准备原页、不识别", tags=["学习内容"],
                     description="把上传的图片/PDF 转成“原页图像 + 版面标签”，直接交给视觉模型拆题时不产生文字中间层。不调用模型。",
                     requestBody=form_body({
                         "files": {"type": "array", "items": FORM_FILE},
                         "page_range": TEXT,
                         "keep_image_ids": TEXT,
                         "request_id": TEXT,
                     }, required=["files"]),
                     responses={**ok("原页与元数据", "IntakePrepareResult"), **err(400, "文件或页码非法"), **err(409, "有请求正在处理中"), **err(499, "已停止")}),
    },
    "/api/intake/clear": {
        "post": dict(summary="清空统一入口的上传区", tags=["学习内容"],
                     description="清空整理页的临时对话与原图（不影响复习问答、已保存记录）。",
                     requestBody=json_body("ClearBody", required=False),
                     responses={**ok("已清空"), **err(400, "参数非法"), **err(409, "有请求正在处理中")}),
    },
    "/api/materials/read": {
        "post": dict(summary="资料页：读取资料文字", tags=["资料整理"],
                     description="可上传文件，也可传入之前保留的原文件 id；文字型 PDF 本地提取，扫描件走识图。",
                     requestBody=form_body({
                         "files": {"type": "array", "items": FORM_FILE},
                         "source_file_ids": dict(TEXT, description="JSON 数组字符串：保留的原文件 id"),
                         "page_range": TEXT,
                         "request_id": TEXT,
                     }),
                     responses={**ok("资料文字与页信息", "MaterialText"), **err(400, "参数非法"), **err(409, "有请求正在处理中"),
                                **err(499, "已停止"), **err(502, "识别失败")}),
    },
    "/api/materials/parse": {
        "post": dict(summary="资料页：同步拆题（小批量）", tags=["资料整理"],
                     description="把已读取的文字拆成题目 JSON，只返回预览。批量/原图整理请用 /api/materials/jobs。",
                     requestBody=json_body("MaterialParse"),
                     responses={**ok("题目预览", "MaterialParseResult"), **err(400, "参数非法"), **err(409, "有请求正在处理中"),
                                **err(499, "已停止"), **err(502, "模型输出不可用")}),
    },
    "/api/materials/jobs": {
        "get": dict(summary="后台整理任务列表", tags=["资料整理"],
                    responses={**ok("任务列表", "MaterialJobList"), **err(400, "参数非法")}),
        "post": dict(
            summary="提交后台整理任务（推荐）", tags=["资料整理"],
            description="提交后立即返回 202 与任务 id，后台线程去识别/拆题；用户核对预览后才入库。表单一式（带 files）与 JSON 两种提交方式都支持。",
            requestBody=dict(content={
                "multipart/form-data": {"schema": {"type": "object", "properties": {
                    "files": {"type": "array", "items": FORM_FILE},
                    "source": TEXT, "page_range": TEXT, "text": TEXT}}},
                "application/json": {"schema": {"$ref": "#/components/schemas/MaterialJobSubmit"}},
            }),
            responses={**ok("已排队", "MaterialJobSubmitResult", status=202),
                       **err(400, "资料名称/内容/页数非法"), **err(409, "排队过多或缓存已满")},
        ),
    },
    "/api/materials/jobs/<identity>": {
        "get": dict(summary="任务详情（含完整预览）", tags=["资料整理"],
                    parameters=[param("identity", "path", "任务 id", TEXT)],
                    responses={**ok("任务详情", "MaterialJobDetail"), **err(404, "任务不存在或已过期")}),
    },
    "/api/materials/jobs/<identity>/<action>": {
        "post": dict(summary="任务操作：停止 / 移除 / 重试", tags=["资料整理"],
                     description="action=cancel 只停止（预览保留）；remove 从列表移除；retry 只重做失败的页（已成功部分复用缓存）。",
                     parameters=[param("identity", "path", "任务 id", TEXT),
                                 param("action", "path", "操作", {"type": "string", "enum": ["cancel", "remove", "retry"]})],
                     responses={**ok("最新任务状态", "MaterialJob"), **err(404, "任务不存在"), **err(409, "当前状态不允许该操作")}),
    },
    "/api/materials/jobs/<identity>/pages/<int:index>": {
        "get": dict(summary="任务原页预览", tags=["资料整理"],
                    parameters=[param("identity", "path", "任务 id", TEXT),
                                param("index", "path", "批次内页索引（从 1 开始）", {"type": "integer", "minimum": 1})],
                    responses={**binary("原页 JPEG"), **err(404, "原页不存在或已过期")}),
    },
    "/api/materials/files/<identity>/pages/<int:page>": {
        "get": dict(summary="保留原文件的任意页预览", tags=["资料整理"],
                    description="上传的原 PDF 会被临时保留，用于预览、续读和作为新任务的来源。",
                    parameters=[param("identity", "path", "保留文件 id", TEXT),
                                param("page", "path", "文件页码（从 1 开始）", {"type": "integer", "minimum": 1})],
                    responses={**binary("页面 JPEG"), **err(404, "文件不存在或已过期")}),
    },
    "/api/materials/revise": {
        "post": dict(summary="按用户要求校正某批预览", tags=["资料整理"],
                     description="只返回建议的修改（before/fields/reason），不直接改库；可附带题目局部图。",
                     requestBody=dict(content={
                         "application/json": {"schema": {"$ref": "#/components/schemas/MaterialRevise"}},
                         "multipart/form-data": {"schema": {"type": "object", "properties": {
                             "image": FORM_FILE,
                             "payload": dict(TEXT, description="JSON 字符串：与 application/json 相同的字段")}}},
                     }),
                     responses={**ok("修改建议", "MaterialReviseResult"), **err(400, "参数非法"), **err(409, "批次已过期或请求处理中"),
                                **err(499, "已停止"), **err(502, "模型输出不可用")}),
    },
    "/api/materials/clear": {
        "post": dict(summary="清空资料页上传区", tags=["资料整理"],
                     description="删除临时预览与不再被任务引用的原文件；已入库内容与后台任务保留。",
                     requestBody=json_body("MaterialClear"),
                     responses={**ok("已清空"), **err(400, "参数非法")}),
    },
    "/api/files/preview": {
        "post": dict(summary="上传 PDF 用于逐页预览", tags=["文件预览"],
                     description="不调用模型、不入库；按会话隔离，30 分钟过期，单会话最多 3 份。",
                     requestBody=form_body({"file": FORM_FILE}, required=["file"]),
                     responses={**ok("预览文档", "PreviewDocument"), **err(400, "不是 PDF / 加密 / 过大")}),
    },
    "/api/files/preview/<document_id>/<int:page>": {
        "get": dict(summary="预览 PDF 的某一页", tags=["文件预览"],
                    parameters=[param("document_id", "path", "预览文档 id", TEXT),
                                param("page", "path", "页码（从 1 开始）", {"type": "integer", "minimum": 1})],
                    responses={**binary("页面 JPEG"), **err(404, "预览过期或页码越界")}),
    },
    "/api/library/delete-preview": {
        "post": dict(summary="批量删除：生成待确认清单", tags=["跨库操作"],
                     description="不删除任何数据，只返回快照与 proposal id，用户确认后再调用 /api/library/confirm。",
                     requestBody=json_body("RecordRefs"),
                     responses={**ok("待确认方案", "ProposalResult"), **err(400, "记录格式非法"), **err(409, "有请求正在处理中")}),
    },
    "/api/library/confirm": {
        "post": dict(summary="批量删除/合并：执行确认", tags=["跨库操作"],
                     description="必须带 confirmed=true 与预览时返回的 proposal_id（15 分钟内有效，且只能由本会话使用）。合并时可用 note 传入用户编辑后的正文。",
                     requestBody=json_body("ConfirmRequest"),
                     responses={**ok("执行结果", "ConfirmResult"), **err(400, "未确认或格式有误"), **err(409, "预览已过期或记录已变更"),
                                **err(499, "已停止")}),
    },
    "/api/library/export": {
        "post": dict(summary="导出勾选内容的合集", tags=["跨库操作"],
                     description="返回 md/pdf/json 其中一种文件（附件下载），不调用模型、不改动原记录。",
                     requestBody=json_body("ExportRequest"),
                     responses={**binary("合集文件"), **err(400, "格式或记录非法"), **err(409, "有请求正在处理中"), **err(499, "已停止")}),
    },
}


# ---------------------------------------------------------------------------- 共享模型
def ref(name):
    return {"$ref": "#/components/schemas/" + name}


SCHEMAS = {
    "ErrorResponse": {
        "type": "object",
        "description": "统一错误信封。HTTP 状态码表达类别，error 字段是可直接展示给用户的中文说明。",
        "required": ["ok", "error"],
        "properties": {
            "ok": {"type": "boolean", "const": False},
            "error": {"type": "string", "description": "可展示给用户的错误说明"},
            "events": {"type": "array", "items": ref("StudyEvent"), "description": "出错前已发生的工具事件"},
            "cancelled": {"type": "boolean", "description": "是否为用户主动停止"},
            "context_retained": {"type": "boolean", "description": "停止时是否保留了对话上下文（steer）"},
        },
        "additionalProperties": False,
    },
    "OkEnvelope": {
        "type": "object", "description": "成功信封：ok=true，其余字段因接口而异。",
        "required": ["ok"], "properties": {"ok": {"type": "boolean", "const": True}},
        "additionalProperties": True,
    },
    "OkDataEnvelope": {
        "type": "object", "required": ["ok", "data"],
        "properties": {"ok": {"type": "boolean", "const": True}, "data": {}},
        "additionalProperties": True,
    },
    "RecordRef": {
        "type": "object", "description": "跨库记录引用：kind + id。",
        "required": ["kind", "id"],
        "properties": {
            "kind": {"type": "string", "enum": ["note", "mistake", "exercise"]},
            "id": {"type": "string", "minLength": 1, "maxLength": 120},
        },
        "additionalProperties": False,
    },
    "RecordRefs": {
        "type": "object", "required": ["items"],
        "properties": {"items": {"type": "array", "minItems": 1, "maxItems": 30, "items": ref("RecordRef")}},
        "additionalProperties": False,
    },
    "Note": {
        "type": "object", "description": "一条笔记。content 是保存的原文；display_content 是做了纯文本公式兼容转换后的展示版。",
        "required": ["id", "topic", "content"],
        "properties": {
            "id": {"type": "string", "description": "内容哈希前 16 位"},
            "topic": {"type": "string"},
            "content": {"type": "string", "description": "原始 Markdown（导出/展示的唯一来源）"},
            "display_content": {"type": "string", "description": "仅列表接口返回：公式已转换的展示版"},
            "downloads": {"type": "object", "description": "kind → 下载地址；只包含与当前正文一致的导出版本",
                          "additionalProperties": {"type": "string"}},
            "created_at": {"type": "string", "format": "date-time"},
            "source_refs": {"type": "array", "items": ref("RecordRef"), "description": "合并生成时记录的来源"},
        },
        "additionalProperties": True,
    },
    "Mistake": {
        "type": "object", "description": "一条错题（同一题目+同一错误答案只存一份）。",
        "required": ["id", "question", "user_answer", "correct_answer", "reason", "topic"],
        "properties": {
            "id": {"type": "string"},
            "question": {"type": "string", "maxLength": 8000},
            "user_answer": {"type": "string", "maxLength": 8000},
            "correct_answer": {"type": "string", "maxLength": 8000},
            "reason": {"type": "string", "maxLength": 8000},
            "topic": {"type": "string", "maxLength": 8000},
            "created_at": {"type": "string", "format": "date-time"},
        },
    },
    "Exercise": {
        "type": "object", "description": "题库中的一道已确认题目。练习接口只返回题干，不返回答案。",
        "required": ["id", "source", "number", "topic", "question", "answer"],
        "properties": {
            "id": {"type": "string"},
            "source": {"type": "string", "maxLength": 180},
            "number": {"type": "string", "maxLength": 80, "description": "保留大题节号，如 二、2"},
            "topic": {"type": "string", "maxLength": 120},
            "question": {"type": "string", "maxLength": 8000},
            "answer": {"type": "string", "maxLength": 8000, "description": "资料中的参考答案；没有则为空串"},
            "paper": {"type": "string", "maxLength": 160, "description": "完整试卷标题（含前缀编号）"},
            "tags": {"type": "array", "items": {"type": "string", "maxLength": 40}, "maxItems": 8},
            "page_index": {"type": "integer", "minimum": 1, "maximum": 100},
            "answer_page_indices": {"type": "array", "items": {"type": "integer"}},
            "origin_regions": {"type": "array", "items": ref("Region")},
            "source_anchor": {"type": "string"},
            "provenance": {"type": "object", "description": "入库时记录的文件/页码范围/批次号"},
            "created_at": {"type": "string", "format": "date-time"},
            "updated_at": {"type": "string", "format": "date-time"},
        },
    },
    "Region": {
        "type": "object", "description": "原页上的归一化矩形（0–1，左上到右下）。",
        "required": ["page_index", "role", "bbox"],
        "properties": {
            "page_index": {"type": "integer", "minimum": 1, "maximum": 100},
            "role": {"type": "string", "enum": ["question", "answer"]},
            "bbox": {"type": "array", "minItems": 4, "maxItems": 4, "items": {"type": "number", "minimum": 0, "maximum": 1}},
        },
    },
    "StudyEvent": {
        "type": "object", "description": "Agent 的一步事件（请求模型 / 工具请求 / 工具结果），前端据此展示保存结果。",
        "required": ["event", "value"],
        "properties": {
            "event": {"type": "string", "enum": ["请求模型", "工具请求", "工具结果"]},
            "value": {"type": "object"},
        },
    },
    "Proposal": {
        "type": "object", "description": "待用户确认的删除/合并方案（服务器保存快照，15 分钟内有效）。",
        "required": ["id", "type", "items"],
        "properties": {
            "id": {"type": "string"},
            "type": {"type": "string", "enum": ["delete", "merge"]},
            "items": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
            "note": {"type": "object", "description": "仅合并：{topic, content}"},
        },
    },
    "CurrentQuestion": {
        "type": "object", "description": "“当前题”白名单视图：不含答案、错因与历史作答。",
        "required": ["id", "kind", "topic", "question"],
        "properties": {
            "id": {"type": "string", "description": "exercise:<id> / mistake:<id> / generated"},
            "kind": {"type": "string", "enum": ["exercise", "mistake", "generated"]},
            "topic": {"type": "string"},
            "question": {"type": "string"},
            "tags": {"type": "array", "items": {"type": "string"}},
            "source": {"type": "string"},
            "number": {"type": "string"},
            "paper": {"type": "string"},
        },
    },
    "MaterialJob": {
        "type": "object", "description": "后台整理任务摘要。",
        "required": ["id", "source", "status"],
        "properties": {
            "id": {"type": "string"},
            "source": {"type": "string"},
            "status": {"type": "string", "enum": ["queued", "running", "ready", "failed", "cancelled"]},
            "created_at": {"type": "number", "description": "Unix 时间戳"},
            "updated_at": {"type": "number"},
            "progress": {"type": "object"},
            "error": {"type": "string"},
            "metadata": {"type": "object", "description": "来源文件、页码范围、批次号、识图方式"},
            "count": {"type": "integer", "description": "已拆出的题目数"},
            "failed_parts": {"type": "integer", "description": "失败的页组数"},
            "source_files": {"type": "array", "items": {"type": "object"}, "description": "保留的原文件引用"},
        },
    },
    "Settings": {
        "type": "object", "required": ["base_url", "model", "ocr_model", "ocr_backend"],
        "properties": {
            "base_url": {"type": "string", "description": "文字模型接口地址（HTTPS 或本机 HTTP）"},
            "model": {"type": "string"},
            "ocr_base_url": {"type": "string"},
            "ocr_model": {"type": "string"},
            "ocr_backend": {"type": "string", "enum": ["auto", "local", "remote"]},
            "api_key": {"type": "string", "description": "仅输入：保存后不再返回"},
            "ocr_api_key": {"type": "string", "description": "仅输入"},
        },
    },
    "SettingsResponse": {
        "type": "object",
        "description": "GET/POST /api/settings 与 POST /api/settings/model 的共同返回结构。",
        "required": ["ok", "settings"],
        "properties": {
            "ok": {"type": "boolean", "const": True},
            "settings": ref("PublicSettings"),
        },
    },
    "PublicSettings": {
        "type": "object", "description": "可安全展示的设置：永远不含密钥明文。",
        "required": ["base_url", "model", "ocr_model", "ocr_backend", "configured"],
        "properties": {
            "base_url": {"type": "string"}, "model": {"type": "string"},
            "ocr_base_url": {"type": "string"}, "ocr_model": {"type": "string"},
            "ocr_backend": {"type": "string", "enum": ["auto", "local", "remote"]},
            "configured": {"type": "boolean"},
            "key_saved": {"type": "boolean"},
            "ocr_key_saved": {"type": "boolean"},
            "storage": {"type": "string", "description": "密钥存储方式说明"},
        },
    },
    "SettingsInput": {
        "type": "object", "description": "保存设置的请求体：空字符串表示沿用原值。",
        "properties": {
            "base_url": {"type": "string", "maxLength": 2000},
            "model": {"type": "string", "maxLength": 2000},
            "ocr_base_url": {"type": "string", "maxLength": 2000},
            "ocr_model": {"type": "string", "maxLength": 2000},
            "ocr_backend": {"type": "string", "enum": ["auto", "local", "remote"]},
            "api_key": {"type": "string", "maxLength": 8000},
            "ocr_api_key": {"type": "string", "maxLength": 8000},
        },
    },
    "ModelSwitch": {"type": "object", "required": ["model"],
                    "properties": {"model": {"type": "string", "maxLength": 2000}}, "additionalProperties": False},
    "Status": {
        "type": "object", "required": ["ok", "configured", "model", "version"],
        "properties": {
            "ok": {"type": "boolean", "const": True},
            "configured": {"type": "boolean", "description": "是否已配置可用密钥"},
            "model": {"type": "string"},
            "ocr_model": {"type": "string"},
            "version": {"type": "string", "description": "前端用它检测旧版后端"},
            "local_ocr": {"type": "boolean"},
            "ocr_backend": {"type": "string", "enum": ["auto", "local", "remote"]},
            "local_ocr_available": {"type": "boolean"},
            "local_ocr_status": {"type": "object"},
            "capabilities": {"type": "array", "items": {"type": "string"}},
        },
    },
    "DesktopStatus": {"type": "object", "required": ["ok", "app", "instance"],
                      "properties": {"ok": {"type": "boolean", "const": True}, "app": {"type": "string"},
                                     "instance": {"type": "string"}}},
    "OperationProgress": {
        "type": "object", "required": ["ok", "active"],
        "properties": {"ok": {"type": "boolean", "const": True}, "active": {"type": "boolean"},
                       "progress": {"type": "object", "description": "phase/message/completed/total"}},
    },
    "CancelRequest": {
        "type": "object",
        "properties": {
            "request_id": dict(TEXT, maxLength=100, description="要停止的请求编号；省略则停止当前请求"),
            "steer": dict(BOOL, description="true=停止并补充（保留上下文）"),
        },
        "additionalProperties": False,
    },
    "OcrBackend": {"type": "object", "required": ["backend"],
                   "properties": {"backend": {"type": "string", "enum": ["auto", "local", "remote"]}},
                   "additionalProperties": False},
    "OcrText": {"type": "object", "required": ["ok", "text"],
                "properties": {"ok": {"type": "boolean", "const": True}, "text": {"type": "string"},
                               **{"image_id": dict(TEXT, description="笔记原稿接口返回：可用于后续对话的图片 id"),
                                  "image_ids": {"type": "array", "items": {"type": "string"}}}}},
    "RequestIdBody": {"type": "object", "properties": {"request_id": dict(TEXT, maxLength=100)},
                      "additionalProperties": False},
    "Prompts": {"type": "object", "required": ["ok", "prompts"],
                "properties": {"ok": {"type": "boolean", "const": True},
                               "prompts": {"type": "object", "additionalProperties": {"type": "string"}}}},
    "NoteList": {"type": "object", "required": ["ok", "notes", "total"],
                 "properties": {"ok": {"type": "boolean", "const": True},
                                "notes": {"type": "array", "items": ref("Note")},
                                "total": {"type": "integer"}}},
    "ExportResult": {
        "type": "object", "required": ["ok", "note", "exports"],
        "properties": {
            "ok": {"type": "boolean", "const": True}, "note": ref("Note"),
            "exports": {"type": "object", "additionalProperties": {
                "type": "object", "properties": {"ok": {"type": "boolean"}, "path": {"type": "string"},
                                                 "error": {"type": "string"}}}},
        },
    },
    "MistakeData": {
        "type": "object", "required": ["ok", "data"],
        "properties": {
            "ok": {"type": "boolean", "const": True},
            "data": {"type": "object", "required": ["total", "topic_counts", "mistakes"],
                     "properties": {"total": {"type": "integer"},
                                    "topic_counts": {"type": "object", "additionalProperties": {"type": "integer"}},
                                    "mistakes": {"type": "array", "items": ref("Mistake")}}},
        },
    },
    "ExerciseList": {
        "type": "object", "required": ["ok", "exercises", "total", "revisions"],
        "properties": {"ok": {"type": "boolean", "const": True},
                       "exercises": {"type": "array", "items": ref("Exercise")},
                       "total": {"type": "integer"},
                       "revisions": {"type": "object", "description": "id → 内容指纹；修改时作为乐观锁的 revision",
                                     "additionalProperties": {"type": "string"}}},
    },
    "ExerciseImport": {
        "type": "object", "required": ["source", "exercises", "confirmed"],
        "properties": {
            "source": {"type": "string", "maxLength": 180, "description": "资料名称"},
            "exercises": {"type": "array", "minItems": 1, "maxItems": 1000, "items": ref("Exercise")},
            "confirmed": {"type": "boolean", "const": True, "description": "用户已核对"},
            "job_id": dict(TEXT, description="来自哪个后台任务（可选，会保存来源信息）"),
        },
        "additionalProperties": False,
    },
    "ExerciseImportResult": {
        "type": "object", "required": ["ok", "data"],
        "properties": {"ok": {"type": "boolean", "const": True},
                       "data": {"type": "object", "required": ["added", "duplicates", "total"],
                                "properties": {"added": {"type": "integer"}, "duplicates": {"type": "integer"},
                                               "total": {"type": "integer"}}}},
    },
    "ExerciseOrganize": {
        "type": "object", "required": ["items", "confirmed"],
        "properties": {
            "confirmed": {"type": "boolean", "const": True},
            "items": {"type": "array", "minItems": 1, "maxItems": 30,
                      "items": {"type": "object", "required": ["id", "revision"],
                                "properties": {"id": TEXT, "revision": TEXT}, "additionalProperties": False}},
            "paper": dict(TEXT, maxLength=160, description="设置为该试卷/题组；不传表示不改"),
            "tags": {"type": "array", "maxItems": 8, "items": {"type": "string", "maxLength": 40},
                     "description": "覆盖细题型；不传表示不改"},
        },
        "additionalProperties": False,
    },
    "ExerciseOrganizeResult": {"type": "object", "required": ["ok", "data"],
                               "properties": {"ok": {"type": "boolean", "const": True},
                                              "data": {"type": "object", "properties": {"updated": {"type": "integer"}}}}},
    "ExerciseEdit": {
        "type": "object", "required": ["exercise", "revision", "confirmed"],
        "properties": {
            "exercise": ref("Exercise"),
            "source": dict(TEXT, maxLength=180),
            "revision": dict(TEXT, description="修改前从列表拿到的指纹"),
            "confirmed": {"type": "boolean", "const": True},
        },
        "additionalProperties": False,
    },
    "ExerciseEditResult": {"type": "object", "required": ["ok", "exercise", "revision"],
                           "properties": {"ok": {"type": "boolean", "const": True}, "exercise": ref("Exercise"),
                                          "revision": {"type": "string"}}},
    "ReviewCatalog": {
        "type": "object", "required": ["ok", "categories", "total", "counts", "source"],
        "properties": {
            "ok": {"type": "boolean", "const": True},
            "total": {"type": "integer"},
            "source": {"type": "string", "enum": ["any", "exercise", "mistake"]},
            "counts": {"type": "object", "additionalProperties": {"type": "integer"}},
            "categories": {"type": "array", "items": {"type": "object", "required": ["category", "count", "children"],
                "properties": {"category": {"type": "string"}, "label": {"type": "string"},
                               "count": {"type": "integer"},
                               "children": {"type": "array", "items": {"type": "object",
                                   "properties": {"tag": {"type": "string"}, "label": {"type": "string"},
                                                  "count": {"type": "integer"}}}}}}},
        },
    },
    "ReviewSelection": {
        "type": "object",
        "properties": {
            "category": dict(TEXT, maxLength=120, description="一级知识点；空串表示全部"),
            "tag": dict(TEXT, maxLength=40, description="细分标签；必须先选 category"),
            "source": {"type": "string", "enum": ["any", "exercise", "mistake"], "default": "any"},
            "request_id": dict(TEXT, maxLength=100),
        },
        "additionalProperties": False,
    },
    "ReviewSelectionResult": {
        "type": "object", "required": ["ok", "answer", "selection", "current_question"],
        "properties": {
            "ok": {"type": "boolean", "const": True},
            "answer": {"type": "string", "description": "给用户看的选题说明（题干由程序原样拼入）"},
            "events": {"type": "array", "items": ref("StudyEvent")},
            "selection": {"type": "object"},
            "current_question": {"oneOf": [ref("CurrentQuestion"), {"type": "null"}]},
        },
    },
    "ChatRequest": {
        "type": "object", "required": ["message"],
        "properties": {
            "message": dict(TEXT, minLength=1, maxLength=80000),
            "request_id": dict(TEXT, maxLength=100, description="前端生成的编号；用于停止与进度轮询"),
            "view": {"type": "string", "enum": ["organize", "review", "notes", "analysis"], "default": "organize"},
            "scope": {"type": "string", "enum": ["current", "history"], "default": "current",
                      "description": "current=围绕当前题；history=明确的历史错题复习"},
            "intent": {"type": ["string", "null"], "enum": [None, "practice"], "description": "practice=明确要出一道练习题"},
            "topic": dict(TEXT, maxLength=120, description="指定知识点（历史复习时限定方向）"),
            "exercise_id": dict(TEXT, maxLength=64, description="直接练习题库中的某一道题"),
            "new_problem": dict(BOOL, description="开始一道新题：清空上一题的知识点与图片"),
            "image_ids": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 64},
                          "description": "来自 /api/intake/read、/api/intake/prepare、/api/notes/read 或 /api/chat/attachments"},
            "selection": {"type": "array", "maxItems": 30, "items": ref("RecordRef"),
                          "description": "仅 analysis：本轮勾选的记录"},
        },
        "additionalProperties": False,
    },
    "ChatResponse": {
        "type": "object", "required": ["ok", "answer", "events"],
        "properties": {
            "ok": {"type": "boolean", "const": True},
            "answer": {"type": "string", "description": "展示给用户的回答（Markdown）"},
            "events": {"type": "array", "items": ref("StudyEvent")},
            "proposals": {"type": "array", "items": ref("Proposal"), "description": "需要用户再次确认的删除/合并方案"},
            "current_question": {"oneOf": [ref("CurrentQuestion"), {"type": "null"}]},
        },
    },
    "AssignmentUpload": {"type": "object", "required": ["ok", "image_ids"],
                         "properties": {"ok": {"type": "boolean", "const": True},
                                        "image_ids": {"type": "array", "items": {"type": "string"}}}},
    "PageInfo": {"type": "object", "properties": {"source": {"type": "string"},
                                                 "page": {"oneOf": [{"type": "integer"}, {"type": "null"}]},
                                                 "page_index": {"type": "integer"},
                                                 "method": {"type": "string"}}},
    "IntakeReadResult": {
        "type": "object", "required": ["ok", "text", "image_ids", "pages"],
        "properties": {"ok": {"type": "boolean", "const": True}, "text": {"type": "string"},
                       "image_ids": {"type": "array", "items": {"type": "string"}},
                       "pages": {"type": "array", "items": ref("PageInfo")}},
    },
    "IntakePrepareResult": {
        "type": "object", "required": ["ok", "text", "image_ids", "pages", "metadata"],
        "properties": {"ok": {"type": "boolean", "const": True}, "text": {"type": "string"},
                       "image_ids": {"type": "array", "items": {"type": "string"}},
                       "pages": {"type": "array", "items": {"type": "object"}},
                       "metadata": {"type": "object"}},
    },
    "ClearBody": {"type": "object", "properties": {"preview_ids": {"type": "array", "maxItems": 20,
                                                                  "items": {"type": "string", "maxLength": 100}}}},
    "MaterialText": {"type": "object", "required": ["ok", "text", "pages"],
                     "properties": {"ok": {"type": "boolean", "const": True}, "text": {"type": "string"},
                                    "pages": {"type": "array", "items": ref("PageInfo")}}},
    "MaterialParse": {"type": "object", "required": ["text"],
                      "properties": {"text": dict(TEXT, minLength=1, maxLength=80000),
                                     "request_id": dict(TEXT, maxLength=100)}},
    "MaterialParseResult": {
        "type": "object", "required": ["ok", "exercises", "warnings", "issues"],
        "properties": {"ok": {"type": "boolean", "const": True},
                       "exercises": {"type": "array", "items": ref("Exercise")},
                       "warnings": {"type": "array", "items": {"type": "string"}},
                       "issues": {"type": "array", "items": {"type": "object"}},
                       "answer_fragments": {"type": "array", "items": {"type": "object"}},
                       "diagnostics": {"type": "array", "items": {"type": "string"}},
                       "segments": {"type": "integer"}},
    },
    "MaterialJobSubmit": {
        "type": "object", "required": ["source"],
        "properties": {
            "source": dict(TEXT, maxLength=180, description="资料名称，会显示在任务列表与入库来源中"),
            "text": dict(TEXT, maxLength=80000, description="已粘贴/读取的资料文字"),
            "page_range": dict(TEXT, maxLength=500),
            "source_file_ids": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 100},
                                "description": "复用之前保留的原文件"},
            "metadata": {"type": "object", "description": "来源说明：files / page_range / mode"},
        },
        "additionalProperties": False,
    },
    "MaterialJobList": {"type": "object", "required": ["ok", "jobs"],
                        "properties": {"ok": {"type": "boolean", "const": True},
                                       "jobs": {"type": "array", "items": ref("MaterialJob")}}},
    "MaterialJobSubmitResult": {"type": "object", "required": ["ok", "job"],
                                "properties": {"ok": {"type": "boolean", "const": True}, "job": ref("MaterialJob")}},
    "MaterialJobDetail": {
        "type": "object", "required": ["ok", "job"],
        "properties": {"ok": {"type": "boolean", "const": True},
                       "job": {"allOf": [ref("MaterialJob"), {"type": "object", "properties": {
                           "text": {"type": "string"},
                           "documents": {"type": "array", "items": {"type": "object"}},
                           "result": {"type": "object", "description": "exercises/warnings/issues/failures",
                                      "properties": {"exercises": {"type": "array", "items": ref("Exercise")},
                                                     "warnings": {"type": "array", "items": {"type": "string"}},
                                                     "issues": {"type": "array", "items": {"type": "object"}},
                                                     "failures": {"type": "array", "items": {"type": "object"}}}},
                       }}]}},
    },
    "MaterialRevise": {
        "type": "object", "required": ["exercises", "instruction"],
        "properties": {
            "exercises": {"type": "array", "items": ref("Exercise")},
            "instruction": dict(TEXT, minLength=1, maxLength=4000, description="用户的修改要求"),
            "source_text": dict(TEXT, maxLength=80000),
            "job_id": dict(TEXT, description="本批资料的批次 id，用于调取原页"),
            "selected_indices": {"type": "array", "items": {"type": "integer", "minimum": 0},
                                 "description": "只校正这些下标的题；不传表示全部"},
            "reference_page": {"type": ["integer", "null"], "description": "只参考这一页原页"},
            "history": {"type": "array", "maxItems": 12, "items": {"type": "object",
                        "required": ["role", "text"],
                        "properties": {"role": {"type": "string", "enum": ["user", "assistant"]},
                                       "text": {"type": "string", "maxLength": 5000}}}},
            "request_id": dict(TEXT, maxLength=100),
        },
    },
    "MaterialReviseResult": {
        "type": "object", "required": ["ok", "message", "changes"],
        "properties": {"ok": {"type": "boolean", "const": True}, "message": {"type": "string"},
                       "changes": {"type": "array", "items": {"type": "object", "required": ["index", "fields"],
                           "properties": {"index": {"type": "integer"}, "before": {"type": "object"},
                                          "fields": {"type": "object"}, "reason": {"type": "string"}}}}},
    },
    "MaterialClear": {
        "type": "object",
        "properties": {"preview_ids": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 100}},
                       "source_file_ids": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 100}}},
        "additionalProperties": False,
    },
    "PreviewDocument": {"type": "object", "required": ["ok", "document"],
                        "properties": {"ok": {"type": "boolean", "const": True},
                                       "document": {"type": "object", "required": ["id", "pages", "name"],
                                                    "properties": {"id": {"type": "string"}, "pages": {"type": "integer"},
                                                                   "name": {"type": "string"}}}}},
    "ProposalResult": {"type": "object", "required": ["ok", "proposal"],
                       "properties": {"ok": {"type": "boolean", "const": True}, "proposal": ref("Proposal")}},
    "ConfirmRequest": {
        "type": "object", "required": ["proposal_id", "confirmed"],
        "properties": {
            "proposal_id": dict(TEXT, description="预览接口返回的 id"),
            "confirmed": {"type": "boolean", "const": True},
            "remove_source_notes": dict(BOOL, description="合并后是否删除被合并的原笔记（错题与练习题保留）"),
            "note": {"type": "object", "required": ["topic", "content"],
                     "properties": {"topic": {"type": "string", "maxLength": 120},
                                    "content": {"type": "string", "maxLength": 24000}},
                     "description": "仅合并：用户编辑后的正文"},
            "request_id": dict(TEXT, maxLength=100),
        },
        "additionalProperties": False,
    },
    "ConfirmResult": {"type": "object", "required": ["ok", "data"],
                      "properties": {"ok": {"type": "boolean", "const": True}, "data": {"type": "object"}}},
    "ExportRequest": {
        "type": "object", "required": ["items", "format"],
        "properties": {"items": {"type": "array", "minItems": 1, "maxItems": 30, "items": ref("RecordRef")},
                       "format": {"type": "string", "enum": ["md", "pdf", "json"]},
                       "request_id": dict(TEXT, maxLength=100)},
        "additionalProperties": False,
    },
}


# ---------------------------------------------------------------------------- 从源码读取路由
ROUTE_RE = re.compile(r'@app\.(get|post)\(\s*"([^"]+)"')
ROUTE_ANY_RE = re.compile(r'@app\.route\(\s*"([^"]+)",\s*methods=\[([^\]]+)\]')
NAME_RE = re.compile(r'^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(', re.MULTILINE)


def route_entries(text):
    """找出源码里注册的 (路径, 方法, 处理函数名)。

    支持两种写法：
        @app.get(<路径>)" / "@app.post(<路径>)"
        @app.route(<路径>, methods=["GET", "POST"])
    """
    entries = []

    def handler_name(lines, index):
        """装饰器下面第一行 def 的函数名（顺便跳过 @app.route 换行写的参数）。"""
        for follow in lines[index + 1:index + 5]:
            found = NAME_RE.match(follow)
            if found:
                return found.group(1)
        return "unknown"

    lines = text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        match = ROUTE_RE.search(line)
        if match:
            entries.append((match.group(2), match.group(1).lower(), handler_name(lines, index)))
            index += 1
            continue
        if "@app.route(" in line:
            chunk = line
            end = index
            open_count = chunk.count("(") - chunk.count(")")
            while open_count > 0 and end + 1 < len(lines):
                end += 1
                chunk += "\n" + lines[end]
                open_count = chunk.count("(") - chunk.count(")")
            found = re.search(r'"([^"]+)"', chunk)
            methods = re.search(r'methods=\[([^\]]*)\]', chunk)
            if found and methods:
                for method in re.findall(r'"([a-zA-Z]+)"', methods.group(1)):
                    entries.append((found.group(1), method.lower(), handler_name(lines, end)))
            index = end + 1
            continue
        index += 1
    return entries


def build():
    text = WEB.read_text(encoding="utf-8")
    paths = {}
    for path, method, name in route_entries(text):
        if not path.startswith("/api/"):
            continue  # 页面路由（/ 与静态文件）不属于 API
        methods = PATHS.get(path)
        if methods is None:
            raise SystemExit("openapi 缺少路由说明：" + method.upper() + " " + path)
        if method not in methods:
            raise SystemExit("openapi 缺少方法说明：" + method.upper() + " " + path)
        operation = dict(methods[method])
        operation["operationId"] = name
        paths.setdefault(path, {})[method] = operation
    # 源码里不存在、但说明表里有的条目同样算过期。
    # desktop.py 在 create_app 之后额外注册 /api/desktop/status，属于已知的源码外扩展。
    documented = {(path, method) for path, methods in PATHS.items() for method in methods}
    actual = {(path, method) for path, method, _ in route_entries(text)}
    actual.add(("/api/desktop/status", "get"))
    stale = documented - actual
    if stale:
        raise SystemExit("openapi 含有源码中不存在的路由：" + ", ".join(
            method.upper() + " " + path for path, method in sorted(stale)))
    spec = {
        "openapi": "3.1.0",
        "info": {
            "title": "知错 · 学习整理助手 API",
            "version": "workspace-v20",
            "description": (
                "本机学习整理助手的 HTTP 接口。默认只监听 127.0.0.1，使用 Cookie 会话；"
                "所有业务接口都以 {ok:true,...} 或 {ok:false,error} 信封返回。\n\n"
                "约定：\n"
                "1. 先调用 GET /api/status 建立会话，并检查 configured；\n"
                "2. 长请求都带 request_id，可用 POST /api/cancel 停止、GET /api/operation 轮询进度；\n"
                "3. 模型只能提议，真正写库的是服务端；删除/合并在用户确认前只是预览；\n"
                "4. 学习记录保存在 data/*.json，笔记原文是唯一来源，导出失败不会丢数据。\n\n"
                "Python 调用：可以在进程内使用 study_api.StudyService，或用 study_api.HttpApiClient "
                "调用这些 HTTP 接口（见 PYTHON_API.md）。"
            ),
        },
        "servers": [
            {"url": "http://127.0.0.1:8765", "description": "源码模式：python web.py 默认端口"},
            {"url": "http://127.0.0.1:{port}", "description": "桌面版：端口由系统分配，见数据目录 desktop-instance.json",
             "variables": {"port": {"default": "自动分配"}}},
        ],
        "tags": [
            {"name": "系统", "description": "状态、设置、停止与临时会话"},
            {"name": "学习内容", "description": "统一添加入口：读取图片/PDF/文本"},
            {"name": "笔记", "description": "笔记列表、读取原稿、导出与下载"},
            {"name": "错题", "description": "错题统计与列表"},
            {"name": "复习", "description": "复习目录与选题"},
            {"name": "资料整理", "description": "把试卷整理成可核对的题目（含后台任务）"},
            {"name": "资料题库", "description": "已确认题目的查询、修改与批量归类"},
            {"name": "对话", "description": "与学习助手对话（逐步引导、保存结果）"},
            {"name": "图片识图", "description": "图片转写与识图方式"},
            {"name": "跨库操作", "description": "勾选记录的删除预览、确认与导出"},
            {"name": "文件预览", "description": "PDF 逐页预览"},
        ],
        "security": [{"sessionCookie": []}],
        "paths": dict(sorted(paths.items())),
        "components": {
            "securitySchemes": {
                "sessionCookie": {
                    "type": "apiKey", "in": "cookie", "name": "session",
                    "description": "Flask 会话 Cookie，由第一次请求自动下发；所有 /api 接口都依赖它隔离数据。",
                }
            },
            "schemas": dict(sorted(SCHEMAS.items())),
        },
    }
    return json.dumps(spec, ensure_ascii=False, indent=2) + "\n"


def main(argv):
    check = "--check" in argv
    content = build()
    if check:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != content:
            print("openapi.json 已过期，请运行 python tools/generate_openapi.py 重新生成。")
            return 1
        print("openapi.json 与 web.py 路由一致。")
        return 0
    OUTPUT.write_text(content, encoding="utf-8")
    print("已写入 " + str(OUTPUT))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
