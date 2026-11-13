// 只改这一个文件就能切换环境。
//
// 本机联调：
//   1) 在本机运行 `python wx_api.py --host 0.0.0.0 --port 8766`
//   2) 开发者工具「详情 → 本地设置」勾选「不校验合法域名…」
//   3) baseUrl 改成 http://<电脑局域网 IP>:8766，devLogin 改成 true
//      （服务端同时要设置 WX_DEV_LOGIN=1）
//
// 正式环境：
//   baseUrl 必须是已在微信后台「开发设置 → 服务器域名」里登记的 HTTPS 域名。

module.exports = {
  baseUrl: 'http://127.0.0.1:8766',
  apiPrefix: '/api/v1',

  // 用微信云托管部署时改成 true，并让 baseUrl 填服务名（如 study-agent）。
  // 云托管会注入 X-WX-OPENID，服务端设置 WX_TRUST_CLOUD_HEADER=1 即可免 code2session；
  // 这时 cloudAuth 保持 true，小程序端不再调用 wx.login。
  useCloudContainer: false,
  cloudEnv: '',
  cloudAuth: true,

  // 本地没有真实 AppID 时打开：只发 dev:xxx 假 code，不会调用微信接口。
  devLogin: false
};
