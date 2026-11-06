const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, session, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = __dirname;

// 文案只在一处定义：src/i18n/*.json。主进程自己取，渲染进程用同一份文件 fetch。
const DICTS = {
  zh: require('./src/i18n/zh.json'),
  en: require('./src/i18n/en.json'),
};
const LANGS = ['zh', 'en'];

// 开源发布后，仓库地址和赞助方式都在这里改，不用翻代码
const APP_INFO = (() => {
  try { return require('./src/config/app-info.json'); } catch { return {}; }
})();

// 缺键时回退中文：新加的键还没翻译时，界面宁可显示中文，也不要出现 "undefined"
function t(key, vars) {
  const pick = (dict) => key.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : null), dict);
  let s = pick(DICTS[settings?.language] || DICTS.zh) ?? pick(DICTS.zh) ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
  return s;
}

// 首次运行跟随系统语言，之后完全由用户的选择说了算
function detectLanguage() {
  try {
    return String(app.getLocale() || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

// 打包后 app 名会变成 productName，userData 目录会跟着变，用户的设置和基线就"丢了"。
// 固定成 postureguard，让开发态和安装版共用同一份配置。
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'postureguard'));
} catch {
  /* 拿不到路径就沿用默认 */
}

// 摄像头机位 → 推荐阈值。
// 侧向 45° 时肩线在画面里被压缩到约 0.7 倍（1/cos45°≈1.41），而 dTilt / dDrop / dYaw
// 的公式里都以肩宽为分母或基准，量纲被同比例放大，所以侧向必须整体放宽，否则同样
// 的实际偏移在侧向会被判得更严。dAngle 则是前伸的投影变短，也需要放宽。
// 下沉用整数百分比：设置面板只收整数，写成 0.045 保存一次就会被舍入成 0.05。
const CAMERA_PRESETS = {
  front: { dAngle: 6, dTilt: 4, dDrop: 0.05, dYaw: 0.15 },
  left45: { dAngle: 8, dTilt: 7, dDrop: 0.06, dYaw: 0.21 },
  right45: { dAngle: 8, dTilt: 7, dDrop: 0.06, dYaw: 0.21 },
};

// 机位名的译文在字典里，渲染进程按 key 自己取
const CAMERA_KEYS = Object.keys(CAMERA_PRESETS);

const DEFAULTS = {
  // null = 还没选过，首次运行按系统语言定一次；用户选了之后就以文件里的为准
  language: null,
  autoLaunch: false,
  persistBaseline: false,
  schedule: { weekdaysOnly: true, segments: [[540, 720], [840, 1080]] },
  // 默认机位为正前方，阈值必须与之匹配，否则"默认正前方"只是个标签
  thresholds: { dAngle: 6, dTilt: 4, dDrop: 0.05, dYaw: 0.15, holdMs: 3500, cooldownMs: 20000 },
  camera: 'front',
  cameraAsked: false,
  sit: { enabled: true, minutes: 45 },
  // 'auto' = 最大的一块屏。多屏时首次运行会引导选一次，之后可随时改。
  overlayDisplay: 'auto',
  // 提醒卡片背景的不透明度。0.6 是"能看清桌面、字也还压得住"的折中值
  overlayOpacity: 0.6,
  displayAsked: false,
  baseline: null,
};

let mainWin = null;
let overlayWin = null;
let tray = null;
let server = null;
let port = 0;
let workActive = null;
let isQuitting = false;
let settings = null;

// 主进程异常不该让程序无声消失——记到 userData/error.log 里，便于事后查。
function logCrash(e) {
  try {
    const dir = app.isReady() ? app.getPath('userData') : ROOT;
    fs.appendFileSync(path.join(dir, 'error.log'), `[${new Date().toISOString()}] ${e?.stack || e}\n`);
  } catch { /* 日志失败也要让程序活下去 */ }
}
process.on('uncaughtException', logCrash);
process.on('unhandledRejection', logCrash);

// 配置存在 userData 下，与代码目录分开，升级/移动项目不会丢
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// 逐层合并，让新增的配置项在旧文件上也能拿到默认值
function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function loadSettings() {
  let disk = null;
  try { disk = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* 首次运行没有文件 */ }
  settings = deepMerge(DEFAULTS, disk || {});
  // 语言只推断这一次：用户在下拉框里选过之后，就再也不看系统语言了
  if (!LANGS.includes(settings.language)) settings.language = detectLanguage();
  // 文件可能被手工改坏，越界的透明度会让卡片要么全透明要么挡死
  settings.overlayOpacity = clampOpacity(settings.overlayOpacity, 0.6);
  if (!disk) saveSettings(); // 首次运行落盘，方便直接查看和手工修改
  return settings;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) {
    logCrash(e);
  }
}

