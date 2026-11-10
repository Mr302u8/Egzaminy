// Nadzór kamerą: analiza obrazu lokalnie w przeglądarce (MediaPipe Tasks Vision).
// Wideo nie jest nigdzie wysyłane. Na zewnątrz trafiają tylko zdarzenia + pojedyncze zrzuty JPEG.

const MP_VERSION = '0.10.14';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
// EfficientDet-Lite2 – wyraźnie lepiej łapie telefon i książkę niż Lite0 (ok. 12 MB, pobierany raz).
const OBJ_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/latest/efficientdet_lite2.tflite';
// Lżejszy model dla słabszych komputerów (przełączany automatycznie, gdy Lite2 jest za wolny).
const OBJ_MODEL_LIGHT = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

// Progi – do strojenia w pilotażu. Czas = jak długo sytuacja musi trwać, zanim powstanie zdarzenie.
export const RULES = {
  no_face:    { ms: 1500, label: 'Brak twarzy w kadrze' },
  multi_face: { ms: 800,  label: 'Więcej niż jedna twarz' },
  look_down:  { ms: 1500, label: 'Patrzenie w dół (kartki / telefon na kolanach)' },
  look_side:  { ms: 1500, label: 'Patrzenie w bok / poza ekran' },
  look_up:    { ms: 2500, label: 'Patrzenie w górę' },
  phone:      { ms: 400,  label: 'Telefon w kadrze' },
  book:       { ms: 600,  label: 'Książka / kartki w kadrze' },
  person:     { ms: 800,  label: 'Druga osoba w kadrze' },
  dark:       { ms: 1500, label: 'Kamera zasłonięta lub ciemny obraz' },
  frozen:     { ms: 3000, label: 'Obraz z kamery zamrożony' },
  face_moved: { ms: 2000, label: 'Zmiana pozycji przed kamerą (odsunięcie / pochylenie)' },
  camera_off: { ms: 0,    label: 'Kamera wyłączona' },
};
export const LIMITS = {
  headDown: 0.06,   // przesunięcie nosa w dół względem kalibracji (część wysokości twarzy)
  headUp: 0.08,
  headSide: 0.10,   // przesunięcie nosa w bok (część szerokości twarzy)
  eyesDown: 0.30,   // wzrost wskaźnika „oczy w dół” (blendshape 0–1) względem kalibracji
  eyesSide: 0.35,
  phoneScore: 0.30,
  bookScore: 0.35,
  personScore: 0.45,
};
// Marginesy poza „pudełkiem” wyznaczonym w kalibracji 5 punktów (patrzenie na rogi i środek ekranu).
export const MARGINS = {
  ih: 0.07,     // poziome położenie źrenicy w oku (część szerokości oka)
  iv: 0.05,     // pionowe położenie źrenicy względem kącików oka (część szerokości oka)
  hyaw: 10,     // obrót głowy w bok, stopnie
  hpitch: 9,    // pochylenie głowy, stopnie
  yaw: 0.06, pitch: 0.05, // położenie nosa w twarzy (zapas na wypadek błędu macierzy)
  down: 0.25,   // blendshape „oczy w dół”
};
const REFIRE_MS = 8000; // trwająca sytuacja zgłaszana ponownie co 8 s
const TICK_MS = 300;

