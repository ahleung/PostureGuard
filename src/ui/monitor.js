import { FilesetResolver, PoseLandmarker } from '../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';
import { neckAngle, shoulderTilt, shoulderFrame, headYaw, trusted, median } from '../core/geometry.js';
import { PostureJudge } from '../core/judge.js';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const canvas = $('skel');
const ctx = canvas.getContext('2d');

const TICK_MS = 250;          // 4 FPS：姿势是慢变量，不必占满帧率
const CALIB_FRAMES = 20;      // 标定采集 5 秒
const SMOOTH_N = 9;           // 中值滤波窗口，压制单帧关键点抖动
const BASE_KEYS = ['angle', 'tilt', 'shY', 'shW', 'yaw'];
// 站起来时肩中点会明显高于标定基线（画面 y 轴向下，所以这个差是负值）。
// 按标定时的肩宽归一后，"坐着"和"站着"差着好几倍，是"还在不在座位上"最直接的判据。
// -0.3 ≈ 肩中点抬高 12cm 以上才算离座；坐着时的正常起伏不到 0.05。
const SEAT_DROP_MIN = -0.3;
// 连续这么久不在座位，就不再判姿势：作废 badMs、收起卡片。2 秒是"人还在不在"的确认窗口。
const AWAY_MS = 2000;
// 离开这么久才算一次真正的休息，久坐计时才清零——和上面那个不是一回事。
// 不能太小：45 分钟的"连续"里只要出现一次 2 秒的检测中断（够东西、低头、转身），
// 计数就被打回 0，提醒永远攒不满。0.3.9 把两者都设成 2 秒，真机就是"45 分钟从没提醒过"。
// 15 秒分界：低头、被挡一下都在 5 秒内，不会误清；起身倒水/离开座位一般超过 15 秒，
// 回来就该从 0 起。0.3.10/0.3.11 曾用 60 秒，真机上"出去一趟回来没重置"被当成 bug。
// 仿真复核：45 分钟里每 8 分钟遮挡 3 秒仍准时弹 1 次（sim.mjs F 场景）。
const SIT_BREAK_MS = 15 * 1000;
// 姿势卡片正常靠"坐正 3 秒"收起，但那条路依赖 judge.shown 一直为真。
// 判定态被外部清掉（离座确认、改机位作废基线、重新标定）后就再也没人产出 release，
// 卡片会永久停在屏幕上，只能退出程序才消失。给个上限兜底：再怎么样也不会常驻挡屏。
const POSTURE_MAX_MS = 30 * 1000;
// 基线超过这个时间就作废：换过桌椅、调过显示器、身体状态变了，旧基线会悄悄失准
const BASELINE_MAX_MS = 7 * 24 * 3600 * 1000;

let sitLimit = 45 * 60 * 1000; // 由设置覆盖
let cfg = null;
let userPaused = false;
let displayList = [];
let appInfo = null;

const judge = new PostureJudge();

let landmarker = null;
let running = false;
let forceRun = false;
let timer = null;
let lastTs = 0;
let calibBuf = null;
let angle = null;
let tilt = 0;
let shY = 0;
let yaw = 0;
let rawBuf = [];
let tiltBuf = [];
let shBuf = [];
let yawBuf = [];
let sitMs = 0;          // 只累加"确实坐在座位上"的时长，离座就停表
let awaySince = 0;      // 这一轮离座从什么时候开始，0 表示在座
let standFired = false;
let overlayOpen = false;
let overlayKind = null;    // 'posture' | 'sit' | null：屏幕上这张卡片是哪一类
let overlayTimer = null;
let lastVideoTime = -1;
let stallSince = 0;
let detectFails = 0;

// ---------------- 语言 ----------------

// 中英字典一次性都取回来（两份 JSON 加起来不到 40KB），切语言就是换个引用，不必重载页面
const DICTS = {};
let LANG = 'zh';

function translate(dict, key, vars) {
  let s = key.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : null), dict);
  if (typeof s !== 'string') return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
  return s;
}

// 缺键回退中文：新加的键还没翻译时显示中文，也好过界面里冒出 "status.foo"
function t(key, vars) {
  const primary = translate(DICTS[LANG], key, vars);
  return primary === key ? translate(DICTS.zh, key, vars) : primary;
}

const CAMERA_I18N = { front: 'set.cameraFront', left45: 'set.cameraLeft45', right45: 'set.cameraRight45' };
const cameraName = (k) => (CAMERA_I18N[k] ? t(CAMERA_I18N[k]) : (k || t('set.unknown')));

async function loadDicts() {
  const [zh, en] = await Promise.all([
    fetch('/src/i18n/zh.json').then((r) => r.json()),
    fetch('/src/i18n/en.json').then((r) => r.json()),
  ]);
  DICTS.zh = zh;
  DICTS.en = en;
}

// 静态文案靠 data-i18n 批量替换；动态文案由各自的渲染函数在下一次 tick 时自然跟上
function applyLang(lang) {
  LANG = DICTS[lang] ? lang : 'zh';
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  // 英文标签更长，布局要相应放宽，这里只负责打标记，具体规则在 style.css
  document.body.dataset.lang = LANG;
  document.title = t('app.name');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  setState(stateKey, stateKind, stateVars);
  // 提示层的内容是动态的，但它的容器带 data-i18n，刚被上面的批量替换冲掉，这里补回来
  if (hintSpec) showHint(hintSpec, hintOnClick);
  if (cfg) {
    applySettings(cfg);
    refreshSettingsText();
  }
  // 没在跑的时候读数不会自己重画，切语言后「0 分」这类带单位的旧值会留在界面上
  if (!running) idlePaint(sitMs);
  tickClock();
}

