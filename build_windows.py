"""生成 Windows x64 单文件 exe 和供同学下载的 ZIP；不打包用户数据。"""

import argparse
import importlib.metadata
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parent


def create_icon():
    from PIL import Image, ImageDraw
    assets = ROOT / "build_assets"
    assets.mkdir(exist_ok=True)
    image = Image.new("RGBA", (256, 256))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, 255, 255), radius=58, fill="#ece8fc")
    purple = "#6755cf"
    draw.line([(45,59),(97,59),(126,76),(126,199),(96,180),(45,180),(45,59)],fill=purple,width=12,joint="curve")
    draw.line([(126,76),(156,59),(209,59),(209,180),(158,180),(126,199)],fill=purple,width=12,joint="curve")
    image.save(assets / "app.ico", sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "dist/windows")
    parser.add_argument("--work", type=Path, default=ROOT / "build/windows")
    parser.add_argument("--package-only", action="store_true", help="只更新说明/源码附件，复用已验收的 exe")
    args = parser.parse_args()
    output, work = args.output.resolve(), args.work.resolve()
    output.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    create_icon()
    command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--onefile", "--noconsole", "--noupx",
               "--name", "知错", "--distpath", str(output), "--workpath", str(work / "pyinstaller"),
               "--specpath", str(work), "--icon", str(ROOT / "build_assets/app.ico"),
               "--log-level", "WARN", "--hidden-import", "note_pdf", "--collect-all", "playwright",
               "--collect-all", "pymupdf", "--copy-metadata", "Flask", "--copy-metadata", "Pillow",
               "--python-option", "X utf8"]
    for folder in ("static", "templates", "skills", "build_assets"):
        command += ["--add-data", str(ROOT / folder) + ":" + folder]
    command.append(str(ROOT / "desktop.py"))
    if not args.package_only:
        subprocess.run(command, cwd=ROOT, check=True)
    elif not (output / "知错.exe").is_file():
        raise ValueError("没有可复用的 exe，请先正常构建。")
    package = output / "知错-Windows-x64"
    package.mkdir(exist_ok=True)
    shutil.copy2(output / "知错.exe", package / "知错.exe")
    shutil.copytree(ROOT / "examples", package / "示例资料", dirs_exist_ok=True)
    guide = """知错 · 学习整理助手 — Windows 64 位体验版

1. 解压整个压缩包，双击“知错.exe”。不需要安装 Python，也不需要执行命令。
2. 程序会打开本机网页；第一次在“模型设置”填写服务地址、API Key 和模型。
3. Key 不随软件提供；完整 AI 功能需要联网，费用由所填 Key 的账户承担。
4. 可使用“示例资料”体验笔记、错题与资料题库；也可以上传自己的图片或 PDF。
5. 关闭启动小窗口即可退出程序。重复双击会打开已有页面，不会重复启动服务。

运行要求：Windows 10/11，x64。网页使用默认浏览器；PDF 导出需已安装 Edge 或 Chrome。
模型要求：整理需工具调用；带图整理及 OCR 需相应模型支持图片输入。

你的数据保存在：%LOCALAPPDATA%\\ZhicuoStudy
启动窗口的“打开数据文件夹”可以查看；data 是学习记录，.local-settings.json 是本机加密配置。
升级时替换程序即可；学习记录不会保存在 exe 的临时解压目录中。
不要把自己的数据目录、API Key 或配置文件发给别人。

Windows 可能因程序尚未代码签名而显示未知发布者提示；请确认软件来自可信渠道。
历史对话暂不持久保存；“清空本次上传”按当前上传页清空临时内容，已收录内容保留。
练习资料可后台整理；右上角圆钮查看任务，核对后入库。关闭程序会清空后台任务。
出现问题时，请反馈操作步骤、预期结果、实际结果和模型名称；不要附上 API Key。
启动问题可查看数据目录里的 desktop.log。
"""
    (package / "使用说明.txt").write_text(guide, encoding="utf-8-sig")
    licenses = package / "第三方组件"
    licenses.mkdir(exist_ok=True)
    names = ("Flask", "Werkzeug", "Jinja2", "MarkupSafe", "itsdangerous", "click", "blinker", "Pillow",
             "playwright", "pyee", "greenlet", "typing_extensions", "PyMuPDF", "PyInstaller")
    notice = ["第三方组件版本与项目地址（保留原许可证；不改变各组件许可条件）\n"]
    for name in names:
        dist = importlib.metadata.distribution(name)
        notice.append(f"{name} {dist.version}\n" + "\n".join(dist.metadata.get_all("Project-URL") or [dist.metadata.get("Home-page", "")]) + "\n")
        for item in dist.files or []:
            if item.name.lower().startswith(("license", "copying", "notice")) and dist.locate_file(item).is_file():
                dest = licenses / name / item.name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dist.locate_file(item), dest)
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    if python_license.exists():
        shutil.copy2(python_license, licenses / "Python-LICENSE.txt")
    (licenses / "组件版本.txt").write_text("\n".join(notice), encoding="utf-8-sig")
    # 同时附当前项目源码，不含个人 JSON、密钥、虚拟环境或设计书籍。
    with zipfile.ZipFile(package / "项目源码.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        files = [p for p in ROOT.iterdir() if p.is_file() and (p.suffix in (".py", ".md", ".cmd") or p.name in ("requirements.txt", "requirements-build.txt", ".gitignore"))]
        for folder in ("static", "templates", "skills", "examples", "tests", "build_assets"):
            files += [p for p in (ROOT/folder).rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix not in (".pyc", ".pyo")]
        for file in sorted(files):
            archive.write(file, "mini-study-agent/" + file.relative_to(ROOT).as_posix())
    archive_path = output / "知错-Windows-x64.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(package.rglob("*")):
            if file.is_file():
                archive.write(file, package.name + "/" + file.relative_to(package).as_posix())
    print("Windows package: " + str(archive_path), flush=True)
    print("Executable: " + str(package / "知错.exe"), flush=True)


if __name__ == "__main__":
    main()
