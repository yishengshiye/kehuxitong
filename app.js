/* =================================================================
 * 客户管理系统 - 纯本地版
 * 客户管理 + 定制订单 + 包材管理（按客户→按产品）
 * ================================================================= */

var STORAGE_KEY = {
  AUTH: 'crm_auth',
  SESSION: 'crm_session',
  CUSTOMERS: 'crm_customers',
  ORDERS: 'crm_orders',
  MATERIAL_RECORDS: 'crm_material_records',
};

var allCustomers = [];
var allOrders = [];
var allMaterialRecords = [];
var selectedMaterialCustomerId = null;
var editingCustomerId = null;
var editingOrderId = null;
var deletingType = 'customer';
var deletingCustomerId = null;
var deletingOrderId = null;
var deletingMaterialId = null;
var currentViewProductName = null; // 当前查看明细的产品名

// ========== 密码 ==========
async function hashPassword(password) {
  var enc = new TextEncoder();
  var data = enc.encode(password + 'crm_salt_2026');
  var hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

// ========== 权限 ==========
function getCurrentUser() { return sessionStorage.getItem('crm_logged_user') || ''; }
function getCurrentRole() { return sessionStorage.getItem('crm_role') || '业务员'; }
function isManager() { return getCurrentRole() === '总经理'; }

function getVisibleCustomers() {
  if (isManager()) return allCustomers;
  var u = getCurrentUser();
  return allCustomers.filter(function(c) { return c.user_id === u; });
}
function getVisibleOrders() {
  if (isManager()) return allOrders;
  var u = getCurrentUser();
  return allOrders.filter(function(o) { return o.user_id === u; });
}
function getVisibleMaterialRecords() {
  if (isManager()) return allMaterialRecords;
  var u = getCurrentUser();
  var myIds = [];
  allCustomers.forEach(function(c) { if (c.user_id === u) myIds.push(c.id); });
  if (!myIds.length) return [];
  return allMaterialRecords.filter(function(r) { return myIds.indexOf(r.customer_id) !== -1; });
}

// ========== 存储 ==========
function storageGet(key) { try { var r = localStorage.getItem(key); return r ? JSON.parse(r) : null; } catch(e) { return null; } }
function storageSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// ========== GitHub 云同步 ==========
var GITHUB_API_BASE = 'https://api.github.com/repos/yishengshiye/kehuxitong/contents/data/';
var cloudSHAs = {};
var cloudEnabled = function() { return !!localStorage.getItem('crm_github_token'); };

function _getToken() { return localStorage.getItem('crm_github_token') || ''; }

function _b64ToUtf8(b64) {
  var bin = atob(b64); var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function _utf8ToB64(str) {
  var bytes = new TextEncoder().encode(str); var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// 从 GitHub 拉取数据，返回 { data, sha } 或 null
async function cloudPull(fileName) {
  try {
    var resp = await fetch(GITHUB_API_BASE + fileName + '.json', {
      headers: { 'Authorization': 'token ' + _getToken(), 'Accept': 'application/vnd.github.v3+json' }
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error('status ' + resp.status);
    var j = await resp.json();
    cloudSHAs[fileName] = j.sha;
    return { data: JSON.parse(_b64ToUtf8(j.content)), sha: j.sha };
  } catch(e) { console.warn('云端拉取失败(' + fileName + '):', e.message); return null; }
}

// 推数据到 GitHub（最多重试2次）
async function cloudPush(fileName, data, retryCount) {
  if (!cloudEnabled()) return false;
  retryCount = retryCount || 0;
  try {
    var body = { message: '[auto] update ' + fileName, content: _utf8ToB64(JSON.stringify(data, null, 2)) };
    if (cloudSHAs[fileName]) body.sha = cloudSHAs[fileName];
    var resp = await fetch(GITHUB_API_BASE + fileName + '.json', {
      method: 'PUT',
      headers: { 'Authorization': 'token ' + _getToken(), 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      // 冲突了：重新拉取 SHA 后再试一次
      if (resp.status === 409 && retryCount < 2) {
        var freshPull = await cloudPull(fileName);
        if (freshPull) {
          return cloudPush(fileName, data, retryCount + 1);
        }
      }
      throw new Error('status ' + resp.status);
    }
    var j = await resp.json();
    cloudSHAs[fileName] = j.content.sha;
    return true;
  } catch(e) {
    console.warn('云端推送失败(' + fileName + '):', e.message);
    return false;
  }
}

// 首次加载：从云端拉全部数据，并智能合并本地+云端
async function cloudSyncOnLoad() {
  if (!cloudEnabled()) return false;
  try {
    var files = ['users', 'customers', 'orders', 'material_records'];
    var updated = false;
    for (var i = 0; i < files.length; i++) {
      var cloudResult = await cloudPull(files[i]);
      var localKey = files[i] === 'users' ? STORAGE_KEY.AUTH :
                     files[i] === 'customers' ? STORAGE_KEY.CUSTOMERS :
                     files[i] === 'orders' ? STORAGE_KEY.ORDERS : STORAGE_KEY.MATERIAL_RECORDS;
      var localData = storageGet(localKey);

      if (cloudResult && cloudResult.data) {
        // 云端有数据，检查本地是否有云端没有的（合并）
        if (localData) {
          var merged = _mergeData(files[i], cloudResult.data, localData);
          if (merged) { cloudResult.data = merged; await cloudPush(files[i], merged); }
        }
        storageSet(localKey, cloudResult.data);
        updated = true;
      } else if (localData) {
        // 云端没数据，把本地的推上去
        await cloudPush(files[i], localData);
      }
    }
    return updated;
  } catch(e) { console.warn('云端同步失败:', e.message); return false; }
}

// 合并云端和本地数据（本地有但云端没有的，补充到云端）
function _mergeData(fileName, cloudData, localData) {
  if (fileName === 'users') {
    var cloudUsers = cloudData.users || [];
    var localUsers = localData.users || [];
    // 如果云端已清空（管理员重置），则本地也清空，不再合并
    if (cloudUsers.length === 0) return { users: [] };
    var merged = false;
    for (var i = 0; i < localUsers.length; i++) {
      var found = cloudUsers.some(function(u) { return u.username === localUsers[i].username; });
      if (!found) { cloudUsers.push(localUsers[i]); merged = true; }
    }
    return merged ? { users: cloudUsers } : null;
  }
  // 对于 customers、orders、material_records，用 id 去重并合并
  if (Array.isArray(cloudData) && Array.isArray(localData)) {
    var cloudIds = {};
    cloudData.forEach(function(item) { if (item.id) cloudIds[item.id] = true; });
    var hasNew = false;
    for (var j = 0; j < localData.length; j++) {
      if (localData[j].id && !cloudIds[localData[j].id]) {
        cloudData.push(localData[j]);
        cloudIds[localData[j].id] = true;
        hasNew = true;
      }
    }
    return hasNew ? cloudData : null;
  }
  return null;
}

// ========== 认证 ==========
function getUsers() {
  var auth = storageGet(STORAGE_KEY.AUTH);
  if (!auth) return [];
  // 兼容旧版单用户格式 → 多用户格式
  if (auth.passwordHash && !auth.users) {
    var migrated = { users: [{ username: auth.username || auth.name || '管理员', name: auth.name || auth.username || '管理员', passwordHash: auth.passwordHash, securityQuestion: '', securityAnswer: '', createdAt: auth.createdAt || '' }] };
    storageSet(STORAGE_KEY.AUTH, migrated);
    return migrated.users;
  }
  return auth.users || [];
}

function saveUsers(users) { var d = { users: users }; storageSet(STORAGE_KEY.AUTH, d); cloudPush('users', d); }

function findUser(username) {
  var users = getUsers();
  for (var i = 0; i < users.length; i++) { if (users[i].username === username) return users[i]; }
  return null;
}

function isRegistered() { return getUsers().length > 0; }
function isLoggedIn() { return sessionStorage.getItem(STORAGE_KEY.SESSION) === '1'; }

function showAuthForms() {
  // 默认显示登录
  document.getElementById('login-form').style.display = 'block';
  document.getElementById('register-form').style.display = 'none';
  document.getElementById('forgot-password-form').style.display = 'none';
  document.getElementById('auth-error').style.display = 'none';
  document.getElementById('register-error').style.display = 'none';
  document.getElementById('forgot-error').style.display = 'none';
  document.getElementById('forgot-success').style.display = 'none';
  // 如果没有账号，也显示注册
  if (!isRegistered()) {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'block';
    // 首个用户自动为总经理，隐藏角色选择器
    document.getElementById('register-role').value = '总经理';
    document.getElementById('register-role-group').style.display = 'none';
  } else {
    // 已有用户时，新注册只能是业务员，隐藏角色选择
    document.getElementById('register-role-group').style.display = 'none';
    document.getElementById('register-role').value = '业务员';
  }
  // 云同步配置提示
  document.getElementById('token-setup').style.display = cloudEnabled() ? 'none' : 'block';
  document.getElementById('token-setup-msg').textContent = '';
}

function showRegisterForm() {
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('register-form').style.display = 'block';
  document.getElementById('forgot-password-form').style.display = 'none';
  document.getElementById('register-error').style.display = 'none';
  // 无用户时自动总经理，有用户时显示角色选择
  if (getUsers().length === 0) {
    document.getElementById('register-role').value = '总经理';
    document.getElementById('register-role-group').style.display = 'none';
  } else {
    // 已有用户时，新注册只能是业务员
    document.getElementById('register-role-group').style.display = 'none';
    document.getElementById('register-role').value = '业务员';
  }
}

function showLoginForm() {
  document.getElementById('login-form').style.display = 'block';
  document.getElementById('register-form').style.display = 'none';
  document.getElementById('forgot-password-form').style.display = 'none';
  document.getElementById('auth-error').style.display = 'none';
}

function showForgotForm() {
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('register-form').style.display = 'none';
  document.getElementById('forgot-password-form').style.display = 'block';
  document.getElementById('forgot-error').style.display = 'none';
  document.getElementById('forgot-success').style.display = 'none';
  document.getElementById('forgot-question-section').style.display = 'none';
  document.getElementById('btn-forgot-check').style.display = 'block';
  document.getElementById('btn-forgot-reset').style.display = 'none';
  document.getElementById('forgot-username').value = '';
  document.getElementById('forgot-answer').value = '';
  document.getElementById('forgot-new-password').value = '';
}

async function handleRegister(e) {
  e.preventDefault();
  var username = document.getElementById('register-username').value.trim();
  var pw = document.getElementById('register-password').value;
  var question = document.getElementById('register-security-question').value;
  var answer = document.getElementById('register-security-answer').value.trim();
  var err = document.getElementById('register-error');
  if (!username || username.length < 2) { err.textContent = '账号至少需要2位'; err.style.display = 'block'; return; }
  if (findUser(username)) { err.textContent = '该账号已存在，请换一个账号名'; err.style.display = 'block'; return; }
  if (!pw || pw.length < 4) { err.textContent = '密码至少需要4位'; err.style.display = 'block'; return; }
  if (!question) { err.textContent = '请选择安全问题'; err.style.display = 'block'; return; }
  if (!answer) { err.textContent = '请填写安全问题的答案'; err.style.display = 'block'; return; }
  // 角色：首个用户自动总经理，后面注册的只能是业务员
  var existing = getUsers();
  var role = existing.length === 0 ? '总经理' : '业务员';
  err.style.display = 'none';
  var hash = await hashPassword(pw);
  var answerHash = await hashPassword(answer);
  var users = getUsers();
  users.push({ username: username, name: username, passwordHash: hash, securityQuestion: question, securityAnswer: answerHash, role: role, createdAt: new Date().toISOString() });
  saveUsers(users);
  if (cloudEnabled()) {
    var ok = await cloudPush('users', { users: users });
    if (!ok) { setTimeout(function() { toast('⚠ 云端同步失败，请稍后刷新页面重试', 'error'); }, 500); }
  }
  sessionStorage.setItem(STORAGE_KEY.SESSION, '1');
  sessionStorage.setItem('crm_logged_user', username);
  sessionStorage.setItem('crm_role', role);
  enterApp(username);
}

async function handleLogin(e) {
  e.preventDefault();
  var username = document.getElementById('login-username').value.trim();
  var pw = document.getElementById('login-password').value;
  var err = document.getElementById('auth-error');
  if (!username) { err.textContent = '请输入账号'; err.style.display = 'block'; return; }
  if (!pw) { err.textContent = '请输入密码'; err.style.display = 'block'; return; }
  var user = findUser(username);
  if (!user) { err.textContent = '账号不存在，请检查账号名或联系管理员'; err.style.display = 'block'; return; }
  var inputHash = await hashPassword(pw);
  if (inputHash !== user.passwordHash) { err.textContent = '密码错误，请重试'; err.style.display = 'block'; return; }
  sessionStorage.setItem(STORAGE_KEY.SESSION, '1');
  sessionStorage.setItem('crm_logged_user', user.name || username);
  // 有明确角色的直接用；没有的看是不是第一个注册的用户
  var role = user.role;
  if (!role) {
    var allUsers = getUsers();
    var firstUser = allUsers.length > 0 ? allUsers[0].username : '';
    role = (user.username === firstUser) ? '总经理' : '业务员';
  }
  sessionStorage.setItem('crm_role', role);
  enterApp(user.name || username);
}

// ---- 忘记密码 ----
var forgotTargetUser = null;

async function handleForgotCheck() {
  var username = document.getElementById('forgot-username').value.trim();
  var err = document.getElementById('forgot-error');
  var success = document.getElementById('forgot-success');
  err.style.display = 'none'; success.style.display = 'none';
  if (!username) { err.textContent = '请输入账号'; err.style.display = 'block'; return; }
  var user = findUser(username);
  if (!user) { err.textContent = '账号不存在'; err.style.display = 'block'; return; }
  if (!user.securityQuestion) {
    // 旧账号没有安全问题，直接允许重置
    forgotTargetUser = user;
    document.getElementById('forgot-question-section').style.display = 'none';
    document.getElementById('btn-forgot-check').style.display = 'none';
    document.getElementById('btn-forgot-reset').style.display = 'block';
    success.textContent = '该账号未设置安全问题，可直接设置新密码';
    success.style.display = 'block';
    return;
  }
  forgotTargetUser = user;
  document.getElementById('forgot-question-text').textContent = user.securityQuestion;
  document.getElementById('forgot-question-section').style.display = 'block';
  document.getElementById('btn-forgot-check').style.display = 'none';
  document.getElementById('btn-forgot-reset').style.display = 'block';
}

async function handleForgotReset() {
  var answer = document.getElementById('forgot-answer').value.trim();
  var newPw = document.getElementById('forgot-new-password').value;
  var err = document.getElementById('forgot-error');
  var success = document.getElementById('forgot-success');
  err.style.display = 'none'; success.style.display = 'none';
  if (forgotTargetUser.securityQuestion) {
    if (!answer) { err.textContent = '请输入安全问题的答案'; err.style.display = 'block'; return; }
    var answerHash = await hashPassword(answer);
    if (answerHash !== forgotTargetUser.securityAnswer) { err.textContent = '答案错误，请重试'; err.style.display = 'block'; return; }
  }
  if (!newPw || newPw.length < 4) { err.textContent = '新密码至少需要4位'; err.style.display = 'block'; return; }
  var newHash = await hashPassword(newPw);
  // 更新用户密码
  var users = getUsers();
  for (var i = 0; i < users.length; i++) {
    if (users[i].username === forgotTargetUser.username) { users[i].passwordHash = newHash; break; }
  }
  saveUsers(users);
  forgotTargetUser = null;
  success.textContent = '密码重置成功！请返回登录。';
  success.style.display = 'block';
  document.getElementById('btn-forgot-reset').style.display = 'none';
}

function handleLogout() {
  sessionStorage.removeItem(STORAGE_KEY.SESSION);
  sessionStorage.removeItem('crm_logged_user');
  sessionStorage.removeItem('crm_role');
  document.getElementById('auth-section').style.display = 'flex';
  document.getElementById('app-section').style.display = 'none';
  showAuthForms();
}

function enterApp(userName) {
  document.getElementById('auth-section').style.display = 'none';
  document.getElementById('app-section').style.display = 'flex';
  var role = getCurrentRole();
  document.getElementById('user-name').textContent = userName + ' (' + role + ')';
  sessionStorage.setItem('crm_logged_user', userName);
  switchView('dashboard');
  loadDashboard();
  loadCustomers(); loadOrders(); loadMaterialRecords();
}

function resetSystem() {
  if (!confirm('确定要重置系统吗？所有数据（客户、订单、包材记录）将被清除且无法恢复！')) return;
  Object.keys(STORAGE_KEY).forEach(function(k) { localStorage.removeItem(STORAGE_KEY[k]); });
  sessionStorage.removeItem(STORAGE_KEY.SESSION);
  location.reload();
}

// ========== 视图 ==========
function switchView(viewName) {
  document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
  var tv = document.getElementById('view-' + viewName);
  if (tv) tv.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
  var ni = document.querySelector('[data-view="' + viewName + '"]');
  if (ni) ni.classList.add('active');
}

// ================================================================
//                      客 户
// ================================================================
function loadCustomers() { allCustomers = storageGet(STORAGE_KEY.CUSTOMERS) || []; renderCustomerTable(getVisibleCustomers()); updateCustomerDropdowns(); }
function saveCustomers() { storageSet(STORAGE_KEY.CUSTOMERS, allCustomers); cloudPush('customers', allCustomers); }

function renderCustomerTable(customers) {
  var tb = document.getElementById('customer-table-body');
  if (!customers || !customers.length) { tb.innerHTML = '<tr><td colspan="8" class="empty-state">暂无客户数据</td></tr>'; return; }
  tb.innerHTML = customers.map(function(c) {
    var lc = c.last_contact_date || c.updated_at || '';
    return '<tr>' +
      '<td><strong>' + esc(c.name || '') + '</strong></td>' +
      '<td>' + esc(c.company_name || '-') + '</td>' +
      '<td>' + esc(c.country || '-') + '</td>' +
      '<td>' + esc(c.phone || '-') + '</td>' +
      '<td><span class="badge ' + levelBadge(c.customer_level) + '">' + esc(c.customer_level || '-') + '</span></td>' +
      '<td><span class="badge ' + statusBadge(c.status) + '">' + esc(c.status || '-') + '</span></td>' +
      '<td>' + fmtDate(lc) + '</td>' +
      '<td><div class="action-btns"><button class="btn btn-sm" onclick="openEditCustomerModal(\'' + c.id + '\')">编辑</button> <button class="btn btn-sm btn-danger" onclick="openDeleteConfirm(\'customer\',\'' + c.id + '\',\'' + esc(c.name || '') + '\')">删除</button></div></td></tr>';
  }).join('');
}

function filterCustomers() {
  var s = document.getElementById('customer-search').value.toLowerCase().trim();
  var sf = document.getElementById('customer-status-filter').value;
  var lf = document.getElementById('customer-level-filter').value;
  var f = getVisibleCustomers();
  if (s) f = f.filter(function(c) { return (c.name && c.name.toLowerCase().indexOf(s) !== -1) || (c.company_name && c.company_name.toLowerCase().indexOf(s) !== -1) || (c.country && c.country.toLowerCase().indexOf(s) !== -1) || (c.phone && c.phone.toLowerCase().indexOf(s) !== -1); });
  if (sf) f = f.filter(function(c) { return c.status === sf; });
  if (lf) f = f.filter(function(c) { return c.customer_level === lf; });
  renderCustomerTable(f);
}

function genId() { return Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8); }

function openAddCustomerModal() { editingCustomerId = null; document.getElementById('customer-modal-title').textContent = '新增客户'; document.getElementById('customer-form').reset(); document.getElementById('customer-id').value = ''; document.getElementById('customer-modal').style.display = 'flex'; }

function openEditCustomerModal(id) {
  var c = allCustomers.find(function(x) { return x.id === id; }); if (!c) return;
  editingCustomerId = id;
  document.getElementById('customer-modal-title').textContent = '编辑客户';
  document.getElementById('customer-id').value = c.id;
  document.getElementById('customer-name').value = c.name || '';
  document.getElementById('customer-company').value = c.company_name || '';
  document.getElementById('customer-country').value = c.country || '';
  document.getElementById('customer-phone').value = c.phone || '';
  document.getElementById('customer-wechat').value = c.wechat || '';
  document.getElementById('customer-source').value = c.source || '';
  document.getElementById('customer-level').value = c.customer_level || '潜在';
  document.getElementById('customer-status').value = c.status || '潜在客户';
  document.getElementById('customer-first-contact').value = c.first_contact_date || '';
  document.getElementById('customer-last-contact').value = c.last_contact_date || '';
  document.getElementById('customer-notes').value = c.notes || '';
  document.getElementById('customer-modal').style.display = 'flex';
}

function closeCustomerModal() { document.getElementById('customer-modal').style.display = 'none'; editingCustomerId = null; }

function saveCustomer(e) {
  e.preventDefault();
  var name = document.getElementById('customer-name').value.trim();
  if (!name) { toast('请填写客户姓名', 'error'); return; }
  var now = new Date().toISOString();
  var d = {
    name: name,
    company_name: document.getElementById('customer-company').value.trim(),
    country: document.getElementById('customer-country').value.trim(),
    phone: document.getElementById('customer-phone').value.trim(),
    wechat: document.getElementById('customer-wechat').value.trim(),
    source: document.getElementById('customer-source').value.trim(),
    customer_level: document.getElementById('customer-level').value,
    status: document.getElementById('customer-status').value,
    first_contact_date: document.getElementById('customer-first-contact').value || null,
    last_contact_date: document.getElementById('customer-last-contact').value || null,
    notes: document.getElementById('customer-notes').value.trim(),
  };
  if (editingCustomerId) {
    var i = allCustomers.findIndex(function(x) { return x.id === editingCustomerId; });
    if (i !== -1) { d.id = editingCustomerId; d.user_id = allCustomers[i].user_id; d.created_at = allCustomers[i].created_at; d.updated_at = now; allCustomers[i] = d; }
  } else { d.id = genId(); d.user_id = getCurrentUser(); d.created_at = now; d.updated_at = now; allCustomers.unshift(d); }
  saveCustomers();
  toast(editingCustomerId ? '客户信息已更新' : '客户添加成功', 'success');
  closeCustomerModal(); renderCustomerTable(getVisibleCustomers()); updateCustomerDropdowns(); loadDashboard();
}

// ================================================================
//                      订 单
// ================================================================
function loadOrders() { allOrders = storageGet(STORAGE_KEY.ORDERS) || []; renderOrderTable(getVisibleOrders()); updateOrderCustomerFilter(); }
function saveOrders() { storageSet(STORAGE_KEY.ORDERS, allOrders); cloudPush('orders', allOrders); }

function updateCustomerDropdowns() {
  var cs = getVisibleCustomers();
  var opts = cs.map(function(c) { return '<option value="' + c.id + '">' + esc(c.name) + (c.company_name ? ' - ' + esc(c.company_name) : '') + '</option>'; }).join('');
  var sel = document.getElementById('order-customer');
  if (sel) sel.innerHTML = '<option value="">请选择客户</option>' + opts;
}

function updateOrderCustomerFilter() {
  var cs = getVisibleCustomers();
  var opts = cs.map(function(c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
  var f = document.getElementById('order-customer-filter');
  if (f) f.innerHTML = '<option value="">全部客户</option>' + opts;
}

function getCustName(cid) { var c = allCustomers.find(function(x) { return x.id === cid; }); return c ? c.name : '未知客户'; }

function renderOrderTable(orders) {
  var tb = document.getElementById('order-table-body');
  if (!orders || !orders.length) { tb.innerHTML = '<tr><td colspan="8" class="empty-state">暂无订单数据</td></tr>'; return; }
  tb.innerHTML = orders.map(function(o) {
    return '<tr>' +
      '<td><strong>' + esc(getCustName(o.customer_id)) + '</strong></td>' +
      '<td>' + esc(o.product_name || '-') + '</td>' +
      '<td>' + (o.order_quantity || '-') + '</td>' +
      '<td>' + (o.quotation_price ? '¥' + o.quotation_price : '-') + '</td>' +
      '<td>' + (o.delivery_date || '-') + '</td>' +
      '<td><span class="badge ' + orderBadge(o.status) + '">' + esc(o.status || '沟通中') + '</span></td>' +
      '<td>' + fmtDate(o.created_at) + '</td>' +
      '<td><div class="action-btns"><button class="btn btn-sm" onclick="openEditOrderModal(\'' + o.id + '\')">编辑</button> <button class="btn btn-sm btn-danger" onclick="openDeleteConfirm(\'order\',\'' + o.id + '\',\'' + esc(o.product_name || '') + '\')">删除</button></div></td></tr>';
  }).join('');
}

function filterOrders() {
  var s = document.getElementById('order-search').value.toLowerCase().trim();
  var sf = document.getElementById('order-status-filter').value;
  var cf = document.getElementById('order-customer-filter').value;
  var f = getVisibleOrders();
  if (s) f = f.filter(function(o) { return (o.product_name && o.product_name.toLowerCase().indexOf(s) !== -1) || getCustName(o.customer_id).toLowerCase().indexOf(s) !== -1; });
  if (sf) f = f.filter(function(o) { return o.status === sf; });
  if (cf) f = f.filter(function(o) { return o.customer_id === cf; });
  renderOrderTable(f);
}

function openAddOrderModal() { editingOrderId = null; document.getElementById('order-modal-title').textContent = '新增订单'; document.getElementById('order-form').reset(); document.getElementById('order-id').value = ''; updateCustomerDropdowns(); document.getElementById('order-modal').style.display = 'flex'; }

function openEditOrderModal(id) {
  var o = allOrders.find(function(x) { return x.id === id; }); if (!o) return;
  editingOrderId = id; updateCustomerDropdowns();
  document.getElementById('order-modal-title').textContent = '编辑订单';
  document.getElementById('order-id').value = o.id;
  document.getElementById('order-customer').value = o.customer_id || '';
  document.getElementById('order-product-name').value = o.product_name || '';
  document.getElementById('order-size').value = o.size || '';
  document.getElementById('order-logo-requirements').value = o.logo_requirements || '';
  document.getElementById('order-quotation-price').value = o.quotation_price || '';
  document.getElementById('order-quantity').value = o.order_quantity || '';
  document.getElementById('order-delivery-date').value = o.delivery_date || '';
  document.getElementById('order-status').value = o.status || '沟通中';
  document.getElementById('order-tax-included').value = o.tax_included || '';
  document.getElementById('order-shipping-included').value = o.shipping_included || '';
  document.getElementById('order-sample-record').value = o.sample_record || '';
  document.getElementById('order-communication-notes').value = o.communication_notes || '';
  document.getElementById('order-modal').style.display = 'flex';
}

function closeOrderModal() { document.getElementById('order-modal').style.display = 'none'; editingOrderId = null; }

function saveOrder(e) {
  e.preventDefault();
  var cid = document.getElementById('order-customer').value;
  var pn = document.getElementById('order-product-name').value.trim();
  if (!cid) { toast('请选择客户', 'error'); return; }
  if (!pn) { toast('请填写产品名称', 'error'); return; }
  var now = new Date().toISOString();
  var d = {
    customer_id: cid, product_name: pn,
    size: document.getElementById('order-size').value.trim(),
    logo_requirements: document.getElementById('order-logo-requirements').value.trim(),
    quotation_price: document.getElementById('order-quotation-price').value || null,
    order_quantity: document.getElementById('order-quantity').value || null,
    delivery_date: document.getElementById('order-delivery-date').value || null,
    status: document.getElementById('order-status').value,
    tax_included: document.getElementById('order-tax-included').value,
    shipping_included: document.getElementById('order-shipping-included').value,
    sample_record: document.getElementById('order-sample-record').value.trim(),
    communication_notes: document.getElementById('order-communication-notes').value.trim(),
  };
  if (editingOrderId) {
    var i = allOrders.findIndex(function(x) { return x.id === editingOrderId; });
    if (i !== -1) { d.id = editingOrderId; d.user_id = allOrders[i].user_id; d.created_at = allOrders[i].created_at; d.updated_at = now; allOrders[i] = d; }
  } else { d.id = genId(); d.user_id = getCurrentUser(); d.created_at = now; d.updated_at = now; allOrders.unshift(d); }
  saveOrders();
  toast(editingOrderId ? '订单已更新' : '订单添加成功', 'success');
  closeOrderModal(); renderOrderTable(getVisibleOrders()); updateOrderCustomerFilter(); loadDashboard();
}

// ================================================================
//                包 材 管 理（选客户 → 看产品 → 出入库）
// ================================================================
function loadMaterialRecords() {
  allMaterialRecords = storageGet(STORAGE_KEY.MATERIAL_RECORDS) || [];
  updateMaterialCustomerSelect();
}

function saveMaterialRecords() { storageSet(STORAGE_KEY.MATERIAL_RECORDS, allMaterialRecords); cloudPush('material_records', allMaterialRecords); }

function updateMaterialCustomerSelect() {
  var cs = getVisibleCustomers();
  var opts = cs.map(function(c) { return '<option value="' + c.id + '">' + esc(c.name) + (c.company_name ? ' - ' + esc(c.company_name) : '') + '</option>'; }).join('');
  var sel = document.getElementById('material-customer-select');
  if (sel) {
    var cur = sel.value;
    sel.innerHTML = '<option value="">请选择客户</option>' + opts;
    if (cur) sel.value = cur;
  }
}

// 选择客户 → 展示该客户的定制产品列表
function onMaterialCustomerChange() {
  selectedMaterialCustomerId = document.getElementById('material-customer-select').value;
  if (selectedMaterialCustomerId) {
    document.getElementById('material-summary').style.display = 'block';
    document.getElementById('material-no-customer').style.display = 'none';
    showProductList();
  } else {
    document.getElementById('material-summary').style.display = 'none';
    document.getElementById('material-no-customer').style.display = 'block';
  }
}

// 展示该客户的产品列表（从订单中提取，去重）
function showProductList() {
  document.getElementById('material-records-section').style.display = 'none';
  currentViewProductName = null;

  // 从订单中获取该客户的所有产品名（去重）
  var orders = getVisibleOrders();
  var customerOrders = orders.filter(function(o) { return o.customer_id === selectedMaterialCustomerId; });
  var productNames = [];
  customerOrders.forEach(function(o) {
    if (o.product_name && productNames.indexOf(o.product_name) === -1) {
      productNames.push(o.product_name);
    }
  });

  var tb = document.getElementById('material-products-body');
  if (!productNames.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty-state">该客户暂无定制产品，请先在"定制订单"中添加</td></tr>';
    return;
  }

  tb.innerHTML = productNames.map(function(pn) {
    // 统计该客户 + 该产品的包材出入库
    var records = getVisibleMaterialRecords().filter(function(r) {
      return r.customer_id === selectedMaterialCustomerId && r.product_name === pn;
    });
    var totalIn = records.filter(function(r) { return r.type === '入库'; }).reduce(function(s, r) { return s + r.quantity; }, 0);
    var totalOut = records.filter(function(r) { return r.type === '出库'; }).reduce(function(s, r) { return s + r.quantity; }, 0);
    var remain = totalIn - totalOut;
    return '<tr>' +
      '<td><strong>' + esc(pn) + '</strong></td>' +
      '<td style="color:#16a34a;">' + totalIn + '</td>' +
      '<td style="color:#dc2626;">' + totalOut + '</td>' +
      '<td style="color:#2563eb;font-weight:700;">' + remain + '</td>' +
      '<td><div class="action-btns">' +
        '<button class="btn btn-sm" onclick="openMaterialModal(\'in\',\'' + esc(pn) + '\')">入库</button> ' +
        '<button class="btn btn-sm" onclick="openMaterialModal(\'out\',\'' + esc(pn) + '\')">出库</button> ' +
        '<button class="btn btn-sm" onclick="showProductRecords(\'' + esc(pn) + '\')">记录</button>' +
      '</div></td></tr>';
  }).join('');

  loadDashboard();
}

// 查看某产品的出入库明细
function showProductRecords(productName) {
  currentViewProductName = productName;
  document.getElementById('material-records-section').style.display = 'block';
  document.getElementById('material-records-product-name').textContent = productName;

  var records = getVisibleMaterialRecords().filter(function(r) {
    return r.customer_id === selectedMaterialCustomerId && r.product_name === productName;
  });

  var tb = document.getElementById('material-records-body');
  if (!records.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty-state">暂无出入库记录</td></tr>';
  } else {
    tb.innerHTML = records.map(function(r) {
      return '<tr>' +
        '<td>' + fmtDateTime(r.created_at) + '</td>' +
        '<td><span class="badge ' + (r.type === '入库' ? 'badge-deal' : 'badge-lost') + '">' + r.type + '</span></td>' +
        '<td><strong>' + r.quantity + '</strong></td>' +
        '<td>' + esc(r.notes || '-') + '</td>' +
        '<td><button class="btn btn-sm btn-danger" onclick="openDeleteConfirm(\'material\',\'' + r.id + '\',\'包材记录\')">删除</button></td></tr>';
    }).join('');
  }
}

// 打开入库/出库弹窗
function openMaterialModal(type, productName) {
  if (!selectedMaterialCustomerId) { toast('请先选择客户', 'error'); return; }
  var c = allCustomers.find(function(x) { return x.id === selectedMaterialCustomerId; });
  document.getElementById('material-modal-title').textContent = type === 'in' ? '入库' : '出库';
  document.getElementById('material-type').value = type;
  document.getElementById('material-customer-id').value = selectedMaterialCustomerId;
  document.getElementById('material-product-name').value = productName;
  document.getElementById('material-customer-info').textContent = '客户：' + (c ? c.name : '') + '  |  产品：' + productName;
  document.getElementById('material-id').value = '';
  document.getElementById('material-quantity').value = '';
  document.getElementById('material-notes').value = '';
  document.getElementById('material-modal').style.display = 'flex';
}

function closeMaterialModal() { document.getElementById('material-modal').style.display = 'none'; }

function saveMaterialRecord(e) {
  e.preventDefault();
  var type = document.getElementById('material-type').value;
  var customerId = document.getElementById('material-customer-id').value;
  var productName = document.getElementById('material-product-name').value;
  var qty = parseInt(document.getElementById('material-quantity').value);
  var notes = document.getElementById('material-notes').value.trim();

  if (!qty || qty <= 0) { toast('请输入有效数量', 'error'); return; }

  if (type === 'out') {
    var records = getVisibleMaterialRecords().filter(function(r) { return r.customer_id === customerId && r.product_name === productName; });
    var tin = records.filter(function(r) { return r.type === '入库'; }).reduce(function(s, r) { return s + r.quantity; }, 0);
    var tout = records.filter(function(r) { return r.type === '出库'; }).reduce(function(s, r) { return s + r.quantity; }, 0);
    if (tin - tout < qty) { toast('剩余包材不足，当前剩余：' + (tin - tout), 'error'); return; }
  }

  allMaterialRecords.unshift({
    id: genId(),
    customer_id: customerId,
    product_name: productName,
    type: type === 'in' ? '入库' : '出库',
    quantity: qty,
    notes: notes,
    user_id: getCurrentUser(),
    created_at: new Date().toISOString(),
  });
  saveMaterialRecords();
  toast((type === 'in' ? '入库' : '出库') + '成功', 'success');
  closeMaterialModal();
  showProductList();
  if (currentViewProductName) showProductRecords(currentViewProductName);
}

// ================================================================
//                      删 除
// ================================================================
function openDeleteConfirm(type, id, name) {
  deletingType = type;
  deletingCustomerId = type === 'customer' ? id : null;
  deletingOrderId = type === 'order' ? id : null;
  deletingMaterialId = type === 'material' ? id : null;

  var labels = { customer: '客户', order: '订单', material: '包材记录' };
  var extra = type === 'customer' ? '（关联订单和包材记录也将被删除）' : '';
  document.getElementById('confirm-message').textContent = '确定要删除' + labels[type] + '"' + name + '"吗？此操作不可撤销。' + extra;
  document.getElementById('confirm-modal').style.display = 'flex';
}

function closeDeleteConfirm() {
  document.getElementById('confirm-modal').style.display = 'none';
  deletingCustomerId = null; deletingOrderId = null; deletingMaterialId = null;
}

function confirmDelete() {
  if (deletingType === 'customer' && deletingCustomerId) {
    var cust = allCustomers.find(function(c) { return c.id === deletingCustomerId; });
    if (!isManager() && cust && cust.user_id !== getCurrentUser()) { toast('无权删除该客户', 'error'); closeDeleteConfirm(); return; }
    allOrders = allOrders.filter(function(o) { return o.customer_id !== deletingCustomerId; });
    allMaterialRecords = allMaterialRecords.filter(function(r) { return r.customer_id !== deletingCustomerId; });
    allCustomers = allCustomers.filter(function(c) { return c.id !== deletingCustomerId; });
    saveCustomers(); saveOrders(); saveMaterialRecords();
    toast('客户及其关联数据已删除', 'success');
  } else if (deletingType === 'order' && deletingOrderId) {
    var ord = allOrders.find(function(o) { return o.id === deletingOrderId; });
    if (!isManager() && ord && ord.user_id !== getCurrentUser()) { toast('无权删除该订单', 'error'); closeDeleteConfirm(); return; }
    allOrders = allOrders.filter(function(o) { return o.id !== deletingOrderId; });
    saveOrders(); toast('订单已删除', 'success');
  } else if (deletingType === 'material' && deletingMaterialId) {
    var rec = allMaterialRecords.find(function(r) { return r.id === deletingMaterialId; });
    if (!isManager() && rec && rec.user_id !== getCurrentUser()) { toast('无权删除该记录', 'error'); closeDeleteConfirm(); return; }
    allMaterialRecords = allMaterialRecords.filter(function(r) { return r.id !== deletingMaterialId; });
    saveMaterialRecords(); toast('包材记录已删除', 'success');
  }
  closeDeleteConfirm();
  renderCustomerTable(getVisibleCustomers()); renderOrderTable(getVisibleOrders());
  updateCustomerDropdowns(); updateOrderCustomerFilter(); updateMaterialCustomerSelect();
  if (selectedMaterialCustomerId) showProductList();
  if (currentViewProductName) showProductRecords(currentViewProductName);
  loadDashboard();
}

// ================================================================
//                      仪 表 盘
// ================================================================
function loadDashboard() {
  allCustomers = storageGet(STORAGE_KEY.CUSTOMERS) || [];
  allOrders = storageGet(STORAGE_KEY.ORDERS) || [];
  allMaterialRecords = storageGet(STORAGE_KEY.MATERIAL_RECORDS) || [];

  var vc = getVisibleCustomers();
  var vo = getVisibleOrders();
  var vr = getVisibleMaterialRecords();

  document.getElementById('stat-total-customers').textContent = vc.length;

  var now = new Date();
  var firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  document.getElementById('stat-new-customers').textContent = vc.filter(function(c) { return c.created_at >= firstDay; }).length;

  var active = ['沟通中', '打样中', '已报价', '已下单', '生产中', '已发货'];
  document.getElementById('stat-active-orders').textContent = vo.filter(function(o) { return active.indexOf(o.status) !== -1; }).length;

  // 有剩余包材的产品数
  var allProducts = {};
  vr.forEach(function(r) {
    var key = r.customer_id + '|||' + r.product_name;
    if (!allProducts[key]) allProducts[key] = { tin: 0, tout: 0 };
    if (r.type === '入库') allProducts[key].tin += r.quantity;
    else allProducts[key].tout += r.quantity;
  });
  var withStock = Object.values(allProducts).filter(function(p) { return p.tin - p.tout > 0; }).length;
  document.getElementById('stat-low-stock').textContent = withStock;
}

// ================================================================
//                      工 具
// ================================================================
function toast(msg, type) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast toast-' + (type === 'error' ? 'error' : 'success');
  t.style.display = 'block';
  clearTimeout(t._tid);
  t._tid = setTimeout(function() { t.style.display = 'none'; }, 3000);
}

function esc(str) { if (!str) return ''; var d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
function fmtDate(ds) { if (!ds) return '-'; var d = new Date(ds); if (isNaN(d.getTime())) return '-'; return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
function fmtDateTime(ds) { if (!ds) return '-'; var d = new Date(ds); if (isNaN(d.getTime())) return '-'; return d.toLocaleString('zh-CN'); }
function levelBadge(l) { return l === 'VIP' ? 'badge-vip' : l === '普通' ? 'badge-normal' : l === '潜在' ? 'badge-potential' : ''; }
function statusBadge(s) { return s === '潜在客户' ? 'badge-lead' : s === '已成交客户' ? 'badge-deal' : s === '长期客户' ? 'badge-longterm' : s === '流失客户' ? 'badge-lost' : ''; }
function orderBadge(s) { var m = { '沟通中': 'badge-lead', '打样中': 'badge-normal', '已报价': 'badge-vip', '已下单': 'badge-potential', '生产中': 'badge-vip', '已发货': 'badge-deal', '已完成': 'badge-longterm' }; return m[s] || ''; }

// ================================================================
//                    Excel 导出 (CSV)
// ================================================================
function downloadCSV(rows, filename) {
  if (!rows || !rows.length) { toast('没有数据可导出', 'error'); return; }
  var BOM = '﻿'; // 让 Excel 正确识别中文
  var csv = BOM + rows.map(function(row) {
    return row.map(function(cell) {
      var v = (cell === null || cell === undefined) ? '' : String(cell);
      // CSV 转义：包含逗号、引号或换行的字段需要用引号包裹
      if (v.indexOf(',') !== -1 || v.indexOf('"') !== -1 || v.indexOf('\n') !== -1) {
        return '"' + v.replace(/"/g, '""') + '"';
      }
      return v;
    }).join(',');
  }).join('\n');

  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('导出成功', 'success');
}

function exportCustomers() {
  var cs = getVisibleCustomers();
  var rows = [['客户姓名', '公司名称', '国家', '电话', '微信', '阿里来源', '等级', '状态', '首次联系', '最近联系', '备注', '创建时间']];
  cs.forEach(function(c) {
    rows.push([c.name, c.company_name, c.country, c.phone, c.wechat, c.source, c.customer_level, c.status, c.first_contact_date, c.last_contact_date, c.notes, fmtDateTime(c.created_at)]);
  });
  downloadCSV(rows, '客户列表_' + new Date().toISOString().slice(0, 10));
}

function exportOrders() {
  var orders = getVisibleOrders();
  var rows = [['客户', '产品名称', '尺寸', '商标要求', '报价(¥)', '数量', '交期', '是否含税', '是否含运费', '状态', '打样记录', '沟通备注', '创建时间']];
  orders.forEach(function(o) {
    rows.push([getCustName(o.customer_id), o.product_name, o.size, o.logo_requirements, o.quotation_price, o.order_quantity, o.delivery_date, o.tax_included, o.shipping_included, o.status, o.sample_record, o.communication_notes, fmtDateTime(o.created_at)]);
  });
  downloadCSV(rows, '订单列表_' + new Date().toISOString().slice(0, 10));
}

function exportMaterialRecords() {
  if (!selectedMaterialCustomerId || !currentViewProductName) { toast('请先选择客户并点击产品的"记录"', 'error'); return; }
  var records = getVisibleMaterialRecords().filter(function(r) { return r.customer_id === selectedMaterialCustomerId && r.product_name === currentViewProductName; });
  var rows = [['时间', '类型', '产品', '数量', '备注']];
  records.forEach(function(r) {
    rows.push([fmtDateTime(r.created_at), r.type, r.product_name, r.quantity, r.notes]);
  });
  downloadCSV(rows, '包材记录_' + currentViewProductName + '_' + new Date().toISOString().slice(0, 10));
}

// ================================================================
//                      事 件
// ================================================================
function bindEvents() {
  document.getElementById('register-form').addEventListener('submit', handleRegister);
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('show-register').addEventListener('click', function(e) { e.preventDefault(); showRegisterForm(); });
  document.getElementById('show-forgot-password').addEventListener('click', function(e) { e.preventDefault(); showForgotForm(); });
  document.getElementById('show-login-from-register').addEventListener('click', function(e) { e.preventDefault(); showLoginForm(); });
  document.getElementById('show-login-from-forgot').addEventListener('click', function(e) { e.preventDefault(); showLoginForm(); });
  document.getElementById('btn-forgot-check').addEventListener('click', handleForgotCheck);
  document.getElementById('btn-forgot-reset').addEventListener('click', handleForgotReset);
  document.getElementById('btn-save-token').addEventListener('click', async function() {
    var token = document.getElementById('setup-token').value.trim();
    var msg = document.getElementById('token-setup-msg');
    if (!token) { msg.textContent = '请输入 Token'; return; }
    if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) { msg.textContent = 'Token 格式不正确，应以 ghp_ 或 github_pat_ 开头'; return; }
    localStorage.setItem('crm_github_token', token);
    msg.textContent = '正在从云端同步数据...';
    msg.style.color = '#2563eb';
    // 立即触发云端同步
    await cloudSyncOnLoad();
    msg.textContent = '云同步已启用！';
    msg.style.color = '#16a34a';
    setTimeout(function() { document.getElementById('token-setup').style.display = 'none'; showAuthForms(); }, 1000);
  });
  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  document.querySelectorAll('.nav-item[data-view]').forEach(function(item) {
    item.addEventListener('click', function(e) {
      e.preventDefault();
      var v = item.dataset.view;
      switchView(v);
      if (v === 'dashboard') loadDashboard();
      if (v === 'customers') loadCustomers();
      if (v === 'orders') { loadOrders(); updateCustomerDropdowns(); }
      if (v === 'inventory') { loadMaterialRecords(); }
    });
  });

  // 客户
  document.getElementById('btn-add-customer').addEventListener('click', openAddCustomerModal);
  document.getElementById('customer-form').addEventListener('submit', saveCustomer);
  document.getElementById('btn-close-modal').addEventListener('click', closeCustomerModal);
  document.getElementById('btn-cancel-form').addEventListener('click', closeCustomerModal);
  document.getElementById('customer-modal').addEventListener('click', function(e) { if (e.target === document.getElementById('customer-modal')) closeCustomerModal(); });
  document.getElementById('customer-search').addEventListener('input', filterCustomers);
  document.getElementById('customer-status-filter').addEventListener('change', filterCustomers);
  document.getElementById('customer-level-filter').addEventListener('change', filterCustomers);

  // 订单
  document.getElementById('btn-add-order').addEventListener('click', openAddOrderModal);
  document.getElementById('order-form').addEventListener('submit', saveOrder);
  document.getElementById('btn-close-order-modal').addEventListener('click', closeOrderModal);
  document.getElementById('btn-cancel-order-form').addEventListener('click', closeOrderModal);
  document.getElementById('order-modal').addEventListener('click', function(e) { if (e.target === document.getElementById('order-modal')) closeOrderModal(); });
  document.getElementById('order-search').addEventListener('input', filterOrders);
  document.getElementById('order-status-filter').addEventListener('change', filterOrders);
  document.getElementById('order-customer-filter').addEventListener('change', filterOrders);

  // 包材
  document.getElementById('material-customer-select').addEventListener('change', onMaterialCustomerChange);
  document.getElementById('material-form').addEventListener('submit', saveMaterialRecord);
  document.getElementById('btn-close-material-modal').addEventListener('click', closeMaterialModal);
  document.getElementById('btn-cancel-material-form').addEventListener('click', closeMaterialModal);
  document.getElementById('material-modal').addEventListener('click', function(e) { if (e.target === document.getElementById('material-modal')) closeMaterialModal(); });
  document.getElementById('btn-back-to-products').addEventListener('click', function() { showProductList(); });

  // 导出
  document.getElementById('btn-export-customers').addEventListener('click', exportCustomers);
  document.getElementById('btn-export-orders').addEventListener('click', exportOrders);
  document.getElementById('btn-export-records').addEventListener('click', exportMaterialRecords);

  // 删除
  document.getElementById('btn-confirm-delete').addEventListener('click', confirmDelete);
  document.getElementById('btn-cancel-confirm').addEventListener('click', closeDeleteConfirm);
  document.getElementById('confirm-modal').addEventListener('click', function(e) { if (e.target === document.getElementById('confirm-modal')) closeDeleteConfirm(); });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { closeCustomerModal(); closeOrderModal(); closeMaterialModal(); closeDeleteConfirm(); }
  });
}

// ========== 重置所有用户（通过 ?reset-users=1 触发） ==========
async function resetAllUsers() {
  storageSet(STORAGE_KEY.AUTH, { users: [] });
  sessionStorage.removeItem(STORAGE_KEY.SESSION);
  sessionStorage.removeItem('crm_logged_user');
  sessionStorage.removeItem('crm_role');
  if (cloudEnabled()) {
    await cloudPush('users', { users: [] });
  }
  document.getElementById('auth-section').style.display = 'flex';
  document.getElementById('app-section').style.display = 'none';
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('register-form').style.display = 'none';
  document.getElementById('forgot-password-form').style.display = 'none';
  var err = document.getElementById('auth-error');
  err.textContent = '所有用户已清除，请重新注册。';
  err.style.display = 'block';
  err.style.color = '#16a34a';
  // 清除 URL 中的参数
  if (window.history && window.history.replaceState) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// ========== 启动 ==========
document.addEventListener('DOMContentLoaded', async function() {
  // 检查是否需要重置所有用户
  if (window.location.search.indexOf('reset-users=1') !== -1) {
    await resetAllUsers();
    return;
  }

  bindEvents();
  // 先从云端拉取最新数据
  var cloudUpdated = await cloudSyncOnLoad();
  if (cloudUpdated) {
    // 云端有新数据，刷新内存
    var auth = storageGet(STORAGE_KEY.AUTH);
    if (auth) { /* 用户数据已更新 */ }
  }
  if (isLoggedIn()) {
    var loggedUser = sessionStorage.getItem('crm_logged_user');
    if (loggedUser) {
      if (!sessionStorage.getItem('crm_role')) { var u = findUser(loggedUser); if (u) { var allU = getUsers(); var firstU = allU.length > 0 ? allU[0].username : ''; sessionStorage.setItem('crm_role', u.role || ((u.username === firstU) ? '总经理' : '业务员')); } }
      enterApp(loggedUser); return;
    }
  }
  document.getElementById('auth-section').style.display = 'flex';
  document.getElementById('app-section').style.display = 'none';
  showAuthForms();
});
