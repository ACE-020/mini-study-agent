"""Source identities, page regions and batch-wide answer/issue reconciliation.

PDF text is used only for labels and geometry, never to reconstruct math answers.
"""
from copy import deepcopy
import math
import re

CN = "一二三四五六七八九十"


def canonical_number(value):
    value = re.sub(r"\s+", "", str(value)).replace("．", ".").replace("，", "、")
    match = re.search(r"(["+CN+r"]+)[、.](\d+)", value)
    if match:
        return match[1]+"、"+str(int(match[2]))
    match = re.fullmatch(r"(["+CN+r"]+)[、.]?", value)
    if match:
        return match[1]
    return value.strip(".、")


def paper_code(value):
    match = re.match(r"\s*(?:第\s*)?(\d+|["+CN+r"]+)\s*(?:套|组|[ \[【])", str(value))
    return match[1] if match else ""


def validate_region(value):
    if (not isinstance(value, list) or len(value) != 4 or
            any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in value) or
            value[2]-value[0] < .001 or value[3]-value[1] < .001):
        raise ValueError("原页位置必须是0到1之间的有效矩形。")
    return [round(v, 5) for v in value]


def pdf_layouts(pdf, selected, token=None):
    """Carry explicit paper/section labels over continuation pages in this file."""
    result, paper, section, mode = {}, "", "", "question"
    if not selected:
        return result
    for index in range(max(0, min(selected)-12), max(selected)+1):
        if token:
            token.check()
        page = pdf[index]
        if getattr(page, "rotation", 0):
            # Text boxes use unrotated PDF coordinates; let vision locate rotated pages.
            if index in selected:
                result[index] = {"paper":paper,"anchors":[]}
            continue
        lines = []
        for block in page.get_text("dict", sort=True)["blocks"]:
            for line in block.get("lines", []):
                spans = line["spans"]
                text = "".join(s["text"] for s in spans).strip()
                if spans and text:
                    lines.append((line["bbox"], text, max(s["size"] for s in spans)))
        markers = []
        for bbox, text, size in lines:
            x0, y0, x1, y1 = bbox
            if y0 > page.rect.height*.93:
                continue
            if (size >= 11.5 and y0 < page.rect.height*.35 and len(text) <= 180 and
                    re.match(r"^(?:\d+\s*[\[【]|第.+?套)", text) and
                    re.search(r"考试|试卷|试题|期[中末]|高数|数学分析|线性代数|概率", text)):
                paper, section, mode = text[:160], "", "question"
                markers.append({"boundary": True, "top": y0})
                continue
            if x0 > page.rect.width*.23 or size < 9:
                continue
            if re.fullmatch(r"(?:参考)?答案(?:与解析|解析)?", text):
                mode, section = "answer", ""
                markers.append({"boundary": True, "top": y0})
                continue
            major = re.match(r"^(["+CN+r"]+)[、.．]\s*(.*)", text)
            number = None
            if major:
                section, rest = major[1], major[2]
                if re.match(r"(?:填空|选择|判断|单选|多选)题", rest):
                    markers.append({"boundary": True, "top": y0})
                    continue
                sub = re.match(r"(\d{1,3})[.．、](?!\d)", rest)
                number = section+("、"+str(int(sub[1])) if sub else "")
            else:
                sub = re.match(r"^(\d{1,3})[.．、](?!\d)", text)
                if sub:
                    number = (section+"、" if section else "")+str(int(sub[1]))
            if number:
                markers.append({"number": number, "paper": paper, "role": mode, "top": max(0, y0-4),
                                "left": max(0, x0-5), "text_hint": text[:180]})
        # Fractions/exponents often live in separate text blocks above the number.
        # Expand to their connected text band, while keeping the next question out.
        bands=[]
        for bbox, _, _ in sorted(lines,key=lambda line:line[0][1]):
            if bbox[1]>page.rect.height*.93:
                continue
            if bands and bbox[1]<=bands[-1][1]+2:
                bands[-1][1]=max(bands[-1][1],bbox[3])
            else:
                bands.append([bbox[1],bbox[3]])
        original_tops=[m["top"]+5 for m in markers]
        for j,marker in enumerate(markers):
            band=next((b for b in bands if b[0]<=original_tops[j]<=b[1]),None)
            if band and sum(band[0]<=top<=band[1] for top in original_tops)==1:
                marker["top"]=max(0,band[0]-3)
        anchors = []
        for j, marker in enumerate(markers):
            if marker.get("boundary"):
                continue
            bottom = min(page.rect.height*.93, markers[j+1]["top"]-2 if j+1 < len(markers) else page.rect.height*.93)
            if bottom <= marker["top"]+3:
                continue
            anchors.append({k: marker[k] for k in ("paper", "number", "role")} |
                           {"bbox": [round(marker["left"]/page.rect.width, 5), round(marker["top"]/page.rect.height, 5),
                                     .95, round(bottom/page.rect.height, 5)]})
        if index in selected:
            result[index] = {"paper": paper, "anchors": anchors[:200]}
    return result