// 设置面板里会随语言变化、但不该动用户已改动的输入框的那几处
function refreshSettingsText() {
  if (!cfg) return;
  fillDisplayOptions($('s-display').value);
  updateBaselineNote(cfg);
  // 首次引导的说明要在用户确认之前一直保留，确认过之后回到通用说明
  $('camera-note').textContent = cfg.cameraAsked
    ? t('set.cameraNote')
    : t('set.cameraGuide', { cur: cameraName(cfg.camera) });
  $('display-note').textContent = (cfg.displayAsked || displayList.length < 2)
    ? t('set.displayNote')
    : t('set.displayGuide');
  updatePresetHint();
}

// ---------------- 提醒卡片 ----------------

// 两类卡片都自带超时：姿势卡片正常靠"坐正 3 秒"提前收，久坐卡片 20 秒后自动收。
// 不能只给久坐卡片设定时器——第二次 openOverlay 会 clearTimeout 掉前一个，
// 叠加出来的姿势卡片就既没超时、又不一定等得到 release（真机"弹窗不消失"）。
function openOverlay(payload, kind, autoHideMs) {
  window.api.showOverlay(payload);
  overlayKind = kind;
  overlayOpen = true;
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(closeOverlay, autoHideMs);
}

function closeOverlay() {
  if (overlayOpen) {
    window.api.hideOverlay();
    overlayOpen = false;
  }
  overlayKind = null;
  clearTimeout(overlayTimer);
  overlayTimer = null;
  // 卡片收了，判定器的"正在提醒"也必须结束：shown 挂着 true 时 update() 不再产生
  // trigger，表现就是"之后再也不弹窗"。按 judge.shown 判断而非 overlayOpen——
  // 画面里没人时这里每帧都会走到，无条件清 badMs 会把正在累积的判定打断。
  if (judge.shown) judge.clearVerdict();
}

// ---------------- 顶部状态 ----------------

let stateKey = 'status.waiting';
let stateKind = '';
let stateVars = null;

function setState(key, kind, vars) {
  stateKey = key;
  stateKind = kind || '';
  stateVars = vars || null;
  $('state').textContent = t(stateKey, stateVars);
  $('dot').className = 'dot' + (stateKind ? ' ' + stateKind : '');
}

function log(msg) {
  const li = document.createElement('li');
  const time = new Date().toTimeString().slice(0, 8);
  li.textContent = `${time}  ${msg}`;
  const box = $('log');
  box.prepend(li);
  while (box.children.length > 4) box.lastChild.remove();
}

// spec: {title, text, btn} 三个都是字典键，每次调用现取，
// 这样语言切完不用通知任何人，下一帧自然就换成新语言了
let hintSpec = null;
let hintOnClick = null;

function showHint(spec, onClick) {
  hintSpec = spec;
  hintOnClick = onClick || null;
  $('hint').classList.remove('hidden');
  $('hint').querySelector('strong').textContent = t(spec.title, spec.vars);
  $('hint-text').textContent = t(spec.text, spec.vars);
  const btn = $('hint-btn');
  if (spec.btn) {
    btn.style.display = '';
    btn.textContent = t(spec.btn);
    btn.onclick = onClick;
  } else {
    btn.style.display = 'none';
    btn.onclick = null;
  }
}

function hideHint() {
  hintSpec = null;
  hintOnClick = null;
  $('hint').classList.add('hidden');
}

// ---------------- 摄像头与模型 ----------------

async function loadModel() {
  if (landmarker) return;
  const vision = await FilesetResolver.forVisionTasks('/node_modules/@mediapipe/tasks-vision/wasm');
  const buf = new Uint8Array(await (await fetch('/models/pose_landmarker_lite.task')).arrayBuffer());
  const base = {
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetBuffer: buf, delegate: 'GPU' },
      ...base,
    });
    log(t('log.modelGpu'));
  } catch {
    landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetBuffer: buf, delegate: 'CPU' },
      ...base,
    });
    log(t('log.modelCpu'));
  }
}

// 14:00 整点自动启动时，电脑常刚从休眠醒来，摄像头设备还没就绪，第一次 getUserMedia 会失败。
// 所以先按间隔重试；若默认设备本身坏了，再逐个设备试一遍。
async function openCamera() {
  const base = { width: 640, height: 480, frameRate: 15 };
  const attempt = async (videoConstraints, who) => {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    } catch (e) {
      log(t('log.camFail', { who, err: e.name || e.message }));
      return null;
    }
  };

  for (let i = 0; i < 3; i++) {
    const s = await attempt(base, t('log.camRetry', { i: i + 1 }));
    if (s) return s;
    if (i < 2) await new Promise((r) => setTimeout(r, 1500));
  }

  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  log(t('log.camEnum', { n: cams.length }));
  for (const cam of cams) {
    const s = await attempt({ ...base, deviceId: { exact: cam.deviceId } }, cam.label || t('log.camUnnamed'));
    if (s) {
      log(t('log.camPicked', { name: cam.label || cam.deviceId.slice(0, 8) }));
      return s;
    }
  }
  throw new Error(t('log.camAllFail'));
}

