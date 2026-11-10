import { Proctor, drawFaceView } from './proctor.js';

const $ = id => document.getElementById(id);
const LS_CFG = 'egz_config', LS_REP = 'egz_reports';
const WEIGHTS = {
  no_face: 3, multi_face: 5, phone: 5, book: 4, person: 5, dark: 4, camera_off: 5,
  look_down: 2, look_left: 2, look_right: 2, talking: 2, look_up: 1, frozen: 4, face_moved: 2, calibration_failed: 2, pointer_unlock: 2, start_photo: 0,
  tab_hidden: 3, focus_lost: 2, fullscreen_exit: 3, clipboard: 1, blocked_key: 1,
  dom_injection: 3, extension_present: 2, multi_monitor: 3, window_resized: 1,
};
const MAX_SNAPS = 60;

let config = null, configSource = '';
let proctor = null, stream = null;
let exam = null; // stan trwającej próby
let lastReport = null;
const DEBUG = new URLSearchParams(location.search).has('debug');

/* ---------- nawigacja ---------- */
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('hidden', s.id !== id));
  if (id === 's-admin') fillAdmin();
  if (id === 's-reports') renderReports();
  if (id === 's-candidate') $('cand-title').textContent = config?.title || 'Egzamin';
}
document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go && !exam) show(go.dataset.go);
});

/* ---------- konfiguracja egzaminu ---------- */
async function loadConfig() {
  try {
    const r = await fetch('egzamin.json', { cache: 'no-store' });
    if (r.ok) { config = await r.json(); configSource = 'plik egzamin.json na serwerze'; }
  } catch { /* brak pliku */ }
  if (!config) {
    try { config = JSON.parse(localStorage.getItem(LS_CFG)); configSource = 'ustawienia zapisane na tym komputerze'; } catch {}
  }
  if (!config) {
    try {
      const r = await fetch('przyklad.csv');
      const { questions } = parseCSV(await r.text());
      config = { title: 'Egzamin próbny', count: 10, totalMin: 15, perQ: 60, pass: 60, exits: 2,
                 shuffle: true, back: false, camera: true, keyboardOnly: true, questions };
      configSource = 'pytania przykładowe (przyklad.csv)';
    } catch {}
  }
  $('exam-source').textContent = config
    ? `Źródło egzaminu: ${configSource}. Pytań w puli: ${config.questions.length}.`
    : 'Brak egzaminu – wgraj pytania w panelu egzaminatora.';
}

/* ---------- CSV ---------- */
function splitCSVLine(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { questions: [], errors: ['Plik jest pusty.'] };
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const head = splitCSVLine(lines[0], sep).map(h => h.toLowerCase());
  const hasHeader = head.includes('pytanie') || head.includes('poprawna');
  const idx = name => head.indexOf(name);
  const col = hasHeader
    ? { q: idx('pytanie'), a: idx('a'), b: idx('b'), c: idx('c'), d: idx('d'), ok: idx('poprawna'), cat: idx('kategoria'), pts: idx('punkty') }
    : { q: 0, a: 1, b: 2, c: 3, d: 4, ok: 5, cat: 6, pts: 7 };
  const questions = [], errors = [];
  lines.slice(hasHeader ? 1 : 0).forEach((line, i) => {
    const n = i + (hasHeader ? 2 : 1);
    const f = splitCSVLine(line, sep);
    const q = f[col.q], answers = [f[col.a], f[col.b], f[col.c], f[col.d]];
    const ok = (f[col.ok] || '').toUpperCase();
    if (!q) return errors.push(`Wiersz ${n}: brak treści pytania.`);
    if (answers.some(a => !a)) return errors.push(`Wiersz ${n}: brakuje którejś z odpowiedzi A–D.`);
    if (!'ABCD'.includes(ok) || ok.length !== 1) return errors.push(`Wiersz ${n}: kolumna „poprawna” musi być A, B, C lub D (jest „${f[col.ok] ?? ''}”).`);
    const pts = col.pts >= 0 && f[col.pts] ? Number(f[col.pts].replace(',', '.')) : 1;
    questions.push({ q, a: answers, correct: 'ABCD'.indexOf(ok), cat: col.cat >= 0 ? f[col.cat] || '' : '', pts: isFinite(pts) && pts > 0 ? pts : 1 });
  });
  return { questions, errors };
}