def all_anchors(documents):
    return [{**a, "page_index": d["page_index"]} for d in documents for a in d.get("layout", {}).get("anchors", [])]


def bind_location(item, documents, role="question"):
    item = deepcopy(item)
    anchors = [a for a in all_anchors(documents) if a["role"] == role]
    exact = [a for a in anchors if a.get("id") == item.get("source_anchor")] if item.get("source_anchor") else []
    number = canonical_number(item.get("number", ""))
    exact = [a for a in exact if
             (not item.get("page_index") or item["page_index"] == a["page_index"]) and
             (not number or number == canonical_number(a["number"]) or number.isdigit() and canonical_number(a["number"]).split("、")[-1] == number)]
    if not exact:
        candidates = [a for a in anchors if a["page_index"] == item.get("page_index")]
        if not item.get("page_index"):
            paper = item.get("paper", "").strip()
            code = paper_code(paper)
            # Never choose between papers solely by a repeated question number.
            candidates = [a for a in anchors if paper and re.sub(r"\s+", "", a["paper"]) == re.sub(r"\s+", "", paper)]
            if not candidates and code:
                by_code = [a for a in anchors if paper_code(a["paper"]) == code]
                if len({a["paper"] for a in by_code}) == 1:
                    candidates = by_code
        exact = [a for a in candidates if canonical_number(a["number"]) == number]
        if not exact and number.isdigit():
            exact = [a for a in candidates if canonical_number(a["number"]).split("、")[-1] == number]
        if len(exact) > 1 and item.get("origin_regions"):
            box = item["origin_regions"][0]["bbox"]
            center = (box[0]+box[2])/2, (box[1]+box[3])/2
            exact = [a for a in exact if a["bbox"][0] <= center[0] <= a["bbox"][2] and a["bbox"][1] <= center[1] <= a["bbox"][3]]
    if len(exact) == 1:
        anchor = exact[0]
        item.update(number=anchor["number"], paper=anchor["paper"], page_index=anchor["page_index"], source_anchor=anchor["id"])
        item["origin_regions"] = [{"page_index": anchor["page_index"], "bbox": anchor["bbox"], "role": role},
                                  *[r for r in item.get("origin_regions", []) if r["role"] != role or r["page_index"] != anchor["page_index"]]]
    else:
        known = {a["paper"] for a in anchors if a["page_index"] == item.get("page_index") and a["paper"]}
        if len(known) == 1:
            item["paper"] = known.pop()
    return item


def identity(item):
    return item.get("paper", "").strip(), canonical_number(item.get("number", ""))


def comparable_answer(value):
    return re.sub(r"\s+|\$|\\[()\[\]]", "", value).strip("。.")


def issue_candidates(event, items, documents, wide_missing=False):
    text = event["message"]
    page_index = event.get("page_index")
    physical = re.search(r"第\s*(\d+)\s*页", text)
    if page_index is None and physical:
        matches = [d for d in documents if d.get("page") == int(physical[1])]
        if len(matches) == 1:
            page_index = matches[0]["page_index"]
    number = canonical_number(event.get("number", ""))
    if not number and not wide_missing:
        match = re.search(r"(["+CN+r"]+)\s*[、.．]\s*(\d{1,3})", text)
        if match:
            number = match[1]+"、"+str(int(match[2]))
    paper = event.get("paper", "")
    code_match = re.search(r"(?:题组|试卷)\s*(\d+)|第\s*(\d+|["+CN+r"]+)\s*套", text)
    code = paper_code(paper) or (next((v for v in code_match.groups() if v), "") if code_match else "")
    cn_codes = dict(zip(CN[:10], map(str, range(1, 11))))
    code = cn_codes.get(code, code)
    candidates = list(range(len(items)))
    if paper and any(i.get("paper") == paper for i in items):
        candidates = [i for i in candidates if items[i].get("paper") == paper]
    elif code:
        candidates = [i for i in candidates if paper_code(items[i].get("paper", "")) == code]
    if number:
        candidates = [i for i in candidates if canonical_number(items[i].get("number")) == number]
    if page_index is not None and not (wide_missing and (paper or code)):
        local = [i for i in candidates if items[i].get("page_index") == page_index or page_index in items[i].get("answer_page_indices", [])]
        # An explicit but contradictory page is not silently reinterpreted.
        candidates = local
    if not (number or paper or code or page_index):
        candidates = []
    return candidates, page_index


