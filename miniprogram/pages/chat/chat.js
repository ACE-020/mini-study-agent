const api = require('../../utils/api.js');
const markdown = require('../../utils/markdown.js');

Page({
  data: {
    modes: [
      { key: 'organize', name: '整理' },
      { key: 'notes', name: '笔记' },
      { key: 'review', name: '复习' }
    ],
    mode: 'organize',
    messages: [],
    images: [],
    uploading: false,
    input: '',
    canSend: false,
    busy: false,
    progressText: '',
    taskId: '',
    anchor: '',
    configured: true
  },

  onLoad() {
    this.alive = true;
    api.status()
      .then((body) => {
        if (this.alive) {
          this.setData({ configured: body.configured !== false });
        }
      })
      .catch((error) => {
        if (error.code === 401) {
          return api.login();
        }
        this.toast(error.message);
        return null;
      });
  },

  onUnload() {
    this.alive = false;
  },

  toast(message) {
    wx.showToast({ title: message || '操作失败', icon: 'none', duration: 2600 });
  },

  onInput(event) {
    const value = event.detail.value;
    this.setData({ input: value, canSend: !!value.trim() });
  },

  switchMode(event) {
    if (this.data.busy) {
      return;
    }
    const mode = event.currentTarget.dataset.key;
    if (mode === 'review' && this.data.images.length) {
      // 复习作答图片要走 OCR 转写，小程序端还没接，先清掉，别让用户白等。
      this.toast('复习暂不支持图片作答，已清空所选图片');
      this.setData({ images: [] });
    }
    this.setData({ mode: mode });
  },

  onChooseImage() {
    if (this.data.busy || this.data.uploading) {
      return;
    }
    const remain = 4 - this.data.images.length;
    if (remain <= 0) {
      this.toast('一次最多带 4 张图片');
      return;
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const files = (res.tempFiles || []).map((item) => item.tempFilePath);
        this.uploadAll(files);
      }
    });
  },

  uploadAll(files) {
    if (!files || !files.length) {
      return;
    }
    this.setData({ uploading: true });
    // 串行上传：一条失败不影响其他，也不会瞬间打满服务端实例。
    const queue = files.slice();
    const done = [];
    const step = () => {
      const path = queue.shift();
      if (!path) {
        this.setData({ uploading: false });
        if (done.length) {
          this.setData({ images: this.data.images.concat(done) });
        }
        return;
      }
      api.uploadImage(path)
        .then((id) => {
          done.push({ id: id, path: path });
          step();
        })
        .catch((error) => {
          this.toast(error.message || '图片上传失败');
          step();
        });
    };
    step();
  },

  onRemoveImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images: images });
  },

  appendMessage(message) {
    const messages = this.data.messages.concat([message]);
    this.setData({ messages: messages, anchor: 'msg-' + (messages.length - 1) });
  },

  scrollToEnd() {
    this.setData({ anchor: 'thread-end' });
  },

  onSend() {
    const text = (this.data.input || '').trim();
    if (!text || this.data.busy) {
      return;
    }
    if (!this.data.configured) {
      this.toast('服务端还没有配置模型 API Key');
      return;
    }
    this.appendMessage({ role: 'user', text: text, html: '' });
    this.setData({ input: '', canSend: false, busy: true, progressText: '正在准备这一轮…' });
    this.scrollToEnd();

    const requestId = 'mp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const payload = {
      message: text,
      view: this.data.mode,
      request_id: requestId,
      image_ids: this.data.images.map((item) => item.id)
    };
    api.chat(payload)
      .then((task) => {
        if (!this.alive) {
          return Promise.reject({ message: '已离开页面' });
        }
        this.setData({ taskId: task.task_id });
        return api.pollTask(task.task_id, (update) => {
          if (!this.alive) {
            return;
          }
          const progress = update.progress || {};
          this.setData({ progressText: progress.message || '正在处理…' });
        });
      })
      .then((result) => {
        if (!this.alive) {
          return;
        }
        if (result.status === 'cancelled') {
          this.setData({ busy: false, progressText: '', taskId: '', images: [] });
          this.toast('已停止这一轮');
          return;
        }
        if (result.status === 'error') {
          this.setData({ busy: false, progressText: '', taskId: '', images: [] });
          this.appendMessage({ role: 'assistant', text: result.error || '这一轮没有完成', html: markdown.toHtml(result.error || '这一轮没有完成') });
          this.scrollToEnd();
          return;
        }
        const answer = result.answer || '（没有返回内容）';
        this.appendMessage({
          role: 'assistant',
          text: answer,
          html: markdown.toHtml(answer),
          question: result.current_question || null
        });
        this.setData({ busy: false, progressText: '', taskId: '', images: [] });
        this.scrollToEnd();
      })
      .catch((error) => {
        if (!this.alive) {
          return;
        }
        this.setData({ busy: false, progressText: '', taskId: '', images: [] });
        if (error.code === 401) {
          api.login().then(() => this.toast('登录已刷新，请重新发送')).catch(() => this.toast('登录失败'));
          return;
        }
        this.appendMessage({ role: 'assistant', text: error.message || '网络异常', html: markdown.toHtml(error.message || '网络异常') });
        this.scrollToEnd();
      });
  },

  onStop() {
    if (!this.data.taskId) {
      return;
    }
    api.cancel(this.data.taskId).then(() => {
      this.setData({ progressText: '正在停止…' });
    });
  },

  onReset() {
    if (this.data.busy) {
      this.toast('请先停止当前这一轮');
      return;
    }
    wx.showModal({
      title: '开始新的对话',
      content: '会清空这一段上下文，已经保存的笔记和错题不受影响。',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        api.resetConversation()
          .then(() => this.setData({ messages: [], anchor: '' }))
          .catch((error) => this.toast(error.message));
      }
    });
  },

  onCopy(event) {
    const text = event.currentTarget.dataset.text;
    if (text) {
      wx.setClipboardData({ data: text });
    }
  }
});