/* ---------- panel egzaminatora ---------- */
let adminQuestions = null;
function fillAdmin() {
  const c = config || {};
  $('cfg-title').value = c.title ?? 'Egzamin próbny';
  $('cfg-count').value = c.count ?? 10;
  $('cfg-total').value = c.totalMin ?? 15;
  $('cfg-per').value = c.perQ ?? 60;
  $('cfg-pass').value = c.pass ?? 60;
  $('cfg-exits').value = c.exits ?? 2;
  $('cfg-shuffle').checked = c.shuffle ?? true;
  $('cfg-back').checked = c.back ?? false;
  $('cfg-camera').checked = c.camera ?? true;
  $('cfg-kbd').checked = c.keyboardOnly ?? true;
  adminQuestions = c.questions || null;
  $('csv-report').textContent = adminQuestions ? `Obecna pula: ${adminQuestions.length} pytań.` : '';
}
$('csv-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const { questions, errors } = parseCSV(await file.text());
  const rep = $('csv-report');
  rep.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = `Wczytano poprawnie: ${questions.length} pytań. Błędy: ${errors.length}.`;
  rep.append(p);
  if (errors.length) {
    const ul = document.createElement('ul'); ul.className = 'error';
    errors.slice(0, 30).forEach(er => { const li = document.createElement('li'); li.textContent = er; ul.append(li); });
    rep.append(ul);
  }
  if (questions.length) adminQuestions = questions;
});
function readAdmin() {
  const num = (id, min) => Math.max(min, Number($(id).value) || 0);
  if (!adminQuestions?.length) { $('admin-msg').textContent = 'Najpierw wgraj pytania z CSV.'; return null; }
  return {
    title: $('cfg-title').value.trim() || 'Egzamin',
    count: Math.min(num('cfg-count', 1), adminQuestions.length),
    totalMin: num('cfg-total', 1), perQ: num('cfg-per', 0), pass: Math.min(100, num('cfg-pass', 0)),
    exits: num('cfg-exits', 0), shuffle: $('cfg-shuffle').checked, back: $('cfg-back').checked,
    camera: $('cfg-camera').checked, keyboardOnly: $('cfg-kbd').checked, questions: adminQuestions,
  };
}
$('btn-save').addEventListener('click', () => {
  const c = readAdmin(); if (!c) return;
  localStorage.setItem(LS_CFG, JSON.stringify(c));
  config = c; configSource = 'ustawienia zapisane na tym komputerze';
  $('admin-msg').textContent = `Zapisano: ${c.count} z ${c.questions.length} pytań, ${c.totalMin} min.`;
  loadConfig();
});
$('btn-export').addEventListener('click', () => {
  const c = readAdmin(); if (!c) return;
  download('egzamin.json', JSON.stringify(c, null, 2));
  $('admin-msg').textContent = 'Wrzuć egzamin.json obok index.html na serwerze. Uwaga: w MVP plik zawiera klucz odpowiedzi (w etapie 2 ocenianie przechodzi na serwer).';
});

/* ---------- dane zdającego i kamera ---------- */
$('btn-to-camera').addEventListener('click', async () => {
  if (!config) return ($('cand-msg').textContent = 'Brak skonfigurowanego egzaminu.');
  if (!$('cand-name').value.trim()) return ($('cand-msg').textContent = 'Podaj imię i nazwisko.');
  if (!$('cand-consent').checked) return ($('cand-msg').textContent = 'Bez zgody na nadzór nie można rozpocząć egzaminu.');
  if (!$('cand-devices').checked) return ($('cand-msg').textContent = 'Potwierdź, że nie masz okularów ani słuchawek z kamerą/elektroniką.');
  $('cand-msg').textContent = '';
  show('s-camera');
  await setupCamera();
});

const mark = (id, ok, text) => { const el = $(id); el.className = ok ? 'ok' : 'bad'; if (text) el.textContent = text; };

async function setupCamera() {
  const isChromium = /Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent);
  const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  mark('ck-browser', isChromium && !isMobile, isMobile ? 'Przeglądarka: egzamin wymaga komputera' : isChromium ? 'Przeglądarka: OK' : 'Przeglądarka: zalecany Chrome lub Edge');
  if (isMobile) return;

  if (!config.camera) {
    ['ck-cam', 'ck-models', 'ck-face'].forEach(id => mark(id, true, $(id).textContent + ' (wyłączone przez egzaminatora)'));
    await checkScreens(); $('btn-start').disabled = false; return;
  }
  try {
    await openCamera(localStorage.getItem('egz_cam') || undefined);
  } catch (e) {
    mark('ck-cam', false, cameraError(e));
    return;
  }
  await fillCameraList();
  $('cam-msg').textContent = 'Ładowanie modeli AI (pierwszy raz kilka–kilkanaście sekund)…';
  try {
    proctor = new Proctor({ onEvent: ev => logEvent(ev.type, ev.label, ev.detail, ev.img), onStatus: showStatus, snapCanvas: $('snap') });
    await proctor.init($('feed'));
    if (DEBUG) window.__proctor = proctor;
    startViews();
    mark('ck-models', true, 'Modele AI: OK');
  } catch (e) {
    console.error(e);
    mark('ck-models', false, 'Modele AI: nie udało się wczytać (sprawdź internet)');
    $('cam-msg').textContent = String(e.message || e);
    return;
  }
  await checkScreens();
  await calibrateFace();
}

