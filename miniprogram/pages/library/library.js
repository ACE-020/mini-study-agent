const api = require('../../utils/api.js');
const markdown = require('../../utils/markdown.js');

Page({
  data: {
    notes: [],
    noteTotal: 0,
    mistakes: [],
    mistakeTotal: 0,
    progress: null,
    detail: null,
    detailHtml: '',
    loading: false,
    error: ''
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load(true);
  },

  load(refreshing) {
    if (this.data.loading) {
      return;
    }
    this.setData({ loading: true, error: '' });
    Promise.all([api.notes(), api.mistakes(), api.reviewProgress().catch(() => null)])
      .then((results) => {
        const notes = results[0] || {};
        const mistakes = results[1] || {};
        const progress = results[2] || null;
        const groups = (progress && progress.progress) || {};
        const attempts = Object.keys(groups).reduce((total, key) => total + (groups[key].count || 0), 0);
        this.setData({
          notes: notes.notes || [],
          noteTotal: notes.total || 0,
          mistakes: (mistakes.mistakes || []).slice(0, 20),
          mistakeTotal: mistakes.total || 0,
          progress: progress ? { attempts: attempts } : null,
          loading: false
        });
      })
      .catch((error) => {
        this.setData({ loading: false, error: error.message || '读取失败' });
      })
      .then(() => {
        if (refreshing) {
          wx.stopPullDownRefresh();
        }
      });
  },

  openNote(event) {
    const id = event.currentTarget.dataset.id;
    api.noteDetail(id)
      .then((body) => {
        const note = body.note || {};
        this.setData({ detail: note, detailHtml: markdown.toHtml(note.content || '') });
      })
      .catch((error) => this.toast(error.message));
  },

  closeDetail() {
    this.setData({ detail: null, detailHtml: '' });
  },

  copyDetail() {
    const note = this.data.detail;
    if (note && note.content) {
      wx.setClipboardData({ data: note.content });
    }
  },

  toast(message) {
    wx.showToast({ title: message || '操作失败', icon: 'none', duration: 2400 });
  },

  onDeleteAccount() {
    wx.showModal({
      title: '删除我的全部数据',
      content: '笔记、错题和做题记录会一并删除，无法恢复。',
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
            api.deleteAccount()
              .then(() => {
                this.setData({
                  notes: [],
                  noteTotal: 0,
                  mistakes: [],
                  mistakeTotal: 0,
                  progress: null
                });
                wx.showToast({ title: '已删除', icon: 'none' });
              })
              .catch((error) => this.toast(error.message));
          }
        });
      }
    });
  },

  noop() {}
});
