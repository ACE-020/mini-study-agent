# 笔记整理与工具说明

产品界面改名为“知错 · 学习整理助手”。保留原来的 mini-study-agent 文件夹和启动入口，避免破坏虚拟环境与快捷方式。错题与笔记共用“添加学习内容”入口，自动分类后分别进入两个库。

## 到底有几个工具

现在注册给模型的是以下 **7 个**工具。完整注册表是 tools.py 的 SCHEMAS，网页的“本次处理过程”会展示实际调用的名字与参数。

| 工具 | 模型何时使用 | 数据位置 |
| --- | --- | --- |
| search_notes(query) | 找相关笔记 | 读取 data/notes.json |
| save_mistake(question, user_answer, correct_answer, reason, topic) | 有依据地记录错题 | 写入 data/mistakes.json |
| get_mistakes(topic?, limit?) | 明确要求复习历史错题 | 读取 data/mistakes.json |
| pick_exercise(topic, exclude_id?, exercise_id?) | 从已确认资料中挑原题 | 读取 data/exercises.json |
| save_note(topic, content) | 保存整理好的完整 Markdown 笔记 | 写入 data/notes.json，导出到 data/note_exports/ |
| delete_records(items) | 生成所选记录的待确认删除清单 | 确认前不改数据 |
| merge_records(items, topic, content) | 生成可编辑的合并笔记预览 | 确认前不改数据 |

`_read` 是读取 JSON 的内部函数；`_write_mistakes` 是内部写文件函数；`execute` 校验白名单与参数后分发调用。这些没有注册进 SCHEMAS，模型不能直接调用。`save_mistake → _write_mistakes → _write_records` 是一条调用链，不是三个重复工具。没有另加同义的 write_note / write_mistake 工具。

## Skill 怎样接进应用

用户提供的八个文件完整保存在 skills/organize-math-board/，按原来的相对路径还原 agents、assets、references、scripts。

note_skill.py 从 SKILL.md 与 references/style.md 加载内容与注解规范；整理笔记时自动作为系统规则发送给模型，没有开关或手动选择 skill 的步骤。网页“助手规则 → 笔记整理（默认）”展示的内容与本次发送的规则相同。用户已有的 prompts.py 没有改写，原有错题讲解继续逐步引导；笔记整理负责生成完整笔记。

Skill 是规则与资源，复制文件本身不会让模型自动执行它。这里由 Python 加载规则、限制本轮工具范围，并执行 save_note。原 skill 中面向宿主的 Library/Git 操作由本地 JSON 与导出目录替代；它不是给全局 Codex 安装插件，也不依赖另一个应用中的技能开关。

## 使用流程

1. 重启原网页服务，进入侧边栏“添加学习内容”。模型沿用右上角现有配置。
2. 粘贴原稿，或多选图片、PDF、UTF-8 TXT、Markdown。每批最多 20 张图片 / PDF 页、80000 字，可指定页码；识别结果插入光标处，可手动修改。切到文字时隐藏上传区，文字保持不变。
3. 点击“交给 AI 整理”。有图片时，整理模型同时收到本次原图与核对后的文字，因此主模型也需要支持图片输入。原图仅留在会话内存，重启服务后消失。
4. 模型默认保留原编号、标题、符号与推导，自己的补充放入独立注解；关键符号不确定时先提问。补充答案后，在同一个笔记对话中继续。
5. save_note 写入 JSON，再导出 Markdown/PDF。相同内容不会重复保存；修改后作为另一份记录保留旧版。成功后收起原稿，笔记库可查看正文、搜索与下载。
6. “停止并编辑”、Esc、无选中文字时的 Ctrl+C 可取消当前请求。停止后原稿保留，已经写入的笔记不会回滚。刷新页面清空未提交输入与原图；已入库笔记仍在。

## 哪些地方调用 API

图片识别调用配置的 OCR 模型；整理、核对原图和必要的工具选择调用主模型。JSON 读写、关键词检索、去重、Markdown 导出、PDF 排版与下载都是本地 Python 执行，不另调用大模型 API。