// Kamera: najpierw próbujemy wyższej rozdzielczości (więcej pikseli na oko), a gdy kamera jej nie
// obsługuje – coraz skromniejszych ustawień, aż do „dowolny obraz”. Nic nie jest wymagane na sztywno.
const CAMERA_TRIES = [
  { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  { width: { ideal: 640 }, height: { ideal: 480 } },
  {},
];
async function openCamera(deviceId) {
  let lastErr;
  for (const c of CAMERA_TRIES) {
    const video = { ...c, ...(deviceId ? { deviceId: { ideal: deviceId } } : { facingMode: 'user' }) };
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: Object.keys(video).length ? video : true, audio: false });
      stream?.getTracks().forEach(t => t.stop());
      stream = s;
      break;
    } catch (e) {
      lastErr = e;
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e; // brak zgody – nie ma sensu próbować dalej
    }
  }
  if (!stream || stream.getVideoTracks()[0]?.readyState !== 'live') throw lastErr || new Error('Brak obrazu z kamery');
  $('cam-preview').srcObject = stream;
  $('feed').srcObject = stream;
  await Promise.all([$('cam-preview').play(), $('feed').play()]);
  const st = stream.getVideoTracks()[0].getSettings();
  const w = st.width || $('feed').videoWidth, h = st.height || $('feed').videoHeight;
  const label = stream.getVideoTracks()[0].label || 'kamera';
  const low = Math.min(w, h) < 360;
  mark('ck-cam', true, `Kamera: OK – ${label} (${w}×${h})` + (low ? ' – niska rozdzielczość, usiądź bliżej' : ''));
  if (low) $('ck-cam').className = 'warn';
  proctor?.attachTrack(stream.getVideoTracks()[0]);
}

function cameraError(e) {
  const n = e?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Kamera: brak zgody – kliknij ikonę kamery w pasku adresu, wybierz „Zezwalaj” i odśwież stronę.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Kamera: nie znaleziono kamery – podłącz kamerę i odśwież stronę.';
  if (n === 'NotReadableError' || n === 'AbortError') return 'Kamera: jest zajęta przez inny program (Zoom, Teams, FaceTime…) – zamknij go i odśwież stronę.';
  return 'Kamera: nie udało się uruchomić (' + (e?.message || n || 'nieznany błąd') + ')';
}

// Wybór kamery, gdy jest ich kilka (wbudowana, USB, wirtualna).
async function fillCameraList() {
  const sel = $('cam-select');
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  sel.parentElement.classList.toggle('hidden', cams.length < 2);
  const current = stream?.getVideoTracks()[0]?.getSettings().deviceId;
  sel.innerHTML = '';
  cams.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = c.deviceId; o.textContent = c.label || `Kamera ${i + 1}`;
    if (c.deviceId === current) o.selected = true;
    sel.append(o);
  });
}
$('cam-select').addEventListener('change', async e => {
  $('btn-start').disabled = true;
  try {
    await openCamera(e.target.value);
    try { localStorage.setItem('egz_cam', e.target.value); } catch {}
    if (proctor) await calibrateFace();
  } catch (err) { mark('ck-cam', false, cameraError(err)); }
});

// Kalibracja pozycji + ocena jakości obrazu (światło, rozdzielczość, odległość).
async function calibrateFace() {
  $('cam-msg').textContent = 'Patrz w ekran – kalibracja…';
  mark('ck-face', false, 'Szukam twarzy…'); $('ck-face').className = '';
  for (let i = 0; i < 25; i++) {
    if (proctor.last.faces === 1 && await proctor.calibrate()) {
      mark('ck-face', true, 'Twarz i kalibracja: OK');
      const q = qualityReport();
      $('cam-msg').textContent = q.msg;
      $('btn-start').disabled = q.block;
      return;
    }
    const dark = proctor.last.brightness !== undefined && proctor.last.brightness < 40;
    mark('ck-face', false, proctor.last.faces > 1 ? 'W kadrze jest więcej niż jedna osoba' : dark ? 'Za ciemno – zapal światło przed sobą (nie za plecami)' : 'Nie widzę twarzy – ustaw kamerę na wysokości oczu i usiądź na wprost');
    await new Promise(r => setTimeout(r, 1000));
  }
  $('cam-msg').textContent = 'Nie udało się skalibrować. Popraw światło i pozycję albo wybierz inną kamerę, potem odśwież stronę.';
}

