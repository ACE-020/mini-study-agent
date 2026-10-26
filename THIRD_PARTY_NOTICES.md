# 第三方资源

网页内置以下前端依赖，以便本机使用时无需加载外部 CDN。分发时保留对应许可文本：

- Marked：`static/vendor/marked-LICENSE.txt`
- DOMPurify：`static/vendor/dompurify-LICENSE.txt`
- KaTeX 及其随附网页字体：`static/vendor/katex-LICENSE.txt`

Python 依赖通过 `requirements.txt` 安装，不把虚拟环境复制进仓库。本机 OCR 与文档实验工具、模型权重没有包含在源码中；另行安装时遵循各项目自己的许可。

用户导入的题目、笔记、照片、参考书与试卷均不在源码发布范围。项目中的学习示例为演示内容；真实模型的数学与识别结果仍需核对。
