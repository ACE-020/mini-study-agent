"""Local attempt history. Scheduling is deliberately left to a later feature."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile
import threading
import hashlib
from uuid import uuid4

ERROR_TYPES = {"concept":"概念理解", "conditions":"条件遗漏", "method":"方法选择",
               "formula":"公式使用", "calculation":"运算失误", "reasoning":"推理不完整",
               "reading":"审题偏差", "notation":"书写表达", "unconfirmed":"错因待确认"}
OUTCOMES = {"not_answered", "unassessed", "partial", "incorrect", "correct"}
_locks = {}
_registry_lock = threading.Lock()


def now():
    return datetime.now(timezone.utc).isoformat()


def question_key(question):
    identity = question["id"]
    return identity if identity.startswith(("exercise:", "mistake:", "generated:")) else "exercise:"+identity


def question_signature(question):
    return hashlib.sha256(" ".join(question["question"].split()).encode("utf-8")).hexdigest()


def assessment_fields(outcome, assisted, error_tags, evidence):
    if outcome not in OUTCOMES-{"not_answered"} or type(assisted) is not bool:
        raise ValueError("请选择有效的作答情况和提示情况。")
    if (not isinstance(error_tags, list) or len(error_tags)>len(ERROR_TYPES) or
            any(not isinstance(tag,str) or tag not in ERROR_TYPES for tag in error_tags)):
        raise ValueError("错因标签无效。")
    if not isinstance(evidence,str) or not evidence.strip() or len(evidence)>1500:
        raise ValueError("请提供 1 到 1500 字的判定依据。")
    if outcome=="incorrect" and not error_tags:
        error_tags=["unconfirmed"]
    if outcome in {"correct", "unassessed"} and error_tags:
        raise ValueError("本次答对或尚未判定时，不新增错因标签；以前的错因仍保留。")
    return dict(outcome=outcome, assisted=assisted, error_tags=list(dict.fromkeys(error_tags)), evidence=evidence.strip())


class ReviewProgress:
    def __init__(self, directory):
        self.path=Path(directory)/"review-attempts.json"
        with _registry_lock:
            self.lock=_locks.setdefault(str(self.path.resolve()),threading.RLock())

    def _read(self):
        if not self.path.exists():
            return []
        value=json.loads(self.path.read_text(encoding="utf-8"))
        if (not isinstance(value,dict) or value.get("version")!=1 or not isinstance(value.get("attempts"),list)):
            raise ValueError("做题记录格式有误，原文件未被覆盖。")
        attempts=value["attempts"]
        if any(not isinstance(a,dict) or not all(isinstance(a.get(k),str) and a[k] for k in
               ("id","question_id","round_id","started_at","updated_at")) or
               a.get("outcome") not in OUTCOMES or not isinstance(a.get("turns"),list) or
               not isinstance(a.get("assessments"),list) or not isinstance(a.get("error_tags"),list)
               for a in attempts):
            raise ValueError("做题记录内容有误，原文件未被覆盖。")
        for attempt in attempts:
            if (not isinstance(attempt.get("question"),dict) or
                    not all(isinstance(attempt["question"].get(k),str) and attempt["question"][k] for k in ("id","topic","question")) or
                    type(attempt.get("assisted")) is not bool or type(attempt.get("was_wrong")) is not bool or
                    attempt.get("closed_at") is not None and not isinstance(attempt["closed_at"],str) or
                    attempt.get("first_answer_at") is not None and not isinstance(attempt["first_answer_at"],str) or
                    any(not isinstance(tag,str) or tag not in ERROR_TYPES for tag in attempt["error_tags"])):
                raise ValueError("做题记录字段有误，原文件未被覆盖。")
            if any(not isinstance(t,dict) or not all(isinstance(t.get(k),str) and t[k] for k in ("at","request_id","text")) for t in attempt["turns"]):
                raise ValueError("作答时间记录有误，原文件未被覆盖。")
            for entry in attempt["assessments"]:
                if not isinstance(entry,dict) or not isinstance(entry.get("at"),str) or entry.get("source") not in ("model","user"):
                    raise ValueError("作答判定记录有误，原文件未被覆盖。")
                try:assessment_fields(**{k:entry[k] for k in ("outcome","assisted","error_tags","evidence")})
                except (ValueError,TypeError,KeyError) as exc:raise ValueError("作答判定字段有误，原文件未被覆盖。") from exc
        return attempts

    def _write(self, attempts):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        temporary=None
        try:
            with tempfile.NamedTemporaryFile(mode="w",encoding="utf-8",dir=self.path.parent,delete=False) as file:
                temporary=file.name
                json.dump({"version":1,"attempts":attempts},file,ensure_ascii=False,indent=2)
                file.write("\n");file.flush();os.fsync(file.fileno())
            os.replace(temporary,self.path)
        finally:
            if temporary and Path(temporary).exists():Path(temporary).unlink()

    def begin(self, question, round_id):
        with self.lock:
            attempts=self._read();stamp=now()
            attempt=dict(id=uuid4().hex,question_id=question_key(question),round_id=round_id,
                         question=deepcopy(question),started_at=stamp,updated_at=stamp,closed_at=None,
                         first_answer_at=None,outcome="not_answered",assisted=False,was_wrong=False,error_tags=[],turns=[],assessments=[])
            attempts.append(attempt);self._write(attempts);return deepcopy(attempt)

    def _update(self, identity, action):
        with self.lock:
            attempts=self._read();attempt=next((a for a in attempts if a["id"]==identity),None)
            if attempt is None:raise ValueError("这次做题记录不存在。")
            action(attempt);attempt["updated_at"]=now();self._write(attempts);return deepcopy(attempt)

    def submit(self, identity, text, request_id, attachment_text=None):
        if not isinstance(text,str) or not text.strip() or len(text)>80000:
            raise ValueError("作答内容无效。")
        def add(attempt):
            if attempt["closed_at"]:raise ValueError("本次做题已经结束，请重新选题。")
            if any(t["request_id"]==request_id for t in attempt["turns"]):return
            stamp=now();attempt["first_answer_at"]=attempt.get("first_answer_at") or stamp
            attempt["turns"].append(dict(at=stamp,request_id=request_id,text=text,attachment_text=attachment_text))
            # A later answer needs a fresh assessment; previous judgments remain in the log.
            attempt["outcome"]="unassessed"
        return self._update(identity,add)

    def assess(self, identity, *, outcome, assisted, error_tags, evidence, source="model"):
        fields=assessment_fields(outcome,assisted,error_tags,evidence)
        def add(attempt):
            if not attempt["turns"]:raise ValueError("尚未收到用户作答或求助，不能凭空记录做题结果。")
            if attempt["closed_at"]:raise ValueError("本次做题已经结束。")
            entry=dict(at=now(),source=source,turn=len(attempt["turns"]),**fields)
            # Tool retries must not duplicate the same judgment.
            if attempt["assessments"] and all(attempt["assessments"][-1].get(k)==entry[k] for k in entry if k!="at"):
                return
            attempt["assessments"].append(entry);attempt["outcome"]=outcome
            attempt["assisted"]|=assisted
            attempt["was_wrong"]|=outcome=="incorrect" or bool(fields["error_tags"])
            attempt["error_tags"]=list(dict.fromkeys([*attempt["error_tags"],*fields["error_tags"]]))
        return self._update(identity,add)

    def close(self, identity):
        if identity:return self._update(identity,lambda a:a.update(closed_at=a["closed_at"] or now()))

    def get(self, identity):
        with self.lock:return deepcopy(next((a for a in self._read() if a["id"]==identity),None))

    @staticmethod
    def public(attempt, detail=False):
        result={k:deepcopy(v) for k,v in attempt.items() if k not in {"turns","question","assessments"}}
        result["turn_count"]=len(attempt["turns"])
        result["independent_correct"]=attempt["outcome"]=="correct" and not attempt["assisted"] and not attempt["was_wrong"]
        result["question_title"]=attempt["question"].get("topic","")
        if detail:
            result["assessments"]=deepcopy(attempt["assessments"])
            result["turns"]=[{k:(v[:1200] if k=="text" else v) for k,v in t.items() if k!="attachment_text"} for t in attempt["turns"]]
        return result

    def summary(self):
        with self.lock:
            groups={}
            for attempt in self._read():
                if not attempt["turns"]:continue
                entry=groups.setdefault(attempt["question_id"],dict(count=0,last=None,error_tags=[],assisted_count=0,correct_count=0))
                entry["count"]+=1;entry["last"]=self.public(attempt)
                entry["error_tags"]=list(dict.fromkeys([*entry["error_tags"],*attempt["error_tags"]]))
                entry["assisted_count"]+=int(attempt["assisted"])
                entry["correct_count"]+=int(attempt["outcome"]=="correct")
            return groups

    def history(self, question_id=None, offset=0, limit=20):
        with self.lock:
            attempts=[a for a in self._read() if a["turns"] and (not question_id or a["question_id"]==question_id)]
            attempts.reverse()
            return dict(total=len(attempts),attempts=[self.public(a,True) for a in attempts[offset:offset+limit]])


RECORD_SCHEMA={"type":"function","function":{"name":"record_review_result",
    "description":"记录当前题本次作答的观察结果；只根据用户实际步骤与已给出的帮助判定，不安排复习日期。调用后继续正常讲解。",
    "parameters":{"type":"object","additionalProperties":False,"properties":{
        "outcome":{"type":"string","enum":["unassessed","partial","incorrect","correct"]},
        "assisted":{"type":"boolean"},"error_tags":{"type":"array","items":{"type":"string","enum":list(ERROR_TYPES)},"maxItems":len(ERROR_TYPES)},
        "evidence":{"type":"string","minLength":1,"maxLength":1500}},"required":["outcome","assisted","error_tags","evidence"]}}}
RECORD_POLICY="""记录当前题的实际作答情况：每次收到用户步骤、答案或求助，应在回复前调用 record_review_result。
仅一个中间步骤成立记 partial，不能当整题做对；错误步骤记 incorrect，给有依据的错因标签，不确定错因用 unconfirmed。
只在整题答案与理由核对正确时记 correct；信息不足用 unassessed，不猜测正确性。用户只求提示且未作答不能记错。
你给过实质提示、关键方法、下一步答案或完整解答时 assisted=true；仅邀请用户先尝试不算提示。先前错误和提示不会因最后改对而被清除。
判定依据简短具体，工具只作用于当前题，不接收任意题号。没有提交作答的题目不算做过。不安排日期、不承诺自动复习。
只有剩余未出题数量大于0时才建议再选一道；为0应说明本轮已经出完，可换范围或结束本轮后重做。"""
