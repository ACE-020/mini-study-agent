// 用模拟的 wx 真实加载小程序模块，验证两条传输路径与两个页面入口。
// 运行：node tests/miniprogram_harness.cjs
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram');
const calls = { request: [], container: [], upload: [], toast: [], switchTab: [] };
const storage = {};

function url(pathname) {
  return 'http://127.0.0.1:8766/api/v1' + pathname;
}

function body(pathname) {
  if (pathname === '/auth/login') return { ok: true, token: 'TOKEN-1', expires_at: 9999999999 };
  if (pathname === '/status') {
    if (global.__statusUnauthorizedOnce) {
      global.__statusUnauthorizedOnce = false;
      return { __status: 401, ok: false, error: '登录已过期' };
    }
    if (global.__statusConfigured === false) {
      return { ok: true, configured: false, model: '', key_source: '', key_error: '',
               ocr_configured: !!global.__ocrConfigured };
    }
    return { ok: true, configured: true, model: 'test', mistakes: 0, views: ['organize'],
             ocr_configured: !!global.__ocrConfigured };
  }
  if (pathname === '/chat') {
    if (global.__forceConflict) {
      global.__forceConflict = false;
      return { __status: 409, ok: false, error: '上一条还在处理中，请稍等', task_id: 'task-1', retry: true };
    }
    return { ok: true, task_id: global.__chatTaskId || 'task-1', status: 'running' };
  }
  if (pathname === '/tasks/task-2') return { ok: true, task_id: 'task-2', status: 'running', progress: { message: '还在跑' } };
  if (pathname === '/tasks/task-5') {
    // 取消请求晚于任务完成：终态是 done，用来验证不会重复追加回答
    if (global.__task5Cancelled) return { ok: true, task_id: 'task-5', status: 'done', answer: '完成' };
    return { ok: true, task_id: 'task-5', status: 'running', progress: { message: '还在跑' } };
  }
  if (pathname === '/tasks/task-7') return { ok: true, task_id: 'task-7', status: 'done', answer: '延迟完成' };
  if (pathname === '/tasks/task-6') return { __status: 404, ok: false, error: '这个任务不存在或已过期' };
  if (pathname === '/tasks/task-3') {
    task3Polls += 1;
    if (task3Polls < 3) return { ok: true, task_id: 'task-3', status: 'running', progress: { message: '正在停止…' } };
    return { ok: true, task_id: 'task-3', status: 'cancelled', error: '已停止本次处理' };
  }
  if (pathname === '/tasks/task-4') return { __status: 401, ok: false, error: '登录已过期' };
  if (pathname === '/tasks/task-1') return { ok: true, task_id: 'task-1', status: 'done', answer: '**答**：42', steps: [] };
  if (pathname === '/uploads' || pathname === '/uploads/base64') return { ok: true, image_ids: ['img-1'] };
  if (pathname === '/notes') return { ok: true, notes: [{ id: 'n1', topic: '极限', excerpt: 'x', chars: 3 }], total: 1 };
  if (pathname === '/mistakes') return { ok: true, total: 2, mistakes: [{ id: 'm1', topic: '导数', question: 'q', user_answer: 'a' }] };
  if (pathname === '/review/progress') return { ok: true, review: {}, progress: { q1: { count: 3 } } };
  if (pathname === '/conversation/reset') return { ok: true };
  if (pathname === '/account/delete') return { ok: true, deleted: true };
  if (pathname === '/me/profile') {
    if (global.__profileMissingOnce) {
      // 旧服务端没有这个路由：Flask 统一 404 信封
      global.__profileMissingOnce = false;
      return { __status: 404, ok: false, error: '接口不存在，请确认小程序版本。' };
    }
    if (global.__profileFailOnce) {
      global.__profileFailOnce = false;
      return { __status: 500, ok: false, error: '账号准备失败，请重试' };
    }
    const nickname = global.__profileNickname || '默认昵称';
    return { ok: true, account: { id: 'acc-1' }, profile: {
      nickname: nickname,
      default_nickname: nickname === '默认昵称',
      avatar: { kind: 'default', mime: 'image/png', version: 0, data_url: 'DEFAULT-AVATAR' },
      updated_at: 1
    } };
  }
  if (pathname === '/me/avatar') {
    return { ok: true, account: { id: 'acc-1' }, profile: {
      nickname: 'OLD-NICK',
      default_nickname: false,
      avatar: { kind: 'custom', mime: 'image/jpeg', version: 7,
                data_url: 'data:image/jpeg;base64,AVATAR' },
      updated_at: 2
    } };
  }
  if (pathname === '/me/model') {
    const saved = !!global.__modelSaved;
    return { ok: true, model: {
      configured: true, key_saved: saved, source: saved ? 'user' : 'server',
      model: global.__modelName || 'deepseek-v4-pro', provider: 'deepseek',
      provider_label: 'DeepSeek 官方', updated_at: saved ? 3 : 0, key_error: '',
      shared_configured: true, models: ['deepseek-v4-pro']
    } };
  }
  if (pathname === '/me/model/test') return { ok: true, test: { ok: true, error: '', latency_ms: 12 } };
  if (pathname === '/me/model/clear') {
    global.__modelSaved = false;
    return { ok: true, model: {
      configured: true, key_saved: false, source: 'server', model: 'deepseek-v4-pro',
      provider: 'deepseek', provider_label: 'DeepSeek 官方', updated_at: 0, key_error: '',
      shared_configured: true, models: ['deepseek-v4-pro']
    } };
  }
  return { ok: true };
}

