"""知识点、细题型与试卷归属分开保存；不根据关键词硬猜题型。"""
ALIASES = {"洛必达法则":"洛必达法", "洛必达规则":"洛必达法", "等价无穷小替换":"等价无穷小", "泰勒公式":"泰勒展开", "黎曼和":"定积分定义", "左右极限":"单侧极限", "1的无穷次方":"1^∞型极限", "一的无穷次方":"1^∞型极限", "1^∞":"1^∞型极限", "1∞型":"1^∞型极限", "1的无穷大次方":"1^∞型极限", "1^∞型":"1^∞型极限"}
SEED_TAGS = ["等价无穷小", "泰勒展开", "洛必达法", "单侧极限", "数列极限", "夹逼准则", "定积分定义", "分段函数连续性", "可去间断点", "跳跃间断点", "反函数", "隐函数求导", "参数方程求导", "高阶导数", "换元积分", "分部积分", "列变换", "递推行列式"]

def clean_tags(value):
    if not isinstance(value,list) or len(value)>8 or any(not isinstance(t,str) or not t.strip() or len(t)>40 for t in value):
        raise ValueError("细题型最多 8 个，每个标签为 1 到 40 字。")
    return list(dict.fromkeys(ALIASES.get(t.strip(),t.strip()) for t in value))

def classification_rules(vocabulary=()):
    names=list(dict.fromkeys([*vocabulary,*SEED_TAGS]))[:120]
    return ("\n将 chapter/topic（宽泛知识点）、tags（细题型/方法）、paper（试卷或题组）分开。"
            "topic 沿用现有字段，不返回 chapter。tags 是最多8个短标签的数组；根据题干结构标注细题型，"
            "例如极限还可有单侧极限、等价无穷小、定积分定义等；不能为了细分而编造确定的解法。"
            "优先复用已有标签，同义词用统一名称，没有合适的可建议新标签，无法判断用[]。"
            "paper 仅填写原页明确的完整试卷标题/编号，或用户指定的题组；无依据用空字符串，"
            "不要把原题号、当前批次号当试卷名，不因相邻页面就推断同一套试卷。"
            "保留 number 中的题型节号与小题号，不能只留开头一个数字。"
            "可选 answer_page_indices 是参考答案所在原页索引数组；必须确实看到对应答案，未见用[]。"
            "已有细标签参考："+"、".join(names))