function applyAutoLaunch(on) {
  try {
    // 便携版每次运行都会解压到临时目录，process.execPath 指向那个随时会被清掉的副本，
    // 拿它注册登录项等于开机启动直接失效。PORTABLE_EXECUTABLE_FILE 才是原始 exe 的位置。
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({
      openAtLogin: !!on,
      path: target,
      args: app.isPackaged ? [] : [ROOT],
    });
  } catch (e) {
    logCrash(e);
  }
}

function inWorkWindow(d = new Date()) {
  if (!settings) return false;
  const day = d.getDay();
  if ((day === 0 || day === 6) && settings.schedule.weekdaysOnly) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  return settings.schedule.segments.some(([s, e]) => m >= s && m < e);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// MediaPipe 会创建 Worker 并加载 wasm，file:// 与自定义协议都容易踩坑。
// 起一个只监听 127.0.0.1 的静态服务，让渲染进程像普通网页一样工作。
function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 820,
    minHeight: 560,
    title: t('app.name'),
    backgroundColor: '#F7F7F5',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 关窗后窗口只是隐藏，检测要继续跑。默认的后台节流会把 250ms 定时器降到 1s，
      // 甚至暂停 video 解码，导致"看似运行中、实际不判定"。
      backgroundThrottling: false,
    },
  });
  mainWin.loadURL(`http://127.0.0.1:${port}/src/ui/monitor.html`);
  // 关闭窗口只收进托盘：检测要继续跑，误点 X 不该让程序整个消失。
  mainWin.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    mainWin.hide();
    if (tray) {
      tray.displayBalloon?.({
        title: t('tray.hiddenTitle'),
        content: t('tray.hiddenContent'),
      });
    }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

// 优先用用户选定的屏；那块屏不在了就退回"最大的一块"，避免拔掉显示器后遮罩跑到看不见的地方
function targetDisplay() {
  const all = screen.getAllDisplays();
  const want = settings?.overlayDisplay;
  if (want && want !== 'auto') {
    const hit = all.find((d) => String(d.id) === String(want));
    if (hit) return hit;
  }
  return all.reduce((a, b) =>
    b.workArea.width * b.workArea.height > a.workArea.width * a.workArea.height ? b : a);
}

function createOverlayWindow() {
  const W = 620, H = 280;
  overlayWin = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWin.loadURL(`http://127.0.0.1:${port}/src/ui/overlay.html`);
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.on('closed', () => { overlayWin = null; });
}

function placeOverlay() {
  if (!overlayWin) return;
  const { workArea } = targetDisplay();
  const [w, h] = overlayWin.getSize();
  overlayWin.setBounds({
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + (workArea.height - h) / 2),
    width: w,
    height: h,
  });
}

// Windows 的"总在最前"是一个层（topmost band），同层内谁最后被 SetWindowPos 谁在最前。
// 遮罩窗是 focusable:false，永远不会被"激活"，所以任何全屏前台程序（远程桌面 mstsc 最大化、
// 视频全屏、游戏）一抢焦点就把它压到下面——只在创建时设一次 AlwaysOnTop 根本不够。
// 每次显示都重新声明一遍，才能把它顶回该层最前面。
function raiseOverlay() {
  // moveTop() 在 Windows 上会把**已隐藏**的窗口重新显示出来（实测 isVisible 从 false 变 true）。
  // 不挡这一下的话，overlay:show 里延迟 150/400ms 的那两次抬高会在卡片被收起后把它复活：
  // 渲染进程以为已经收过、不会再发 overlay:hide，卡片就永久停在屏幕上，只能重启。
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.moveTop();
}

let overlayKeeper = null;
let overlayTimers = [];
let overlayShownAt = 0;

// 显示期间挂的异步任务全部登记，hide 时一次性取消。
// 连"预览的 1.8 秒收起"和"主进程兜底"一起管：真卡片弹出时别被预览的定时器误收，
// 卡片收起时别让任何残留回调再把窗口拉回来。
function scheduleOverlay(fn, ms) {
  overlayTimers.push(setTimeout(fn, ms));
}

function clearOverlayTimers() {
  for (const id of overlayTimers) clearTimeout(id);
  overlayTimers = [];
}