export class Proctor {
  constructor({ onEvent, onStatus, snapCanvas }) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.snap = snapCanvas;
    this.state = {};
    this.baseline = null;
    this.last = { faces: 0, pose: null, gaze: null, objects: [], errors: 0 };
    this.running = false;
    this.tick = 0;
    this.objEvery = 2;
    this.slow = 0;
    this.lastVideoTime = -1;
    this.videoStuckSince = null;
  }

  async init(video) {
    this.video = video;
    this.vision = await import(`${MP_URL}/vision_bundle.mjs`);
    this.fileset = await this.vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
    try { await this.build('GPU'); } catch (e) { console.warn('GPU niedostępne, CPU', e); await this.build('CPU'); }
    const track = video.srcObject?.getVideoTracks?.()[0];
    if (track) {
      track.addEventListener('ended', () => this.fire('camera_off', 'strumień zakończony'));
      track.addEventListener('mute', () => this.fire('camera_off', 'kamera przestała nadawać'));
    }
    this.loop = setInterval(() => this.step(), TICK_MS);
  }

  async build(delegate) {
    this.delegate = delegate;
    this.face?.close?.();
    const v = this.vision;
    this.face = await v.FaceLandmarker.createFromOptions(this.fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate },
      runningMode: 'VIDEO', numFaces: 3,
      minFaceDetectionConfidence: 0.4, minFacePresenceConfidence: 0.4, minTrackingConfidence: 0.4,
      outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    });
    await this.buildObj(delegate, this.light ? OBJ_MODEL_LIGHT : OBJ_MODEL);
    this.ts = 0;
  }

  async buildObj(delegate, model) {
    const old = this.obj;
    this.obj = await this.vision.ObjectDetector.createFromOptions(this.fileset, {
      baseOptions: { modelAssetPath: model, delegate },
      runningMode: 'VIDEO', scoreThreshold: 0.25, maxResults: 10,
      categoryAllowlist: ['cell phone', 'book', 'person', 'laptop', 'remote'],
    });
    if (old && old !== this.obj) old.close?.();
  }

  // Analizowany element <video> (podczas egzaminu – widoczny podgląd w rogu).
  setVideo(v) { this.video = v; }

  step() {
    const v = this.video;
    if (!v || v.readyState < 2 || this.busy) return;
    this.busy = true;
    const now = performance.now();
    this.ts = Math.max(this.ts + 1, now);
    this.tick++;
    try {
      const fr = this.face.detectForVideo(v, this.ts);
      const faces = fr.faceLandmarks || [];
      this.last.faces = faces.length;
      this.last.lm = faces[0] || null;
      this.last.f = faces.length ? features(faces[0], fr.faceBlendshapes?.[0]?.categories, fr.facialTransformationMatrixes?.[0]?.data) : null;
      this.last.pose = this.last.f; this.last.gaze = this.last.f;
      this.last.faceMs = performance.now() - now;
      if (this.calib && this.last.faces === 1 && this.last.f) this.calib.push(this.last.f);
      // Detekcja przedmiotów jest cięższa: uruchamiana co N kroków, N dobierane do szybkości komputera.
      if (this.tick % this.objEvery === 0) {
        const t0 = performance.now();
        const or = this.obj.detectForVideo(v, this.ts);
        this.last.objects = (or.detections || []).map(d => ({ name: d.categories[0].categoryName, score: d.categories[0].score }));
        this.last.objMs = performance.now() - t0;
        this.objEvery = Math.min(8, Math.max(2, Math.ceil(this.last.objMs / 120)));
        if (this.last.objMs > 300 && !this.light && ++this.slow >= 2) {
          this.light = true; this.objEvery = 2;
          this.buildObj(this.delegate, OBJ_MODEL_LIGHT).catch(e => console.warn(e));
        }
      }
      if (this.tick % 5 === 0) this.last.brightness = this.brightness();
      this.last.errors = 0;
    } catch (e) {
      console.warn('detekcja', e);
      this.busy = false;
      if (++this.last.errors === 3 && this.delegate === 'GPU') this.build('CPU').catch(err => console.error(err));
      this.onStatus?.(this.status());
      return;
    }
    this.busy = false;

    // Zamrożony obraz (np. wirtualna kamera z nagraniem lub zawieszony sterownik).
    if (v.currentTime === this.lastVideoTime) this.videoStuckSince ??= now; else this.videoStuckSince = null;
    this.lastVideoTime = v.currentTime;

    this.onStatus?.(this.status());
    if (!this.running) return;

    const L = this.last, dir = this.direction();
    const has = (n, min) => L.objects.filter(o => o.name === n && o.score >= min);
    const dark = L.brightness !== undefined && L.brightness < 25;
    this.cond('no_face', L.faces === 0 && !dark, now);
    this.cond('multi_face', L.faces >= 2, now, `${L.faces} twarze`);
    this.cond('look_down', dir.down, now, dir.why);
    this.cond('look_side', dir.side, now, dir.why);
    this.cond('look_up', dir.up, now, dir.why);
    this.cond('phone', has('cell phone', LIMITS.phoneScore).length > 0 || has('remote', 0.5).length > 0, now, conf(has('cell phone', LIMITS.phoneScore)));
    this.cond('book', has('book', LIMITS.bookScore).length > 0, now, conf(has('book', LIMITS.bookScore)));
    this.cond('person', has('person', LIMITS.personScore).length >= 2, now, `${has('person', LIMITS.personScore).length} osoby`);
    this.cond('dark', dark, now, `jasność ${Math.round(L.brightness)}`);
    this.cond('frozen', this.videoStuckSince !== null && now - this.videoStuckSince > 0, now);
    this.cond('face_moved', !!dir.moved, now, dir.moved || '');
  }

  // Kierunek patrzenia. Po kalibracji 5 punktów: czy źrenice, głowa lub nos wyszły poza zakres
  // zmierzony przy patrzeniu na rogi ekranu (+ margines). Bez niej: odchylenie od pozycji startowej.
  direction() {
    const f = this.last.f, b = this.baseline, box = this.box;
    const out = { down: false, side: false, up: false, why: '', moved: '' };
    if (!f || !b) return out;
    const vDir = (f.pitch - b.pitch) + (f.iv - b.iv) >= 0 ? 'down' : 'up';
    const hits = [];
    if (box) {
      for (const k of ['ih', 'hyaw', 'yaw', 'iv', 'hpitch', 'pitch', 'down']) {
        const [lo, hi] = box[k], m = MARGINS[k], x = f[k];
        if (x == null || Number.isNaN(x)) continue;
        if (x > hi + m || (k !== 'down' && x < lo - m)) hits.push([k, x > hi ? x - hi : lo - x]);
      }
    } else {
      if (f.pitch - b.pitch > LIMITS.headDown) hits.push(['pitch', f.pitch - b.pitch]);
      if (b.pitch - f.pitch > LIMITS.headUp) hits.push(['pitch', b.pitch - f.pitch]);
      if (Math.abs(f.yaw - b.yaw) > LIMITS.headSide) hits.push(['yaw', Math.abs(f.yaw - b.yaw)]);
      if (f.down - b.down > LIMITS.eyesDown) hits.push(['down', f.down - b.down]);
      if (f.side - b.side > LIMITS.eyesSide) hits.push(['side', f.side - b.side]);
    }
    const NAMES = { ih: 'źrenice w bok', iv: 'źrenice', hyaw: 'głowa w bok', yaw: 'głowa w bok', hpitch: 'pochylenie głowy', pitch: 'pochylenie głowy', down: 'oczy w dół', side: 'oczy w bok' };
    const horiz = hits.filter(([k]) => ['ih', 'hyaw', 'yaw', 'side'].includes(k));
    const vert = hits.filter(([k]) => !['ih', 'hyaw', 'yaw', 'side'].includes(k));
    const desc = list => list.map(([k, d]) => `${NAMES[k]} +${k.startsWith('h') ? Math.round(d) + '°' : d.toFixed(2)}`).join(', ');
    if (vert.length && (vDir === 'down' || vert.some(([k]) => k === 'down'))) { out.down = true; out.why = desc(vert); }
    else if (horiz.length) { out.side = true; out.why = desc(horiz); }
    else if (vert.length) { out.up = true; out.why = desc(vert); }
    // Odsunięcie od kamery / przesunięcie twarzy (np. pochylanie się nad kartką obok laptopa).
    if (f.size / b.size < 0.65) out.moved = 'twarz dalej od kamery';
    else if (f.size / b.size > 1.6) out.moved = 'twarz bliżej kamery';
    else if (Math.hypot(f.cx - b.cx, f.cy - b.cy) > 0.22) out.moved = 'twarz przesunięta w kadrze';
    return out;
  }

  // Kalibracja wzroku: zdający patrzy kolejno na punkty ekranu; zbieramy medianę cech dla każdego.
  async collectPoint(ms = 1400) {
    this.calib = [];
    const start = performance.now();
    while ((performance.now() - start < ms || this.calib.length < 3) && performance.now() - start < 5000) {
      await new Promise(r => setTimeout(r, 80));
    }
    const samples = this.calib.slice(Math.floor(this.calib.length / 3)); // pomijamy pierwsze klatki (ruch oczu do kropki)
    this.calib = null;
    return samples.length >= 2 ? median(samples) : null;
  }
  setBox(points) {
    const ok = points.filter(Boolean);
    if (ok.length < 4) { this.box = null; return false; }
    this.box = {};
    for (const k of Object.keys(MARGINS)) {
      const vals = ok.map(p => p[k]).filter(x => x != null && !Number.isNaN(x));
      this.box[k] = vals.length ? [Math.min(...vals), Math.max(...vals)] : [-Infinity, Infinity];
    }
    return true;
  }

  // Kalibracja: mediana pozycji głowy i oczu przez ~2 s, gdy zdający patrzy w ekran.
  async calibrate(ms = 2000) {
    this.calib = [];
    const start = performance.now();
    // co najmniej `ms` i co najmniej 6 klatek z jedną twarzą (wolne komputery), maks. 8 s
    while ((performance.now() - start < ms || this.calib.length < 6) && performance.now() - start < 8000) {
      await new Promise(r => setTimeout(r, 100));
    }
    const samples = this.calib; this.calib = null;
    if (samples.length < 6) return false;
    this.baseline = median(samples);
    return true;
  }

  cond(type, active, now, detail = '') {
    const s = this.state[type] || (this.state[type] = { since: null, fired: 0 });
    if (!active) { s.since = null; s.fired = 0; return; }
    if (s.since === null) s.since = now;
    if (now - s.since >= RULES[type].ms && now - s.fired >= REFIRE_MS) {
      s.fired = now;
      this.fire(type, detail);
    }
  }

  fire(type, detail) {
    this.onEvent?.({ type, label: RULES[type].label, detail, img: this.snapshot() });
  }

  status() {
    const L = this.last, d = this.direction();
    const f = L.f || {};
    const phone = L.objects.filter(o => o.name === 'cell phone').reduce((m, o) => Math.max(m, o.score), 0);
    return {
      ok: L.errors === 0, delegate: this.delegate + (this.light ? ' lite0' : ' lite2'), faces: L.faces,
      looking: d.down ? 'w dół' : d.side ? 'w bok' : d.up ? 'w górę' : 'w ekran',
      why: d.why, calibrated: !!this.box,
      ih: f.ih, iv: f.iv, hyaw: f.hyaw, hpitch: f.hpitch, phone, objects: L.objects, brightness: L.brightness, faceMs: L.faceMs, objMs: L.objMs, objEvery: this.objEvery,
    };
  }

  snapshot() {
    try {
      const c = this.snap, ctx = c.getContext('2d');
      ctx.drawImage(this.video, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.6);
    } catch { return null; }
  }

  brightness() {
    const c = this._bc || (this._bc = Object.assign(document.createElement('canvas'), { width: 32, height: 24 }));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, 0, 0, 32, 24);
    const d = ctx.getImageData(0, 0, 32, 24).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return sum / (d.length / 4);
  }

  start() { this.running = true; this.state = {}; }
  stop() { this.running = false; clearInterval(this.loop); }
}