let taskPolls = 0;
let failNextChat = false;
let loginCalls = 0;
let task3Polls = 0;
global.__chatFailMode = 'ok';
global.__statusUnauthorizedOnce = false;
global.__chatTaskId = 'task-1';
global.__task5Cancelled = false;

global.wx = {
  getStorageSync: (key) => (key in storage ? storage[key] : ''),
  setStorageSync: (key, value) => { storage[key] = value; },
  removeStorageSync: (key) => { delete storage[key]; },
  login: ({ success }) => {
    loginCalls += 1;
    success({ code: 'CODE-1' });
  },
  request: (options) => {
    const method = options.method || 'GET';
    const pathname = options.url.replace(/^https?:\/\/[^/]+/, '').replace('/api/v1', '');
    if (pathname === '/chat' && (failNextChat || global.__chatFailMode === 'fail')) {
      failNextChat = false;
      calls.request.push({ path: pathname, header: options.header, data: options.data, failed: true });
      if (options.fail) {
        options.fail({ errMsg: 'request:fail timeout' });
        return;
      }
    }
    calls.request.push({ path: pathname, method: method, header: options.header, data: options.data });
    if (pathname === '/me/model' && method === 'POST') {
      const data = options.data || {};
      global.__modelSaved = true;
      if (data.model) {
        global.__modelName = data.model;
      }
      options.success({ statusCode: 200, data: { ok: true, model: {
        configured: true, key_saved: true, source: 'user',
        model: global.__modelName || 'deepseek-v4-pro', provider: 'deepseek',
        provider_label: 'DeepSeek 官方', updated_at: 4, key_error: '',
        shared_configured: true, models: ['deepseek-v4-pro']
      } } });
      return;
    }
    if (pathname === '/me/profile' && method === 'PUT') {
      const data = options.data || {};
      const nickname = (data.nickname || '').trim();
      // 模拟“服务端回包里带着更旧的头像快照”：页面必须只合并昵称字段。
      const reply = { statusCode: 200, data: { ok: true, account: { id: 'acc-1' }, profile: {
        nickname: nickname, default_nickname: false,
        avatar: { kind: 'default', mime: 'image/png', version: 0, data_url: 'DEFAULT-AVATAR' },
        updated_at: 5
      } } };
      if (global.__delayProfilePut) {
        setTimeout(() => options.success(reply), global.__delayProfilePut);
      } else {
        options.success(reply);
      }
      return;
    }
    if (pathname === '/tasks/task-5/cancel') {
      global.__task5Cancelled = true;
      options.success({ statusCode: 200, data: { ok: true, task_id: 'task-5' } });
      return;
    }
    if (pathname === '/tasks/task-7/cancel') {
      // 回包晚于首次轮询读到 done
      setTimeout(() => options.success({ statusCode: 200, data: { ok: true, task_id: 'task-7' } }), 1500);
      return;
    }
    if (pathname === '/cancel' || pathname.endsWith('/cancel')) {
      if (global.__cancelFails) {
        global.__cancelFails = false;
        options.success({ statusCode: 500, data: { ok: false, error: '停止失败' } });
        return;
      }
    }
    if (pathname === '/tasks/task-1') taskPolls += 1;
    const payload = body(pathname);
    const statusCode = payload.__status || 200;
    delete payload.__status;
    options.success({ statusCode, data: payload });
  },
  uploadFile: (options) => {
    const pathname = options.url.replace(/^https?:\/\/[^/]+/, '').replace('/api/v1', '');
    calls.upload.push({ path: pathname, header: options.header });
    options.success({ statusCode: 200, data: JSON.stringify(body(pathname)) });
  },
  compressImage: ({ src, success }) => success({ tempFilePath: src + '.small' }),
  getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: 'BASE64PAYLOAD' }) }),
  showToast: (options) => calls.toast.push(options.title),
  showModal: ({ success }) => success({ confirm: true }),
  switchTab: ({ url }) => { calls.switchTab.push(url); },
  stopPullDownRefresh: () => {},
  setClipboardData: () => {},
  chooseMedia: ({ success }) => success({ tempFiles: [{ tempFilePath: '/tmp/a.jpg' }] }),
  nextTick: (fn) => fn(),
  cloud: {
    init: (config) => calls.cloudInit = config,
    callContainer: (options) => {
      calls.container.push({ path: options.path, header: options.header, data: options.data });
      const pathname = options.path.replace('/api/v1', '');
      if (pathname === '/tasks/task-1') taskPolls += 1;
      const payload = body(pathname);
      const statusCode = payload.__status || 200;
      delete payload.__status;
      options.success({ statusCode, data: payload });
    }
  }
};

