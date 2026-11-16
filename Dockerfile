# 学习整理助手 · 小程序 API
#
# 构建：docker build -t study-agent-wx .
# 运行：docker run -d --name study-agent-wx -p 8766:8766 -v study-agent-data:/data \
#         -e LLM_API_KEY=sk-xxx -e WX_APPID=wx... -e WX_SECRET=... study-agent-wx
#
# 数据目录 /data 必须挂载出来：每个微信用户一个子目录，删容器不能删数据。

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    WX_API_DATA_DIR=/data

WORKDIR /app

COPY requirements-server.txt ./
RUN pip install --no-cache-dir -r requirements-server.txt

COPY . .

# 容器内用 root 运行：云托管挂载的文件存储通常只有 root 可写，换成普通用户会导致
# /data 不可写、用户的笔记和错题在实例重启后消失。安全边界在云托管网络层（关闭公网访问）。
RUN mkdir -p /data && chmod 700 /data

VOLUME ["/data"]
EXPOSE 80 8766

# 只开 1 个 worker：任务表在进程内存里，多 worker 会让轮询打到别的进程。
# 并发靠线程：--threads 16 足够 100 人以内的试用；要扩容先看 WECHAT_MINIPROGRAM.md 的“横向扩展”。
# 端口：云托管监听 80（平台注入 PORT），自建用 docker-compose 里的 PORT=8766。
CMD ["sh", "deploy/start.sh"]