// 摄像头流可能被拔掉、被别的程序抢走，或系统休眠后没恢复。
// 不主动检查的话，loop 会一直拿最后一帧反复判定，界面显示"运行中"却什么都没在看。
function handleStall() {
  if (!running) return;
  log(t('log.camStall'));
  stop();
  setState('status.camLost', 'warn');
  showHint({ title: 'hint.camLostTitle', text: 'hint.camLostText', btn: 'btn.reconnect' }, () => {
    hideHint();
    start();
  });
}

async function start() {
  if (running) return;
  showHint({ title: 'hint.startingTitle', text: 'hint.initText' });
  try {
    const stream = await openCamera();
    video.srcObject = stream;
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', () => { if (running) handleStall(); });
    });
    await video.play().catch(() => {});
    await loadModel();
  } catch (e) {
    const err = `${e.name || ''} ${e.message || e}`.trim();
    setState('status.startFail', 'warn');
    showHint({ title: 'hint.failTitle', text: 'hint.failText', btn: 'btn.resume', vars: { err } });
    log(t('log.startFail', { err }));
    return;
  }
  running = true;
  lastTs = 0;
  lastVideoTime = -1;
  stallSince = 0;
  angle = null;
  rawBuf = [];
  tiltBuf = [];
  shBuf = [];
  yawBuf = [];
  // 上一轮的坐时不能继承：跨时段停机、手动暂停之后，人早就起身过了
  sitMs = 0;
  awaySince = 0;
  standFired = false;
  hideHint();
  setState('status.running', 'on');
  setToggleLabel();
  log(t('log.started'));
  if (timer) clearInterval(timer);
  timer = setInterval(loop, TICK_MS);
}

function stop() {
  running = false;
  if (timer) { clearInterval(timer); timer = null; }
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setState('status.paused');
  setToggleLabel();
  closeOverlay();
  // 兜底：卡片也许早就被定时器收掉了（wasOpen 为 false），但判定态一样不能留。
  // 检测一停，这一轮提醒就算结束，恢复后必须从零开始，否则 shown 卡死后永远不再弹。
  judge.clearVerdict();
  log(t('log.stopped'));
}

function setToggleLabel() {
  $('toggle').textContent = t(running ? 'btn.pause' : 'btn.resume');
}

function draw(lm, bad) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!lm) return;
  const color = bad ? '#E24B4A' : '#5DCAA5';
  const links = [[7, 11], [8, 12], [11, 12], [11, 23], [12, 24], [23, 24]];
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, canvas.width / 400);
  ctx.beginPath();
  for (const [a, b] of links) {
    if (!lm[a] || !lm[b]) continue;
    ctx.moveTo(lm[a].x * canvas.width, lm[a].y * canvas.height);
    ctx.lineTo(lm[b].x * canvas.width, lm[b].y * canvas.height);
  }
  ctx.stroke();

  ctx.fillStyle = color;
  for (const i of [7, 8, 11, 12, 23, 24]) {
    if (!lm[i]) continue;
    ctx.beginPath();
    ctx.arc(lm[i].x * canvas.width, lm[i].y * canvas.height, Math.max(2.5, canvas.width / 160), 0, Math.PI * 2);
    ctx.fill();
  }
}

function bar(id, ratio, over) {
  const el = $(id);
  el.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
  el.className = over ? 'over' : '';
}

function paint(m, dev, sitMs) {
  const c = judge.cfg;
  $('v-angle').textContent = m.angle.toFixed(1) + '°';
  $('v-tilt').textContent = (m.tilt >= 0 ? '+' : '') + m.tilt.toFixed(1) + '°';
  $('v-drop').textContent = (dev ? dev.drop * 100 : 0).toFixed(1) + '%';
  $('v-hold').textContent = (judge.badMs / 1000).toFixed(1) + 's';
  $('v-sit').textContent = t('metric.sitValue', { n: Math.floor(sitMs / 60000) });
  if (judge.ready) {
    $('f-angle').textContent = t('metric.baseAngle', { base: judge.base.angle.toFixed(1), thr: c.dAngle });
    $('f-tilt').textContent = t('metric.baseTilt', { base: judge.base.tilt.toFixed(1), thr: c.dTilt });
    $('f-drop').textContent = t('metric.dropFoot', { thr: Math.round(c.dDrop * 100) });
  }
  bar('b-angle', dev == null ? 0 : dev.angle / c.dAngle, dev != null && dev.angle > c.dAngle);
  bar('b-tilt', dev == null ? 0 : Math.abs(dev.tilt) / c.dTilt, dev != null && Math.abs(dev.tilt) > c.dTilt);
  bar('b-drop', dev == null ? 0 : dev.drop / c.dDrop, dev != null && dev.drop > c.dDrop);
  bar('b-hold', judge.badMs / c.holdMs, judge.badMs >= c.holdMs);
  bar('b-sit', sitMs / sitLimit, sitMs >= sitLimit);
}

