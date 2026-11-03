import { median } from './geometry.js';

export const DEFAULTS = {
  // 45° 斜视角下前伸的水平位移只投影出约七成，阈值需比正侧视更低才不迟钝。
  // 中值滤波后噪声约 ±1.5°，8° 已远高于噪声。觉得太敏感就调到 12，不灵就降到 6。
  dAngle: 8,
  // 肩线倾斜按绝对值比较，往两侧任一方向歪都算。噪声约 ±0.6°，5° 留足余量。
  dTilt: 5,
  // 身体下沉：肩膀比标定时低了"肩宽的百分之多少"。0.06 ≈ 实沉 2.4cm。
  // 弯腰塌腰时肩头相对关系不变，但整体位置会掉下来，这个量专门补这一块。
  dDrop: 0.06,
  // 转头容差：鼻尖相对肩中线的偏移偏离基线超过这个量，就认为你在看屏幕两侧。
  // 此时耳肩几何在画面里已不代表前伸，暂停颈角判定——否则大屏用户会被误报淹没。
  // 0.18 约等于左右各转 33°。嫌敏感就加到 0.25，管太松就降到 0.12。
  dYaw: 0.18,
  // 端到端延迟预算 ≈ 中值滤波(约 1s) + holdMs。8s 时用户会觉得程序没反应，
  // 3.5s 落在"还来得及纠正"和"不像误报"之间。
  holdMs: 3500,
  recoverMs: 3000, // 恢复后多久收起提示
  // 冷却太长会让用户误以为失效；20s 足够打断"坐正→又塌下去"的反复。
  cooldownMs: 20000,
  // 连续良好达到这个时长就把累计清零。没有它的话，良好时按半速回退意味着
  // 不良时间占比只要超过 1/3 就能持续累积——阈值附近来回抖几分钟也会弹出提醒。
  resetMs: 1500,
};

// 双指标判定：颈前伸或肩线倾斜任一超阈值即为"此刻不良"，
// 再用积分器累积时长做去抖——短暂前倾攒不够 holdMs，持续驼背会。
export class PostureJudge {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.reset();
  }

  reset() {
    this.base = null;
    this.shown = false;
    this.badMs = 0;
    this.goodMs = 0;
    this.goodRun = 0;
    this.coolUntil = 0;
  }

  // 卡片被外部收回时调用：暂停、时段结束、摄像头中断、提醒超时自己收起。
  // 只清本轮判定的中间态，不动 base——清了 base 就得重新标定。
  //
  // 为什么必须有：shown 为 true 时 update() 只会走"等恢复"分支，不再产生 trigger。
  // 一旦卡片被外部关掉而 shown 还挂着 true，之后无论多驼背都不会再提醒，
  // 表现就是"用一段时间后突然不弹窗，重启才好"。
  clearVerdict() {
    this.shown = false;
    this.badMs = 0;
    this.goodMs = 0;
    this.goodRun = 0;
  }

  get ready() {
    return this.base !== null;
  }

  // meta: {camera, capturedAt} 随基线一起保存，用于判断这份基线还适不适用于当前机位
  calibrate(samples, meta = {}) {
    this.base = {
      angle: median(samples.map((s) => s.angle)),
      tilt: median(samples.map((s) => s.tilt)),
      shY: median(samples.map((s) => s.shY)),
      shW: median(samples.map((s) => s.shW)),
      yaw: median(samples.map((s) => s.yaw)),
      ...meta,
    };
    this.shown = false;
    this.badMs = 0;
    this.goodMs = 0;
    this.goodRun = 0;
    return this.base;
  }

  // m: {angle, tilt, shY, yaw}；返回 {bad, badNeck, badTilt, badDrop, turned, trigger, release, dev}
  update(m, dtMs, now) {
    if (!this.base) {
      return { bad: false, badNeck: false, badTilt: false, badDrop: false, turned: false, trigger: false, release: false, dev: null };
    }

    const c = this.cfg;
    // 分母用标定时的肩宽（常量），而不是当前肩宽：转身时当前肩宽变小会把下沉量放大成误报
    const drop = (m.shY - this.base.shY) / Math.max(this.base.shW, 0.1);
    const yawDev = Math.abs(m.yaw - this.base.yaw);
    // 转头超过容差时，颈角在画面里的读数不再可信，这一项不参与判定
    const turned = yawDev > c.dYaw;
    const dev = { angle: m.angle - this.base.angle, tilt: m.tilt - this.base.tilt, drop, yaw: yawDev };
    const badNeck = !turned && dev.angle > c.dAngle;
    const badTilt = Math.abs(dev.tilt) > c.dTilt;
    const badDrop = drop > c.dDrop;
    const bad = badNeck || badTilt || badDrop;

    // 不良时累积；良好时等速扣减，连续良好够久再清零。
    // 等速（而非半速）才能保证不良占比不超过一半时不会持续累积。
    if (bad) {
      this.badMs += dtMs;
      this.goodRun = 0;
    } else {
      this.goodRun += dtMs;
      this.badMs = Math.max(0, this.badMs - dtMs);
      if (this.goodRun >= c.resetMs) this.badMs = 0;
    }

    let trigger = false, release = false;
    if (!this.shown && this.badMs >= c.holdMs && now >= this.coolUntil) {
      this.shown = true;
      trigger = true;
      this.goodMs = 0;
    }
    if (this.shown) {
      this.goodMs = bad ? 0 : this.goodMs + dtMs;
      if (this.goodMs >= c.recoverMs) {
        this.shown = false;
        this.badMs = 0;
        this.coolUntil = now + c.cooldownMs;
        release = true;
      }
    }
    return { bad, badNeck, badTilt, badDrop, turned, trigger, release, dev };
  }
}