let pageDefinition = null;
let appDefinition = null;
global.Page = (definition) => { pageDefinition = definition; };
global.App = (definition) => { appDefinition = definition; };

function loadPage(relative) {
  pageDefinition = null;
  const file = path.join(ROOT, relative);
  delete require.cache[require.resolve(file)];
  require(file);
  assert.ok(pageDefinition, relative + ' 应该注册 Page');
  const page = Object.assign({}, pageDefinition);
  page.data = JSON.parse(JSON.stringify(pageDefinition.data || {}));
  page.setData = function setData(patch) {
    Object.assign(this.data, patch);
  };
  return page;
}

function loadApp(relative) {
  appDefinition = null;
  const file = path.join(ROOT, relative);
  delete require.cache[require.resolve(file)];
  require(file);
  assert.ok(appDefinition, relative + ' 应该注册 App');
  const app = Object.assign({}, appDefinition);
  app.globalData = Object.assign({}, appDefinition.globalData || {});
  return app;
}

// 测试 fixture 的统一开关：显式把配置切到自建 HTTP，并清掉 api 缓存，
// 让页面 require 到的 api 与 config 都是这一份（用户 config.js 里的云托管配置不能被改）。
function useSelfHostedHttp() {
  const configPath = path.join(ROOT, 'config.js');
  const apiPath = path.join(ROOT, 'utils', 'api.js');
  delete require.cache[require.resolve(configPath)];
  const config = require(configPath);
  config.useCloudContainer = false;
  config.cloudAuth = false;
  config.devLogin = true;
  config.baseUrl = 'http://127.0.0.1:8766';
  delete require.cache[require.resolve(apiPath)];
  return require(apiPath);
}

