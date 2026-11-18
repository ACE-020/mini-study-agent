const api = require('./utils/api.js');
const config = require('./config.js');

App({
  onLaunch() {
    this.globalData.profile = null;
    this.globalData.profileReady = false;
    this.globalData.profileError = '';
    if (config.useCloudContainer) {
      // 云托管的前置：先初始化云开发环境，之后才能 callContainer。
      if (!wx.cloud) {
        console.error('当前基础库不支持云开发，请升级微信版本，或改用 HTTPS 域名部署。');
        this.globalData.profileError = '当前微信版本不支持云托管调用，请升级微信';
        return;
      }
      wx.cloud.init(config.cloudEnv ? { env: config.cloudEnv, traceUser: true } : { traceUser: true });
      // 云托管用平台注入的身份，这里第一次请求就会拿到/建立默认账号（不填号、不填密码）。
      this.bootstrapProfile();
      return;
    }
    // 进小程序就先换一次登录态；失败了也不拦着，页面发送时会再试。
    api.login().catch(() => {});
    this.bootstrapProfile();
  },

  // 现有身份优先：有云托管身份或已登录会话时直接取默认账号；失败留给「设置」页重试。
  bootstrapProfile() {
    const task = api.profile()
      .then((body) => {
        this.globalData.profile = (body && body.profile) || null;
        this.globalData.profileReady = true;
        this.globalData.profileError = '';
        return this.globalData.profile;
      })
      .catch((error) => {
        this.globalData.profileReady = false;
        // 旧服务端还没有账号接口（404）：不阻塞小程序，只记一条可读的错误供设置页提示。
        this.globalData.profileError = error && error.code === 404
          ? '服务端版本过旧，缺少账号接口；更新服务端后可自动建号'
          : ((error && error.message) || '账号准备失败，请重试');
        return null;
      });
    this.globalData.profileTask = task;
    return task;
  },

  onShow() {},
  globalData: {}
});