// 画面里没人时不保留上一次的陈旧读数，否则会被误读成"现在测的是这样"。
// 久坐读数例外：短暂离座期间它停在原处，不该先跳成 0 再跳回来。
function idlePaint(sit = 0) {
  $('v-angle').textContent = '--';
  $('v-tilt').textContent = '--';
  $('v-drop').textContent = '--';
  $('v-sit').textContent = t('metric.sitValue', { n: Math.floor(sit / 60000) });
  bar('b-angle', 0, false);
  bar('b-tilt', 0, false);
  bar('b-drop', 0, false);
  bar('b-sit', sit / sitLimit, false);
}

// 盖在画面上的提示由当前状态驱动：待标定 / 倒计时 / 没人 / 完成即收起。
// 每帧调用，DOM 操作成本可忽略，省掉一套状态同步。
function syncHint(personVisible) {
  if (calibBuf) {
    const left = Math.ceil((CALIB_FRAMES - calibBuf.length) * TICK_MS / 1000);
    showHint({ title: 'hint.keepTitle', text: 'hint.keepText', btn: 'btn.cancelCalib', vars: { n: left } }, cancelCalib);
    return;
  }
  if (judge.ready) {
    hideHint();
    return;
  }
  if (personVisible) {
    showHint({ title: 'hint.needCalibTitle', text: 'hint.needCalibText', btn: 'btn.startCalib' }, startCalib);
  } else {
    showHint({ title: 'hint.noPersonTitle', text: 'hint.noPersonText' });
  }
}

function startCalib() {
  if (!running) { log(t('log.needStart')); return; }
  // 重新开始标定；顺带清掉中值滤波窗口，否则前几帧会混进标定前的姿态
  calibBuf = [];
  rawBuf = [];
  tiltBuf = [];
  shBuf = [];
  yawBuf = [];
  log(t('log.calibStart'));
}

function cancelCalib() {
  if (!calibBuf) return;
  calibBuf = null;
  log(t('log.calibCancel'));
}

// 状态栏必须随时说明"为什么还没提示"，否则用户只会觉得程序没反应。
// 冷却期必须说清楚：明明在偏离却因为冷却不弹，比不显示更让人困惑。
function describe(now, r) {
  if (!judge.ready) return ['status.needCalib'];
  if (judge.shown) return ['status.bad', 'bad'];
  if (r && r.turned) return ['status.turned', 'warn'];
  if (judge.badMs > 500) {
    const sec = (judge.badMs / 1000).toFixed(1);
    return now < judge.coolUntil
      ? ['status.deviatingCool', 'warn', { s: sec }]
      : ['status.deviating', 'warn', { s: sec }];
  }
  return ['status.good', 'on'];
}

function loop() {
  if (!running || !video.videoWidth) return;
  const now = performance.now();
  const dt = lastTs ? Math.min(now - lastTs, 2000) : 0;
  lastTs = now;

  // 帧时间戳不再前进 = 流断了。宽容 5 秒，避免偶发卡顿就报警。
  if (video.currentTime === lastVideoTime) {
    if (!stallSince) {
      stallSince = now;
    } else if (now - stallSince > 5000) {
      handleStall();
      return;
    }
  } else {
    lastVideoTime = video.currentTime;
    stallSince = 0;
  }

  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const aspect = video.videoWidth / video.videoHeight;

  let res;
  try {
    res = landmarker.detectForVideo(video, now);
    detectFails = 0;
  } catch (e) {
    // 偶发单帧失败很常见，连续失败才说明推理管线坏了（GPU 上下文丢失、驱动重置等）。
    // 这种时候画面时间戳还在正常前进，上面的 stall 检测抓不到——不处理就成了
    // "界面显示运行中，其实一帧都没在判定"，和用户看到的"不弹窗"一模一样。
    if (++detectFails >= 12) { // 4 FPS × 3 秒
      detectFails = 0;
      log(t('log.inferFail', { err: e?.message || e }));
      landmarker = null; // 丢掉坏实例，重连时 loadModel 会重建
      handleStall();
    }
    return;
  }

  const lm = res.landmarks?.[0];

  if (!trusted(lm)) {
    leaveSeat(now, 'status.noPerson');
    return;
  }

  // 人在画面里 ≠ 坐在座位上：站起来时肩中点会明显高于标定基线。
  // 这里刻意用**当前帧**的肩中点、不用中值滤波后的值——滤波窗口 9 帧要 1 秒多才跟上，
  // 起身 5 秒会被吃掉 1 秒多，久坐计时就总也够不到清零门槛（真机实测卡在这）。
  // 单帧噪声交给 leaveSeat 里那 2 秒的防抖吸收。
  const sf = shoulderFrame(lm, aspect);
  const dropNow = judge.base ? (sf.y - judge.base.shY) / Math.max(judge.base.shW, 0.1) : 0;
  if (judge.base && dropNow < SEAT_DROP_MIN) {
    leaveSeat(now, 'status.leftSeat', dropNow);
    return;
  }
  if (awaySince) sitEvent('return', { awayMs: now - awaySince, reason: 'inSeat' });
  awaySince = 0;

  const raw = neckAngle(lm, aspect);
  rawBuf.push(raw);
  if (rawBuf.length > SMOOTH_N) rawBuf.shift();
  tiltBuf.push(shoulderTilt(lm, aspect));
  if (tiltBuf.length > SMOOTH_N) tiltBuf.shift();
  shBuf.push(sf.y);
  if (shBuf.length > SMOOTH_N) shBuf.shift();
  yawBuf.push(headYaw(lm));
  if (yawBuf.length > SMOOTH_N) yawBuf.shift();
  angle = median(rawBuf);
  tilt = median(tiltBuf);
  shY = median(shBuf);
  yaw = median(yawBuf);

  if (calibBuf) {
    calibBuf.push({ angle, tilt, shY, shW: sf.width, yaw });
    if (calibBuf.length >= CALIB_FRAMES) {
      const base = judge.calibrate(calibBuf, { camera: cfg?.camera ?? null, capturedAt: Date.now() });
      calibBuf = null;
      if (cfg?.persistBaseline) {
        window.api.saveBaseline(base)
          .then(() => log(t('log.calibSaved')))
          .catch(() => log(t('log.calibSaveFail')));
      }
      log(t('log.calibDone', { a: base.angle.toFixed(1), b: base.tilt.toFixed(1) }));
    }
  }

  const r = judge.update({ angle, tilt, shY, yaw }, dt, now);
  updateSit(dt);
  draw(lm, r.bad);
  paint({ angle, tilt, shY }, r.dev, sitMs);

  if (r.trigger) {
    const whyKeys = [];
    const tipKeys = [];
    if (r.badNeck) { whyKeys.push('overlay.whyNeck'); tipKeys.push('overlay.tipNeck'); }
    if (r.badTilt) { whyKeys.push('overlay.whyTilt'); tipKeys.push('overlay.tipTilt'); }
    if (r.badDrop) { whyKeys.push('overlay.whyDrop'); tipKeys.push('overlay.tipDrop'); }
    const why = whyKeys.map((k) => t(k)).join(t('overlay.sep'));
    const tips = tipKeys.map((k) => t(k)).join(t('overlay.sep'));
    openOverlay({
      title: t('overlay.postureTitle'),
      body: t('overlay.postureBody', { why, tips }),
      meta: t('overlay.meta'),
    }, 'posture', POSTURE_MAX_MS);
    log(t('log.remind', { why }));
  }
  if (r.release) {
    closeOverlay();
    log(t('log.recovered'));
  } else if (overlayKind === 'posture' && !judge.shown) {
    // 判定态被外部清掉（离座确认、改机位作废基线、重新标定）时，
    // update() 再也不会产出 release，姿势卡片就没人收了。这里强制对齐状态和屏幕。
    closeOverlay();
  }
  setState(...describe(now, r));
  syncHint(true);
}