统一原稿可同时使用 search_notes、save_note、save_mistake，误放入口不必重新上传。当前题仍不读历史错题；跨库分析只收到所选内容，不检索其他记录，删除和合并需要网页再次确认。资料和笔记正文作为输入数据处理，不作为系统指令。

## 导出与失败处理

最终 Markdown 是排版的唯一内容来源，Markdown/PDF 同名。先尝试原 skill 的 Pandoc/XeLaTeX 渲染器；没有完整 TeX 命令时，使用固定的 note_pdf.py 备用流程：本地 Markdown、KaTeX、Chrome/Edge 排版，A4、11pt、独立浅底注解框。PDF 检查公式解析、页面宽度、中文提取和字体嵌入；复杂公式无法排版时会明确报错。

依赖列入 requirements.txt。本机已安装；复制到新机器后，在项目虚拟环境执行 pip install -r requirements.txt。浏览器流程优先复用 Chrome/Edge，没有时可执行 python -m playwright install chromium。

JSON 保存与导出状态分别显示。PDF 失败时保留 JSON 和已生成的 Markdown，笔记条目提供“导出文件”，不会显示虚假的 PDF 成功链接。损坏的 JSON 不被覆盖。导出文件名由程序生成，模型不能指定任意磁盘路径。

自动检查不等于数学正确或原图完全辨识准确。实现阶段已对包含中文、行列式、分段函数、注解和多行推导的样例进行字体/文本检查并逐页查看。使用时仍应核对原稿；原稿不清晰时先补充，系统不提供数学证明验证器。PDF 批量导入已实现；DOCX、编辑覆盖旧笔记、向量检索与多人部署未实现。

## 怎么检查

- 打开“助手规则”，确认有默认笔记规则。
- 上传一张原稿，核对识别文字，点击整理；在处理过程中确认 save_note 的参数。
- 在笔记库下载 Markdown、PDF，核对原编号、变量与注解；重新启动服务后确认笔记仍在。
- 在错题对话里请它检索该知识点，查看 search_notes 是否返回新笔记。
- 在测试目录运行 python -m unittest discover -s tests -v。浏览器验收使用 tests/serve_workspace_fixture.py 与 tests/browser_workspace.cjs，只调用模拟模型和临时数据。


## 跨页勾选、删除与合并

错题本与笔记库右上角都有添加按钮，每条都有勾选和删除。选择会跨页面保留，可在“已选内容”栏分析共同点、合并去重或批量删除。分析窗口列出所选来源；改变所选集合后，后端与显示的分析上下文重新建立，避免夹带上一批内容。

删除先展示具体清单，取消不会改数据。确认时重新核对原记录快照；变化或过期的方案拒绝执行。批量删除保存到 data/trash.json，两个库更新中途失败或进程退出时，根据 data/library.transaction.json 恢复原记录。

合并先生成可编辑的完整笔记预览，默认保留原记录；可明确勾选移除原笔记，原错题保留。被合并的原笔记另存于 data/merge_backups/。正文与公式直接在网页显示，下载入口及导出状态在各自笔记内部，切换页面不显示无关记录的导出消息。
# 选择栏与文件预览补充

`math_text.py` 兼容早期纯文字公式，`web.py` 将转换结果作为 display_content 返回，原始 content 保留；`note_exports.py` 复用相同转换，旧缓存需重新生成。

`library_export.py` 把跨页所选笔记与错题生成 Markdown/PDF 合集或 JSON 原始数据，不调用模型。网页的固定选择栏包含“导出所选”和右下角“交给 AI”。

`file_preview.py` 与 `static/file-preview.js` 提供本机 PDF 逐页预览、跳页与回填读取范围。大 PDF 临时存盘；单文件 256 MB、整批 512 MB，预览可以浏览整本，模型一次仍处理最多 20 页。具体容量原因和清理规则见 WEB_GUIDE.md。

