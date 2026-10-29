"""Read-only review projection over confirmed exercises and personal mistakes.

Folders are display/filter metadata, not a migration of either JSON file.
Categories use explicit topic aliases; no mathematical classification is guessed
from a question. Picks expose a whitelist so prior answers/reasons stay hidden.
"""
from classification import ALIASES


GROUPS = {
    "函数": ("函数", "定义域", "值域", "反函数", "复合函数", "分段函数", "函数性质"),
    "极限": ("极限", "函数极限", "数列极限", "极限性质", "无穷小", "无穷小比较", "洛必达法", "极限计算", "不等式与数列"),
    "连续与间断": ("连续与间断", "连续性", "函数连续性", "间断点", "间断点分类", "可去间断点", "跳跃间断点"),
    "导数与微分": ("导数与微分", "导数", "微分", "导数定义", "可导性", "隐函数求导", "参数方程求导", "高阶导数", "分段函数可导性", "微分中值定理", "中值定理", "拉格朗日中值定理", "罗尔定理", "柯西中值定理"),
    "积分": ("积分", "不定积分", "定积分", "换元积分", "分部积分", "积分应用", "反常积分"),
    "行列式与矩阵": ("行列式与矩阵", "行列式", "矩阵", "线性代数", "线性方程组", "特征值", "二次型"),
    "数列与级数": ("数列与级数", "数列", "级数", "数项级数", "幂级数", "函数项级数"),
    "多元微积分": ("多元微积分", "偏导数", "全微分", "重积分", "多元函数", "曲线积分", "曲面积分"),
    "微分方程": ("微分方程", "常微分方程"),
}
TOPIC_GROUP = {topic: group for group, topics in GROUPS.items() for topic in topics}


def category_for(topic):
    topic = ALIASES.get(topic.strip(), topic.strip())
    return TOPIC_GROUP.get(topic, topic)


def facets_for(record):
    topic = record["topic"].strip()
    tags = record.get("tags") or []
    tags = tags if isinstance(tags, list) else []
    values = [*tags, *([topic] if topic != category_for(topic) and len(topic) <= 40 else [])]
    return list(dict.fromkeys(ALIASES.get(value.strip(), value.strip()) for value in values
                              if isinstance(value, str) and 0 < len(value.strip()) <= 40))


def validate_filter(category="", tag="", source="any"):
    if (not isinstance(category, str) or len(category) > 120 or
            not isinstance(tag, str) or len(tag) > 40 or source not in ("any", "exercise", "mistake") or
            tag and not category):
        raise ValueError("请选择有效的知识点、细分标签和题目来源。")
    if tag.strip() and not category.strip():
        raise ValueError("选择细分标签前请先选择知识点。")
    return {"category": category.strip(), "tag": ALIASES.get(tag.strip(), tag.strip()), "source": source}


class ReviewCatalog:
    def __init__(self, exercises, mistakes):
        self.records = [("exercise", item) for item in exercises] + [("mistake", item) for item in mistakes]

    def matches(self, category="", tag="", source="any"):
        selected = validate_filter(category, tag, source)
        category, tag, source = selected["category"], selected["tag"], selected["source"]
        return [(kind, item) for kind, item in self.records
                if (source == "any" or kind == source)
                and (not category or category_for(item["topic"]) == selected["category"])
                and (not tag or selected["tag"] in facets_for(item))]

    def tree(self, source="any"):
        records = self.matches(source=source)
        groups = {}
        topic_filters = {}
        for kind, item in records:
            category = category_for(item["topic"])
            topic = ALIASES.get(item["topic"].strip(), item["topic"].strip())
            topic_filters[item["topic"]] = {"category": category,
                "tag": topic if topic != category and len(topic) <= 40 else ""}
            node = groups.setdefault(category, {"category": category, "label": category, "count": 0, "tags": {}})
            node["count"] += 1
            for tag in facets_for(item):
                node["tags"][tag] = node["tags"].get(tag, 0)+1
        order = {key: index for index, key in enumerate(GROUPS)}
        nodes = []
        for key in sorted(groups, key=lambda key: (order.get(key, len(order)), key)):
            node = groups[key]
            nodes.append({k: v for k, v in node.items() if k != "tags"} | {
                "children": [{"tag": tag, "label": tag, "count": count} for tag, count in sorted(node["tags"].items())]})
        return {"categories": nodes, "total": len(records),
                "counts": {kind: sum(k == kind for k, _ in records) for kind in ("exercise", "mistake")},
                "source": source, "topic_filters": topic_filters}

    def pick(self, category="", tag="", source="any", exclude_id=None, exercise_id=None):
        records = self.matches(category, tag, source)
        if exercise_id:
            records = [(kind, item) for kind, item in records if kind+":"+item["id"] == exercise_id]
        start = next((i+1 for i, (kind, item) in enumerate(records) if kind+":"+item["id"] == exclude_id), 0)
        records = records[start:] + records[:start]
        choices = [(kind, item) for kind, item in records if kind+":"+item["id"] != exclude_id]
        # An explicit re-pick can redo the only available question.
        chosen = (choices or records)[0] if records else None
        public = None
        if chosen:
            kind, item = chosen
            public = {"id": kind+":"+item["id"], "kind": kind, "topic": item["topic"],
                      "question": item["question"], "tags": facets_for(item),
                      "source": item.get("source", "已确认资料") if kind == "exercise" else "我的错题本",
                      "number": item.get("number", ""), "paper": item.get("paper", "")}
        return {"topic": category or "全部知识点", "exercise": public, "matched": len(records),
                "selection": validate_filter(category, tag, source)}