function assertHttpRequests(tag) {
  const broken = calls.request.filter((item) => item.path.indexOf('study-agent') === 0
    || item.path.indexOf('http') === 0);
  assert.equal(broken.length, 0, tag + ' 的请求必须走 HTTP baseUrl，实际路径：'
    + JSON.stringify(broken.map((item) => item.path)));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function selfHosted() {
  const api = useSelfHostedHttp();

  await api.ensureLogin();
  assert.ok(storage.study_agent_token, '登录后应保存令牌');
  assert.ok(calls.request.some((item) => item.path === '/auth/login'), '应走 /auth/login');
  assertHttpRequests('自建模式');

  const status = await api.status();
  assert.equal(status.configured, true);
  const authHeader = calls.request.find((item) => item.path === '/status').header.Authorization;
  assert.equal(authHeader, 'Bearer TOKEN-1', '自建模式应带 Bearer 令牌');

  const task = await api.chat({ message: 'hi', view: 'organize', request_id: 'mp-test-0001' });
  assert.equal(task.task_id, 'task-1');

  let progress = 0;
  const result = await api.pollTask('task-1', () => { progress += 1; });
  assert.equal(result.status, 'done');
  assert.ok(progress >= 1, '轮询应至少回调一次');

  const timedOut = await api.pollTask('task-2', () => {}, { timeoutMs: 1 });
  assert.equal(timedOut.status, 'timeout', '超时应返回 timeout 而不是把错误抛给页面');
  assert.equal(timedOut.task_id, 'task-2', '超时结果要保留任务句柄');

  // 首次提交网络失败：用同一个 request_id 重试，不能新建一轮。
  failNextChat = true;
  const retried = await api.chat({ message: '重试', view: 'organize', request_id: 'retry-request-0001' });
  assert.equal(retried.task_id, 'task-1');
  const chatCalls = calls.request.filter((item) => item.path === '/chat'
    && item.data && item.data.request_id === 'retry-request-0001');
  assert.equal(chatCalls.length, 2, '网络失败应重试一次');
  assert.equal(chatCalls[0].failed, true, '第一次应是网络失败');

  // 停止失败不能被吞掉
  global.__cancelFails = true;
  await assert.rejects(() => api.cancel('task-1'), (error) => error.code === 500);

  const imageId = await api.uploadImage('/tmp/a.jpg');
  assert.equal(imageId, 'img-1');
  assert.equal(calls.upload[0].path, '/uploads', '自建模式应走 multipart 上传');

  await api.cancel('task-1');
  await api.deleteAccount();
  assert.ok(calls.request.some((item) => item.path === '/account/delete'));
  console.log('ok  自建模式：登录/状态/对话/轮询/上传/取消/删除');
}

async function cloudRun() {
  const configPath = path.join(ROOT, 'config.js');
  delete require.cache[require.resolve(configPath)];
  const config = require(configPath);
  config.useCloudContainer = true;
  config.cloudAuth = true;
  config.cloudEnv = 'prod';
  config.baseUrl = 'study-agent';
  // 自建环境遗留的令牌：云托管请求绝不能带出去。
  storage.study_agent_token = 'STALE-SELFHOST-TOKEN';

  // 页面与 api 在同一模块缓存上，重新加载以读取新配置
  const apiPath = path.join(ROOT, 'utils', 'api.js');
  delete require.cache[require.resolve(apiPath)];
  const api = require(apiPath);

  await api.ensureLogin();
  assert.equal(calls.request.filter((item) => item.path === '/auth/login').length, 1,
    '云托管 cloudAuth 模式不应再调 wx.login');

  await api.status();
  const last = calls.container[calls.container.length - 1];
  assert.equal(last.path, '/api/v1/status');
  assert.equal(last.header['X-WX-SERVICE'], 'study-agent', '应带云托管服务名头');
  assert.equal(last.header.Authorization, undefined, 'cloudAuth 不能带自建令牌');

  // 云托管下遇到 401 也不能退化成 wx.login
  const loginsBefore = loginCalls;
  global.__statusUnauthorizedOnce = true;
  let unauthorized = null;
  try {
    await api.status();
  } catch (error) {
    unauthorized = error;
  }
  assert.equal(unauthorized && unauthorized.code, 401, JSON.stringify(unauthorized));
  assert.equal(loginCalls, loginsBefore, 'cloudAuth 的 401 不能触发 wx.login');

  const imageId = await api.uploadImage('/tmp/a.jpg');
  assert.equal(imageId, 'img-1');
  const upload = calls.container[calls.container.length - 1];
  assert.equal(upload.path, '/api/v1/uploads/base64', '云托管应走 base64 上传');
  assert.equal(upload.data.images[0].data, 'BASE64PAYLOAD');

  const task = await api.chat({ message: 'hi', view: 'notes', request_id: 'mp-test-0002' });
  const result = await api.pollTask(task.task_id);
  assert.equal(result.status, 'done');
  console.log('ok  云托管模式：免 login/状态/base64 上传/对话/轮询');
}

async function appEntry() {
  // 云托管：init 之后用平台注入的身份第一次请求，就取得/建立默认账号。
  const configPath = path.join(ROOT, 'config.js');
  delete require.cache[require.resolve(configPath)];
  const config = require(configPath);
  config.useCloudContainer = true;
  config.cloudAuth = true;
  config.cloudEnv = 'prod';
  config.baseUrl = 'study-agent';
  delete require.cache[require.resolve(path.join(ROOT, 'utils', 'api.js'))];

  const app = loadApp('app.js');
  const before = calls.container.length;
  app.onLaunch();
  await wait(40);
  assert.equal(app.globalData.profileReady, true, '启动后应取得默认账号');
  const bootstrap = calls.container.slice(before).find((item) => item.path === '/api/v1/me/profile');
  assert.ok(bootstrap, '云托管首次业务请求必须是 /api/v1/me/profile');
  assert.equal(bootstrap.header.Authorization, undefined, '云托管请求不能带自建令牌');
  assert.equal(app.globalData.profile.nickname, '默认昵称', '默认账号应带稳定昵称');

  // 失败要留错误，并且能重试（设置页的重试入口由此兜底）。
  global.__profileFailOnce = true;
  const retryApp = loadApp('app.js');
  retryApp.onLaunch();
  await wait(40);
  assert.equal(retryApp.globalData.profileReady, false);
  assert.ok(retryApp.globalData.profileError, '失败要留下可展示的错误');
  global.__profileFailOnce = false;
  await retryApp.bootstrapProfile();
  assert.equal(retryApp.globalData.profileReady, true, '重试后应取得账号');
  assert.equal(retryApp.globalData.profileError, '');

  // 旧服务端没有账号接口：不崩溃，留一条“更新服务端”的可读错误。
  global.__profileMissingOnce = true;
  const staleApp = loadApp('app.js');
  staleApp.onLaunch();
  await wait(40);
  assert.equal(staleApp.globalData.profileReady, false);
  assert.ok(String(staleApp.globalData.profileError).indexOf('服务端版本过旧') >= 0,
    '旧服务端提示：' + staleApp.globalData.profileError);

  // 第三个 tab 与设置页文件必须齐备。
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  assert.deepEqual(appJson.pages,
    ['pages/chat/chat', 'pages/library/library', 'pages/settings/settings']);
  assert.equal(appJson.tabBar.list.length, 3, '底部应有三个 tab');
  assert.equal(appJson.tabBar.list[2].pagePath, 'pages/settings/settings');
  assert.equal(appJson.tabBar.list[2].text, '设置');
  for (const extension of ['js', 'json', 'wxml', 'wxss']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'pages/settings/settings.' + extension)),
      '缺少设置页文件 settings.' + extension);
  }
  console.log('ok  app 入口：云托管启动即取默认账号 / 失败可重试 / 第三个 tab 就位');
}