def reconcile_batch(items, fragments, events, documents):
    items = [bind_location(item, documents) for item in items]
    source_by_page = {d["page_index"]:d["source"] for d in documents}
    def scoped(item):
        return (source_by_page.get(item.get("page_index"), ""), *identity(item))
    by_key = {}
    for i, item in enumerate(items):
        by_key.setdefault(scoped(item), []).append(i)
    answers = {}
    for raw in fragments:
        fragment = bind_location(raw, documents, "answer")
        key = scoped(fragment)
        if not key[1] or len(by_key.get(key, [])) != 1:
            continue
        answers.setdefault(key, []).append(fragment)
    extra = []
    native_answers = {}
    for a in all_anchors(documents):
        if a["role"] == "answer":
            native_answers.setdefault(scoped(a), []).append(a)
    for key, indices in by_key.items():
        if len(indices) != 1:
            continue
        item = items[indices[0]]
        candidates = answers.get(key, [])
        texts = {comparable_answer(f["answer"]): f["answer"] for f in candidates if f.get("answer", "").strip()}
        if item.get("answer"):
            texts[comparable_answer(item["answer"])] = item["answer"]
        # Substrings are not mathematical equivalence (e.g. 1 versus 21).
        maximal = list(texts)
        if len(maximal) == 1:
            item["answer"] = texts[maximal[0]]
        elif len(maximal) > 1:
            extra.append({"message": "同一道题识别到的参考答案出现不同内容，请对照原页确认。", "kind": "answer_conflict",
                          "paper": key[1], "number": key[2], "page_index": item.get("page_index")})
        regions = item.setdefault("origin_regions", [])
        for f in candidates:
            for region in f.get("origin_regions", []):
                if region not in regions:
                    regions.append(region)
            if f.get("page_index"):
                item.setdefault("answer_page_indices", []).append(f["page_index"])
        # Local labels establish where the answer is, not what its math means.
        for a in native_answers.get(key, []):
            region = {"page_index": a["page_index"], "bbox": a["bbox"], "role": "answer"}
            if region not in regions:
                regions.append(region)
            item.setdefault("answer_page_indices", []).append(a["page_index"])
        if "answer_page_indices" in item:
            item["answer_page_indices"] = list(dict.fromkeys(item["answer_page_indices"]))[:20]
        item["origin_regions"] = regions[:20]
        if not item["origin_regions"]:
            del item["origin_regions"]
    issues, diagnostics, seen = [], [], set()
    for event in [*events, *extra]:
        message = event["message"].strip()
        internal = re.search(r"本段.*(?:主页面|参考答案|未导出|整理\s*\d+\s*题)|不属于本段|page_index|第\s*\d+\s*/\s*\d+\s*段|本段显示", message)
        critical = re.search(r"无法辨认|模糊|错位|歧义|不一致|不符|不同内容", message)
        if (event.get("kind") == "diagnostic" or internal) and not critical:
            diagnostics.append(message)
            continue
        missing = event.get("kind") == "answer_missing" or bool(re.search(r"答案.*(?:未见|缺失|仅见|只看到|未找到|不全|缺少)|(?:仅见|只看到|只见|仅有).{0,40}答案", message))
        wide_missing=missing and not event.get("number") and bool(re.search(r"其余|其他|仅见|只(?:看到|见|有)",message))
        candidates, page = issue_candidates(event, items, documents, wide_missing)
        if missing and candidates and all(items[i].get("answer", "").strip() for i in candidates):
            diagnostics.append("后续原页已补齐："+message)
            continue
        if missing and not candidates:
            # A segment cannot establish that answers are missing from the entire batch.
            diagnostics.append("未能对应到具体题目的分段答案说明："+message)
            continue
        if missing:
            candidates=[i for i in candidates if not items[i].get("answer","").strip()]
            message="参考答案尚未完整关联，请对照原页核对。" if len(candidates)>1 else "本题参考答案尚未关联，请对照原页核对。"
        issue = {"message": message, "kind": event.get("kind", "recognition"),
                 "exercise_indices": candidates, "page_index": page}
        if len(candidates) == 1:
            item = items[candidates[0]]
            issue.update(paper=item.get("paper", ""), number=item["number"], page_index=page or item.get("page_index"))
        elif event.get("paper"):
            issue["paper"] = event["paper"]
        signature = (message, tuple(candidates), issue.get("page_index"))
        if signature not in seen:
            seen.add(signature)
            issues.append(issue)
    return {"exercises": items, "warnings": [i["message"] for i in issues],
            "issues": issues, "diagnostics": list(dict.fromkeys(diagnostics))}
