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
      outputFaceBlendshapes: true,
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
      this.last.pose = faces.length ? pose(faces[0]) : null;
      this.last.gaze = fr.faceBlendshapes?.[0] ? gaze(fr.faceBlendshapes[0].categories) : null;
      this.last.faceMs = performance.now() - now;
      if (this.calib && this.last.faces === 1 && this.last.pose) this.calib.push({ ...this.last.pose, ...(this.last.gaze || { down: 0, side: 0 }) });
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
  }

  // Kierunek patrzenia: ruch głowy (pozycja nosa w twarzy) LUB ruch samych oczu (blendshapes).
  direction() {
    const p = this.last.pose, g = this.last.gaze, b = this.baseline;
    const out = { down: false, side: false, up: false, why: '' };
    if (!p || !b) return out;
    const dHead = p.pitch - b.pitch, sHead = Math.abs(p.yaw - b.yaw);
    const dEyes = g ? g.down - b.down : 0, sEyes = g ? g.side - b.side : 0;
    if (dHead > LIMITS.headDown || dEyes > LIMITS.eyesDown) {
      out.down = true; out.why = dHead > LIMITS.headDown ? `głowa w dół (${fmt(dHead)})` : `oczy w dół (${fmt(dEyes)})`;
    } else if (sHead > LIMITS.headSide || sEyes > LIMITS.eyesSide) {
      out.side = true; out.why = sHead > LIMITS.headSide ? `głowa w bok (${fmt(sHead)})` : `oczy w bok (${fmt(sEyes)})`;
    } else if (-dHead > LIMITS.headUp) {
      out.up = true; out.why = `głowa w górę (${fmt(-dHead)})`;
    }
    return out;
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
    const med = k => samples.map(s => s[k]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    this.baseline = { yaw: med('yaw'), pitch: med('pitch'), down: med('down'), side: med('side') };
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
    const phone = L.objects.filter(o => o.name === 'cell phone').reduce((m, o) => Math.max(m, o.score), 0);
    return {
      ok: L.errors === 0, delegate: this.delegate + (this.light ? ' lite0' : ' lite2'), faces: L.faces,
      looking: d.down ? 'w dół' : d.side ? 'w bok' : d.up ? 'w górę' : 'w ekran',
      why: d.why, phone, objects: L.objects, brightness: L.brightness, faceMs: L.faceMs, objMs: L.objMs, objEvery: this.objEvery,
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

// Pozycja nosa w twarzy: między policzkami (obrót w bok) i między czołem a brodą (pochylenie).
function pose(lm) {
  const nose = lm[1], left = lm[234], right = lm[454], top = lm[10], chin = lm[152];
  return {
    yaw: (nose.x - left.x) / ((right.x - left.x) || 1e-6),
    pitch: (nose.y - top.y) / ((chin.y - top.y) || 1e-6),
  };
}

// Kierunek samych oczu z blendshapes MediaPipe (0–1).
function gaze(cats) {
  const s = Object.fromEntries(cats.map(c => [c.categoryName, c.score]));
  const lookLeft = ((s.eyeLookOutLeft || 0) + (s.eyeLookInRight || 0)) / 2;
  const lookRight = ((s.eyeLookInLeft || 0) + (s.eyeLookOutRight || 0)) / 2;
  return {
    down: ((s.eyeLookDownLeft || 0) + (s.eyeLookDownRight || 0)) / 2,
    side: Math.max(lookLeft, lookRight),
  };
}

const fmt = x => x.toFixed(2);
function conf(list) {
  if (!list.length) return '';
  return `pewność ${Math.round(Math.max(...list.map(o => o.score)) * 100)}%`;
}