// 久坐计时：只累加"确实坐在座位上"的时长。起身就停表；离开满 SIT_BREAK_MS 才算休息、进度清零。
// 旧版拿 sitStart 的差值当已坐时长，人一走开表就冻在旧值上、回来接着往下走，
// 看起来就是"离开座位了计时没停"；而只要还在画面里（哪怕已经站起来），它压根停不下来。
function updateSit(dt) {
  sitMs += dt;
  if (!standFired && sitMs > sitLimit) {
    standFired = true;
    const minutes = Math.round(sitLimit / 60000);
    openOverlay({
      title: t('overlay.sitTitle'),
      body: t('overlay.sitBody', { n: minutes }),
      meta: t('overlay.metaSit', { s: 20 }),
    }, 'sit', 20000);
    log(t('log.sitRemind', { n: minutes }));
  }
}

// 久坐事件落盘：只在状态切换时记一行，不逐帧刷（4 FPS × 长时间离座会刷屏）。
// drop 是当帧肩中点相对基线的偏移，真机用它判断 SEAT_DROP_MIN=-0.3 是不是太钝：
// 日志里根本没有 leave 行，就说明离座压根没被识别，调 SIT_BREAK_MS 也没用。
function sitEvent(action, fields = {}) {
  try {
    window.api.logSitEvent?.({
      action,
      awayMs: Math.round(fields.awayMs ?? 0),
      drop: fields.drop == null ? null : Number(fields.drop.toFixed(3)),
      sitMs: Math.round(fields.sitMs ?? sitMs),
      reason: fields.reason || '',
    });
  } catch { /* 记不上日志也不能影响判定 */ }
}

// 离座（人走出画面，或人还在画面里但站起来了）时的统一收尾。
function leaveSeat(now, statusKey, drop = null) {
  const starting = !awaySince;
  draw(null);
  setState(statusKey, 'warn');
  // 卡片立刻收起：人都不在座位上了，那张卡片留着只会被当成"还在判我"
  closeOverlay();
  // 标定中途走开就作废，否则缓冲区会混进两次落座的姿态
  if (calibBuf) {
    calibBuf = null;
    log(t('log.calibInterrupted'));
  }
  rawBuf = [];
  tiltBuf = [];
  shBuf = [];
  yawBuf = [];
  handleAway(now);
  if (starting) sitEvent('leave', { drop, reason: statusKey });
  idlePaint(sitMs);
  syncHint(false);
}

// 连续不在座位满 AWAY_MS 才收账：作废姿势累计（不作废的话，人回来坐下几秒就接着弹上次的提醒）。
// 久坐计时另算：离座期间它本来就不累加（updateSit 只在在座帧调用），这里只决定"进度要不要作废"。
// 卡片本身不在这里收——leaveSeat 一发现人不在座位上就收掉了。
function handleAway(now) {
  if (!awaySince) awaySince = now;
  const away = now - awaySince;
  if (away >= AWAY_MS) judge.clearVerdict();
  if (away >= SIT_BREAK_MS) {
    if (sitMs) {
      sitEvent('reset', { awayMs: away, reason: 'sitBreak' });
      log(t('log.sitReset'));
    }
    sitMs = 0;
    standFired = false;
  }
}

