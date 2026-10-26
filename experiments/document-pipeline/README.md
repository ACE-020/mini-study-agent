# PDF 导入对照实验 · 2026-10-24

2026-10-25 更新：[免费方案实测与付费价格](FREE_OCR_2026-10-25.md)。已下载并本地测试 GLM-OCR、PaddleOCR-VL、MinerU 标准/高精度；发现并修正实验分区裁图截断根号线的问题。新模型尚未接入网页，不把局部成功写成整页或全部题型通过。

继续识别优化：已新增 [第二轮候选与同图实测](OCR_CANDIDATES.md)。独立 Pix2Text 公式模型在同样 10 张局部图上完成对照，第 6 题根号范围识别优于基础模型，但存在其他误识别；不代表整页准确率。识别问题继续推进，服务器题集方案不代替这条任务线。

目前保留网页原有的直接读图流程。MinerU 已在本机安装并跑通，作为可复现的本地 PDF → Markdown + 来源位置转换试验，尚未接到网页按钮；不自动写入题库。导出试验暂告一段落，体验包不更新。

## 已验证的导入结果

| 测试 | 范围 | 用时 | 本机峰值内存 | 结果与边界 |
| --- | --- | --- | --- | --- |
| MinerU Basic，逐页、公式批量 1 | 原 PDF 文件第 16–20 页 | 141.62 秒总耗时；其中子进程 140.16 秒 | 1471.5 MiB | 5 页转换完成；保留 2 套试卷、32 个原题身份及全部对应答案位置 |
| 同一转换任务复用缓存 | 同上 | 0.09 秒，不含 Python 启动 | 未加载识别模型 | 5/5 检查点校验通过，直接重新组合输出 |
| MinerU Basic，扫描版 | 第 16 页渲染成无文字层 PDF | 33.73 秒 | 1573.1 MiB | 能恢复分段函数、嵌套根号、分式；只是清晰印刷扫描样本，未验证手写照片 |
| 现有 DeepSeek 直接读图 | 第 16–17 页 | 66.7 秒接口试验；含本地监控 67.34 秒 | 109.9 MiB | 16 题、无返回警告；人工抽查关键公式与原题号，未评估整体准确率 |

本地转换与云端读图的输出范围和任务不同，表格不能用于宣称哪一个整体更快、更准。云端模型的算力、内存也不在本机统计中。本次只验证了 5 页，未跑完整本 598 页，不承诺整本一轮完成。

“32 个身份与答案位置”来自原 PDF 的明确卷名、题号和坐标，是来源覆盖检查，**不是 32 题文字和答案全部正确的准确率**。`inspect_import.py` 校验这一指定样本，不能拿固定的 32 题断言验证其他试卷。

## 现在可以查看什么

- `work/results/import-16-20/document.md`：可导入当前网页的 Markdown 校对稿，含物理页码与完整卷名。
- `work/results/import-16-20/preview.html`：离线预览，已嵌入本地公式资源；97 个公式节点渲染成功、0 个 KaTeX 语法错误。可以双击打开。渲染成功不证明公式内容正确。
- `work/results/import-16-20/document.json`：完整来源页、原始块、归一化坐标、页眉与原 PDF 标签。
- `work/results/import-16-20/identities.json`：以完整卷名 + 原题号匹配题目/答案位置，避免两套试卷同名时混淆。
- `work/results/import-16-20/checks.json`、`work/results/*-metrics.json`、`work/logs/`：校验、资源使用与原始日志。
- `work/results/current-vision-audit.json`：唯一一次真实 API 对照的调用计数和用量，不含密钥。

## 识别仍有的缺陷

1. MinerU 默认 Markdown 丢掉页眉，包括卷名与前面的 1/2 编号。本试验从原 PDF 明确标签及结构化 JSON 中保留这些信息，再写回 Markdown；继续页继承来源标签，数学表达式不取自平铺文字层。
2. 第 16 页 L'Hôpital 人名及脚注标记被识别成奇怪的公式，第 18 页一处 `e` 被识别为带下标的 `e_x`。这些错误保留在识别稿里，没有凭猜测修正。
3. 部分题目/答案之间换行被合并，填空横线可能丢失；仍需后续拆题与核对。原题号/坐标可用于找回原页，不等于语义拆题已验收。
4. 用户此前两份 MD 标注来源为旧版 1.3.2，readable 版说明仅清理排版；其中已有平铺公式。因此不把它们当作当前 1.4.3 PDF 的正确答案或 LaTeX 真值，也不把版本差异直接归为 OCR 错误。
5. 清晰印刷页、低清照片、手写解答的效果不能互相代替。没有在所有题型上比较识别率。

