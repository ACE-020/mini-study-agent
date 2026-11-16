const api = require('./utils/api.js');
const config = require('./config.js');

App({
  onLaunch() {
    if (config.useCloudContainer) {
      // 云托管的前置：先初始化云开发环境，之后才能 callContainer。
      if (!wx.cloud) {
        console.error('当前基础库不支持云开发，请升级微信版本，或改用 HTTPS 域名部署。');
        return;
      }
      wx.cloud.init(config.cloudEnv ? { env: config.cloudEnv, traceUser: true } : { traceUser: true });
      return; // 用户身份由平台注入，不再走 wx.login
    }
    // 进小程序就先换一次登录态；失败了也不拦着，首页发送时会再试。
    api.login().catch(() => {});
  },
  onShow() {},
  globalData: {}
});
