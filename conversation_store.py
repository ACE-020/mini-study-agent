"""把每个视图（organize / notes / review）的对话上下文落到用户目录里。

为什么需要它：对话历史原本只存在内存的 ``StudyAgent.messages`` 里，进程一重启
（换版本、崩溃、云托管重新部署）用户就会看到“模型把我刚才的题忘了”，
而这正是内置测时最容易踩的坑。

落盘规则刻意保守：

* 只存能安全重放的文本：图片一律替换成 ``[图片]`` 占位，二进制永远不写盘；
* 工具中间态（``tool_calls`` / ``role=tool``）不重放，避免历史里出现“没有结果的调用”；
* 超过条数或字符预算时，从最旧的成对消息开始丢，但 **system 提示和第一条用户消息（原题）永久保留**。
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

MAX_MESSAGES = 60        # 约 30 轮问答
MAX_CHARS = 160_000      # 粗略上限，防止长对话把每次请求都撑爆
IMAGE_PLACEHOLDER = "[图片]"


def text_of(content) -> str:
    """把消息内容压成纯文本；图片只留占位符。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            kind = item.get("type")
            if kind in ("text", "input_text") and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif kind in ("image_url", "input_image", "image"):
                parts.append(IMAGE_PLACEHOLDER)
        return "\n".join(part for part in parts if part)
    return ""


def sanitize(messages) -> list[dict]:
    """只保留可重放的 user / assistant 文本消息。"""
    cleaned: list[dict] = []
    for item in messages or []:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        if role not in ("system", "user", "assistant"):
            continue
        text = text_of(item.get("content"))
        if not text:
            continue
        cleaned.append({"role": role, "content": text})
    return cleaned


def trim(messages, max_messages: int = MAX_MESSAGES, max_chars: int = MAX_CHARS) -> list[dict]:
    """保留 system + 第一条用户消息（原题）+ 最近的若干轮。"""
    messages = list(messages or [])
    if not messages:
        return []
    head: list[dict] = []
    rest = messages
    if rest and rest[0].get("role") == "system":
        head.append(rest[0])
        rest = rest[1:]
    pinned: list[dict] = []
    if rest and rest[0].get("role") == "user":
        pinned.append(rest[0])
        rest = rest[1:]

    budget = max_chars - sum(len(item.get("content") or "") for item in head + pinned)
    room = max(0, max_messages - len(head) - len(pinned))
    kept: list[dict] = []
    for item in reversed(rest):
        size = len(item.get("content") or "")
        if len(kept) >= room or budget - size < 0:
            break
        kept.append(item)
        budget -= size
    kept.reverse()
    return head + pinned + kept


def path_for(directory, view: str) -> Path:
    return Path(directory) / "conversations" / (view + ".json")


def load(directory, view: str) -> list[dict]:
    """读回上下文；文件缺失或损坏都当作“没有历史”，绝不影响这一轮。"""
    try:
        payload = json.loads(path_for(directory, view).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    messages = payload.get("messages") if isinstance(payload, dict) else None
    if not isinstance(messages, list):
        return []
    return sanitize(messages)


def save(directory, view: str, messages) -> None:
    """原子写入；只有 system 一条时不落盘（等于没有上下文）。"""
    trimmed = trim(sanitize(messages))
    if not trimmed or (len(trimmed) == 1 and trimmed[0].get("role") == "system"):
        return
    path = path_for(directory, view)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".conversation-", dir=str(path.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump({"version": 1, "messages": trimmed}, stream, ensure_ascii=False)
        os.replace(temporary, path)
    except OSError:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def clear(directory, view: str) -> None:
    try:
        path_for(directory, view).unlink()
    except OSError:
        pass
