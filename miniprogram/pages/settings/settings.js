const api = require('../../utils/api.js');

// 头像和昵称都就地编辑、自动保存：不再有“修改 → 分别保存”的必经步骤。
// 头像：点圆形头像即可选择（微信 chooseAvatar，可选微信头像或相册），选完立即上传。
// 昵称：直接点昵称输入框改，失焦/完成时自动保存；空白不覆盖旧昵称，同值不发请求。
Page({
  data: {
    loading: true,
    loadError: '',
    profile: null,
    nicknameDraft: '',
    nicknameSaving: false,
    nicknameError: '',
    avatarUploading: false,
    avatarError: '',
    model: null,
    modelDraft: '',
    keyDraft: '',
    modelSaving: false,
    modelTesting: false,
    testResult: null,
    modelError: '',
    clearing: false,
    deleting: false
  },

  onLoad() {
    this.alive = true;
    this.lastSavedNickname = '';
    this.pendingNickname = '';
    this.pendingBlank = false;
    this.loading = false;
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load(true);
  },

  onUnload() {
    this.alive = false;
  },

  toast(message) {
    wx.showToast({ title: message || '操作失败', icon: 'none', duration: 2400 });
  },

  load(refreshing) {
    if (this.loading) {
      if (refreshing) {
        wx.stopPullDownRefresh();
      }
      return;
    }
    this.loading = true;
    // 首次进入：显示骨架；再次进入不闪屏，只刷新内容。
    this.setData({ loading: !this.data.profile, loadError: '' });
    Promise.all([api.profile(), api.modelSettings()])
      .then((results) => {
        if (!this.alive) {
          return;
        }
        const profile = (results[0] && results[0].profile) || {};
        const model = (results[1] && results[1].model) || {};
        this.lastSavedNickname = (profile.nickname || '').trim();
        const draft = (this.data.nicknameDraft || '').trim();
        // 用户还没保存的草稿要保留：刷新不能把正在改的昵称冲掉。
        const keepDraft = !!draft && draft !== this.lastSavedNickname && !this.data.nicknameSaving;
        // 只覆盖当前没有正在保存的字段：刷新回包晚于保存回包时，不能把新头像/新昵称打回去。
        const merged = Object.assign({}, this.data.profile || {});
        if (!this.data.nicknameSaving) {
          merged.nickname = profile.nickname;
          merged.default_nickname = profile.default_nickname;
          merged.updated_at = profile.updated_at;
        }
        if (!this.data.avatarUploading) {
          merged.avatar = profile.avatar;
        }
        this.setData({
          loading: false,
          loadError: '',
          profile: merged,
          model: model,
          modelDraft: model.model || '',
          nicknameDraft: keepDraft ? this.data.nicknameDraft : (profile.nickname || '')
        });
      })
      .catch((error) => {
        if (!this.alive) {
          return;
        }
        // 旧服务端没有 /me/* 路由时会回 404：给一句能照着做的提示，而不是抛接口名。
        const missingApi = error && error.code === 404;
        this.setData({
          loading: false,
          loadError: missingApi
            ? '服务端还是旧版本，缺少账号与设置接口。请让管理员更新并重新部署服务端，然后点「重试」。'
            : ((error && error.message) || '加载失败，请重试')
        });
      })
      .then(() => {
        this.loading = false;
        if (refreshing) {
          wx.stopPullDownRefresh();
        }
      });
  },

  onRetry() {
    this.load();
  },

  // ---- 昵称：失焦/完成即保存 ----

  onNicknameInput(event) {
    this.setData({ nicknameDraft: event.detail.value, nicknameError: '' });
  },

  onNicknameDone(event) {
    const value = event && event.detail && typeof event.detail.value === 'string'
      ? event.detail.value
      : this.data.nicknameDraft;
    this.setData({ nicknameDraft: value || '' });
    this.commitNickname();
  },

  commitNickname() {
    const draft = (this.data.nicknameDraft || '').trim();
    if (!draft) {
      if (this.data.nicknameSaving) {
        // 保存进行中被清空：等它回来后再对齐服务端值，绝不用空值盖掉。
        this.pendingBlank = true;
        return;
      }
      // 空白不覆盖：恢复上一次保存过的昵称，输入框也不会变成空。
      this.setData({ nicknameDraft: this.lastSavedNickname || '', nicknameError: '' });
      this.toast('昵称不能为空，已保留原昵称');
      return;
    }
    // 保存中先入队：即使改回“看起来相同”的旧值，也要在上一笔落地后重新写一次。
    if (this.data.nicknameSaving) {
      this.pendingNickname = draft;
      return;
    }
    if (draft === this.lastSavedNickname) {
      return; // 没有在途请求且同值：不发重复请求
    }
    this.saveNickname(draft);
  },

  saveNickname(nickname) {
    this.setData({ nicknameSaving: true, nicknameError: '' });
    api.updateProfile({ nickname: nickname })
      .then((body) => {
        if (!this.alive) {
          return;
        }
        const profile = (body && body.profile) || {};
        this.lastSavedNickname = (profile.nickname || nickname).trim();
        const current = (this.data.nicknameDraft || '').trim();
        // 只合并昵称相关字段：头像上传的回包可能更早，整份覆盖会把头像退回旧值。
        const patch = {
          nicknameSaving: false,
          profile: Object.assign({}, this.data.profile || {}, {
            nickname: profile.nickname || nickname,
            default_nickname: profile.default_nickname,
            updated_at: profile.updated_at
          })
        };
        if (this.pendingBlank || !current || current === nickname) {
          patch.nicknameDraft = profile.nickname || nickname;
        }
        this.pendingBlank = false;
        this.setData(patch);
        this.toast('昵称已更新');
      })
      .catch((error) => {
        if (!this.alive) {
          return;
        }
        // 失败保留草稿，用户可以直接再失焦重试。
        this.setData({ nicknameSaving: false, nicknameError: (error && error.message) || '昵称没有保存，请重试' });
      })
      .then(() => {
        const pending = this.pendingNickname;
        this.pendingNickname = '';
        if (pending && pending !== this.lastSavedNickname && this.alive) {
          this.saveNickname(pending);
        }
      });
  },

  // ---- 头像：选完即上传 ----

  onChooseAvatar(event) {
    const url = event && event.detail && event.detail.avatarUrl;
    if (!url) {
      return; // 用户取消选择：不改任何东西
    }
    if (this.data.avatarUploading) {
      return;
    }
    this.setData({ avatarUploading: true, avatarError: '' });
    api.uploadAvatar(url)
      .then((body) => {
        if (!this.alive) {
          return;
        }
        const profile = (body && body.profile) || {};
        // 只合并头像字段：昵称保存的回包可能更早，整份覆盖会把昵称退回旧值。
        this.setData({
          avatarUploading: false,
          profile: Object.assign({}, this.data.profile || {}, { avatar: profile.avatar })
        });
        this.toast('头像已更新');
      })
      .catch((error) => {
        if (!this.alive) {
          return;
        }
        this.setData({ avatarUploading: false, avatarError: (error && error.message) || '头像没有保存，请重试' });
      });
  },

  // ---- 模型配置 ----

  onModelInput(event) {
    this.setData({ modelDraft: event.detail.value, modelError: '' });
  },

  onKeyInput(event) {
    this.setData({ keyDraft: event.detail.value, modelError: '' });
  },

  modelPayload() {
    const key = (this.data.keyDraft || '').trim();
    const model = (this.data.modelDraft || '').trim();
    const payload = {};
    if (model) {
      payload.model = model;
    }
    if (key) {
      payload.api_key = key;
    }
    return payload;
  },

  modelReady() {
    const saved = !!(this.data.model && this.data.model.key_saved);
    return saved || !!(this.data.keyDraft || '').trim();
  },

  saveModel() {
    if (this.data.modelSaving) {
      return;
    }
    if (!this.modelReady()) {
      this.toast('请先填写 API Key');
      return;
    }
    this.setData({ modelSaving: true, modelError: '', testResult: null });
    api.saveModelSettings(this.modelPayload())
      .then((body) => {
        if (!this.alive) {
          return;
        }
        const status = (body && body.model) || {};
        this.setData({
          modelSaving: false,
          model: status,
          modelDraft: status.model || this.data.modelDraft,
          keyDraft: '' // 保存后立刻从输入框清掉，避免密钥停留在界面上
        });
        this.toast('已保存，聊天会使用你的模型');
      })
      .catch((error) => {
        if (!this.alive) {
          return;
        }
        // 保存失败：Key 保留在输入框里，用户不用重新粘贴。
        this.setData({ modelSaving: false, modelError: (error && error.message) || '保存失败，请重试' });
      });
  },

  testModel() {
    if (this.data.modelTesting || this.data.modelSaving) {
      return;
    }
    if (!this.modelReady()) {
      this.toast('请先填写或保存 API Key');
      return;
    }
    this.setData({ modelTesting: true, testResult: null, modelError: '' });
    api.testModelSettings(this.modelPayload())
      .then((body) => {
        if (!this.alive) {
          return;
        }
        this.setData({
          modelTesting: false,
          testResult: (body && body.test) || { ok: false, error: '测试没有返回结论，请重试' }
        });
      })
      .catch((error) => {
        if (!this.alive) {
          return;
        }
        this.setData({
          modelTesting: false,
          testResult: { ok: false, error: (error && error.message) || '测试没有通过，请稍后重试' }
        });
      });
  },

  clearModel() {
    if (this.data.clearing) {
      return;
    }
    wx.showModal({
      title: '清除个人 API Key',
      content: '清除后不再使用你的 Key；如果管理员配置了共享模型，聊天会回到共享模型。',
      confirmText: '清除',
      confirmColor: '#a4482c',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        this.setData({ clearing: true, modelError: '', testResult: null });
        api.clearModelSettings()
          .then((body) => {
            if (!this.alive) {
              return;
            }
            const status = (body && body.model) || {};
            this.setData({ clearing: false, model: status, modelDraft: status.model || '', keyDraft: '' });
            this.toast('已清除个人 Key');
          })
          .catch((error) => {
            if (!this.alive) {
              return;
            }
            this.setData({ clearing: false, modelError: (error && error.message) || '清除失败，请重试' });
          });
      }
    });
  },

  // ---- 账号：唯一的删号入口 ----

  onDeleteAccount() {
    if (this.data.deleting) {
      return;
    }
    wx.showModal({
      title: '删除我的全部数据',
      content: '会删除：笔记、错题、做题记录、头像，以及保存在服务端的个人模型 API Key。删除后无法恢复。',
      confirmText: '继续',
      success: (first) => {
        if (!first.confirm) {
          return;
        }
        wx.showModal({
          title: '最后确认',
          content: '确定删除吗？这个操作不会保留副本。',
          confirmText: '删除',
          confirmColor: '#a4482c',
          success: (second) => {
            if (!second.confirm) {
              return;
            }
            this.setData({ deleting: true });
            api.deleteAccount()
              .then(() => {
                if (!this.alive) {
                  return;
                }
                this.setData({
                  deleting: false,
                  profile: null,
                  nicknameDraft: '',
                  model: null,
                  modelDraft: '',
                  keyDraft: '',
                  testResult: null
                });
                this.lastSavedNickname = '';
                this.toast('已删除');
                // 再次进入时身份仍然有效：会重新建立默认账号，所以刷新一次展示新状态。
                this.load();
              })
              .catch((error) => {
                if (!this.alive) {
                  return;
                }
                this.setData({ deleting: false });
                this.toast((error && error.message) || '删除失败，请重试');
              });
          }
        });
      }
    });
  },

  onGoChat() {
    wx.switchTab({ url: '/pages/chat/chat' });
  }
});
