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
    pendingTaskId: '',
    anchor: '',
    configured: true,
    ocrConfigured: false,
    needSettings: false
  },

  onLoad() {
    this.alive = true;
    this.unconfirmed = null;
    this.polling = null;
    this.authRetried = false;
  },

  onShow() {
    // 从「设置」返回时重新读一次状态：填完 Key 回来横幅要立刻消失。
    this.refreshStatus();
  },

  refreshStatus() {
    api.status()
      .then((body) => {
        if (!this.alive) {
          return;
        }
        const configured = body.configured !== false;
        this.setData({
          configured: configured,
          // 老后端没有这个字段：按 false 处理，行为与旧版一致。
          ocrConfigured: body.ocr_configured === true,
          needSettings: !configured || !!body.key_error
        });
      })
      .catch((error) => {
        if (error.code === 401) {
          return api.login();
        }
        if (this.alive) {
          this.toast(error.message);
        }
        return null;
      });
  },

  onUnload() {
    this.alive = false;
  },

  goSettings() {
    wx.switchTab({ url: '/pages/settings/settings' });
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
    if (this.data.pendingTaskId) {
      this.toast('上一轮还没结束，请先继续查看或停止');
      return;
    }
    if (!this.data.configured) {
      // 只配置了管理员 OCR Key 的老部署：带图这一轮仍然能跑，不要拦。
      const imagePath = this.data.images.length > 0 && this.data.ocrConfigured;
      if (!imagePath) {
        this.setData({ needSettings: true });
        this.toast('还没有可用的模型 API Key，请到「设置」填写');
        return;
      }
    }
    // 同一草稿复用同一个 request_id：提交失败后手动再发不会变成新任务。
    const signature = [this.data.mode, text, this.data.images.map((item) => item.id).join(',')].join('|');
    if (!this.unconfirmed || this.unconfirmed.signature !== signature) {
      this.unconfirmed = {
        requestId: 'mp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        signature: signature
      };
    }
    const payload = {
      message: text,
      view: this.data.mode,
      request_id: this.unconfirmed.requestId,
      image_ids: this.data.images.map((item) => item.id)
    };
    this.setData({ busy: true, progressText: '正在提交…' });

    let submitted = false;
    let activeTaskId = '';
    const attach = (taskId) => {
      activeTaskId = taskId;
      this.authRetried = false;
      this.setData({ taskId: taskId });
      return this.pollAttached(taskId);
    };

    api.chat(payload)
      .then((task) => {
        if (!this.alive) {
          return Promise.reject({ message: '已离开页面' });
        }
        submitted = true;
        this.unconfirmed = null;
        this.appendMessage({ role: 'user', text: text, html: '' });
        this.setData({ input: '', canSend: false, images: [] });
        this.scrollToEnd();
        return attach(task.task_id);
      })
      .catch((error) => {
        if (!this.alive) {
          return;
        }
        // 已提交：查询失败不能假装没发，也不能丢任务句柄。
        if (submitted) {
          this.setData({ busy: false, progressText: '', taskId: '', pendingTaskId: activeTaskId });
          this.toast((error && error.message) || '结果查询失败，可继续查看这一轮');
          return;
        }
        // 同一个 request_id 的重试：服务端已登记任务，接上它。
        if (error.code === 409 && error.body && error.body.retry && error.body.task_id) {
          submitted = true;
          this.unconfirmed = null;
          this.appendMessage({ role: 'user', text: text, html: '' });
          this.setData({ input: '', canSend: false, images: [], busy: true, progressText: '接上刚才那一轮…' });
          attach(error.body.task_id).catch(() => {
            this.setData({ busy: false, progressText: '', taskId: '', pendingTaskId: error.body.task_id });
            this.toast('这一轮还没结束，可继续查看');
          });
          return;
        }
        // 提交阶段失败：草稿、request_id 和附件都保留，消息不进入对话。
        this.setData({ busy: false, progressText: '', input: text, canSend: true });
        if (error.body && error.body.need_model_settings) {
          // 新后端在缺 Key 时直接拒绝提交：横幅引导去「设置」，草稿仍然保留。
          this.setData({ configured: false, needSettings: true });
          this.toast(error.message || '还没有可用的模型 API Key，请到「设置」填写');
          return;
        }
        if (error.code === 401 && !api.isCloudAuth()) {
          api.login().then(() => this.toast('登录已刷新，请重新发送')).catch(() => this.toast('登录失败'));
          return;
        }
        this.toast((error && error.message) || '发送失败，草稿已保留');
      });
  },

  pollAttached(taskId) {
    // 同一任务只保留一条轮询链：停止/继续查看都复用它，避免两个 finishTask 重复追加回答。
    if (this.polling && this.polling.taskId === taskId) {
      return this.polling.promise;
    }
    const chain = api.pollTask(taskId, (update) => {
      if (!this.alive) {
        return;
      }
      this.authRetried = false; // 能读到进度说明登录态有效
      const progress = update.progress || {};
      this.setData({ progressText: progress.message || '正在处理…' });
    }).then(
      (result) => {
        this.polling = null;
        return this.finishTask(result);
      },
      (error) => {
        this.polling = null;
        return this.handlePollFailure(taskId, error);
      }
    );
    this.polling = { taskId: taskId, promise: chain };
    return chain;
  },

  handlePollFailure(taskId, error) {
    if (!this.alive) {
      return;
    }
    if (error && error.code === 404) {
      // 任务已经不存在（服务重启或被清理）：释放句柄，允许重新发送。
      this.setData({ busy: false, progressText: '', taskId: '', pendingTaskId: '' });
      this.toast('这一轮已经不存在，可以重新发送');
      return;
    }
    if (error && error.code === 401 && !api.isCloudAuth()) {
      if (this.authRetried) {
        this.keepTask(taskId, '登录仍未恢复，请重新进入小程序');
        return;
      }
      this.authRetried = true;
      this.setData({ busy: true, progressText: '登录已刷新，正在继续查询…' });
      api.login()
        .then(() => this.pollAttached(taskId))
        .catch(() => this.keepTask(taskId, '登录失败，请重新进入小程序'));
      return;
    }
    this.keepTask(taskId, (error && error.message) || '结果查询失败，可继续查看这一轮');
  },

  keepTask(taskId, message) {
    this.setData({ busy: false, progressText: '', taskId: '', pendingTaskId: taskId });
    this.toast(message);
  },

  finishTask(result) {
    if (!this.alive) {
      return;
    }
    if (result.status === 'timeout') {
      // 任务还在服务端跑：保留句柄，允许“继续查看”或“停止”，不要谎称可以随意重发。
      this.setData({ busy: false, progressText: '', taskId: '', pendingTaskId: result.task_id || '' });
      this.toast('这一轮还没结束，可继续查看或停止');
      return;
    }
    if (result.status === 'cancelled') {
      this.setData({ busy: false, progressText: '', taskId: '', pendingTaskId: '', images: [] });
      this.toast('已停止这一轮');
      return;
    }
    if (result.status === 'error') {
      this.setData({ busy: false, progressText: '', taskId: '', pendingTaskId: '', images: [] });
      if (result.need_model_settings || result.error_code === 'settings_error') {
        // 个人 Key 无法解密或没有可用 Key：明确引导到「设置」，不要把内部细节当答案。
        this.setData({ configured: false, needSettings: true });
        this.toast(result.error || '模型配置有问题，请到「设置」检查');
        return;
      }
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
    this.setData({ busy: false, progressText: '', taskId: '', pendingTaskId: '', images: [] });
    this.scrollToEnd();
  },

  onStop() {
    const taskId = this.data.taskId || this.data.pendingTaskId;
    if (!taskId) {
      return;
    }
    // 取消回包可能晚于任务终态：届时不能再轮询或恢复旧句柄。
    const isCurrent = () => this.alive
      && (this.data.taskId === taskId || this.data.pendingTaskId === taskId);
    this.setData({ busy: true, progressText: '正在停止…' });
    api.cancel(taskId)
      .then(() => {
        if (!isCurrent()) {
          return null;
        }
        if (this.polling && this.polling.taskId === taskId) {
          return null; // 已有轮询链会拿到终态
        }
        return this.pollAttached(taskId);
      })
      .catch((error) => {
        if (!isCurrent()) {
          return; // 已经结束的任务：不改状态、不恢复句柄
        }
        const message = (error && error.message) || '停止失败，可继续查看这一轮';
        if (this.polling && this.polling.taskId === taskId) {
          this.setData({ progressText: '' });
          this.toast(message);
          return;
        }
        this.keepTask(taskId, message);
      });
  },

  onResumePending() {
    const taskId = this.data.pendingTaskId;
    if (!taskId || this.data.busy) {
      return;
    }
    this.setData({ busy: true, progressText: '继续等待这一轮…', pendingTaskId: '', taskId: taskId });
    this.pollAttached(taskId);
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
          .then(() => {
            // 换了新对话，未确认的提交编号也要作废，否则会把旧 request_id 带进新对话。
            this.unconfirmed = null;
            this.setData({ messages: [], anchor: '', pendingTaskId: '' });
          })
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
