const config = require('./config.js');

const TOKEN_KEY = 'study_agent_token';
let token = wx.getStorageSync(TOKEN_KEY) || '';
let loginPromise = null;

function saveToken(value) {
  token = value || '';
  if (token) {
    wx.setStorageSync(TOKEN_KEY, token);
  } else {
    wx.removeStorageSync(TOKEN_KEY);
  }
}

function apiUrl(path) {
  return config.baseUrl + config.apiPrefix + path;
}

// 统一处理 401、网络失败和后端 {ok:false,error} 三种错误，页面只处理 message。
function request(options) {
  const method = options.method || 'GET';
  const header = Object.assign({ 'Content-Type': 'application/json' }, options.header || {});
  if (options.auth !== false && token) {
    header.Authorization = 'Bearer ' + token;
  }
  const payload = options.data;

  const handle = (statusCode, raw) => {
    let body = raw;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (error) {
        body = {};
      }
    }
    body = body || {};
    if (statusCode === 401) {
      saveToken('');
      const failure = { code: 401, message: '登录已过期，请重新进入小程序' };
      throw failure;
    }
    if (statusCode >= 200 && statusCode < 300 && body.ok !== false) {
      return body;
    }
    throw { code: statusCode, message: body.error || '服务暂时不可用，请稍后重试', body: body };
  };

  if (config.useCloudContainer) {
    return new Promise((resolve, reject) => {
      if (!wx.cloud || !wx.cloud.callContainer) {
        reject({ code: 0, message: '当前微信版本不支持云托管调用，请升级微信后重试' });
        return;
      }
      wx.cloud.callContainer({
        config: { env: config.cloudEnv || undefined },
        path: config.apiPrefix + options.path,
        method: method,
        header: Object.assign({ 'X-WX-SERVICE': config.baseUrl }, header),
        data: payload,
        success(res) {
          try {
            resolve(handle(res.statusCode, res.data));
          } catch (error) {
            reject(error);
          }
        },
        fail() {
          reject({ code: 0, message: '网络连接失败，请检查网络后重试' });
        }
      });
    });
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: apiUrl(options.path),
      method: method,
      data: payload,
      header: header,
      timeout: options.timeout || 20000,
      success(res) {
        try {
          resolve(handle(res.statusCode, res.data));
        } catch (error) {
          reject(error);
        }
      },
      fail() {
        reject({ code: 0, message: '网络连接失败，请检查网络后重试' });
      }
    });
  });
}

function wxCode() {
  if (config.devLogin) {
    // 本地联调：固定一个假用户，重启会话后记录仍然在同一个目录里。
    let id = wx.getStorageSync('dev_user_id');
    if (!id) {
      id = 'u' + Date.now().toString(36).slice(-6);
      wx.setStorageSync('dev_user_id', id);
    }
    return Promise.resolve('dev:' + id);
  }
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (res.code) {
          resolve(res.code);
        } else {
          reject({ code: 0, message: '微信登录失败，请重新进入小程序' });
        }
      },
      fail() {
        reject({ code: 0, message: '微信登录失败，请检查网络' });
      }
    });
  });
}

function login() {
  if (loginPromise) {
    return loginPromise;
  }
  loginPromise = wxCode()
    .then((code) => request({ path: '/auth/login', method: 'POST', data: { code: code }, auth: false }))
    .then((body) => {
      saveToken(body.token);
      loginPromise = null;
      return body.token;
    })
    .catch((error) => {
      loginPromise = null;
      throw error;
    });
  return loginPromise;
}

function ensureLogin() {
  if (config.useCloudContainer && config.cloudAuth) {
    // 云托管会把 X-WX-OPENID 注入到请求里，服务端据此识别用户，不必再换 token。
    return Promise.resolve('');
  }
  if (token) {
    return Promise.resolve(token);
  }
  return login();
}

function status() {
  return ensureLogin().then(() => request({ path: '/status' }));
}

// 提交一轮对话：返回 { task_id }，具体结果靠 pollTask 取。
function chat(payload) {
  return ensureLogin().then(() => request({
    path: '/chat',
    method: 'POST',
    data: payload,
    timeout: 20000
  }));
}

function cancel(taskId) {
  return request({ path: '/tasks/' + taskId + '/cancel', method: 'POST' }).catch(() => null);
}