## 工具安装与选择

- **MinerU 4.0.12 / DocVortex 0.6.1**：`.tools/document-pipeline/mineru-env`。CPU Basic + ONNX，本次不加载 Torch；本地公式批量从默认 8 改为运行时 1，未改上游包或模型。默认批量曾在约 2 GB 触发保护，调小后完成试验。
- **Marker-pdf 2.0.0 / Surya 0.22.1 / Torch 2.14.1+cpu**：安装于独立 `marker-env`；命令入口验证通过，尚未完成真实转换。Windows llama.cpp CPU 运行时已下载并核对公开校验值，约 1.37 GiB GGUF 权重未下载完。原下载客户端曾超过 1 GB 内存；改为 HTTP 流式下载后峰值约 42 MiB。为集中验证已跑通的导入路径，主动暂停大模型下载，保留 `.part` 断点；**不能把它写成准确率或速度不如 MinerU 的实测结论**。没有后台下载或推理进程继续运行。
- **Brewdoc md-to-pdf skill**：项目本地副本在 `.tools/document-pipeline/vendor-skills/brewdoc-md-to-pdf`，未安装到全局助手技能。本机测试的 ReportLab 模式有中文与公式问题，不接入；不代表其所有后端都测试失败。
- **Pandoc + 本地 KaTeX + Chrome**：数学/中文试验可运行，已有独立样例与检查结果；本轮暂停进一步导出改造，现有网页导出未改动。

官方资料：[MinerU](https://github.com/opendatalab/MinerU)、[Marker](https://github.com/datalab-to/marker)、[Marker 所需 Surya 权重](https://huggingface.co/datalab-to/surya-ocr-2-gguf)、[Brewdoc skill](https://github.com/kochetkov-ma/claude-brewcode/tree/1b3bbe590a14b491c04339f1d56abc77af6eefa7/brewdoc/skills/md-to-pdf)。Skill 是使用方法，实际转换由相应程序执行；不需要全部注册成学习 Agent 的模型工具。

## 本机重现与继续开发

在项目根目录运行，指定物理文件页码。每批最多 20 页，串行识别，缓存按源文件 SHA256、物理页码、转换版本隔离。即使模型工作进程失败，已完成页的校验检查点仍保留，下次继续。

```powershell
.\.venv\Scripts\python.exe -X utf8 experiments/document-pipeline/import_pdf.py 'D:\yjm\UMath\Higher_Mathematics\大邮数学集-1.4.3.pdf' --pages 16-20 --output experiments/document-pipeline/work/results/import-16-20

# 只允许复用已校验的结果，不启动模型；缺页立即报错。
.\.venv\Scripts\python.exe -X utf8 experiments/document-pipeline/import_pdf.py 'D:\yjm\UMath\Higher_Mathematics\大邮数学集-1.4.3.pdf' --pages 16-20 --cache-only --output experiments/document-pipeline/work/results/import-16-20
```

`import_pdf.py` 使用应用 Python 读取原 PDF 标签，将每一页交给独立环境的 `parse_mineru.py`；`run.py` 设置 2 个 CPU 线程、180 秒单页超时、1800 MiB 进程树预算。系统可用内存低于 384 MiB 持续 8 秒也停止。预算是中止阈值，并非操作系统硬隔离；不要并行启动多个识别任务。仅清理当前试验自己的子进程。

输出 Markdown 和 JSON 一起保留；只把 MD 上传网页会保留其中写出的页码/卷名文字，但不会自动导入 JSON 坐标。当前图片原页与坐标联动仍由网页原有直接读图管线负责。

优先的后续接入方向：作为共用文档读取层的可选本地转换器，两个上传入口复用；结果仍经题目拆分、答案匹配、疑点核对才入库。接入时需要取消任务、并发锁、逐页进度和内存不足的就地反馈，不能只把一个长时间阻塞的转换命令塞进按钮。现阶段不替换已经可用的默认流程。

唯一一次付费对照已经完成：仅发用户明确授权的第 16–17 页及位置标签，`deepseek-flash`，请求 1 次、自动重试 0 次、总量 23940 tokens。`compare_current.py` 有已执行审计检查，拒绝重复运行；进一步真实模型测试需重新明确授权。其余转换、来源检查、HTML 校对均在本地进行，无新增 API 请求，无题库写入。

模型和试验资料均未进入主虚拟环境、个人数据、启动服务或体验包；`.gitignore` 已排除 `.tools/` 和本目录 `work/`。这里只是一份本机试验记录，不是所有电脑都可复用的安装器，也不是发布包。
