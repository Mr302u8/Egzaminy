// Nadzór kamerą: analiza obrazu lokalnie w przeglądarce (MediaPipe Tasks Vision).
// Wideo nie jest nigdzie wysyłane. Na zewnątrz trafiają tylko zdarzenia + pojedyncze zrzuty JPEG.

const MP_VERSION = '0.10.14';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const OBJ_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

// Progi startowe – do strojenia w pilotażu.
export const RULES = {
  no_face:    { ms: 3000, label: 'Brak twarzy w kadrze' },
  multi_face: { ms: 1000, label: 'Więcej niż jedna twarz' },
  look_away:  { ms: 4000, label: 'Odwrócony wzrok / głowa' },
  phone:      { ms: 800,  label: 'Telefon w kadrze' },
  book:       { ms: 800,  label: 'Książka / kartki w kadrze' },
  person:     { ms: 1000, label: 'Druga osoba w kadrze' },
  dark:       { ms: 2000, label: 'Kamera zasłonięta lub ciemny obraz' },
  camera_off: { ms: 0,    label: 'Kamera wyłączona' },
};
const REFIRE_MS = 10000;     // ponowne zgłoszenie trwającej sytuacji co 10 s
const YAW_LIMIT = 0.17;      // odchylenie poziome nosa względem kalibracji
const PITCH_DOWN = 0.10;     // patrzenie w dół (telefon, kartki na kolanach)
const PITCH_UP = 0.12;

export class Proctor {
  constructor({ onEvent, snapCanvas }) {
    this.onEvent = onEvent;
    this.snap = snapCanvas;
    this.state = {};
    this.baseline = null;
    this.last = { faces: 0, pose: null, objects: [] };
    this.running = false;
    this.tick = 0;
  }

  async init(video) {
    this.video = video;
    const vision = await import(`${MP_URL}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
    const mk = async (delegate) => {
      this.face = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate },
        runningMode: 'VIDEO', numFaces: 3,
      });
      this.obj = await vision.ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: OBJ_MODEL, delegate },
        runningMode: 'VIDEO', scoreThreshold: 0.45, maxResults: 8,
        categoryAllowlist: ['cell phone', 'book', 'person', 'laptop'],
      });
    };
    try { await mk('GPU'); } catch { await mk('CPU'); }
    const track = video.srcObject?.getVideoTracks?.()[0];
    if (track) track.addEventListener('ended', () => this.fire('camera_off', 'strumień zakończony'));
    this.loop = setInterval(() => this.step(), 500);
  }

  // Analiza jednej klatki (co 0,5 s twarz, co 1 s obiekty, co 2 s jasność).
  step() {
    const v = this.video;
    if (!v || v.readyState < 2) return;
    const now = performance.now();
    this.tick++;
    try {
      const fr = this.face.detectForVideo(v, now);
      const faces = fr.faceLandmarks || [];
      this.last.faces = faces.length;
      this.last.pose = faces.length ? this.pose(faces[0]) : null;
      if (this.tick % 2 === 0) {
        const or = this.obj.detectForVideo(v, now);
        this.last.objects = (or.detections || []).map(d => ({
          name: d.categories[0].categoryName, score: d.categories[0].score,
        }));
      }
      if (this.tick % 4 === 0) this.last.brightness = this.brightness();
    } catch (e) { console.warn('detekcja', e); return; }

    if (!this.running) return;
    const L = this.last;
    const away = this.awayDirection();
    const has = n => L.objects.filter(o => o.name === n);
    this.cond('no_face', L.faces === 0 && !(L.brightness < 25), now);
    this.cond('multi_face', L.faces >= 2, now, `${L.faces} twarze`);
    this.cond('look_away', !!away, now, away);
    this.cond('phone', has('cell phone').length > 0, now, conf(has('cell phone')));
    this.cond('book', has('book').length > 0, now, conf(has('book')));
    this.cond('person', has('person').length >= 2, now, `${has('person').length} osoby`);
    this.cond('dark', L.brightness !== undefined && L.brightness < 25, now, `jasność ${Math.round(L.brightness)}`);
  }

  // Proporcje punktów twarzy: położenie nosa między policzkami (obrót w bok)
  // i między czołem a brodą (pochylenie). Odporne na odległość od kamery.
  pose(lm) {
    const nose = lm[1], left = lm[234], right = lm[454], top = lm[10], chin = lm[152];
    return {
      yaw: (nose.x - left.x) / ((right.x - left.x) || 1e-6),
      pitch: (nose.y - top.y) / ((chin.y - top.y) || 1e-6),
    };
  }

  awayDirection() {
    const p = this.last.pose, b = this.baseline;
    if (!p || !b) return null;
    if (p.pitch - b.pitch > PITCH_DOWN) return 'w dół';
    if (Math.abs(p.yaw - b.yaw) > YAW_LIMIT) return 'w bok';
    if (b.pitch - p.pitch > PITCH_UP) return 'w górę';
    return null;
  }

  // Kalibracja: średnia pozycja głowy przez ~2 s, gdy zdający patrzy w ekran.
  async calibrate(ms = 2000) {
    const samples = [];
    const end = performance.now() + ms;
    while (performance.now() < end) {
      await new Promise(r => setTimeout(r, 120));
      if (this.last.faces === 1 && this.last.pose) samples.push(this.last.pose);
    }
    if (samples.length < 5) return false;
    const med = k => samples.map(s => s[k]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    this.baseline = { yaw: med('yaw'), pitch: med('pitch') };
    return true;
  }

  cond(type, active, now, detail = '') {
    const s = this.state[type] || (this.state[type] = { since: null, lastFired: 0 });
    if (!active) { s.since = null; return; }
    if (s.since === null) s.since = now;
    if (now - s.since >= RULES[type].ms && now - s.lastFired >= REFIRE_MS) {
      s.lastFired = now;
      this.fire(type, detail);
    }
  }

  fire(type, detail) {
    this.onEvent?.({ type, label: RULES[type].label, detail, img: this.snapshot() });
  }

  snapshot() {
    try {
      const c = this.snap, ctx = c.getContext('2d');
      ctx.drawImage(this.video, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.6);
    } catch { return null; }
  }

  brightness() {
    const c = document.createElement('canvas'); c.width = 32; c.height = 24;
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

function conf(list) {
  if (!list.length) return '';
  return `pewność ${Math.round(Math.max(...list.map(o => o.score)) * 100)}%`;
}
