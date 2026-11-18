"""把自然语言描述转成矩阵 / 行列式的 LaTeX。

只做三件事：拼提示词、调用模型、校验返回。
校验不通过就抛 ValueError —— 模型输出不会被直接交给前端，
因为这段 LaTeX 会进输入框、最终还会发给模型。
"""

from __future__ import annotations

import re

# 允许的矩阵环境：都是标准 amsmath / LaTeX 环境，MathLive 与 KaTeX 都能渲染。
ALLOWED_ENVIRONMENTS = (
    "matrix",
    "pmatrix",
    "bmatrix",
    "Bmatrix",
    "vmatrix",
    "Vmatrix",
    "smallmatrix",
)

MAX_LATEX_LENGTH = 2000
MAX_DESCRIPTION_LENGTH = 300

# 允许出现的命令白名单。
#
# 为什么是白名单而不是黑名单：黑名单永远会漏——\\def、\\newcommand、\\let、
# \\catcode 这些当初都没拦（见 review 意见 1）。白名单是「没列出来的一律不许用」，
# 漏的是反向的（冷门符号被拒），失败方向更安全。
#
# 现在 KaTeX / MathLive 只渲染、不执行 TeX，风险还低；但一旦接上「LaTeX → 编译 PDF」，
# 黑名单就是真的执行入口，所以这里按白名单写。
# 代价：模型用到冷门命令时会被拒，前端提示重试，换句话描述即可。
ALLOWED_COMMANDS = frozenset({
    # 结构
    "begin", "end", "left", "right", "middle", "displaystyle",
    # 定界符
    "lbrace", "rbrace", "langle", "rangle", "lvert", "rvert", "lVert", "rVert",
    "vert", "Vert", "mid", "lfloor", "rfloor", "lceil", "rceil",
    # 分式、根式、组合数
    "frac", "dfrac", "tfrac", "cfrac", "sqrt", "binom", "dbinom", "tbinom",
    # 重音与上下线
    "overline", "underline", "overrightarrow", "overleftarrow",
    "hat", "bar", "vec", "dot", "ddot", "tilde", "widehat", "widetilde",
    # 字体与文本
    "text", "mathrm", "mathbf", "mathit", "mathbb", "mathcal", "mathsf", "mathtt",
    "operatorname", "boldsymbol",
    # 省略号
    "cdots", "ldots", "dots", "vdots", "ddots", "dotsb", "dotsc", "dotsm", "dotsi",
    # 运算符
    "times", "cdot", "div", "pm", "mp", "ast", "star", "circ", "bullet", "oplus", "otimes",
    # 关系
    "le", "leq", "ge", "geq", "ne", "neq", "approx", "sim", "simeq", "cong", "equiv",
    "propto", "ll", "gg", "in", "notin", "ni", "subset", "supset", "subseteq",
    "supseteq", "cup", "cap", "setminus", "emptyset", "varnothing",
    # 箭头
    "to", "gets", "rightarrow", "leftarrow", "leftrightarrow", "Rightarrow",
    "Leftarrow", "Leftrightarrow", "mapsto", "implies", "iff",
    # 微积分与大型运算符
    "sum", "prod", "coprod", "int", "iint", "iiint", "oint", "lim", "limsup",
    "liminf", "partial", "nabla", "infty", "prime",
    # 函数名
    "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
    "ln", "log", "lg", "exp", "max", "min", "sup", "inf", "det", "dim", "ker",
    "gcd", "mod", "bmod", "pmod",
    # 小写希腊字母
    "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta",
    "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron",
    "pi", "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon",
    "phi", "varphi", "chi", "psi", "omega",
    # 大写希腊字母
    "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon",
    "Phi", "Psi", "Omega",
    # 杂项
    "angle", "triangle", "square", "Box", "degree",
    # 间距、换行与转义字符
    "quad", "qquad", " ", ",", ";", ":", "!", "-", "/",
    "#", "%", "&", "_", "$", "{", "}", "\\",
})

# 提取命令名：\frac -> frac；\\ -> \；\, -> ,
_COMMAND_RE = re.compile(r"\\([A-Za-z]+|.)", re.S)

_FENCE_RE = re.compile(r"^\s*```[a-zA-Z]*\s*|\s*```\s*$")
_ENV_RE = re.compile(r"\\begin\s*\{([A-Za-z]+)\}(.*)\\end\s*\{\1\}", re.S)
_ROW_SPLIT_RE = re.compile(r"\\\\")

KIND_LABELS = {"matrix": "矩阵", "determinant": "行列式"}

