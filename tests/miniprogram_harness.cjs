// 用模拟的 wx 真实加载小程序模块，验证两条传输路径与两个页面入口。
// 运行：node tests/miniprogram_harness.cjs
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram');
const calls = { request: [], container: [], upload: [], toast: [] };
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
    return { ok: true, configured: true, model: 'test', mistakes: 0, views: ['organize'] };
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
    const pathname = options.url.replace(/^https?:\/\/[^/]+/, '').replace('/api/v1', '');
    if (pathname === '/chat' && (failNextChat || global.__chatFailMode === 'fail')) {
      failNextChat = false;
      calls.request.push({ path: pathname, header: options.header, data: options.data, failed: true });
      if (options.fail) {
        options.fail({ errMsg: 'request:fail timeout' });
        return;
      }
    }
    calls.request.push({ path: pathname, header: options.header, data: options.data });
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
global.Page = (definition) => { pageDefinition = definition; };
global.App = () => {};

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function selfHosted() {
  const config = require(path.join(ROOT, 'config.js'));
  config.useCloudContainer = false;
  config.devLogin = true;
  config.baseUrl = 'http://127.0.0.1:8766';
  const api = require(path.join(ROOT, 'utils', 'api.js'));

  await api.ensureLogin();
  assert.ok(storage.study_agent_token, '登录后应保存令牌');
  assert.ok(calls.request.some((item) => item.path === '/auth/login'), '应走 /auth/login');

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
  const config = require(path.join(ROOT, 'config.js'));
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
  const config = require(path.join(ROOT, 'config.js'));
  config.useCloudContainer = true;
  const appPath = path.join(ROOT, 'app.js');
  delete require.cache[require.resolve(appPath)];
  const apiPath = path.join(ROOT, 'utils', 'api.js');
  delete require.cache[require.resolve(apiPath)];
  delete require.cache[require.resolve(path.join(ROOT, 'config.js'))];
  const config2 = require(path.join(ROOT, 'config.js'));
  config2.useCloudContainer = true;
  config2.cloudEnv = 'prod';
  require(appPath);
  console.log('ok  app 入口：云托管启动路径可加载');
}

async function chatPage() {
  const config = require(path.join(ROOT, 'config.js'));
  config.useCloudContainer = false;
  config.devLogin = true;
  const apiPath = path.join(ROOT, 'utils', 'api.js');
  delete require.cache[require.resolve(apiPath)];
  delete require.cache[require.resolve(path.join(ROOT, 'config.js'))];
  const config2 = require(path.join(ROOT, 'config.js'));
  config2.useCloudContainer = false;
  config2.devLogin = true;
  const api = require(apiPath);
  await api.ensureLogin();

  const page = loadPage('pages/chat/chat.js');
  page.onLoad();
  await wait(30);
  assert.equal(page.data.configured, true, '首页应读到服务端状态');

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
}

async function libraryPage() {
  const page = loadPage('pages/library/library.js');
  page.onShow();
  await wait(80);
  assert.equal(page.data.noteTotal, 1, '记录页应读取笔记');
  assert.equal(page.data.mistakeTotal, 2, '记录页应读取错题');
  assert.equal(page.data.progress.attempts, 3, '记录页应从分组汇总作答次数');
  page.openNote({ currentTarget: { dataset: { id: 'n1' } } });
  await wait(30);
  console.log('ok  记录页：加载/打开笔记');
}

(async () => {
  await selfHosted();
  await cloudRun();
  await chatPage();
  await libraryPage();
  await appEntry();
  console.log('ALL PASS');
})().catch((error) => {
  console.error('FAIL', error && error.stack || error);
  process.exit(1);
});
