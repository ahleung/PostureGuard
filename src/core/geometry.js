// 姿态几何量计算。
// 只用归一化 2D 关键点：那是模型真正"看到"的像素位置。
// 实测发现摄像头在桌面高度只拍上半身，髋部不可见时 worldLandmarks 的 3D 重建会失真
// （耳肩竖直距离被压扁，比值虚高到 2 以上），因此不采用世界坐标。

const EAR_L = 7, EAR_R = 8, SH_L = 11, SH_R = 12, NOSE = 0;

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// 头颈前伸角：耳中点相对肩中点的连线，与竖直方向在图像平面上的夹角。
// 归一化坐标对宽高各自归一，先乘宽高比还原等比尺度，否则 4:3 画面下角度会失真。
// 只用方向不用长度，所以与离摄像头远近无关，也不需要看到髋部。
export function neckAngle(lm, aspect) {
  const a = lm[EAR_L], b = lm[EAR_R];
  const va = a?.visibility ?? 0, vb = b?.visibility ?? 0;
  // 侧视角下一只耳朵常被头挡住，模型会外推出错误位置；只取真正可见的那只。
  const ear = va >= 0.5 && vb >= 0.5 ? mid(a, b) : (va >= vb ? a : b);
  const s = mid(lm[SH_L], lm[SH_R]);
  const dx = Math.abs(ear.x - s.x) * aspect;
  const dy = Math.abs(s.y - ear.y);
  return (Math.atan2(dx, Math.max(dy, 1e-4)) * 180) / Math.PI;
}

// 肩线倾斜角：两肩连线相对水平线的夹角，正值表示右肩（12 号点）更低。
// 归一化坐标按宽高各自归一，水平分量同样要乘宽高比，否则倾斜角会被拉伸。
// 用 |dx| 而不分左右，保证符号只反映"哪侧肩低"，与画面左右翻转无关。
export function shoulderTilt(lm, aspect) {
  const a = lm[SH_L], b = lm[SH_R];
  const dx = Math.abs((b.x - a.x) * aspect);
  const dy = b.y - a.y;
  return (Math.atan2(dy, Math.max(dx, 1e-4)) * 180) / Math.PI;
}

// 头部左右转动的代理量：鼻尖相对两肩中线的水平偏移，除以肩宽做尺度归一。
// 转头时鼻尖横扫、双肩几乎不动，因此这个值只反映"头转了多少"；
// 除以肩宽后与离摄像头远近无关。正脸约 0，左转右转符号相反。
export function headYaw(lm) {
  const sh = mid(lm[SH_L], lm[SH_R]);
  const w = Math.abs(lm[SH_R].x - lm[SH_L].x);
  return (lm[NOSE].x - sh.x) / Math.max(w, 1e-3);
}

// 肩中点的垂直位置与肩宽。肩宽是骨骼常量（约 40cm），
// 用它当尺子归一化后，"整体下沉了多少"就与离摄像头远近无关。
export function shoulderFrame(lm, aspect) {
  const a = lm[SH_L], b = lm[SH_R];
  return { y: (a.y + b.y) / 2, width: Math.abs(b.x - a.x) * aspect };
}

// 双肩必须可信，耳朵至少一只可见。髋部不参与。
export function trusted(lm, minVis = 0.5) {
  if (!lm) return false;
  const ears = [EAR_L, EAR_R].filter((i) => (lm[i]?.visibility ?? 0) >= minVis).length;
  return ears >= 1 && [SH_L, SH_R].every((i) => (lm[i]?.visibility ?? 0) >= minVis);
}

export function median(values) {
  const a = [...values].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}
