"""兼容早期纯文字公式，只改变显示/导出，不改写保存的原文。"""

import re


PROTECTED = re.compile(
    r"```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|"
    r"\\\([\s\S]*?\\\)|(?<!\$)\$(?!\$)[^\n$]+?\$(?!\$)|"
    r"\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}|"
    r"!?\[[^\]\n]*\]\([^\n)]*\)|https?://[^\s]+"
)
RUN = re.compile(r"[∫√A-Za-z0-9(][A-Za-z0-9\s\t(){}^_+*/=.'\\−<>≥≤∞∫√-]*")


def normalize_math_markdown(source):
    def convert_plain(text):
        # 保留换行；不把普通英文说明、路径或 Markdown 标记当成数学。
        text = re.sub(r"(?<=[A-Za-z0-9)])\s*趋于\s*(?=[A-Za-z0-9(∞+-])", r" \\to ", text)

        def formula(match):
            raw = match[0]
            value = raw.strip()
            if not re.search(r"[=^∫√≥≤]|\\(?:to|frac|sqrt)|(?:sin|cos|tan|ln|log)\(", value):
                return raw
            words = re.findall(r"[A-Za-z]{3,}", value)
            if any(word not in {"sin", "cos", "tan", "cot", "sec", "log", "exp", "frac", "sqrt", "infty", "cdot"} for word in words):
                return raw
            value = re.sub(r"\^\(([^()]*)\)", r"^{\1}", value)
            value = re.sub(r"\^(-?\d+|[A-Za-z])", r"^{\1}", value)
            value = re.sub(r"\b(sin|cos|tan|cot|ln|log|exp)\b", r"\\\1", value)
            value = re.sub(r"√\(([^()]*)\)", r"\\sqrt{\1}", value)
            value = re.sub(r"√([A-Za-z0-9])", r"\\sqrt{\1}", value)
            if "√" in value:
                return raw
            value = value.replace("∫", r"\int ")
            value = value.replace("*", r"\cdot ").replace("≥", r"\ge ").replace("≤", r"\le ").replace("∞", r"\infty ").replace("−", "-")
            value = re.sub(r"(?<![A-Za-z])d([xyz])\b", r"\\,d\1", value)
            return raw[:len(raw)-len(raw.lstrip())] + r"\(" + value + r"\)" + raw[len(raw.rstrip()):]

        return "\n".join(RUN.sub(formula, line) for line in text.split("\n"))

    parts, cursor = [], 0
    for match in PROTECTED.finditer(source):
        parts.extend((convert_plain(source[cursor:match.start()]), match[0]))
        cursor = match.end()
    parts.append(convert_plain(source[cursor:]))
    return "".join(parts)