async function chatPage() {
  const api = useSelfHostedHttp();
  await api.ensureLogin();

  const page = loadPage('pages/chat/chat.js');
  page.onLoad();
  page.onShow();
  await wait(40);
  assert.equal(page.data.configured, true, '首页应读到服务端状态');
  assert.equal(page.data.needSettings, false);
  assertHttpRequests('整理页');

  page.onInput({ detail: { value: '2+2 等于几' } });
  page.onSend();
  await wait(1500);
  assert.equal(page.data.busy, false, '一轮结束后应解除 busy');
  assert.equal(page.data.messages.length, 2, '应有用户与助手两条消息');
  assert.ok(page.data.messages[1].html.includes('<p'), '回答应转成 rich-text');

  page.onInput({ detail: { value: '再问一次' } });
  page.onSend();
  await wait(1500);
  page.onInput({ detail: { value: '停止这一轮' } });
  page.onSend();
  await wait(80);
  page.onStop();
  await wait(1500);
  assert.equal(page.data.busy, false, '停止后应回到非忙碌态');
  console.log('ok  整理页：发送/渲染/停止');

  const beforeConflict = page.data.messages.length;
  global.__forceConflict = true;
  page.onInput({ detail: { value: '冲突时再发' } });
  page.onSend();
  await wait(1500);
  assert.equal(page.data.busy, false, '409 冲突后应接上已有任务并结束忙碌态');
  assert.equal(page.data.messages.length, beforeConflict + 2, '冲突后应补上用户与助手两条消息');
  console.log('ok  整理页：409 冲突时接上已存在的任务');

  page.finishTask({ status: 'timeout', task_id: 'task-1' });
  assert.equal(page.data.pendingTaskId, 'task-1', '超时后应保留任务句柄');
  const beforeResume = page.data.messages.length;
  page.onResumePending();
  await wait(1200);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.messages.length, beforeResume + 1, '继续查看应补上回答');
  console.log('ok  整理页：超时后保留句柄并继续查看');

  // 提交阶段全部失败：草稿/ID 保留，消息不进入对话；手动再发复用同一 ID
  const baseline = page.data.messages.length;
  global.__chatFailMode = 'fail';
  page.onInput({ detail: { value: '同一份草稿' } });
  page.onSend();
  await wait(1800);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.messages.length, baseline, '提交失败不能留下假消息');
  assert.equal(page.data.input, '同一份草稿', '失败后草稿要回到输入框');
  const failed = calls.request.filter((item) => item.path === '/chat'
    && item.data && item.data.message === '同一份草稿');
  assert.equal(failed.length, 3, '两次重试 + 首次共 3 次尝试');
  assert.equal(new Set(failed.map((item) => item.data.request_id)).size, 1,
    '所有传输尝试必须复用同一个 request_id');

  global.__chatFailMode = 'ok';
  page.onSend();
  await wait(1500);
  const retried = calls.request.filter((item) => item.path === '/chat'
    && item.data && item.data.message === '同一份草稿' && !item.failed);
  assert.equal(retried[retried.length - 1].data.request_id, failed[0].data.request_id,
    '手动再发同一草稿应复用未确认的 request_id');
  assert.equal(page.data.messages.length, baseline + 2);
  console.log('ok  整理页：提交失败后同草稿复用 request_id');

  // 停止只代表“收到请求”：保持句柄并轮询到终态
  task3Polls = 0;
  page.finishTask({ status: 'timeout', task_id: 'task-3' });
  assert.equal(page.data.pendingTaskId, 'task-3');
  page.onStop();
  await wait(5000);
  assert.equal(page.data.busy, false, '停止后要回到非忙碌态');
  assert.equal(page.data.pendingTaskId, '', '轮询到终态后才丢弃句柄');
  assert.ok(task3Polls >= 3, '应轮询到 cancelled 才结束');
  console.log('ok  整理页：停止后轮询到实际终态');

  // 已入对话的消息查询失败：保留句柄，不提示重新发送
  await assert.rejects(() => api.pollTask('task-4'), (error) => error.code === 401);
  console.log('ok  轮询 401 如实抛出');

  // 有 pending 任务时不允许悄悄开始新一轮
  page.setData({ pendingTaskId: 'task-9', busy: false, input: '新内容' });
  const beforeGuard = page.data.messages.length;
  page.onSend();
  await wait(50);
  assert.equal(page.data.messages.length, beforeGuard);
  assert.equal(page.data.pendingTaskId, 'task-9', '发送新一轮不能覆盖旧句柄');
  page.setData({ pendingTaskId: '', input: '' });
  console.log('ok  整理页：pending 期间不覆盖旧任务');

  // 运行中取消：只有一条轮询链，回答不重复
  global.__chatTaskId = 'task-5';
  global.__task5Cancelled = false;
  const beforeCancel = page.data.messages.length;
  page.onInput({ detail: { value: '取消我' } });
  page.onSend();
  await wait(1000);
  page.onStop();
  await wait(3500);
  assert.equal(page.data.busy, false, '取消后应回到非忙碌态');
  assert.equal(page.data.pendingTaskId, '', '到达终态后不保留句柄');
  assert.equal(page.data.messages.length, beforeCancel + 2, '停止不应重复追加回答');
  assert.equal(page.data.messages.filter((item) => item.role === 'assistant'
    && item.text === '完成').length, 1, '同一条回答只能出现一次');
  console.log('ok  整理页：运行中取消只有一条轮询链');

  // 服务重启后任务 404：释放句柄，允许重新发送
  global.__chatTaskId = 'task-6';
  const before404 = page.data.messages.length;
  page.onInput({ detail: { value: '重启后' } });
  page.onSend();
  await wait(2000);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.pendingTaskId, '', '404 不能把发送永久锁死');
  assert.equal(page.data.taskId, '');
  global.__chatTaskId = 'task-1';
  page.onInput({ detail: { value: '重新发送' } });
  page.onSend();
  await wait(1500);
  assert.equal(page.data.busy, false);
  assert.ok(page.data.messages.length > before404, '404 之后仍可继续发送');
  console.log('ok  整理页：任务 404 后释放句柄并可重发');

  // 取消回包晚于首次 done：不能二次轮询、不能重复显示答案
  global.__chatTaskId = 'task-7';
  const beforeLateCancel = page.data.messages.length;
  page.onInput({ detail: { value: '取消晚到' } });
  page.onSend();
  await wait(100);
  page.onStop();
  await wait(2500);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.messages.length, beforeLateCancel + 2, '晚到的取消回包不应重复追加');
  assert.equal(page.data.messages.filter((item) => item.role === 'assistant'
    && item.text === '延迟完成').length, 1, '答案只能出现一次');
  console.log('ok  整理页：取消回包晚于 done 不重复追加');

  // 新对话成功会清掉未确认的提交编号
  page.unconfirmed = { requestId: 'stale-id', signature: 'stale' };
  page.onReset();
  await wait(100);
  assert.equal(page.unconfirmed, null, '重置后不应把旧 request_id 带进新对话');
  console.log('ok  整理页：重置清空未确认请求');

  // 缺 Key：明显引导到「设置」，一键可进，草稿不丢
  global.__statusConfigured = false;
  page.setData({ pendingTaskId: '', busy: false });
  page.onShow();
  await wait(40);
  assert.equal(page.data.needSettings, true, '没配 Key 要显示引导横幅');
  const chatCallsBefore = calls.request.filter((item) => item.path === '/chat').length;
  page.onInput({ detail: { value: '没有 Key 也要发' } });
  page.onSend();
  await wait(60);
  assert.equal(calls.request.filter((item) => item.path === '/chat').length, chatCallsBefore,
    '缺 Key 不应发起对话请求');
  assert.equal(page.data.input, '没有 Key 也要发', '缺 Key 时草稿要保留');
  page.goSettings();
  assert.equal(calls.switchTab[calls.switchTab.length - 1], '/pages/settings/settings',
    '横幅必须能一键进入设置页');
  console.log('ok  整理页：缺 Key 显示引导并可进入设置');

  // 只配置了 OCR Key 的老部署：带图这一轮仍然允许发送
  global.__ocrConfigured = true;
  page.onShow();
  await wait(40);
  page.setData({ images: [{ id: 'img-1', path: '/tmp/a.jpg' }], input: '带图发送', canSend: true });
  const beforeOcrSend = calls.request.filter((item) => item.path === '/chat').length;
  page.onSend();
  await wait(1500);
  assert.equal(calls.request.filter((item) => item.path === '/chat').length, beforeOcrSend + 1,
    '只配置 OCR Key 时带图请求不能被前置检查拦掉');
  global.__ocrConfigured = false;
  page.setData({ images: [] });

  // 老后端没有 key_source 等字段：configured 缺省仍按可用处理
  global.__statusConfigured = undefined;
  page.onShow();
  await wait(40);
  assert.equal(page.data.needSettings, false);
  console.log('ok  整理页：兼容 OCR-only 老部署与旧状态字段');
}