// 开会/共享屏幕时一键静默；手动暂停后不会被时段自动启动顶掉
function togglePause() {
  if (running) {
    userPaused = true;
    stop();
    log(t('log.manualPause', { key: hotkeyLabel() }));
  } else {
    userPaused = false;
    start();
  }
}

$('calib').addEventListener('click', startCalib);

$('toggle').addEventListener('click', togglePause);

window.api.onHotkey(togglePause);

function askForceRun() {
  showHint({ title: 'hint.offHoursTitle', text: 'hint.offHoursText', btn: 'btn.forceRun' }, () => {
    forceRun = true;
    hideHint();
    start();
  });
}

window.api.onWorkTime((v) => {
  if (!v && !forceRun && running) {
    stop();
    askForceRun();
  } else if (v && !running && !userPaused) {
    start();
  }
});

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString(LANG === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false });
}

setInterval(tickClock, 1000);

// ---------------- 设置 ----------------

const toHM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
const toMin = (v) => {
  const [h, m] = (v || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

const hotkeyLabel = () => (cfg?.activeHotkey ? cfg.activeHotkey.replace('CommandOrControl', 'Ctrl') : '');

function applySettings(s) {
  cfg = s;
  judge.cfg = { ...judge.cfg, ...s.thresholds };
  sitLimit = s.sit.enabled ? s.sit.minutes * 60000 : Infinity;
  // 顶部 chip：不用打开设置就能看到现在按什么标准在判定
  $('preset-chip').textContent = t('header.profile', {
    preset: presetName(detectPreset(s.thresholds)),
    camera: cameraName(s.camera),
  });
  $('f-hold').textContent = t('metric.holdFoot', { s: (judge.cfg.holdMs / 1000).toFixed(1) });
  $('f-sit').textContent = s.sit.enabled
    ? t('metric.sitFoot', { n: s.sit.minutes })
    : t('metric.sitOff');

  const key = hotkeyLabel();
  $('hotkey-note').textContent = key
    ? t('set.hotkeyNote', { key })
    : t('log.hotkeyFail');

  // 语言切换时这些读数不会重新走 paint，顺手补一遍
  if (judge.ready) {
    $('f-angle').textContent = t('metric.baseAngle', { base: judge.base.angle.toFixed(1), thr: judge.cfg.dAngle });
    $('f-tilt').textContent = t('metric.baseTilt', { base: judge.base.tilt.toFixed(1), thr: judge.cfg.dTilt });
    $('f-drop').textContent = t('metric.dropFoot', { thr: Math.round(judge.cfg.dDrop * 100) });
  }
}

// 基线只在"同一机位 + 未过期 + 字段完整"三个条件都满足时才恢复。
// 换机位意味着摄像头位置变了，shY 的参照系失效，drop 会算出无意义的正负值。
function restoreBaseline(s) {
  if (!s.persistBaseline || !s.baseline) return false;
  const b = s.baseline;

  if (!BASE_KEYS.every((k) => typeof b[k] === 'number')) {
    log(t('log.calibIncomplete'));
    return false;
  }
  if (b.camera !== s.camera) {
    log(t('log.calibCameraMismatch', { from: cameraName(b.camera), to: cameraName(s.camera) }));
    return false;
  }
  if (!b.capturedAt || Date.now() - b.capturedAt > BASELINE_MAX_MS) {
    log(t('log.calibExpired'));
    return false;
  }

  judge.base = { ...b };
  judge.shown = false;
  judge.badMs = 0;
  judge.goodMs = 0;
  judge.goodRun = 0;
  log(t('log.baselineLoaded'));
  return true;
}

function fillDisplayOptions(value) {
  const sel = $('s-display');
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = t('set.displayAuto');
  sel.appendChild(auto);
  displayList.forEach((d) => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = t('display.item', { i: d.index, w: d.width, h: d.height })
      + (d.primary ? t('set.displayPrimary') : '');
    sel.appendChild(o);
  });
  sel.value = value || 'auto';
}

function updateBaselineNote(s) {
  const b = s?.baseline;
  if (b && b.capturedAt) {
    const when = new Date(b.capturedAt).toLocaleString(LANG === 'zh' ? 'zh-CN' : 'en-GB', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    $('baseline-note').textContent = t('set.baselineSaved', { where: cameraName(b.camera), when });
  } else {
    $('baseline-note').textContent = t('set.baselineNone');
  }
}

function fillSettingsForm(s) {
  $('s-language').value = s.language;
  $('s-autoLaunch').checked = s.autoLaunch;
  $('s-recalib').checked = !s.persistBaseline;
  $('s-weekends').checked = !s.schedule.weekdaysOnly;

  [0, 1].forEach((i) => {
    const [a, b] = s.schedule.segments[i] || (i === 0 ? [540, 720] : [840, 1080]);
    $(`s-seg${i}-from`).value = toHM(a);
    $(`s-seg${i}-to`).value = toHM(b);
  });

  const th = s.thresholds;
  $('s-dAngle').value = th.dAngle;
  $('s-dTilt').value = th.dTilt;
  $('s-dDrop').value = Math.round(th.dDrop * 100);
  $('s-dYaw').value = th.dYaw;
  $('s-holdMs').value = th.holdMs / 1000;
  $('s-cooldownMs').value = th.cooldownMs / 1000;

  $('s-camera').value = s.camera;
  $('s-sitEnabled').checked = s.sit.enabled;
  $('s-sitMinutes').value = s.sit.minutes;

  const pct = Math.round((s.overlayOpacity ?? 0.6) * 100);
  $('s-opacity').value = pct;
  $('s-opacity-val').textContent = pct + '%';

  fillDisplayOptions(s.overlayDisplay || 'auto');
  refreshSettingsText();
}

function readSettingsForm() {
  const num = (id, fallback) => {
    const el = $(id);
    const v = Number(el.value);
    return el.value !== '' && Number.isFinite(v) ? v : fallback;
  };
  const seg = (i) => [toMin($(`s-seg${i}-from`).value), toMin($(`s-seg${i}-to`).value)];
  return {
    language: $('s-language').value,
    autoLaunch: $('s-autoLaunch').checked,
    persistBaseline: !$('s-recalib').checked,
    schedule: { weekdaysOnly: !$('s-weekends').checked, segments: [seg(0), seg(1)] },
    thresholds: {
      dAngle: num('s-dAngle', 8),
      dTilt: num('s-dTilt', 5),
      dDrop: num('s-dDrop', 6) / 100,
      dYaw: num('s-dYaw', 0.18),
      holdMs: num('s-holdMs', 3.5) * 1000,
      cooldownMs: num('s-cooldownMs', 20) * 1000,
    },
    camera: $('s-camera').value,
    sit: { enabled: $('s-sitEnabled').checked, minutes: num('s-sitMinutes', 45) },
    overlayDisplay: $('s-display').value || 'auto',
    overlayOpacity: num('s-opacity', 60) / 100,
    displayAsked: true,
    cameraAsked: true,
  };
}

// 三档只是一键把上面六个数字填好，**不落盘成枚举**——避免"预设"和"手改"打架。
// 界面上的"当前档位"因此是从六个数值反推的：完全一致才算命中，差一项就是自定义。
// 单位与 settings.thresholds 一致（比例 / 毫秒），填表时再换算成表单单位。
const PRESETS = {
  loose: { dAngle: 12, dTilt: 8, dDrop: 0.10, dYaw: 0.25, holdMs: 5000, cooldownMs: 30000 },
  normal: { dAngle: 8, dTilt: 5, dDrop: 0.06, dYaw: 0.18, holdMs: 3500, cooldownMs: 20000 },
  strict: { dAngle: 5, dTilt: 3, dDrop: 0.04, dYaw: 0.12, holdMs: 2500, cooldownMs: 15000 },
};
const PRESET_ORDER = ['loose', 'normal', 'strict'];
const PRESET_I18N = { loose: 'set.loose', normal: 'set.normal', strict: 'set.strict' };

function detectPreset(thresholds) {
  if (!thresholds) return 'custom';
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  for (const key of PRESET_ORDER) {
    const p = PRESETS[key];
    if (near(thresholds.dAngle, p.dAngle) && near(thresholds.dTilt, p.dTilt)
      && near(thresholds.dDrop, p.dDrop) && near(thresholds.dYaw, p.dYaw)
      && near(thresholds.holdMs, p.holdMs) && near(thresholds.cooldownMs, p.cooldownMs)) {
      return key;
    }
  }
  return 'custom';
}

const presetName = (key) => t(key === 'custom' ? 'set.custom' : PRESET_I18N[key]);

// 设置面板里的"当前档位"跟着表单实时走（没保存也能预览），三个按钮同步高亮
function updatePresetHint() {
  if (!cfg) return;
  const key = detectPreset(readSettingsForm().thresholds);
  document.querySelectorAll('.seg').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.sens === key);
  });
  $('preset-current').textContent = t('set.presetCurrent', { name: presetName(key) });
}

