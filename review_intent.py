"""Recognize explicit scope changes before applying the previous question's filter."""
import re
from classification import ALIASES


def practice_request(text):
    return bool(re.search(r"^出[。！!\s]*$|下一题|下道题|(?<![指提看算写求得做])出(?:一道|一题|道题|题|类似题|相关题|同类题|练习题|变式题)|巩固|来一道|换一道|选一道|挑一道|选一题|挑一题|(?<![指提看算写求得做])(?:出|来|换|给|找|选|挑|要).{0,5}(?:一|1)(?:道|题)|(?<![指提看算写求得做])出(?:一|1)个(?!错误|提示|建议|思路|步骤|方法)|(?:还有|没有|没).{0,4}(?:别的|其他|新).{0,4}题|这不是.{0,12}出的吗|重复(?:的)?题",text))


def requested_scope(text, catalog, source="any"):
    if not (practice_request(text) or re.search(r"换到|改成|改为|练一下|练习",text)):
        return None
    compact=re.sub(r"\s+","",text)
    # These are notation aliases for the same explicitly named form, not a guessed method.
    if re.search(r"(?:1|一)(?:的)?(?:无穷(?:大)?次方|\^?\{?(?:∞|\\infty)\}?)(?:型|极限)?",compact):
        return dict(category="极限",tag="1^∞型极限",source=source)
    candidates=[]
    for node in catalog.get("categories",[]):
        category=node["category"]
        if category in text:candidates.append((len(category),dict(category=category,tag="",source=source)))
        for leaf in node["children"]:
            tag=leaf["tag"]
            names=[tag,*[alias for alias,value in ALIASES.items() if value==tag]]
            for name in names:
                if name in text:candidates.append((len(name),dict(category=category,tag=tag,source=source)))
    return max(candidates,key=lambda item:item[0])[1] if candidates else None