// 轮询任务；1 秒一次，断网退避到 3 秒，直到结束或超时。
function pollTask(taskId, onUpdate, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || 240000;
  const deadline = Date.now() + timeoutMs;
  let delay = 800;

  return new Promise((resolve, reject) => {
    const step = () => {
      if (Date.now() > deadline) {
        reject({ code: 0, message: '这次等待超时了，可以稍后在记录里查看结果' });
        return;
      }
      request({ path: '/tasks/' + taskId, timeout: 15000 })
        .then((body) => {
          if (onUpdate) {
            onUpdate(body);
          }
          if (body.status === 'running') {
            delay = 1200;
            setTimeout(step, delay);
            return;
          }
          resolve(body);
        })
        .catch((error) => {
          if (error.code === 401 || error.code === 404) {
            reject(error);
            return;
          }
          delay = Math.min(3000, delay + 600);
          setTimeout(step, delay);
        });
    };
    setTimeout(step, delay);
  });
}

function uploadImage(filePath) {
  if (config.useCloudContainer) {
    return uploadImageViaJson(filePath);
  }
  return ensureLogin().then(() => new Promise((resolve, reject) => {
    wx.uploadFile({
      url: apiUrl('/uploads'),
      filePath: filePath,
      name: 'files',
      header: { Authorization: 'Bearer ' + token },
      success(res) {
        let body = {};
        try {
          body = JSON.parse(res.data || '{}');
        } catch (error) {
          body = {};
        }
        if (res.statusCode === 200 && body.ok) {
          resolve(body.image_ids[0]);
        } else if (res.statusCode === 401) {
          saveToken('');
          reject({ code: 401, message: '登录已过期，请重新进入小程序' });
        } else {
          reject({ code: res.statusCode, message: body.error || '图片上传失败' });
        }
      },
      fail() {
        reject({ code: 0, message: '图片上传失败，请检查网络' });
      }
    });
  }));
}

function compressImage(filePath) {
  return new Promise((resolve) => {
    if (!wx.compressImage) {
      resolve(filePath);
      return;
    }
    wx.compressImage({
      src: filePath,
      quality: 70,
      success(res) {
        resolve(res.tempFilePath || filePath);
      },
      fail() {
        resolve(filePath);
      }
    });
  });
}

function readBase64(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      encoding: 'base64',
      success(res) {
        resolve(res.data);
      },
      fail() {
        reject({ code: 0, message: '读取图片失败，请重新选择' });
      }
    });
  });
}

// 云托管用 callContainer，不能发 multipart：先压缩，再用 base64 走 JSON。
function uploadImageViaJson(filePath) {
  return ensureLogin()
    .then(() => compressImage(filePath))
    .then((path) => readBase64(path))
    .then((data) => {
      // base64 后约 4/3 倍，留一点余量即可；超过 4 MB 的码流服务端也会拒。
      if (data.length > 5 * 1024 * 1024) {
        throw { code: 0, message: '这张图片太大，请裁剪后重试' };
      }
      return request({
        path: '/uploads/base64',
        method: 'POST',
        data: { images: [{ data: data, name: 'note.jpg' }] },
        timeout: 40000
      });
    })
    .then((body) => body.image_ids[0]);
}

function resetConversation() {
  return request({ path: '/conversation/reset', method: 'POST' });
}

function deleteAccount() {
  return request({ path: '/account/delete', method: 'POST', data: { confirm: true } });
}

function notes() {
  return ensureLogin().then(() => request({ path: '/notes' }));
}

function noteDetail(id) {
  return ensureLogin().then(() => request({ path: '/notes/' + id }));
}

function mistakes() {
  return ensureLogin().then(() => request({ path: '/mistakes' }));
}

function reviewProgress() {
  return ensureLogin().then(() => request({ path: '/review/progress' }));
}

module.exports = {
  request: request,
  login: login,
  ensureLogin: ensureLogin,
  status: status,
  chat: chat,
  cancel: cancel,
  pollTask: pollTask,
  uploadImage: uploadImage,
  resetConversation: resetConversation,
  deleteAccount: deleteAccount,
  notes: notes,
  noteDetail: noteDetail,
  mistakes: mistakes,
  reviewProgress: reviewProgress
};