document.querySelectorAll('.seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = PRESETS[btn.dataset.sens];
    if (!p) return;
    $('s-dAngle').value = p.dAngle;
    $('s-dTilt').value = p.dTilt;
    $('s-dDrop').value = Math.round(p.dDrop * 100);
    $('s-dYaw').value = p.dYaw;
    $('s-holdMs').value = p.holdMs / 1000;
    $('s-cooldownMs').value = p.cooldownMs / 1000;
    updatePresetHint();
  });
});

['s-dAngle', 's-dTilt', 's-dDrop', 's-dYaw', 's-holdMs', 's-cooldownMs'].forEach((id) => {
  $(id).addEventListener('input', updatePresetHint);
});

$('open-settings').addEventListener('click', () => {
  if (!cfg) return;
  fillSettingsForm(cfg);
  $('settings').classList.remove('hidden');
});

// 语言即时生效，但没有保存就取消，要退回已经存下来的那一种
$('s-language').addEventListener('change', () => {
  const next = $('s-language').value;
  if (next === LANG) return;
  applyLang(next);
  log(t('log.languageChanged'));
});

$('s-opacity').addEventListener('input', () => {
  $('s-opacity-val').textContent = $('s-opacity').value + '%';
});

$('set-preview').addEventListener('click', () => window.api.previewOverlay(Number($('s-opacity').value) / 100));