function qualityReport() {
  const L = proctor.last, f = L.f || {}, v = $('feed');
  const notes = [];
  let block = false, warn = false;
  // Twarz została już wykryta i skalibrowana, więc ciemny obraz tylko ostrzega (nie blokuje).
  if (L.brightness !== undefined && L.brightness < 70) { notes.push('Twarz jest słabo oświetlona – zapal światło przed sobą (nie za plecami), wykrywanie będzie dokładniejsze.'); warn = true; }
  if (f.eyePx !== undefined && f.eyePx < 14) { notes.push(`Oczy są za małe na obrazie (${Math.round(f.eyePx)} px) – usiądź bliżej kamery. Śledzenie źrenic będzie wyłączone, działa śledzenie głowy.`); warn = true; }
  if (f.size !== undefined && f.size < 0.18) { notes.push('Twarz jest daleko od kamery – przysuń się.'); warn = true; }
  if (Math.min(v.videoWidth, v.videoHeight) < 240) { notes.push('Kamera ma bardzo niską rozdzielczość – wybierz inną, jeśli masz.'); warn = true; }
  const bad = L.objects.filter(o => o.name === 'cell phone' || o.name === 'book');
  if (bad.length) notes.push('W kadrze widać telefon lub książkę – usuń je z biurka.');
  mark('ck-quality', !block && !warn, block ? 'Jakość obrazu: za słaba' : warn ? 'Jakość obrazu: wystarczająca, ale można poprawić' : `Jakość obrazu: dobra (${v.videoWidth}×${v.videoHeight}, oko ${Math.round(f.eyePx || 0)} px)`);
  if (warn && !block) $('ck-quality').className = 'warn';
  return { block, msg: notes.length ? notes.join(' ') : 'Wszystko gotowe.' };
}

async function checkScreens() {
  let multi = false;
  try { multi = !!window.screen.isExtended; } catch {}
  mark('ck-screens', !multi, multi ? 'Wykryto drugi monitor – odłącz go przed egzaminem' : 'Jeden monitor: OK');
}

/* ---------- egzamin ---------- */
const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

$('btn-start').addEventListener('click', async () => {
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); }
  catch { $('cam-msg').textContent = 'Nie udało się włączyć pełnego ekranu.'; return; }
  if (proctor) {
    const ok = await gazeCalibration();
    if (!ok) $('cam-msg').textContent = 'Kalibracja wzroku nieudana – używam pozycji startowej.';
  }
  const picked = shuffle(config.questions).slice(0, config.count).map(q => ({
    ...q, order: config.shuffle ? shuffle([0, 1, 2, 3]) : [0, 1, 2, 3], chosen: null, timeMs: 0,
  }));
  const now = Date.now();
  exam = {
    candidate: { name: $('cand-name').value.trim(), id: $('cand-id').value.trim() },
    startedAt: now, endsAt: now + config.totalMin * 60000,
    qs: picked, i: 0, qStart: now, events: [], snaps: 0, fsExits: 0, status: 'w toku',
  };
  $('watermark').textContent = `${exam.candidate.name} ${exam.candidate.id} `.repeat(400);
  if (!stream) { $('pip-status').textContent = ''; document.querySelector('.pip').classList.add('hidden'); }
  show('s-exam');
  document.body.classList.toggle('kbd-only', config.keyboardOnly !== false);
  lockInput();
  attachGuards();
  scanExistingInjections();
  if (window.screen.isExtended) logEvent('multi_monitor', 'Drugi monitor', 'przy starcie');
  proctor?.start();
  if (proctor && !proctor.box) logEvent('calibration_failed', 'Kalibracja wzroku nieudana', 'za mało klatek z widoczną twarzą');
  if (proctor) logEvent('start_photo', 'Zdjęcie startowe (sprawdź okulary, słuchawki, otoczenie)', '', proctor.snapshot());
  renderQuestion();
  exam.timer = setInterval(tickTimers, 250);
});

function perQLimit() { return config.perQ > 0 && !config.back ? config.perQ * 1000 : 0; }