// 卡片显隐是唯一"用户看得见、事后却查不到"的事件。界面里那 4 行日志退出就没了，
// 落盘一行才能回答"到底弹没弹、什么时候收的"。
function logOverlay(action, detail = '') {
  try {
    const file = path.join(app.getPath('userData'), 'overlay-events.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 200 * 1024) {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').slice(-300).join('\n'));
    }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${action} ${detail}\n`);
  } catch { /* 记不上日志也不能影响提醒本身 */ }
}

// 卡片收起的唯一出口。hide 之后不允许任何残留的异步任务再把窗口显示出来。
function hideOverlay(reason) {
  clearOverlayTimers();
  stopOverlayKeeper();
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
  logOverlay('hide', `${reason} shown=${overlayShownAt ? Date.now() - overlayShownAt : 0}ms`);
  overlayShownAt = 0;
}

// 最后防线放在主进程：它持有窗口对象，不依赖渲染进程的 setTimeout 和 IPC。
// 渲染进程自己会在 30s(姿势)/20s(久坐) 收卡，正常情况下这个 35s 永远轮不上。
const OVERLAY_HARD_LIMIT_MS = 35 * 1000;

// 只顶一次不够：mstsc 会在自己激活的瞬间插到上面。卡片显示期间定期抬高一次，
// SetWindowPos 的开销可以忽略，而 1 秒的延迟就足以让提醒被整个错过。
function startOverlayKeeper() {
  if (overlayKeeper) return;
  overlayKeeper = setInterval(() => {
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) raiseOverlay();
    else stopOverlayKeeper();
  }, 2000);
}

function stopOverlayKeeper() {
  if (!overlayKeeper) return;
  clearInterval(overlayKeeper);
  overlayKeeper = null;
}

function makeTrayIcon() {
  const S = 16;
  const buf = Buffer.alloc(S * S * 4); // BGRA
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - 7.5, dy = y - 7.5;
      const outer = dx * dx + dy * dy <= 49;
      const inner = dx * dx + dy * dy <= 12;
      const i = (y * S + x) * 4;
      if (outer && !inner) {
        buf[i] = 86; buf[i + 1] = 110; buf[i + 2] = 15; buf[i + 3] = 255; // #0F6E56
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

function showMainWindow() {
  if (mainWin) { mainWin.show(); mainWin.focus(); } else createMainWindow();
}

// 菜单和 tooltip 都是语言的函数，切语言时整个重刷一遍即可
function applyTrayMenu() {
  if (!tray) return;
  tray.setToolTip(t('tray.tooltip'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('tray.show'), click: showMainWindow },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => app.quit() },
  ]));
}

function createTray() {
  try {
    tray = new Tray(makeTrayIcon());
    applyTrayMenu();
    tray.on('click', () => { if (mainWin) { mainWin.isVisible() ? mainWin.hide() : mainWin.show(); } });
  } catch (e) {
    console.warn('托盘不可用：', e.message);
  }
}

function pushWorkState(force = false) {
  const v = inWorkWindow();
  if (!force && v === workActive) return;
  workActive = v;
  if (mainWin) mainWin.webContents.send('worktime', v);
}

// 开会、共享屏幕时一键静默，不必先切回窗口点暂停。
// Ctrl+Alt+P 在不少机器上已被占用，所以按顺序挑一个能注册成功的，并把结果告诉界面。
const HOTKEYS = [
  'CommandOrControl+Alt+Shift+P',
  'CommandOrControl+Alt+K',
  'CommandOrControl+Shift+F9',
];
let activeHotkey = null;

function registerHotkey() {
  for (const acc of HOTKEYS) {
    try {
      const ok = globalShortcut.register(acc, () => {
        if (mainWin) mainWin.webContents.send('hotkey:pause');
      });
      if (ok) {
        activeHotkey = acc;
        return;
      }
    } catch (e) {
      logCrash(e);
    }
  }
  activeHotkey = null;
  console.warn('全局快捷键全部注册失败，只能用窗口里的「暂停」按钮');
}

function init() {
  loadSettings();
  applyAutoLaunch(settings.autoLaunch);

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });

  startServer().then((p) => {
    port = p;
    createMainWindow();
    createOverlayWindow();
    createTray();
    registerHotkey();

    pushWorkState();
    setInterval(pushWorkState, 30 * 1000);

    mainWin.webContents.on('did-finish-load', () => {
      mainWin.webContents.send('worktime', inWorkWindow());
      mainWin.show();
      mainWin.focus();
    });
  }).catch((e) => {
    console.error('本地服务启动失败：', e);
    app.quit();
  });
}

ipcMain.handle('worktime:get', () => inWorkWindow());

const settingsView = () => ({ ...settings, activeHotkey, cameraKeys: CAMERA_KEYS });

ipcMain.handle('settings:get', () => settingsView());

ipcMain.handle('settings:save', (_e, patch) => {
  const prevCamera = settings.camera;
  const prevLang = settings.language;
  settings = deepMerge(settings, patch);

  // 切换机位时要做两件事：把四项与该机位强相关的阈值重置为推荐值；
  // 以及作废已有基线——换机位意味着摄像头位置变了，旧的 shY 参照系直接失效。
  if (settings.camera !== prevCamera) {
    const p = CAMERA_PRESETS[settings.camera] || CAMERA_PRESETS.right45;
    settings.thresholds = {
      ...settings.thresholds,
      dAngle: p.dAngle,
      dTilt: p.dTilt,
      dDrop: p.dDrop,
      dYaw: p.dYaw,
    };
    settings.baseline = null;
  }

  if (!LANGS.includes(settings.language)) settings.language = prevLang;
  settings.overlayOpacity = clampOpacity(settings.overlayOpacity, 0.6);

  saveSettings();
  applyAutoLaunch(settings.autoLaunch);
  // 托盘和窗口标题不归渲染进程管，语言一变要在这里补一刀
  if (settings.language !== prevLang) {
    applyTrayMenu();
    if (mainWin) mainWin.setTitle(t('app.name'));
  }
  pushWorkState(true); // 时段可能被改了，立即广播一次
  return settingsView();
});

ipcMain.handle('baseline:save', (_e, base) => {
  settings.baseline = base;
  saveSettings();
  return true;
});

ipcMain.handle('baseline:clear', () => {
  settings.baseline = null;
  saveSettings();
  return true;
});

ipcMain.on('overlay:show', (_e, payload) => {
  if (!overlayWin) return;
  // 上一张卡片或预览遗留的异步任务一律作废，尤其是那个"1.8 秒后收起预览"
  clearOverlayTimers();
  placeOverlay();
  // 透明度由主进程盖章，渲染进程传什么都不算数，避免两处各存一份设置
  overlayWin.webContents.send('overlay:content', { ...payload, opacity: settings.overlayOpacity });
  overlayWin.showInactive();
  overlayShownAt = Date.now();
  logOverlay('show', String(payload?.title || ''));
  // 依次抬高几次：mstsc 之类的全屏窗口会在自己激活后插到 topmost 前面，
  // 一次 SetWindowPos 顶不住，等它稳定后再补两下。
  raiseOverlay();
  scheduleOverlay(raiseOverlay, 150);
  scheduleOverlay(raiseOverlay, 400);
  // 渲染进程失联（定时器被节流、IPC 丢失、判定态卡死）时，主进程到点也要把屏幕清空
  scheduleOverlay(() => hideOverlay('main-timeout'), OVERLAY_HARD_LIMIT_MS);
  startOverlayKeeper();
});

// 透明度只有一个合法区间：低于 0.4 字就和背后的桌面文字糊成一片（实测 40% 已是下限），
// 高于 0.9 等于回到原来那张实心卡片
function clampOpacity(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(0.9, Math.max(0.4, n)) : fallback;
}

// 让用户在真实位置"看"到卡片，比从下拉框里选"显示器 1/2"可靠得多
ipcMain.on('overlay:preview', (_e, opacity) => {
  if (!overlayWin) return;
  clearOverlayTimers();
  const d = targetDisplay();
  placeOverlay();
  overlayWin.webContents.send('overlay:content', {
    title: t('overlay.previewTitle'),
    body: t('overlay.previewBody', { w: d.size.width, h: d.size.height }),
    meta: t('overlay.meta'),
    // 预览用滑杆上的临时值，不必先保存也能看出效果
    opacity: clampOpacity(opacity, settings.overlayOpacity),
  });
  overlayWin.showInactive();
  overlayShownAt = Date.now();
  logOverlay('preview', '');
  raiseOverlay();
  scheduleOverlay(raiseOverlay, 150);
  scheduleOverlay(() => hideOverlay('preview-timeout'), 1800);
  startOverlayKeeper();
});

// 只给结构化数据，显示名由渲染进程按当前语言拼——「显示器 1」不该写死在这里
ipcMain.handle('displays:list', () => {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    index: i + 1,
    width: d.size.width,
    height: d.size.height,
    primary: d.id === primary,
  }));
});

ipcMain.handle('app:info', () => {
  const donate = APP_INFO.donate || {};
  // 只有仓库里真的放了二维码图才显示那一栏，否则界面会挂个破图
  const qr = donate.qrImage && fs.existsSync(path.join(ROOT, donate.qrImage)) ? donate.qrImage : null;
  return {
    version: app.getVersion(),
    repo: APP_INFO.repo || '',
    issues: APP_INFO.issues || '',
    donate: { qr, afdian: donate.afdian || '', sponsors: donate.sponsors || '' },
  };
});

// 只放行 https。file:、javascript:、自定义 app 协议一律不转出去——
// 这些地址一旦来自被改过的配置，就等于给外部程序开了个口子。
ipcMain.handle('shell:open', (_e, url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:') return false;
    shell.openExternal(u.toString());
    return true;
  } catch {
    return false;
  }
});

ipcMain.on('overlay:hide', () => {
  hideOverlay('renderer');
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) { mainWin.show(); mainWin.focus(); }
  });
  app.whenReady().then(init);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    if (server) server.close();
  });
}
