# 渲染与依赖

## 一次生成与检查

使用随附 scripts/render_pdf.py，不临时复制脚本再逐项替换字符串。默认模板是 assets/note-layout.tex；scripts/notes_filter.lua 只把首行以“注解”开头的引用块转成文本框，普通引用块保持原意。

~~~bash
python3 <skill-dir>/scripts/render_pdf.py notes.md --output notes.pdf \
  --build-dir <scratch>/math-build --preview-dir <scratch>/math-preview
~~~

一次运行完成 Markdown 注解边界检查、Pandoc 转换、XeLaTeX 编译、缺字与溢出检查、字体嵌入与中文出现次数检查、全部页 PNG 和每四页一张的联系表。注解结束后紧跟未标注引用块会提示检查是否误用不带 > 的内部空行。默认预览 110 dpi；复杂符号可用 --preview-dpi 150。联系表用于快速扫版，不能替代逐页查看。

--build-dir 保留 notes.tex、notes.log、辅助文件与字体，用于诊断和复用；只在 TeX 日志要求时额外编译，最多两次。模板清除显示公式前后的空段落，以固定间距排版；不会修改源 Markdown 或代码块。

## 依赖与复用

需要 Pandoc、XeLaTeX、xeCJK、needspace、titlesec、tcolorbox、Poppler（pdftotext、pdffonts、pdftoppm）及可嵌入的中文字体。生成联系表还需要 Pillow。先查现有环境及本会话已准备的字体/texmf：

~~~bash
python3 <skill-dir>/scripts/render_pdf.py --check-deps \
  --tex-inputs <existing-runtime>/texmf --preview-dir <scratch>/math-preview
~~~

此命令只检查软件与 TeX 包；字体在渲染时自动检测，或明确提供路径。不要因为输出文件变化重复下载依赖或字体。

字体与局部 TeX 目录的完整调用：

~~~bash
python3 <skill-dir>/scripts/render_pdf.py notes.md --output notes.pdf \
  --font-file <runtime>/NotoSansCJKsc-Regular.otf \
  --bold-font-file <runtime>/NotoSansCJKsc-Bold.otf \
  --tex-inputs <runtime>/texmf \
  --build-dir <scratch>/math-build --preview-dir <scratch>/math-preview
~~~

## 缺依赖时

优先用现有运行环境或按当前权限安装正常依赖，不索取不必要的用户确认。常见 Debian 包为 pandoc、texlive-xetex、texlive-lang-chinese、texlive-latex-extra、fonts-noto-cjk、poppler-utils。Pillow 缺失时用当前 Python 环境安装；不要重复尝试同一权限失败。

系统安装不可用时，将字体和 TeX 运行包放进临时目录。不要修改系统或用户的全局 xeCJK 配置；圈号 ①–⑳ 的 CJK 字符分类已包含在模板里。

官方依赖来源：

- Noto 常规字体：https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf
- Noto 粗体：https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf
- ctex 运行文件：https://mirrors.ibiblio.org/CTAN/systems/texlive/tlnet/archive/ctex.tar.xz
- xeCJK 运行文件：https://mirrors.ibiblio.org/CTAN/systems/texlive/tlnet/archive/xecjk.tar.xz

下载二进制字体，安全解压 TeX 包，使用 tarfile.extractall(..., filter="data") 或等效越界检查。不要将仅有 .dtx 的源码包当作已可用的运行包。

匹配现有 TeX Live 版本；不要把新版 LaTeX 要求的 xeCJK 混进旧环境。TeX Live 2023 可用历史运行包 https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2023/tlnet-final/archive/xecjk.tar.xz 及同目录的 ctex.tar.xz，两者解压至同一个局部 texmf。

## 分页与排错

- 短板书与短注解成组分页。长注解只在原有加粗小标题处分段，并追加“续”；无适合分段点或高度过大时自然跨页。
- 默认不缩小正文或注解字号。超宽公式先在 Markdown 中合理拆行；超宽表格拆分或缩短单元格。
- 缺字先确认字体与字符分类；检查公式内 \text{中文}、圈号、分式、上下标、根号、cases 和矩阵。
- 过高内容不能用不可拆框强塞进页；观察垂直溢出、页尾与页码距离。
- 短注解被拆、页首只有一行、条件与结论分离或尾页只有一两行时，调整语义分段后重渲染。不要以减页数为目标盲改页边距。
- 预览目录每次会清除脚本生成的旧 page-*.png 与 contact-*.png，避免分页减少后留下旧末页。使用专用临时目录，不混放其他图片。

## 验证边界

中文出现次数与字体嵌入检查用于发现丢字或部分段落截断，不能证明每个公式或每行正文正确。按板书原编号逐项核对内容，并逐页检查最新截图。

若 XeLaTeX 无法使用，可采用其他完整 Unicode 数学排版管线，但须满足同样的字体嵌入、公式内中文、可搜索文本和视觉检查要求。不得静默降级成未验证输出。