function renderQuestion() {
  const q = exam.qs[exam.i];
  exam.qStart = Date.now();
  $('q-progress').textContent = `Pytanie ${exam.i + 1} z ${exam.qs.length}`;
  $('q-text').textContent = q.q;
  const box = $('q-answers'); box.innerHTML = '';
  q.order.forEach((orig, pos) => {
    const b = document.createElement('button');
    if (q.chosen === orig) b.classList.add('sel');
    b.innerHTML = `<kbd>${pos + 1}</kbd> `; b.append(`${'ABCD'[pos]}. ${q.a[orig]}`);
    b.tabIndex = -1;
    if (config.keyboardOnly === false) b.addEventListener('click', () => { q.chosen = orig; renderSelection(); });
    box.append(b);
  });
  $('btn-prev').classList.toggle('hidden', !config.back || exam.i === 0);
  $('btn-next').textContent = exam.i === exam.qs.length - 1 ? 'Zakończ egzamin (Enter)' : 'Dalej (Enter)';
  $('btn-prev').textContent = 'Poprzednie (←)';
}
function renderSelection() {
  const q = exam.qs[exam.i];
  [...$('q-answers').children].forEach((b, pos) => b.classList.toggle('sel', q.order[pos] === q.chosen));
}
function leaveQuestion() { exam.qs[exam.i].timeMs += Date.now() - exam.qStart; }

$('btn-next').addEventListener('click', () => nextQuestion(false));
$('btn-prev').addEventListener('click', () => { leaveQuestion(); exam.i--; renderQuestion(); });

function nextQuestion(auto) {
  if (!exam) return;
  if (!auto && exam.i === exam.qs.length - 1 && exam.qs.some(q => q.chosen === null) && Date.now() - (exam.confirmAt || 0) > 5000) {
    exam.confirmAt = Date.now();
    return showWarn('Nie wszystkie pytania mają odpowiedź. Naciśnij Enter jeszcze raz, aby zakończyć egzamin.');
  }
  leaveQuestion();
  if (exam.i >= exam.qs.length - 1) return finish('ukończony');
  exam.i++; renderQuestion();
}

const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function tickTimers() {
  const now = Date.now();
  const left = exam.endsAt - now;
  $('t-total').textContent = `Do końca: ${fmt(left)}`;
  $('t-total').classList.toggle('low', left < 60000);
  const lim = perQLimit();
  if (lim) {
    const ql = exam.qStart + lim - now;
    $('q-timer').textContent = `Na to pytanie: ${fmt(ql)}`;
    $('q-timer').classList.toggle('low', ql < 10000);
    if (ql <= 0) nextQuestion(true);
  } else $('q-timer').textContent = '';
  if (left <= 0) finish('koniec czasu');
}

/* ---------- strażnicy przeglądarki ---------- */
let guards = [];
function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); guards.push(() => target.removeEventListener(type, fn, opts)); }