function closeSettings() {
  $('settings').classList.add('hidden');
  if (cfg && LANG !== cfg.language) applyLang(cfg.language);
}

$('set-cancel').addEventListener('click', closeSettings);

async function loadDisplays() {
  try {
    displayList = await window.api.listDisplays();
  } catch {
    displayList = [];
  }
  return displayList;
}

$('set-save').addEventListener('click', async () => {
  try {
    const saved = await window.api.saveSettings(readSettingsForm());
    // 机位一变，主进程已经清掉了持久化的基线，这里把内存里那份也作废，
    // 否则会继续拿旧机位的 shY 去算下沉，出现"越坐越低却显示负值"。
    if (judge.base && saved.camera !== judge.base.camera) {
      judge.reset();
      log(t('log.baselineDropped'));
    }
    applyLang(saved.language);
    applySettings(saved);
    fillSettingsForm(saved);
    $('settings').classList.add('hidden');
    log(t('log.settingsSaved'));
  } catch (e) {
    log(t('log.settingsSaveFail', { err: e.message || e }));
  }
});

// ---------------- 关于与支持作者 ----------------

function renderAboutLinks() {
  const hasRepo = !!appInfo?.repo;
  $('link-repo').style.display = hasRepo ? '' : 'none';
  $('link-issue').style.display = appInfo?.issues ? '' : 'none';
}

// 只做两件事：把作者选的赞助入口摆出来、把收款码贴上。
// 不碰支付流程——金额由用户在支付页面里自己填，程序既不经手也不记录。
function renderDonate() {
  const box = $('donate-box');
  box.innerHTML = '';
  const d = appInfo?.donate || {};

  // 赞赏码排在最前：扫码即付、不用注册，小额赞助的转化全看这一步少几次跳转。
  if (d.qr) {
    const img = document.createElement('img');
    img.className = 'qr';
    img.src = '/' + d.qr;
    img.alt = t('about.donateQr');
    box.appendChild(img);
    const note = document.createElement('p');
    note.className = 'set-note';
    note.textContent = t('about.donateHint');
    box.appendChild(note);
  }

  const channels = [];
  if (d.afdian) channels.push({ url: d.afdian, label: t('about.donateAfdian') });
  if (d.sponsors) channels.push({ url: d.sponsors, label: t('about.donateSponsors') });

  // 有码又有平台才解释「为什么还有第二个入口」，否则这行会显得没头没尾
  if (channels.length && d.qr && d.afdian) {
    const alt = document.createElement('p');
    alt.className = 'set-note';
    alt.textContent = t('about.donateAlt');
    box.appendChild(alt);
  }

  if (channels.length) {
    const row = document.createElement('div');
    row.className = 'row links';
    channels.forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost small';
      btn.textContent = c.label;
      btn.addEventListener('click', () => window.api.openExternal(c.url));
      row.appendChild(btn);
    });
    box.appendChild(row);
  }

  if (!channels.length && !d.qr) {
    const p = document.createElement('p');
    p.className = 'set-note';
    p.textContent = t('about.donateUnset');
    box.appendChild(p);
  }
}

async function openAbout(scrollToDonate = false) {
  if (!appInfo) {
    appInfo = await window.api.getAppInfo().catch(() => ({}));
  }
  $('about-ver').textContent = t('about.version', { v: appInfo.version || '' });
  renderAboutLinks();
  renderDonate();
  $('about').classList.remove('hidden');
  if (scrollToDonate) $('donate-box').scrollIntoView({ block: 'center' });
}

function closeAbout() {
  $('about').classList.add('hidden');
}

$('open-about').addEventListener('click', () => openAbout());
$('about-close').addEventListener('click', closeAbout);
$('about').addEventListener('click', (e) => { if (e.target.id === 'about') closeAbout(); });
$('link-repo').addEventListener('click', () => { if (appInfo?.repo) window.api.openExternal(appInfo.repo); });
$('link-issue').addEventListener('click', () => { if (appInfo?.issues) window.api.openExternal(appInfo.issues); });
$('set-donate').addEventListener('click', () => openAbout(true));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('about').classList.contains('hidden')) closeAbout();
  else if (!$('settings').classList.contains('hidden')) closeSettings();
});

// ---------------- 启动 ----------------

async function boot() {
  try {
    await loadDicts();
  } catch {
    /* 字典没加载上时 t() 只会回落到键名，界面不至于白屏 */
  }

  try {
    cfg = await window.api.getSettings();
    applyLang(cfg.language);
    applySettings(cfg);
    restoreBaseline(cfg);
  } catch {
    /* 读不到配置就按内置默认跑 */
  }
  await loadDisplays();

  // 首次使用要把两件事确认掉：机位（决定四项阈值）和遮罩屏（仅多屏时有意义）
  const needCamera = cfg && !cfg.cameraAsked;
  const needDisplay = cfg && !cfg.displayAsked && displayList.length > 1;
  if (needCamera || needDisplay) {
    // 引导文案由 refreshSettingsText 按 cameraAsked / displayAsked 自动选，这里不用另写一遍
    fillSettingsForm(cfg);
    $('settings').classList.remove('hidden');
  }

  const work = await window.api.getWorkTime().catch(() => true);
  if (work) start();
  else askForceRun();
}

boot();