async function libraryPage() {
  useSelfHostedHttp();
  const page = loadPage('pages/library/library.js');
  page.onShow();
  await wait(80);
  assert.equal(page.data.noteTotal, 1, '记录页应读取笔记');
  assert.equal(page.data.mistakeTotal, 2, '记录页应读取错题');
  assert.equal(page.data.progress.attempts, 3, '记录页应从分组汇总作答次数');
  assert.equal(typeof page.onDeleteAccount, 'undefined', '删号入口只保留在设置页');
  assertHttpRequests('记录页');
  page.openNote({ currentTarget: { dataset: { id: 'n1' } } });
  await wait(30);
  console.log('ok  记录页：加载/打开笔记/删号入口已移走');
}

async function settingsPage() {
  useSelfHostedHttp();
  global.__modelSaved = false;
  global.__modelName = 'deepseek-v4-pro';
  global.__profileNickname = '默认昵称';
  global.__delayProfilePut = 0;

  const page = loadPage('pages/settings/settings.js');
  page.onLoad();
  page.onShow();
  await wait(80);
  assert.ok(page.data.profile, '设置页应自动取得默认账号');
  assert.equal(page.data.profile.nickname, '默认昵称');
  assert.equal(page.data.nicknameDraft, '默认昵称', '昵称框直接可编辑，不需要先点“修改”');
  assert.equal(page.data.model.key_saved, false);
  assert.equal(page.data.modelDraft, 'deepseek-v4-pro');
  assertHttpRequests('设置页');
  console.log('ok  设置页：首次打开自动建号并显示默认昵称/头像/模型状态');

  // 头像：选择成功立即上传，没有额外保存步骤
  const avatarBefore = page.data.profile.avatar.data_url;
  page.onChooseAvatar({ detail: { avatarUrl: '/tmp/avatar.jpg' } });
  await wait(100);
  assert.notEqual(page.data.profile.avatar.data_url, avatarBefore, '头像应更新');
  assert.equal(page.data.profile.avatar.kind, 'custom');
  assert.ok(calls.request.some((item) => item.path === '/me/avatar'), '头像应自动上传');
  console.log('ok  设置页：选完头像立即上传');

  // 昵称：失焦即保存
  page.onNicknameInput({ detail: { value: '小明' } });
  page.onNicknameDone({ detail: { value: '小明' } });
  await wait(60);
  assert.equal(page.data.profile.nickname, '小明');
  assert.equal(page.data.nicknameSaving, false);
  const puts = calls.request.filter((item) => item.path === '/me/profile' && item.method === 'PUT');
  assert.equal(puts[puts.length - 1].data.nickname, '小明');
  console.log('ok  设置页：昵称失焦自动保存');

  // 同值不发请求；空白不覆盖
  const putCount = calls.request.filter((item) => item.path === '/me/profile'
    && item.method === 'PUT').length;
  page.onNicknameDone({ detail: { value: '小明' } });
  await wait(30);
  assert.equal(calls.request.filter((item) => item.path === '/me/profile'
    && item.method === 'PUT').length, putCount, '同值不应重复请求');
  page.onNicknameDone({ detail: { value: '   ' } });
  await wait(30);
  assert.equal(calls.request.filter((item) => item.path === '/me/profile'
    && item.method === 'PUT').length, putCount, '空白不应发请求');
  assert.equal(page.data.nicknameDraft, '小明', '空白不能覆盖已保存昵称');
  console.log('ok  设置页：同值不发请求、空白不覆盖');

  // 交叉回包 1：昵称回包（带旧头像快照）晚到，不能把新头像退回去
  global.__delayProfilePut = 70;
  page.onNicknameDone({ detail: { value: '小红' } });
  await wait(10);
  page.onChooseAvatar({ detail: { avatarUrl: '/tmp/avatar2.jpg' } });
  await wait(160);
  assert.equal(page.data.profile.nickname, '小红');
  assert.equal(page.data.profile.avatar.kind, 'custom', '晚到的昵称回包不能覆盖头像');
  assert.notEqual(page.data.profile.avatar.data_url, 'DEFAULT-AVATAR', '头像不能退回旧快照');
  console.log('ok  设置页：交叉回包只合并各自字段');

  // 交叉回包 2：保存中改回旧值仍要入队，最终以用户最后输入为准
  const savedBefore = page.data.profile.nickname;
  page.onNicknameDone({ detail: { value: '小蓝' } });
  await wait(5);
  page.onNicknameDone({ detail: { value: savedBefore } });
  await wait(260);
  const settled = calls.request.filter((item) => item.path === '/me/profile' && item.method === 'PUT');
  assert.equal(settled[settled.length - 1].data.nickname, savedBefore,
    '保存中改回旧值也要在上一笔落地后补写');
  assert.equal(page.data.profile.nickname, savedBefore);
  global.__delayProfilePut = 0;
  console.log('ok  设置页：保存中改回旧值仍入队');

  // 模型：保存个人 Key（不回显、不写本地缓存）
  page.onKeyInput({ detail: { value: 'sk-personal-TEST-KEY' } });
  page.onModelInput({ detail: { value: 'deepseek-flash' } });
  page.saveModel();
  await wait(60);
  assert.equal(page.data.model.key_saved, true);
  assert.equal(page.data.model.model, 'deepseek-flash');
  assert.equal(page.data.keyDraft, '', '保存后输入框要清空');
  const saved = calls.request.filter((item) => item.path === '/me/model' && item.method === 'POST').pop();
  assert.equal(saved.data.api_key, 'sk-personal-TEST-KEY');
  assert.equal(saved.data.base_url, undefined, '客户端不能提交 base_url');
  const stored = Object.keys(storage).map((key) => String(storage[key])).join('|');
  assert.ok(stored.indexOf('sk-personal-TEST-KEY') === -1, 'API Key 不能写进本地缓存');
  assert.ok(JSON.stringify(calls.toast).indexOf('sk-personal-TEST-KEY') === -1);
  console.log('ok  设置页：保存个人 Key 且不回显/不落缓存');

  page.testModel();
  await wait(60);
  assert.equal(page.data.testResult.ok, true);
  assert.ok(calls.request.some((item) => item.path === '/me/model/test'));

  page.clearModel();
  await wait(60);
  assert.equal(page.data.model.key_saved, false);
  assert.ok(calls.request.some((item) => item.path === '/me/model/clear'));
  console.log('ok  设置页：测试连接与清除个人 Key');

  // 加载失败 → 重试入口
  global.__profileFailOnce = true;
  page.load();
  await wait(40);
  assert.ok(page.data.loadError, '加载失败要给出重试入口');
  page.onRetry();
  await wait(80);
  assert.equal(page.data.loadError, '');
  assert.ok(page.data.profile);
  console.log('ok  设置页：加载失败可重试');

  // 旧服务端没有 /me/* 路由：提示“更新服务端”，不能把 404 原文抛给用户
  global.__profileMissingOnce = true;
  page.load();
  await wait(50);
  assert.ok((page.data.loadError || '').indexOf('服务端还是旧版本') >= 0,
    '旧服务端应提示更新服务端，实际：' + page.data.loadError);
  page.onRetry();
  await wait(90);
  assert.equal(page.data.loadError, '');
  assert.ok(page.data.profile);
  console.log('ok  设置页：旧服务端缺接口时提示更新并可重试');

  // 唯一删号入口
  const beforeDelete = calls.request.filter((item) => item.path === '/account/delete').length;
  page.onDeleteAccount();
  await wait(100);
  assert.equal(calls.request.filter((item) => item.path === '/account/delete').length,
    beforeDelete + 1);
  console.log('ok  设置页：唯一的删号入口');
}

(async () => {
  await selfHosted();
  await cloudRun();
  await appEntry();
  await chatPage();
  await libraryPage();
  await settingsPage();
  console.log('ALL PASS');
})().catch((error) => {
  console.error('FAIL', error && error.stack || error);
  process.exit(1);
});