let blurAt = 0, lastResize = 0, mo = null;
function attachGuards() {
  on(document, 'visibilitychange', () => { if (document.hidden) logEvent('tab_hidden', 'Przełączenie karty / zminimalizowanie okna'); });
  on(window, 'blur', () => { blurAt = Date.now(); });
  on(window, 'focus', () => {
    if (blurAt) logEvent('focus_lost', 'Utrata fokusu okna', `${((Date.now() - blurAt) / 1000).toFixed(1)} s poza oknem`);
    blurAt = 0;
  });
  on(document, 'fullscreenchange', () => {
    if (document.fullscreenElement || !exam) return;
    exam.fsExits++;
    logEvent('fullscreen_exit', 'Wyjście z pełnego ekranu', `${exam.fsExits} z dozwolonych ${config.exits}`);
    if (exam.fsExits > config.exits) return finish('przerwany: za dużo wyjść z pełnego ekranu');
    showWarn(`Wróć do pełnego ekranu. Pozostałe dozwolone wyjścia: ${config.exits - exam.fsExits}.`, true);
  });
  for (const t of ['copy', 'cut', 'paste']) on(document, t, e => { e.preventDefault(); logEvent('clipboard', 'Próba kopiowania/wklejania', t); });
  on(document, 'contextmenu', e => e.preventDefault());
  on(document, 'selectstart', e => { if (!e.target.closest?.('input')) e.preventDefault(); });
  on(document, 'dragstart', e => e.preventDefault());
  on(window, 'keydown', e => {
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const blocked = (mod && ['c', 'v', 'x', 'a', 'p', 's', 'u', 'f', 'g'].includes(k))
      || (mod && e.shiftKey && ['i', 'j', 'c', 'k'].includes(k))
      || (e.metaKey && e.altKey && ['i', 'j', 'c'].includes(k))
      || k === 'f12' || k === 'printscreen';
    if (blocked) { e.preventDefault(); logEvent('blocked_key', 'Zablokowany skrót klawiszowy', shortcut(e)); return; }
    if (mod || e.altKey || e.repeat) return;
    // Sterowanie egzaminem tylko z klawiatury: 1–4 / A–D wybór, Enter lub → dalej, ← wstecz.
    const pos = { '1': 0, '2': 1, '3': 2, '4': 3, a: 0, b: 1, c: 2, d: 3 }[k];
    if (pos !== undefined) { e.preventDefault(); const q = exam.qs[exam.i]; q.chosen = q.order[pos]; renderSelection(); }
    else if (k === 'enter' || k === 'arrowright') { e.preventDefault(); nextQuestion(false); }
    else if (k === 'arrowleft' && config.back && exam.i > 0) { e.preventDefault(); leaveQuestion(); exam.i--; renderQuestion(); }
    else if (k === 'tab') e.preventDefault();
    if (exam && !document.pointerLockElement) lockInput();
  }, true);
  // Myszka: w trybie klawiatury kliknięcia są ignorowane, kursor ukryty i zablokowany w oknie.
  for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'wheel']) on(window, t, e => {
    if (config.keyboardOnly === false || e.target.closest?.('#warn')) return;
    e.preventDefault(); e.stopPropagation();
  }, { capture: true, passive: false });
  on(document, 'pointerlockchange', () => {
    if (!exam || document.pointerLockElement || config.keyboardOnly === false) return;
    logEvent('pointer_unlock', 'Odblokowanie myszki', 'kursor mógł opuścić okno egzaminu');
  });
  on(window, 'keyup', e => { if (e.key === 'PrintScreen') logEvent('blocked_key', 'Zrzut ekranu (PrintScreen)', ''); });
  on(window, 'resize', () => {
    const now = Date.now();
    if (now - lastResize > 5000 && (window.innerWidth < screen.width * 0.9 || window.innerHeight < screen.height * 0.8)) {
      lastResize = now; logEvent('window_resized', 'Zmniejszone okno (możliwe narzędzia deweloperskie lub panel)', `${innerWidth}×${innerHeight}`);
    }
  });
  try { if (screen.addEventListener) on(screen, 'change', () => { if (screen.isExtended) logEvent('multi_monitor', 'Podłączono drugi monitor'); }); } catch {}

  // Wykrywanie elementów wstrzykniętych przez rozszerzenia (np. panele asystentów AI).
  mo = new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1 || isOurs(n)) continue;
      logEvent('dom_injection', 'Element wstrzyknięty przez rozszerzenie', describe(n));
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}
function isOurs(n) {
  const app = $('app');
  if (app.contains(n)) return !n.tagName.includes('-');
  return n.id === 'snap' || n.id === 'feed' || n.tagName === 'SCRIPT' && n.src?.includes('cdn.jsdelivr.net/npm/@mediapipe');
}
function describe(n) { return `<${n.tagName.toLowerCase()}${n.id ? ' id=' + n.id : ''}${n.className && typeof n.className === 'string' ? ' class=' + n.className.slice(0, 40) : ''}>`; }
function scanExistingInjections() {
  const foreign = [...document.documentElement.querySelectorAll('*')].filter(n =>
    !$('app').contains(n) && !['HEAD', 'BODY', 'META', 'TITLE', 'LINK', 'SCRIPT', 'STYLE'].includes(n.tagName) && n.id !== 'snap' && n.id !== 'feed' && n.parentElement && !n.closest('head'));
  const custom = [...document.querySelectorAll('*')].filter(n => n.tagName.includes('-'));
  const all = [...new Set([...foreign, ...custom])];
  if (all.length) logEvent('extension_present', 'Elementy obce na stronie przy starcie (rozszerzenia)', all.slice(0, 5).map(describe).join(', '));
}
function shortcut(e) { return [e.ctrlKey && 'Ctrl', e.metaKey && 'Cmd', e.altKey && 'Alt', e.shiftKey && 'Shift', e.key].filter(Boolean).join('+'); }
function detachGuards() {
  guards.forEach(f => f()); guards = []; mo?.disconnect();
  document.body.classList.remove('kbd-only');
  try { document.exitPointerLock(); navigator.keyboard?.unlock?.(); } catch {}
}

// Blokada myszki (Pointer Lock) i klawiszy systemowych w pełnym ekranie (Keyboard Lock, Chrome/Edge).
function lockInput() {
  if (config.keyboardOnly === false) return;
  try { const r = document.body.requestPointerLock({ unadjustedMovement: true }); r?.catch?.(() => document.body.requestPointerLock()?.catch?.(() => {})); } catch {}
  try { navigator.keyboard?.lock?.().catch(() => {}); } catch {}
}