SYSTEM_PROMPT = (
    "你是 LaTeX 排版助手，只负责把对矩阵或行列式的文字描述转成 LaTeX。\n"
    "规则：\n"
    "1. 只输出一个 LaTeX 矩阵环境，不要任何解释、不要 Markdown 代码块、不要前后缀。\n"
    "2. 环境只能用：pmatrix（圆括号矩阵）、bmatrix（方括号矩阵）、vmatrix（行列式，竖线）、"
    "matrix（无括号）、Vmatrix（双竖线）。\n"
    "3. 元素之间用 & 分隔，行之间用 \\\\ 分隔。\n"
    "4. 描述里出现 n 阶、规律性写法时，用 \\cdots \\vdots \\ddots 表达，"
    "必要时配一两个具体元素，不要真的展开成 n 行。\n"
    "5. 如果描述无法转成矩阵或行列式，只输出 ERROR。"
)


def validate_description(description, kind):
    """校验用户输入，返回清洗后的 (description, kind)。"""

    if not isinstance(description, str):
        raise ValueError("请用一句话描述要生成的矩阵或行列式。")
    text = description.strip()
    if not text:
        raise ValueError("请用一句话描述要生成的矩阵或行列式。")
    if len(text) > MAX_DESCRIPTION_LENGTH:
        raise ValueError(f"描述太长了，请控制在 {MAX_DESCRIPTION_LENGTH} 字以内。")
    if kind not in KIND_LABELS:
        raise ValueError("请选择生成矩阵还是行列式。")
    return text, kind


def build_messages(description, kind):
    """拼出给模型的消息列表，方便单测直接断言提示词内容。"""

    label = KIND_LABELS[kind]
    user = (
        f"目标类型：{label}\n"
        f"描述：{description}\n"
        f"请只输出这一个{label}的 LaTeX 环境。"
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


def extract_latex(raw):
    """从模型回复里取出 LaTeX：去掉代码块围栏和包裹的 $。"""

    if not isinstance(raw, str):
        raise ValueError("模型没有返回内容，请稍后重试。")
    text = raw.strip()
    text = _FENCE_RE.sub("", text).strip()
    if text.startswith("$$") and text.endswith("$$") and len(text) > 4:
        text = text[2:-2].strip()
    elif text.startswith("$") and text.endswith("$") and len(text) > 2:
        text = text[1:-1].strip()
    return text


def extract_commands(latex):
    """取出用到的全部命令名，供白名单比对。"""

    return {match.group(1) for match in _COMMAND_RE.finditer(latex or "")}


def matrix_shape(body):
    """返回 (行数, 列数)。

    一阶行列式（1×1）是合法输入，所以不再要求「必须出现 & 或换行」——
    改成检查各行格子数是否一致，单行单格自然通过（见 review 意见 2）。
    """

    text = (body or "").strip()
    while text.endswith("\\\\"):
        text = text[:-2].rstrip()
    if not text:
        raise ValueError("生成的矩阵是空的，请换个说法重试。")
    rows = _ROW_SPLIT_RE.split(text)
    counts = [len(row.split("&")) for row in rows]
    if len(set(counts)) != 1:
        raise ValueError("生成的矩阵各行格子数不一致，请重试。")
    return len(rows), counts[0]


def validate_latex(latex):
    """确认结果确实是一个可用的矩阵环境，否则抛 ValueError。"""

    text = (latex or "").strip()
    if not text:
        raise ValueError("模型没有返回可用的公式，请重试或换个说法。")
    if text.upper() == "ERROR":
        raise ValueError("这个描述没法转成矩阵，请写得更具体一些。")
    if len(text) > MAX_LATEX_LENGTH:
        raise ValueError("生成的公式过长，请把描述写得更简洁。")

    match = _ENV_RE.search(text)
    if not match:
        raise ValueError("模型返回的不是矩阵环境，请重试。")
    environment = match.group(1)
    if environment not in ALLOWED_ENVIRONMENTS:
        raise ValueError(f"不支持的矩阵环境 {environment}，请重试。")
    if text.count("\\begin") != 1 or text.count("\\end") != 1:
        raise ValueError("生成的公式结构不完整，请重试。")

    unknown = sorted(extract_commands(text) - ALLOWED_COMMANDS)
    if unknown:
        raise ValueError(f"生成的公式包含不支持的命令 \\{unknown[0]}，请重试。")

    matrix_shape(match.group(2))
    return text


def _read_content(reply):
    """从模型回复里取正文。llm.ModelClient.complete 返回 message 字典，
    测试用的替身可能返回对象，两种都接住。"""

    if isinstance(reply, dict):
        content = reply.get("content", "")
    else:
        content = getattr(reply, "content", reply)
    # 少数服务把 content 拆成多段（多模态格式），只取文本片段。
    if isinstance(content, list):
        content = "".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in content
        )
    return content


def generate(client, description, kind="matrix"):
    """调用模型生成 LaTeX，返回校验通过的字符串。失败抛 ValueError / ModelError。"""

    text, kind = validate_description(description, kind)
    reply = client.complete(build_messages(text, kind))
    return validate_latex(extract_latex(_read_content(reply)))