// Cechy jednej twarzy (współrzędne znormalizowane 0–1 względem obrazu).
// Punkty 468–477 to źrenice/tęczówki z modelu Face Landmarker (478 punktów).
const EYES = [
  { a: 33, b: 133, top: 159, bot: 145 },   // jedno oko: kąciki i powieki
  { a: 362, b: 263, top: 386, bot: 374 },  // drugie oko
];
function features(lm, cats, mtx) {
  const nose = lm[1], left = lm[234], right = lm[454], top = lm[10], chin = lm[152];
  const f = {
    yaw: (nose.x - left.x) / ((right.x - left.x) || 1e-6),
    pitch: (nose.y - top.y) / ((chin.y - top.y) || 1e-6),
    cx: (left.x + right.x) / 2, cy: (top.y + chin.y) / 2,
    size: Math.hypot(right.x - left.x, chin.y - top.y),
  };
  // Źrenice: położenie środka tęczówki między kącikami oka (poziomo) i względem linii kącików (pionowo).
  if (lm.length >= 478) {
    const irisC = [lm[468], lm[473]];
    const hs = [], vs = [];
    for (const e of EYES) {
      const A = lm[e.a], B = lm[e.b];
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      const iris = irisC.reduce((best, p) => Math.hypot(p.x - mid.x, p.y - mid.y) < Math.hypot(best.x - mid.x, best.y - mid.y) ? p : best);
      const L = A.x < B.x ? A : B, R = A.x < B.x ? B : A;
      const w = Math.hypot(R.x - L.x, R.y - L.y) || 1e-6;
      // rzut na oś oka (odporny na przechylenie głowy)
      const ux = (R.x - L.x) / w, uy = (R.y - L.y) / w;
      hs.push(((iris.x - L.x) * ux + (iris.y - L.y) * uy) / w);
      vs.push(((iris.x - mid.x) * -uy + (iris.y - mid.y) * ux) / w);
    }
    f.ih = (hs[0] + hs[1]) / 2;
    f.iv = (vs[0] + vs[1]) / 2;
  }
  // Kąty głowy z macierzy transformacji twarzy (kolumnowa 4x4).
  if (mtx && mtx.length === 16) {
    const R = (r, c) => mtx[c * 4 + r];
    f.hyaw = Math.atan2(-R(2, 0), Math.hypot(R(2, 1), R(2, 2))) * 180 / Math.PI;
    f.hpitch = Math.atan2(R(2, 1), R(2, 2)) * 180 / Math.PI;
  }
  if (cats) {
    const s = Object.fromEntries(cats.map(c => [c.categoryName, c.score]));
    f.down = ((s.eyeLookDownLeft || 0) + (s.eyeLookDownRight || 0)) / 2;
    f.side = Math.max(((s.eyeLookOutLeft || 0) + (s.eyeLookInRight || 0)) / 2, ((s.eyeLookInLeft || 0) + (s.eyeLookOutRight || 0)) / 2);
  } else { f.down = 0; f.side = 0; }
  return f;
}
function median(samples) {
  const out = {};
  for (const k of Object.keys(samples[0])) {
    const v = samples.map(s => s[k]).filter(x => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
    out[k] = v.length ? v[Math.floor(v.length / 2)] : null;
  }
  return out;
}

// Podgląd śledzenia: kadr przybliżony na twarz, kąciki oczu i źrenice zaznaczone na obrazie.
export function drawFaceView(canvas, video, proctor) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  const lm = proctor.last.faces ? proctor.last.lm : null;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (lm) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of lm) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    const cx = (x0 + x1) / 2 * vw, cy = (y0 + y1) / 2 * vh;
    sh = Math.min(vh, (y1 - y0) * vh * 1.7); sw = Math.min(vw, sh * W / H);
    sh = sw * H / W;
    sx = Math.max(0, Math.min(vw - sw, cx - sw / 2)); sy = Math.max(0, Math.min(vh - sh, cy - sh / 2));
    proctor._crop = proctor._crop ? lerpBox(proctor._crop, [sx, sy, sw, sh], 0.35) : [sx, sy, sw, sh];
    [sx, sy, sw, sh] = proctor._crop;
  }
  ctx.save();
  ctx.translate(W, 0); ctx.scale(-1, 1); // lustro – naturalny podgląd
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
  if (lm) {
    const P = i => [(lm[i].x * vw - sx) / sw * W, (lm[i].y * vh - sy) / sh * H];
    const d = proctor.direction(), away = d.down || d.side || d.up;
    ctx.lineWidth = 1.5; ctx.strokeStyle = away ? '#ff5252' : '#5ee08a'; ctx.fillStyle = ctx.strokeStyle;
    for (const e of EYES) {
      ctx.beginPath(); ctx.moveTo(...P(e.a)); ctx.lineTo(...P(e.top)); ctx.lineTo(...P(e.b)); ctx.lineTo(...P(e.bot)); ctx.closePath(); ctx.stroke();
    }
    if (lm.length >= 478) for (const i of [468, 473]) { ctx.beginPath(); ctx.arc(...P(i), 2.5, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}
const lerpBox = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const fmt = x => x.toFixed(2);
function conf(list) {
  if (!list.length) return '';
  return `pewność ${Math.round(Math.max(...list.map(o => o.score)) * 100)}%`;
}