function showStatus(st) {
  const el = $('pip-status'); if (!el || !exam) return;
  const face = st.faces === 1 ? 'twarz ✓' : st.faces === 0 ? 'brak twarzy' : `${st.faces} twarze`;
  const n = x => x == null ? '–' : x.toFixed(2), deg = x => x == null ? '–' : Math.round(x) + '°';
  el.textContent = `Nadzór: ${face}, wzrok ${st.looking}` + (DEBUG ? ` · źr ${n(st.ih)}/${n(st.iv)} · pow ${n(st.ear)} · usta ${n(st.mouth)} · gł ${deg(st.hyaw)}/${deg(st.hpitch)} · ${st.calibrated ? 'kalibr. 5 pkt' : 'kalibr. 1 pkt'} · ${st.delegate} ${Math.round(st.faceMs || 0)}/${Math.round(st.objMs || 0)} ms co ${st.objEvery} · ${st.why} · tel ${Math.round(st.phone * 100)}% · ${st.objects.map(o => o.name + ' ' + Math.round(o.score * 100)).join(', ')}` : '');
  document.querySelector('.pip').classList.toggle('alert', st.faces !== 1 || st.looking !== 'w ekran');
}

// Podgląd śledzenia (kadr na twarz + oczy) rysowany płynnie w każdej klatce.
function startViews() {
  const draw = () => {
    if (proctor) {
      if (!$('s-camera').classList.contains('hidden')) drawFaceView($('cam-view'), $('feed'), proctor);
      if (exam && stream) drawFaceView($('pip-view'), $('feed'), proctor);
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

// Kalibracja wzroku: 5 punktów (środek i rogi ekranu) – wyznacza zakres „patrzę w ekran” dla
// źrenic i głowy tej konkretnej osoby. Spojrzenie poza ten zakres = patrzenie poza ekran.
async function gazeCalibration() {
  const pts = [[50, 50], [6, 8], [94, 8], [94, 92], [6, 92], [50, 50]];
  show('s-calib');
  const dot = $('calib-dot'), out = [];
  for (const [x, y] of pts) {
    dot.style.left = x + '%'; dot.style.top = y + '%';
    dot.classList.remove('pulse'); void dot.offsetWidth; dot.classList.add('pulse');
    await new Promise(r => setTimeout(r, 700));      // czas na przeniesienie wzroku
    out.push(await proctor.collectPoint(1300));
  }
  return proctor.setBox(out);
}

let warnTimer;
function showWarn(text, withButton) {
  const w = $('warn'); w.innerHTML = '';
  w.append(document.createTextNode(text + ' '));
  if (withButton) {
    const b = document.createElement('button'); b.textContent = 'Wróć do pełnego ekranu';
    b.addEventListener('click', async () => { try { await document.documentElement.requestFullscreen(); w.classList.add('hidden'); } catch {} });
    w.append(b);
  }
  w.classList.remove('hidden');
  clearTimeout(warnTimer);
  if (!withButton) warnTimer = setTimeout(() => w.classList.add('hidden'), 4000);
}

/* ---------- zdarzenia ---------- */
function logEvent(type, label, detail = '', img = null) {
  if (!exam || exam.status !== 'w toku') return;
  if (!img && proctor && !['blocked_key', 'clipboard', 'start_photo'].includes(type)) img = proctor.snapshot();
  if (img && exam.snaps >= MAX_SNAPS) img = null;
  if (img) exam.snaps++;
  const ev = { t: Date.now() - exam.startedAt, at: new Date().toISOString(), type, label, detail, weight: WEIGHTS[type] ?? 1, q: exam.i + 1, img };
  exam.events.push(ev);
  if (DEBUG) window.__events = exam.events;
  if (type === 'start_photo') return;
  const camera = ['no_face', 'multi_face', 'look_down', 'look_left', 'look_right', 'look_up', 'talking', 'face_moved', 'phone', 'book', 'person', 'dark', 'frozen', 'camera_off'].includes(type);
  if (camera) {
    document.querySelector('.pip').classList.add('alert');
    setTimeout(() => document.querySelector('.pip')?.classList.remove('alert'), 3000);
    showWarn(`${label}. Zdarzenie zostało zapisane.`);
  } else if (type !== 'fullscreen_exit') showWarn(`${label} – zapisano w raporcie.`);
}

/* ---------- zakończenie i raport ---------- */
function finish(status) {
  if (!exam || exam.status !== 'w toku') return;
  if (status !== 'ukończony') leaveQuestion();
  exam.status = status;
  clearInterval(exam.timer);
  proctor?.stop(); detachGuards();
  stream?.getTracks().forEach(t => t.stop());
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('warn').classList.add('hidden');

  const max = exam.qs.reduce((s, q) => s + q.pts, 0);
  const score = exam.qs.reduce((s, q) => s + (q.chosen === q.correct ? q.pts : 0), 0);
  const percent = max ? Math.round(score / max * 1000) / 10 : 0;
  const risk = exam.events.reduce((s, e) => s + e.weight, 0);
  lastReport = {
    exam: config.title, candidate: exam.candidate, status,
    startedAt: new Date(exam.startedAt).toISOString(), finishedAt: new Date().toISOString(),
    score, max, percent, passed: percent >= config.pass, risk, riskLevel: riskLevel(risk),
    settings: { count: config.count, totalMin: config.totalMin, perQ: config.perQ, pass: config.pass, exits: config.exits },
    answers: exam.qs.map(q => ({ question: q.q, chosen: q.chosen === null ? null : 'ABCD'[q.chosen], correct: 'ABCD'[q.correct], ok: q.chosen === q.correct, timeMs: q.timeMs })),
    events: exam.events,
  };
  exam = null;
  saveReport(lastReport);
  renderReport(lastReport, $('result-summary'), $('result-events'));
  show('s-result');
}
const riskLevel = r => r < 5 ? 'niskie' : r < 15 ? 'średnie' : 'wysokie';

function saveReport(rep) {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(LS_REP)) || []; } catch {}
  list.unshift(rep);
  for (let keep = list.length; keep > 0; keep--) {
    try { localStorage.setItem(LS_REP, JSON.stringify(list.slice(0, keep))); return; } catch {}
    // brak miejsca: usuń zrzuty ze starszych raportów
    list.slice(1).forEach(r => r.events.forEach(e => { e.img = null; }));
  }
}

function renderReport(rep, summaryEl, eventsEl) {
  const cls = { niskie: 'risk-low', średnie: 'risk-mid', wysokie: 'risk-high' }[rep.riskLevel];
  summaryEl.innerHTML = '';
  const p = (html) => { const el = document.createElement('p'); el.innerHTML = html; summaryEl.append(el); };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  p(`<strong>${esc(rep.candidate.name)}</strong> ${esc(rep.candidate.id)} · ${esc(rep.exam)} · status: ${esc(rep.status)}`);
  p(`Wynik: <strong>${rep.score} / ${rep.max} (${rep.percent}%)</strong> – ${rep.passed ? 'zaliczony' : 'niezaliczony'}`);
  p(`Ryzyko nieuczciwości: <strong class="${cls}">${rep.riskLevel}</strong> (${rep.risk} pkt, ${rep.events.length} zdarzeń). Decyzję podejmuje egzaminator.`);
  eventsEl.innerHTML = '';
  if (!rep.events.length) { eventsEl.textContent = 'Brak zdarzeń.'; return; }
  const t = document.createElement('table');
  t.innerHTML = '<thead><tr><th>Czas</th><th>Pytanie</th><th>Zdarzenie</th><th>Szczegóły</th><th>Waga</th><th>Zrzut</th></tr></thead>';
  const tb = document.createElement('tbody');
  rep.events.forEach(e => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtT(e.t)}</td><td>${e.q}</td><td>${esc(e.label)}</td><td>${esc(e.detail)}</td><td>${e.weight}</td><td></td>`;
    if (e.img) { const im = new Image(); im.src = e.img; im.alt = 'zrzut z kamery'; tr.lastChild.append(im); }
    tb.append(tr);
  });
  t.append(tb); eventsEl.append(t);
}
const fmtT = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function renderReports() {
  const box = $('reports-list'); box.innerHTML = '';
  let list = [];
  try { list = JSON.parse(localStorage.getItem(LS_REP)) || []; } catch {}
  if (!list.length) { box.textContent = 'Brak zapisanych prób.'; return; }
  list.forEach((rep, i) => {
    const d = document.createElement('details');
    const s = document.createElement('summary');
    s.textContent = `${new Date(rep.startedAt).toLocaleString('pl-PL')} · ${rep.candidate.name} · ${rep.percent}% · ryzyko ${rep.riskLevel} (${rep.events.length} zdarzeń)`;
    const sum = document.createElement('div'), ev = document.createElement('div');
    const dl = document.createElement('button'); dl.textContent = 'Pobierz JSON';
    dl.addEventListener('click', () => download(`raport-${i + 1}.json`, JSON.stringify(rep, null, 2)));
    d.append(s, sum, dl, ev); box.append(d);
    renderReport(rep, sum, ev);
  });
}

$('btn-download').addEventListener('click', () => lastReport && download(
  `raport-${lastReport.candidate.name.replace(/\s+/g, '_')}-${lastReport.startedAt.slice(0, 16).replace(/[:T]/g, '-')}.json`,
  JSON.stringify(lastReport, null, 2)));

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

window.addEventListener('beforeunload', e => { if (exam) { e.preventDefault(); e.returnValue = ''; } });

loadConfig();
