/*! デイリー任務 DEMO — rule-based, offline PWA */
(function () {
  'use strict';

  const STORAGE = 'daily-tasks-demo-v1';
  const MUTE_KEY = 'daily-tasks-demo-mute';
  const WEEKDAYS = { '日':0,'月':1,'火':2,'水':3,'木':4,'金':5,'土':6 };
  const WEEKDAY_NAMES = ['日','月','火','水','木','金','土'];
  const SLOT_TIMES = { '朝':'08:00', '昼':'12:00', '夜':'20:00' };
  const STATUS_LABEL = {
    unaccepted:'未受注', in_progress:'進行中', completed:'完了',
    failed:'失敗', pending_review:'未確認'
  };

  const SE = {
    click: null,
    check: 'se/check.mp3',
    deliver: 'se/deliver.mp3',
    complete: 'se/complete.mp3',
    start: 'se/start.mp3',
    fail: 'se/fail.mp3'
  };

  let state = null;
  let selectedId = null;
  let muted = localStorage.getItem(MUTE_KEY) === '1';
  let audioCtx = null;
  let pendingFailSound = false;
  let editingMainId = null;
  let pendingPreview = null; // chat preview awaiting confirm
  let notifPermissionAsked = false;
  let medNotifTimers = [];
  let editingMedId = null;
  const SHOW_DONE_KEY = 'daily-tasks-demo-show-completed';
  const COLLAPSE_KEY = 'daily-tasks-demo-collapsed-groups';
  let showCompleted = localStorage.getItem(SHOW_DONE_KEY) !== '0';
  let collapsedGroups = (() => { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {}; } catch (_) { return {}; } })();

  // ===== UTIL =====
  const uid = () => 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const todayKey = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  };
  function dateKeyFromDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function addDaysKey(key, delta) {
    const p = String(key).split('-').map(Number);
    const d = new Date(p[0], p[1]-1, p[2]);
    d.setDate(d.getDate() + delta);
    return dateKeyFromDate(d);
  }
  function tomorrowKey() { return addDaysKey(todayKey(), 1); }
  function localDayKeyFromIso(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return dateKeyFromDate(d);
  }

  function weekdayOfKey(key) {
    const p = String(key).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).getDay();
  }
  function isLaundryCleanDay(key) {
    const w = weekdayOfKey(key || todayKey());
    return w === 1 || w === 4; // 月・木
  }
  function isTrashDay(key) {
    const w = weekdayOfKey(key || todayKey());
    return w === 2 || w === 5; // 火・金
  }
  function isSystemTask(t) {
    return !!(t && (t.isMedDaily || t.isBathDaily || t.isLaundryDaily || t.isCleanDaily || t.isTrashDaily));
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // ===== AUDIO =====
  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function synthClick() {
    try {
      const ctx = ensureAudio(); const t = ctx.currentTime;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(500, t + 0.03);
      g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.045);
    } catch (_) {}
  }

  const audioCache = {};
  async function playSound(type) {
    if (muted) return false;
    try {
      if (type === 'click' || !SE[type]) { synthClick(); return true; }
      ensureAudio();
      if (!audioCache[type]) {
        audioCache[type] = new Audio(SE[type]);
        audioCache[type].preload = 'auto';
      }
      const a = audioCache[type].cloneNode();
      a.volume = 0.85;
      await a.play();
      return true;
    } catch (e) {
      if (type === 'fail') pendingFailSound = true;
      console.warn('SE play failed', type, e);
      return false;
    }
  }

  function markGesture() {
    try { ensureAudio(); } catch (_) {}
    if (pendingFailSound && !muted) {
      pendingFailSound = false;
      playSound('fail');
    }
  }
  document.addEventListener('pointerdown', markGesture, true);

  // ===== STATE =====
  function exampleState() {
    const tmr = new Date(); tmr.setDate(tmr.getDate() + 1); tmr.setHours(10, 0, 0, 0);
    const st = {
      tasks: [
        {
          id: 'ex_m1', title: '朝の作戦準備', trader: 'Prapor風 / 自分',
          desc: '【サンプル】起床〜作業開始までの一連任務',
          isExample: true, status: 'in_progress', deadline: null, reward: '',
          failSoundPlayed: false, acceptedAt: Date.now() - 3600000,
          subs: [
            { id: 'ex_s1', title: 'アラームを止めて水を飲む', kind: 'check', target: 1, current: 1, done: true },
            { id: 'ex_s2', title: '水を飲む（コップ）', kind: 'count', target: 3, current: 1, done: false },
            { id: 'ex_s3', title: '今日のカレンダーを開く', kind: 'check', target: 1, current: 0, done: false }
          ],
          deliveries: [
            { id: 'ex_d1', name: '朝食ログ', qty: 1, type: 'deliverable', done: false },
            { id: 'ex_d2', name: 'プロテインバー', qty: 1, type: 'purchase', done: false }
          ]
        },
        {
          id: 'ex_m3', title: '住民票を取りに行く', trader: '自分',
          desc: '【サンプル】期限付き・持ち物つき任務', location: '市役所',
          isExample: true, status: 'unaccepted', deadline: tmr.toISOString(), reward: '',
          failSoundPlayed: false, acceptedAt: null,
          subs: [
            { id: 'ex_s6', title: '印鑑', kind: 'item', target: 1, current: 0, done: false },
            { id: 'ex_s7', title: '本人確認書類', kind: 'item', target: 1, current: 0, done: false },
            { id: 'ex_s8', title: '窓口で住民票を受け取る', kind: 'check', target: 1, current: 0, done: false }
          ],
          deliveries: []
        },
        {
          id: 'ex_m2', title: 'デスク・クリアランス', trader: 'Therapist風 / 自分',
          desc: '【サンプル】受注前の任務',
          isExample: true, status: 'unaccepted', deadline: null, reward: '',
          failSoundPlayed: false, acceptedAt: null,
          subs: [
            { id: 'ex_s4', title: '机の上を片付ける', kind: 'check', target: 1, current: 0, done: false },
            { id: 'ex_s5', title: '明日のタスクを書く', kind: 'count', target: 3, current: 0, done: false }
          ],
          deliveries: [
            { id: 'ex_d3', name: '週次メモ.md', qty: 1, type: 'deliverable', done: false }
          ]
        }
      ],
      shopping: [
        { id: 'ex_sh1', name: '牛乳', qty: 1, checked: false, note: 'サンプル', isExample: true },
        { id: 'ex_sh2', name: '卵', qty: 10, checked: false, note: 'サンプル', isExample: true },
        { id: 'ex_sh3', name: 'ティッシュ', qty: 1, checked: true, note: 'サンプル', isExample: true }
      ],
      medications: [
        {
          id: 'ex_med1', name: 'ビタミン', dose: '1錠',
          times: ['08:00'], linkToDailyTask: true, enabled: true, isExample: true
        },
        {
          id: 'ex_med2', name: '目薬', dose: '両目1滴',
          times: ['20:00'], linkToDailyTask: true, enabled: true, isExample: true
        }
      ],
      medLog: {}, // { 'YYYY-MM-DD': { medId_timeKey: true } }
      chat: [
        { id: 'c0', role: 'bot', text: 'こんにちは。自然な日本語で追加できます。\n例:「明日15時に歯医者」「牛乳と卵を買う」「毎朝8時にビタミンを飲む」「部屋の掃除」', ts: Date.now() }
      ],
      settings: { medLinkDailyTask: true },
      pendingReviewIds: [],
      bathLog: {},
      localOutings: {},
      bathMeta: { lastSeenDay: null, streakWarnedFor: null },
      laundryLog: {},
      cleanLog: {},
      trashLog: {},
      choreMeta: { lastSeenDay: null, warnedFor: null },
      dailyRequired: [],
      dailyLog: {}
    };
    return migrateObjectives(st);
  }

  function normalizeLoaded(p) {
    if (!p || !Array.isArray(p.tasks)) return null;
    p.shopping = p.shopping || [];
    p.medications = p.medications || [];
    p.medLog = p.medLog || {};
    p.chat = p.chat || [];
    p.settings = p.settings || { medLinkDailyTask: true };
    p.pendingReviewIds = p.pendingReviewIds || [];
    p.bathLog = p.bathLog || {};
    p.localOutings = p.localOutings || {};
    p.bathMeta = p.bathMeta || { lastSeenDay: null, streakWarnedFor: null };
    p.laundryLog = p.laundryLog || {};
    p.cleanLog = p.cleanLog || {};
    p.trashLog = p.trashLog || {};
    p.choreMeta = p.choreMeta || { lastSeenDay: null, warnedFor: null };
    p.dailyRequired = Array.isArray(p.dailyRequired) ? p.dailyRequired : [];
    p.dailyLog = p.dailyLog || {};
    migrateMedications(p);
    migrateObjectives(p);
    return p;
  }

  function loadStateSyncFallback() {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) {
        const n = normalizeLoaded(JSON.parse(raw));
        if (n) return n;
      }
    } catch (_) {}
    return null;
  }

  async function loadStateAsync() {
    try {
      if (window.DataLayer) {
        const p = normalizeLoaded(await DataLayer.load());
        if (p) return p;
      }
    } catch (e) { console.warn('DataLayer.load', e); }
    const fb = loadStateSyncFallback();
    if (fb) return fb;
    const ex = exampleState();
    await saveAsync(ex);
    return ex;
  }

  function loadState() {
    // sync path for early callers; prefer cache already in memory after init
    return loadStateSyncFallback() || exampleState();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(state));
    } catch (e) { console.warn('local save failed', e); }
    if (window.DataLayer) {
      DataLayer.save(state).catch((e) => console.warn('DataLayer.save', e));
    }
  }

  async function saveAsync(s) {
    const payload = s || state;
    try { localStorage.setItem(STORAGE, JSON.stringify(payload)); } catch (_) {}
    if (window.DataLayer) await DataLayer.save(payload);
  }

  function updateDataLayerStatus() {
    const el = document.getElementById('dataLayerStatus');
    if (!el) return;
    const st = window.DataLayer ? DataLayer.getStatus() : { mode: 'legacy', note: 'adapter未読込' };
    el.textContent = 'データ層: ' + st.mode + (st.note ? ' — ' + st.note : '');
  }

  function getTask(id) { return state.tasks.find(t => t.id === id); }

  // ===== OBJECTIVES（目標: check / count / item） =====
  // subs[] = 目標。kind: 'check'（チェック） | 'count'（回数・数量 current/target） | 'item'（必要物品・持ち物）
  // target 既定 1。target=1 の check/item は done が真実、count または target>1 は current が真実（done は current>=target に同期）
  const OBJ_KINDS = ['check', 'count', 'item'];
  function objTarget(o) {
    const n = parseInt(o && o.target, 10);
    return n > 0 ? Math.min(n, 9999) : 1;
  }
  function objUsesCount(o) { return !!o && (o.kind === 'count' || objTarget(o) > 1); }
  function objCurrent(o) {
    const tg = objTarget(o);
    if (!objUsesCount(o)) return o && o.done ? 1 : 0;
    const c = Number(o.current);
    if (!Number.isFinite(c)) return o.done ? tg : 0;
    return Math.max(0, Math.min(tg, Math.floor(c)));
  }
  function objDone(o) { return objCurrent(o) >= objTarget(o); }
  function setObjCurrent(o, n) {
    const tg = objTarget(o);
    o.current = Math.max(0, Math.min(tg, Math.floor(Number(n) || 0)));
    o.done = o.current >= tg;
  }
  function setObjDone(o, done) {
    o.done = !!done;
    o.current = done ? objTarget(o) : 0;
  }
  function normalizeObjective(o) {
    if (!o || typeof o !== 'object') return o;
    let title = String(o.title == null ? '' : o.title);
    if (!OBJ_KINDS.includes(o.kind)) {
      const m = title.match(/^持ち物[:：]\s*(.+)$/);
      if (m) { o.kind = 'item'; title = m[1].trim(); } else o.kind = 'check';
    }
    o.title = title;
    o.target = objTarget(o);
    const cur = objUsesCount(o) && Number.isFinite(Number(o.current)) ? Number(o.current) : (o.done ? o.target : 0);
    setObjCurrent(o, cur);
    return o;
  }
  function migrateObjectives(st) {
    (st.tasks || []).forEach(t => {
      t.subs = Array.isArray(t.subs) ? t.subs : [];
      t.deliveries = Array.isArray(t.deliveries) ? t.deliveries : [];
      t.subs.forEach(normalizeObjective);
      if (t.reward == null) t.reward = '';
    });
    return st;
  }
  function makeObjective(title, kind, target) {
    return normalizeObjective({ id: uid(), title, kind: kind || 'check', target: target || 1, current: 0, done: false });
  }

  function taskProgress(task) {
    const subs = task.subs || [];
    const dels = task.deliveries || [];
    const total = subs.length + dels.length;
    const done = subs.filter(objDone).length + dels.filter(d => d.done).length;
    return { done, total, pct: total ? Math.round(done/total*100) : 0 };
  }

  function objectivesComplete(task) {
    const p = taskProgress(task);
    return p.total > 0 && p.done === p.total;
  }

  function effectiveStatus(task) {
    if (task.status === 'pending_review') return 'pending_review';
    if (task.status === 'failed') return 'failed';
    if (task.status === 'unaccepted') return 'unaccepted';
    if (task.status === 'completed' || (task.status === 'in_progress' && objectivesComplete(task))) return 'completed';
    return 'in_progress';
  }

  function syncCompletion(task) {
    if (task.status === 'in_progress' && objectivesComplete(task)) {
      task.status = 'completed';
      return true;
    }
    if (task.status === 'completed' && !objectivesComplete(task)) task.status = 'in_progress';
    return false;
  }

  function checkDeadlines() {
    const now = Date.now();
    let changed = false;
    const newly = [];
    state.tasks.forEach(t => {
      if (!t.deadline || t.status !== 'in_progress' || objectivesComplete(t)) return;
      const dl = Date.parse(t.deadline);
      if (!isNaN(dl) && now > dl) {
        t.status = 'failed';
        changed = true;
        if (!t.failSoundPlayed) newly.push(t);
      }
    });
    if (newly.length) {
      newly.forEach(t => { t.failSoundPlayed = true; });
      playSound('fail').then(ok => { if (!ok) pendingFailSound = true; });
    }
    if (changed) save();
    return changed;
  }

  // ===== MEDICATION HELPERS =====
  const TIME_TO_SLOT = Object.fromEntries(Object.entries(SLOT_TIMES).map(([k,v]) => [v, k]));

  function canonicalizeTimeToken(t) {
    if (t == null) return null;
    const s = String(t).trim();
    if (!s) return null;
    if (SLOT_TIMES[s]) return SLOT_TIMES[s];
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const h = Math.min(23, parseInt(m[1], 10));
      const mi = Math.min(59, parseInt(m[2], 10));
      return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
    }
    return null;
  }

  function dedupeTimes(arr) {
    const out = [];
    const seen = new Set();
    (arr || []).forEach(t => {
      const c = canonicalizeTimeToken(t);
      if (!c || seen.has(c)) return;
      seen.add(c);
      out.push(c);
    });
    return out;
  }

  function normalizeTimeLabel(t) {
    const hhmm = canonicalizeTimeToken(t);
    if (!hhmm) return { key: String(t), hhmm: null, label: String(t) };
    const slot = TIME_TO_SLOT[hhmm];
    return {
      key: hhmm,
      hhmm,
      label: slot ? (slot + ' (' + hhmm + ')') : hhmm
    };
  }

  function migrateMedications(state) {
    (state.medications || []).forEach(med => {
      med.times = dedupeTimes(med.times || []);
    });
    // Remap medLog keys: medId__朝 -> medId__08:00, etc.
    const newLog = {};
    Object.keys(state.medLog || {}).forEach(day => {
      const dayMap = state.medLog[day] || {};
      const next = {};
      Object.keys(dayMap).forEach(k => {
        const idx = k.indexOf('__');
        if (idx < 0) { next[k] = dayMap[k]; return; }
        const medId = k.slice(0, idx);
        const timePart = k.slice(idx + 2);
        const hhmm = canonicalizeTimeToken(timePart) || timePart;
        next[medId + '__' + hhmm] = dayMap[k];
      });
      newLog[day] = next;
    });
    state.medLog = newLog;
    return state;
  }

  function medLogKey(medId, timeKey) { return medId + '__' + timeKey; }

  function isMedTaken(medId, timeKey) {
    const day = state.medLog[todayKey()] || {};
    return !!day[medLogKey(medId, timeKey)];
  }

  function setMedTaken(medId, timeKey, taken) {
    const day = todayKey();
    if (!state.medLog[day]) state.medLog[day] = {};
    const k = medLogKey(medId, timeKey);
    if (taken) state.medLog[day][k] = true;
    else delete state.medLog[day][k];
    save();
    syncMedDailyTask();
  }

  function nextDoseInfo() {
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    let best = null;
    state.medications.filter(m => m.enabled).forEach(med => {
      (med.times || []).forEach(t => {
        const n = normalizeTimeLabel(t);
        if (!n.hhmm) return;
        const [h, m] = n.hhmm.split(':').map(Number);
        const mins = h * 60 + m;
        if (isMedTaken(med.id, n.key)) return;
        const diff = mins - nowMins;
        if (diff >= 0 && (!best || diff < best.diff)) {
          best = { med, n, diff, mins };
        }
      });
    });
    // if none later today, show earliest untaken
    if (!best) {
      state.medications.filter(m => m.enabled).forEach(med => {
        (med.times || []).forEach(t => {
          const n = normalizeTimeLabel(t);
          if (!n.hhmm || isMedTaken(med.id, n.key)) return;
          const [h, m] = n.hhmm.split(':').map(Number);
          const mins = h * 60 + m;
          if (!best || mins < best.mins) best = { med, n, diff: mins - nowMins, mins };
        });
      });
    }
    return best;
  }

  function ensureMedDailyTask() {
    if (!state.settings.medLinkDailyTask) return null;
    let t = state.tasks.find(x => x.isMedDaily);
    if (!t) {
      t = {
        id: uid(), title: '服薬', trader: 'システム',
        desc: '本日の服薬チェックリスト（自動生成）',
        isExample: false, isMedDaily: true, status: 'in_progress',
        deadline: null, failSoundPlayed: false, acceptedAt: Date.now(),
        subs: [], deliveries: []
      };
      state.tasks.unshift(t);
    }
    return t;
  }

  // 服薬は任務タブの「服薬」任務で1回分ずつチェックする（服薬設定は設定シート）
  function medDoseRows() {
    const rows = [];
    state.medications.filter(m => m.enabled !== false).forEach(med => {
      (med.times || []).forEach(t => {
        const n = normalizeTimeLabel(t);
        const slot = n.hhmm ? TIME_TO_SLOT[n.hhmm] : null;
        rows.push({
          key: medLogKey(med.id, n.key),
          title: (slot ? slot + ' ' : '') + med.name + (med.dose ? ' ' + med.dose : ''),
          hhmm: n.hhmm,
          done: isMedTaken(med.id, n.key)
        });
      });
    });
    rows.sort((a, b) => String(a.hhmm || '99:99').localeCompare(String(b.hhmm || '99:99')));
    return rows;
  }

  function syncMedDailyTask() {
    if (!state.settings.medLinkDailyTask) {
      state.tasks = state.tasks.filter(t => !t.isMedDaily);
      save();
      return;
    }
    const task = ensureMedDailyTask();
    task.desc = '本日の服薬（1回分ずつタップでチェック）。薬の登録・時刻・通知は「薬を管理」';
    const byKey = {};
    (task.subs || []).forEach(s => { if (s.medKey) byKey[s.medKey] = s; });
    task.subs = medDoseRows().map(w => {
      const prev = byKey[w.key];
      return {
        id: prev ? prev.id : uid(), title: w.title, kind: 'check', target: 1,
        current: w.done ? 1 : 0, done: w.done, medKey: w.key, medTime: w.hhmm
      };
    });
    task.deadline = null;
    task.status = (task.subs.length && objectivesComplete(task)) ? 'completed' : 'in_progress';
    save();
  }

  function scheduleMedNotifications() {
    medNotifTimers.forEach(clearTimeout);
    medNotifTimers = [];
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const now = Date.now();
    state.medications.filter(m => m.enabled).forEach(med => {
      (med.times || []).forEach(t => {
        const n = normalizeTimeLabel(t);
        if (!n.hhmm) return;
        const [h, m] = n.hhmm.split(':').map(Number);
        const d = new Date();
        d.setHours(h, m, 0, 0);
        let when = d.getTime();
        if (when <= now) return; // only future today while app open
        if (isMedTaken(med.id, n.key)) return;
        const delay = when - now;
        const tid = setTimeout(() => {
          try {
            new Notification('服薬リマインド', {
              body: med.name + ' ' + (med.dose || '') + '（' + n.label + '）',
              icon: 'icons/icon-192.png',
              tag: 'med-' + med.id + '-' + n.key
            });
          } catch (_) {}
        }, delay);
        medNotifTimers.push(tid);
      });
    });
    // 毎日の必須タスク（時刻ありのみ・アプリ表示中）
    (state.dailyRequired || []).filter(d => d.enabled !== false && d.time).forEach(def => {
      const hhmm = canonicalizeTimeToken(def.time);
      if (!hhmm) return;
      const [h, m] = hhmm.split(':').map(Number);
      const d = new Date(); d.setHours(h, m, 0, 0);
      if (d.getTime() <= now) return;
      const t = state.tasks.find(x => x.isDailyRequired && x.dailyId === def.id);
      if (t && t.status === 'completed') return;
      medNotifTimers.push(setTimeout(() => {
        try { new Notification('毎日の必須タスク', { body: def.title + '（' + hhmm + '）', icon: 'icons/icon-192.png', tag: 'daily-' + def.id }); } catch (_) {}
      }, d.getTime() - now));
    });
  }

  // ===== BATH (入浴) =====
  function hasOutingOn(dayKey) {
    if (!dayKey) return false;
    if (state.localOutings && state.localOutings[dayKey]) return true;
    return (state.tasks || []).some(t => {
      if (!t || isSystemTask(t) || t.isDailyRequired) return false;
      if (t.status === 'failed') return false;
      const dk = localDayKeyFromIso(t.deadline);
      return dk === dayKey;
    });
  }

  function isBathRequiredToday() {
    return hasOutingOn(tomorrowKey());
  }

  function getBathToday() {
    const v = state.bathLog[todayKey()];
    if (v === true) return true;
    if (v === false) return false;
    return null;
  }

  function rollBathMisses() {
    const today = todayKey();
    state.bathMeta = state.bathMeta || { lastSeenDay: null, streakWarnedFor: null };
    const last = state.bathMeta.lastSeenDay;
    if (last && last < today) {
      if (state.bathLog[last] === undefined) state.bathLog[last] = false;
      let d = addDaysKey(last, 1);
      while (d < today) {
        if (state.bathLog[d] === undefined) state.bathLog[d] = false;
        d = addDaysKey(d, 1);
      }
    }
    state.bathMeta.lastSeenDay = today;
  }

  function getBathMissStreak() {
    // 過去の連続「なし」を数え、今日未入浴なら +1（初回起動で未記録だけのときは 0）
    let past = 0;
    let d = addDaysKey(todayKey(), -1);
    for (let i = 0; i < 60; i++) {
      const v = state.bathLog[d];
      if (v === true) break;
      if (v === false) { past++; d = addDaysKey(d, -1); continue; }
      break;
    }
    const today = getBathToday();
    if (today === true) return 0;
    if (today === false) return past + 1;
    if (past > 0 || isBathRequiredToday()) return past + 1;
    return 0;
  }

  function ensureBathDailyTask() {
    const required = isBathRequiredToday();
    const bathed = getBathToday() === true;
    let t = state.tasks.find(x => x.isBathDaily);
    if (!t) {
      t = {
        id: uid(), title: '入浴', trader: 'システム',
        desc: required ? '明日予定あり → 本日必須' : '本日の入浴記録',
        isExample: false, isBathDaily: true, status: 'in_progress',
        deadline: null, failSoundPlayed: false, acceptedAt: Date.now(),
        subs: [], deliveries: []
      };
      state.tasks.unshift(t);
    }
    t.desc = required ? '明日予定あり → 本日必須' : '本日の入浴記録';
    const subTitle = required ? '入浴する（必須・明日予定）' : '入浴する';
    let sub = (t.subs || []).find(s => s.isBathSub) || (t.subs || [])[0];
    if (!sub) {
      sub = { id: uid(), title: subTitle, done: bathed, isBathSub: true };
      t.subs = [sub];
    } else {
      sub.title = subTitle;
      sub.done = bathed;
      sub.isBathSub = true;
      t.subs = [sub];
    }
    if (t.status === 'unaccepted') t.status = 'in_progress';
    t.status = bathed ? 'completed' : 'in_progress';
    return t;
  }

  function syncBathDailyTask() {
    rollBathMisses();
    ensureBathDailyTask();
  }

  function setBathToday(bathed) {
    const day = todayKey();
    state.bathLog[day] = !!bathed;
    ensureBathDailyTask();
    save();
    if (bathed) {
      playSound('complete');
      toast('入浴 記録しました');
      if (state.bathMeta) state.bathMeta.streakWarnedFor = null;
    } else {
      playSound('fail');
      toast('入浴なし を記録');
    }
    maybeShowBathStreakWarning(true);
    renderTasks();
  }

  function setTomorrowOuting(flag) {
    const tm = tomorrowKey();
    if (flag) state.localOutings[tm] = true;
    else delete state.localOutings[tm];
    ensureBathDailyTask();
    save();
    playSound('click');
    toast(flag ? '明日予定あり（入浴必須）' : '明日予定を解除');
    renderTasks();
  }

  function maybeShowBathStreakWarning(forceSound) {
    const streak = getBathMissStreak();
    const el = document.getElementById('bathStreakPopup');
    if (!el) return streak;
    if (streak >= 3 && getBathToday() !== true) {
      el.querySelector('.bath-streak-msg').textContent = '入浴なし' + streak + '日目';
      el.classList.add('show');
      const key = todayKey() + ':' + streak;
      if (forceSound || state.bathMeta.streakWarnedFor !== key) {
        state.bathMeta.streakWarnedFor = key;
        save();
        playSound('fail').then(ok => { if (!ok) pendingFailSound = true; });
      }
    } else {
      el.classList.remove('show');
    }
    return streak;
  }

  function renderBathPanel() {
    const required = isBathRequiredToday();
    const status = getBathToday();
    const streak = getBathMissStreak();
    const outingTm = !!state.localOutings[tomorrowKey()];
    const outingAuto = hasOutingOn(tomorrowKey()) && !outingTm;
    let statusLabel = '未記録';
    let statusClass = 'unset';
    if (status === true) { statusLabel = '済'; statusClass = 'ok'; }
    else if (status === false) { statusLabel = 'なし'; statusClass = 'bad'; }
    else if (required) { statusLabel = '必須・未'; statusClass = 'req'; }

    return `<div class="bath-panel ${required ? 'required' : ''} ${streak >= 3 && status !== true ? 'danger' : ''}" id="bathPanel">
      <div class="bath-head">
        <div class="bath-title">入浴 ${required ? '<span class="status-pill pending_review">必須</span>' : ''}</div>
        <div class="bath-status ${statusClass}">${statusLabel}</div>
      </div>
      <div class="bath-hint">${required
        ? '明日に予定あり → 今日の入浴が必須です'
        : '明日予定がある日の前日は入浴必須。連続なしは3日目から警告'}</div>
      ${streak >= 3 && status !== true
        ? `<div class="banner bad show bath-inline-warn">◆ 入浴なし${streak}日目 ◆</div>`
        : (streak > 0 && status !== true ? `<div class="bath-streak-soft">連続なし ${streak}日</div>` : '')}
      <div class="bath-actions">
        <button class="btn btn-primary btn-sm" data-bath="1" ${status === true ? 'disabled' : ''}>入浴した</button>
        <button class="btn btn-danger btn-sm" data-bath="0" ${status === false ? 'disabled' : ''}>入浴なし</button>
        <button class="btn btn-sm ${outingTm ? 'btn-primary' : ''}" data-outing-tm="${outingTm ? '0' : '1'}">${outingTm ? '明日予定✓' : '明日予定あり'}</button>
      </div>
      ${outingAuto ? '<div class="bath-auto-note">任務の期限から明日予定を検出</div>' : ''}
    </div>`;
  }

  // ===== CHORES (洗濯 / 掃除 / ゴミ出し) =====
  // 月・木: 洗濯＋掃除（翌朝ゴミ出し用） / 火・金: 燃えるゴミ（西条地区）
  function choreLogMap(type) {
    if (type === 'laundry') return state.laundryLog;
    if (type === 'clean') return state.cleanLog;
    return state.trashLog;
  }

  function getChoreToday(type) {
    const v = choreLogMap(type)[todayKey()];
    if (v === true) return true;
    if (v === false) return false;
    return null;
  }

  function rollChoreMisses() {
    const today = todayKey();
    state.choreMeta = state.choreMeta || { lastSeenDay: null, warnedFor: null };
    const last = state.choreMeta.lastSeenDay;
    if (last && last < today) {
      let d = last;
      while (d < today) {
        if (isLaundryCleanDay(d)) {
          if (state.laundryLog[d] === undefined) state.laundryLog[d] = false;
          if (state.cleanLog[d] === undefined) state.cleanLog[d] = false;
        }
        if (isTrashDay(d)) {
          if (state.trashLog[d] === undefined) state.trashLog[d] = false;
        }
        d = addDaysKey(d, 1);
      }
    }
    state.choreMeta.lastSeenDay = today;
  }

  function ensureTypedChoreTask(type, title, desc, subTitle, done) {
    const flag = type === 'laundry' ? 'isLaundryDaily'
      : type === 'clean' ? 'isCleanDaily' : 'isTrashDaily';
    let t = state.tasks.find(x => x[flag]);
    if (!t) {
      t = {
        id: uid(), title, trader: 'システム',
        desc, isExample: false, status: 'in_progress',
        deadline: null, failSoundPlayed: false, acceptedAt: Date.now(),
        subs: [], deliveries: [], choreType: type
      };
      t[flag] = true;
      state.tasks.unshift(t);
    }
    t.title = title;
    t.desc = desc;
    t.choreType = type;
    t[flag] = true;
    let sub = (t.subs || []).find(s => s.isChoreSub) || (t.subs || [])[0];
    if (!sub) {
      sub = { id: uid(), title: subTitle, done: !!done, isChoreSub: true, choreType: type };
      t.subs = [sub];
    } else {
      sub.title = subTitle;
      sub.done = !!done;
      sub.isChoreSub = true;
      sub.choreType = type;
      t.subs = [sub];
    }
    if (t.status === 'unaccepted' || t.status === 'failed') t.status = 'in_progress';
    t.status = done ? 'completed' : 'in_progress';
    return t;
  }

  function ensureChoreDailyTasks() {
    rollChoreMisses();
    const today = todayKey();
    const lac = isLaundryCleanDay(today);
    const tr = isTrashDay(today);

    if (lac) {
      ensureTypedChoreTask(
        'laundry', '洗濯',
        '月・木必須 → 翌朝（火/金）にゴミ出しできる流れ',
        '洗濯完了チェック',
        getChoreToday('laundry') === true
      );
      ensureTypedChoreTask(
        'clean', '掃除',
        '月・木：1か所15分＋写真1枚（メモ可）',
        '1か所15分＋写真1枚（メモ可）',
        getChoreToday('clean') === true
      );
    } else {
      state.tasks = state.tasks.filter(t => !t.isLaundryDaily && !t.isCleanDaily);
    }

    if (tr) {
      ensureTypedChoreTask(
        'trash', 'ゴミ出し（燃えるゴミ）',
        '西条地区：火・金の朝（洗濯の翌朝）',
        '燃えるゴミを出した',
        getChoreToday('trash') === true
      );
    } else {
      state.tasks = state.tasks.filter(t => !t.isTrashDaily);
    }
  }

  function syncChoreDailyTasks() {
    ensureChoreDailyTasks();
  }

  function setChoreToday(type, done) {
    const day = todayKey();
    if (type === 'laundry' && !isLaundryCleanDay(day)) return;
    if (type === 'clean' && !isLaundryCleanDay(day)) return;
    if (type === 'trash' && !isTrashDay(day)) return;
    choreLogMap(type)[day] = !!done;
    ensureChoreDailyTasks();
    save();
    if (done) {
      playSound('complete');
      const msg = type === 'laundry' ? '洗濯 完了' : type === 'clean' ? '掃除 完了' : 'ゴミ出し 完了';
      toast(msg);
      if (state.choreMeta) state.choreMeta.warnedFor = null;
    } else {
      playSound('fail');
      toast('未完了に戻しました');
    }
    maybeShowChoreWarning(true);
    renderTasks();
  }

  function todayIncompleteChores() {
    const today = todayKey();
    const miss = [];
    if (isLaundryCleanDay(today)) {
      if (getChoreToday('laundry') !== true) miss.push('洗濯');
      if (getChoreToday('clean') !== true) miss.push('掃除');
    }
    if (isTrashDay(today)) {
      if (getChoreToday('trash') !== true) miss.push('ゴミ出し');
    }
    return miss;
  }

  function nextChoreHint() {
    for (let i = 1; i <= 7; i++) {
      const d = addDaysKey(todayKey(), i);
      const name = WEEKDAY_NAMES[weekdayOfKey(d)];
      if (isLaundryCleanDay(d)) return '次: ' + name + '曜 洗濯・掃除';
      if (isTrashDay(d)) return '次: ' + name + '曜 ゴミ出し（燃えるゴミ）';
    }
    return '';
  }

  function maybeShowChoreWarning(forceSound) {
    const miss = todayIncompleteChores();
    const el = document.getElementById('choreWarnPopup');
    if (!el) return miss;
    if (miss.length) {
      el.querySelector('.chore-warn-msg').textContent = miss.join('・') + ' 未完了';
      el.classList.add('show');
      const key = todayKey() + ':' + miss.join(',');
      if (forceSound || state.choreMeta.warnedFor !== key) {
        state.choreMeta.warnedFor = key;
        save();
        playSound('fail').then(ok => { if (!ok) pendingFailSound = true; });
      }
    } else {
      el.classList.remove('show');
    }
    return miss;
  }

  function choreRowHtml(type, label, hint, doneLabel) {
    const status = getChoreToday(type);
    let statusLabel = '必須・未';
    let statusClass = 'req';
    if (status === true) { statusLabel = '済'; statusClass = 'ok'; }
    else if (status === false) { statusLabel = '未'; statusClass = 'bad'; }
    const danger = status !== true;
    return `<div class="chore-row ${danger ? 'danger' : ''}">
      <div class="chore-row-head">
        <div class="chore-row-title">${label} <span class="status-pill pending_review">必須</span></div>
        <div class="bath-status ${statusClass}">${statusLabel}</div>
      </div>
      <div class="bath-hint">${hint}</div>
      <div class="bath-actions">
        <button class="btn btn-primary btn-sm" data-chore="${type}" data-chore-done="1" ${status === true ? 'disabled' : ''}>${doneLabel}</button>
        <button class="btn btn-danger btn-sm" data-chore="${type}" data-chore-done="0" ${status === false ? 'disabled' : ''}>未完了</button>
      </div>
    </div>`;
  }

  function renderChorePanel() {
    const today = todayKey();
    const lac = isLaundryCleanDay(today);
    const tr = isTrashDay(today);
    const miss = todayIncompleteChores();
    const wname = WEEKDAY_NAMES[weekdayOfKey(today)];
    let body = '';
    if (lac) {
      body += choreRowHtml('laundry', '洗濯', '完了条件: 洗濯が終わるまで（翌朝ゴミ出し用）', '洗濯した');
      body += choreRowHtml('clean', '掃除', '完了条件: 1か所15分＋写真1枚（メモ可）', '掃除した');
    }
    if (tr) {
      body += choreRowHtml('trash', 'ゴミ出し（燃えるゴミ）', '西条地区・火金の朝。完了条件: 燃えるゴミを出した', '出した');
    }
    if (!lac && !tr) {
      body = `<div class="bath-hint">今日（${wname}）のルーチンなし。${esc(nextChoreHint())}</div>
        <div class="bath-auto-note">月木=洗濯・掃除 / 火金=燃えるゴミ（西条）</div>`;
    }
    return `<div class="bath-panel chore-panel ${miss.length ? 'danger required' : (lac || tr ? 'required' : '')}" id="chorePanel">
      <div class="bath-head">
        <div class="bath-title">生活ルーチン ${miss.length ? '<span class="status-pill failed">未完了</span>' : ''}</div>
        <div class="bath-status ${miss.length ? 'req' : ((lac || tr) ? 'unset' : 'ok')}">${miss.length ? miss.join('・') : ((lac || tr) ? '本日' : 'オフ')}</div>
      </div>
      ${miss.length ? `<div class="banner bad show bath-inline-warn">◆ ${esc(miss.join('・'))} 未完了 ◆</div>` : ''}
      ${body}
    </div>`;
  }

  // ===== CHAT PARSER =====
  // 本体は parser.js（DOM非依存・node でテスト可能: tests/parse.test.mjs）。
  // 1文（または箇条書き/複数行）から 任務 / 日時・期限 / 場所 / 持ち物 / 買うもの / メモ を抽出する。
  const CHAT_KINDS = [
    ['main_task', 'メイン任務'], ['todo', 'サブタスク'], ['daily', '毎日の必須'],
    ['shopping', '買い物'], ['medication', '服薬']
  ];
  function chatParser() { return (typeof window !== 'undefined' && window.ChatParser) || null; }
  function parseChat(text) {
    const CP = chatParser();
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (!CP) {
      return { kind: 'todo', label: 'サブタスク / ToDo', source: raw, title: raw, summary: raw,
        meta: '「インボックス」任務のサブタスクとして追加' };
    }
    return CP.parseMessage(raw, { medications: state.medications || [] });
  }
  // 種類を切り替えて再解析（持ち物の引き継ぎ・推定種類を保持）
  function reparseAs(p, kind) {
    const CP = chatParser();
    if (!CP || !p) return p;
    const np = CP.parseChat(p.source, {
      medications: state.medications || [], forceKind: kind,
      guessKind: p.guessKind || p.kind, extraBring: p.extraBring
    });
    if (!np) return p;
    np.skip = !!p.skip;
    return np;
  }

  function addShoppingItem(name, note) {
    state.shopping.push({ id: uid(), name, qty: 1, checked: false, note: note || 'チャット', isExample: false });
  }

  function applyMedication(p) {
    const meds = Array.isArray(p.meds) && p.meds.length ? p.meds
      : [{ name: p.name, dose: p.dose, times: p.times, mergeIntoId: p.mergeIntoId }];
    let added = 0, merged = 0;
    meds.forEach(m => {
      const times = dedupeTimes(m.times || []);
      const generic = d => !d || d === '1回分';
      let existing = m.mergeIntoId ? state.medications.find(x => x.id === m.mergeIntoId) : null;
      if (!existing) {
        existing = state.medications.find(x =>
          x.enabled !== false && String(x.name || '').trim() === String(m.name || '').trim() &&
          (generic(m.dose) || generic(x.dose) || String(x.dose).replace(/\s+/g, '') === m.dose));
      }
      if (existing) {
        existing.times = dedupeTimes(dedupeTimes(existing.times).concat(times));
        if (generic(existing.dose) && !generic(m.dose)) existing.dose = m.dose;
        existing.isExample = false;
        merged++;
      } else {
        state.medications.push({
          id: uid(), name: m.name, dose: m.dose || '1回分',
          times, linkToDailyTask: true, enabled: true, isExample: false
        });
        added++;
      }
    });
    syncMedDailyTask();
    scheduleMedNotifications();
    return '服薬' + (added ? ' 新規' + added : '') + (merged ? ' 更新' + merged : '');
  }

  // 戻り値: トースト用の短い文言
  function applyOne(p) {
    if (!p || p.skip) return '';
    if (p.kind === 'shopping') {
      p.items.forEach(name => addShoppingItem(name, p.note ? ('チャット ' + p.note) : 'チャット'));
      return '買い物' + p.items.length + '件';
    }
    if (p.kind === 'medication') return applyMedication(p);
    if (p.kind === 'main_task') {
      const subs = (p.bring || []).map(it => makeObjective(it, 'item'));
      subs.push(makeObjective('実施する', 'check'));
      const descParts = [];
      if (p.memo) descParts.push('メモ: ' + p.memo);
      if ((p.buy || []).length) descParts.push('買うもの: ' + p.buy.join('、') + (p.buyHint ? '（' + p.buyHint + '）' : '') + ' → 買い物リスト');
      const t = {
        id: uid(), title: p.title, trader: p.trader || 'チャット',
        desc: descParts.join('\n') || 'チャットから追加', isExample: false, status: 'unaccepted',
        deadline: p.deadline, location: p.location || '',
        // カレンダー取り込み互換フィールド（将来: source:'calendar', externalId）
        start: p.start || null, end: null, source: 'chat', externalId: null,
        failSoundPlayed: false, acceptedAt: null, reward: '',
        subs,
        deliveries: []
      };
      state.tasks.push(t);
      (p.buy || []).forEach(name => addShoppingItem(name, 'チャット（' + p.title + (p.buyHint ? '・' + p.buyHint : '') + '）'));
      selectedId = t.id;
      ensureBathDailyTask();
      return '任務1件' + ((p.buy || []).length ? '＋買い物' + p.buy.length + '件' : '');
    }
    if (p.kind === 'daily') {
      const def = {
        id: uid(), title: p.title, time: p.time || null, location: p.location || '',
        bring: (p.bring || []).slice(), memo: p.memo || '',
        recurring: 'daily', required: true, enabled: true, createdAt: Date.now()
      };
      state.dailyRequired.push(def);
      ensureDailyRequiredTasks();
      const t = state.tasks.find(x => x.isDailyRequired && x.dailyId === def.id);
      if (t) selectedId = t.id;
      scheduleMedNotifications();
      return '毎日の必須タスク1件';
    }
    if (p.kind === 'todo') {
      let inbox = state.tasks.find(t => t.isInbox);
      if (!inbox) {
        inbox = {
          id: uid(), title: 'インボックス', trader: 'チャット',
          desc: 'チャットから追加した ToDo', isExample: false, isInbox: true,
          status: 'in_progress', deadline: null, failSoundPlayed: false,
          acceptedAt: Date.now(), subs: [], deliveries: []
        };
        state.tasks.push(inbox);
      }
      inbox.subs.push(makeObjective(p.title, 'check'));
      if (inbox.status === 'completed') inbox.status = 'in_progress';
      selectedId = inbox.id;
      return 'ToDo1件';
    }
    return '';
  }

  function applyPreview(p) {
    if (!p) return;
    const list = p.kind === 'multi' ? p.items : [p];
    const done = list.map(applyOne).filter(Boolean);
    save();
    toast(done.length ? ('追加: ' + done.join(' / ')) : '追加する項目がありません');
  }

  // ===== 毎日の必須タスク（繰り返し・入浴/家事と同じく日替わりで再生成） =====
  function ensureDailyRequiredTasks() {
    state.dailyRequired = state.dailyRequired || [];
    state.dailyLog = state.dailyLog || {};
    const today = todayKey();
    const defs = state.dailyRequired.filter(d => d.enabled !== false);
    const ids = new Set(defs.map(d => d.id));
    let changed = false;
    const before = state.tasks.length;
    state.tasks = state.tasks.filter(t => !t.isDailyRequired || ids.has(t.dailyId));
    if (state.tasks.length !== before) changed = true;
    defs.forEach(def => {
      let t = state.tasks.find(x => x.isDailyRequired && x.dailyId === def.id);
      const subTitle = def.title + (def.time ? '（' + def.time + '）' : '');
      if (!t) {
        t = {
          id: uid(), title: def.title, trader: '毎日', isExample: false,
          isDailyRequired: true, dailyId: def.id, dayKey: today,
          desc: '', deadline: null, location: def.location || '',
          status: 'in_progress', failSoundPlayed: false, acceptedAt: Date.now(),
          source: 'daily', externalId: null, start: null, end: null,
          subs: [Object.assign(makeObjective(subTitle, 'check'), { isDailySub: true })]
            .concat((def.bring || []).map(b => makeObjective(b, 'item'))),
          deliveries: []
        };
        state.tasks.push(t);
        changed = true;
      }
      if (t.dayKey !== today) {
        changed = true;
        // 前日の結果を記録して本日分にリセット
        const prev = t.dayKey;
        if (prev) {
          state.dailyLog[prev] = state.dailyLog[prev] || {};
          if (state.dailyLog[prev][def.id] === undefined) state.dailyLog[prev][def.id] = objectivesComplete(t);
        }
        (t.subs || []).forEach(s => setObjDone(s, false));
        t.dayKey = today;
        t.status = 'in_progress';
        t.failSoundPlayed = false;
      }
      t.title = def.title;
      t.location = def.location || '';
      t.desc = '毎日の必須タスク' + (def.time ? '・' + def.time + 'リマインド' : '') + (def.memo ? '\nメモ: ' + def.memo : '');
      const main = (t.subs || []).find(s => s.isDailySub);
      if (main) main.title = subTitle;
      if (t.status === 'unaccepted' || t.status === 'failed') t.status = 'in_progress';
    });
    if (changed) save();
  }

  // ===== IMPORT / EXPORT =====
  function exportData() {
    const payload = {
      schemaVersion: '1.0',
      exportedAt: new Date().toISOString(),
      mainTasks: state.tasks.filter(t => !isSystemTask(t) && !t.isDailyRequired).map(t => ({
        title: t.title, trader: t.trader, desc: t.desc, deadline: t.deadline,
        location: t.location || '',
        start: t.start || null, end: t.end || null,
        source: t.source || null, externalId: t.externalId || null,
        status: t.status,
        reward: t.reward || '',
        subs: (t.subs||[]).map(s => ({
          title: s.title, kind: s.kind || 'check', target: objTarget(s), current: objCurrent(s), done: objDone(s)
        })),
        deliveries: (t.deliveries||[]).map(d => ({
          name: d.name, qty: d.qty || 1, type: d.type || 'deliverable', done: !!d.done
        }))
      })),
      shopping: state.shopping.map(s => ({
        name: s.name, qty: s.qty || 1, checked: !!s.checked, note: s.note || ''
      })),
      medications: state.medications.map(m => ({
        name: m.name, dose: m.dose, times: m.times || [],
        linkToDailyTask: m.linkToDailyTask !== false, enabled: m.enabled !== false
      }))
    };
    return payload;
  }

  function importData(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('無効なJSON');
    const added = [];
    (payload.mainTasks || []).forEach(mt => {
      if (!mt || !mt.title) return;
      const t = {
        id: uid(),
        title: String(mt.title),
        trader: mt.trader || 'インポート',
        desc: mt.desc || '',
        deadline: mt.deadline || null,
        location: mt.location ? String(mt.location) : '',
        start: mt.start || null, end: mt.end || null,
        source: mt.source || 'import', externalId: mt.externalId || null,
        status: 'pending_review',
        failSoundPlayed: false,
        acceptedAt: null,
        isExample: false,
        reward: mt.reward ? String(mt.reward) : '',
        subs: (mt.subs || []).map(s => normalizeObjective({
          id: uid(), title: s.title || '目標', kind: s.kind, target: s.target || 1, current: 0, done: false
        })),
        deliveries: (mt.deliveries || []).map(d => ({
          id: uid(), name: d.name || 'アイテム', qty: d.qty || 1,
          type: d.type === 'purchase' ? 'purchase' : 'deliverable', done: false
        }))
      };
      state.tasks.push(t);
      state.pendingReviewIds.push(t.id);
      added.push(t.id);
    });
    (payload.shopping || []).forEach(s => {
      if (!s || !s.name) return;
      state.shopping.push({
        id: uid(), name: String(s.name), qty: s.qty || 1,
        checked: false, note: s.note || 'インポート', isExample: false
      });
    });
    (payload.medications || []).forEach(m => {
      if (!m || !m.name) return;
      state.medications.push({
        id: uid(), name: String(m.name), dose: m.dose || '1回分',
        times: dedupeTimes(Array.isArray(m.times) ? m.times : ['08:00']),
        linkToDailyTask: m.linkToDailyTask !== false,
        enabled: m.enabled !== false, isExample: false
      });
    });
    syncMedDailyTask();
    save();
    return added.length;
  }

  // ===== RENDER HELPERS =====
  function formatDeadline(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    const pad = n => String(n).padStart(2,'0');
    return (d.getMonth()+1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2,'0');
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
  }

  // ===== SCREENS =====
  function switchTab(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === name));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    playSound('click');
    if (name === 'tasks') renderTasks();
    if (name === 'chat') renderChat();
    if (name === 'shop') renderShop();
    if (name === 'med') renderMed();
  }

  // ===== COUNTDOWN（期限: 残り 日 + HH:MM:SS） =====
  const pad2 = n => String(n).padStart(2, '0');
  function fmtDuration(ms) {
    const s = Math.floor(Math.abs(ms) / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (d > 0 ? d + '日 ' : '') + pad2(h) + ':' + pad2(m) + ':' + pad2(sec);
  }
  // 通常 / 24時間未満=amber / 3時間未満・期限切れ=red
  function countdownInfo(iso, now) {
    const dl = Date.parse(iso);
    if (isNaN(dl)) return null;
    const r = dl - (now || Date.now());
    if (r <= 0) return { text: '期限切れ +' + fmtDuration(r), level: 'red', over: true };
    return { text: fmtDuration(r), level: r < 3 * 3600e3 ? 'red' : r < 24 * 3600e3 ? 'amber' : 'normal', over: false };
  }
  function deadlineLevel(task) {
    if (!task.deadline || effectiveStatus(task) === 'completed') return '';
    const ci = countdownInfo(task.deadline);
    return ci ? ci.level : '';
  }
  function countdownHtml(task) {
    if (!task.deadline) return '';
    if (effectiveStatus(task) === 'completed') return `<span class="cd cd-done">期限 ${esc(formatDeadline(task.deadline) || '')}</span>`;
    const ci = countdownInfo(task.deadline);
    if (!ci) return '';
    return `<span class="cd cd-${ci.level}" data-cd="${esc(task.deadline)}">${esc(ci.text)}</span>`;
  }
  function tickCountdowns() {
    let crossed = false;
    document.querySelectorAll('[data-cd]').forEach(el => {
      const ci = countdownInfo(el.getAttribute('data-cd'));
      if (!ci) return;
      if (el.textContent !== ci.text) el.textContent = ci.text;
      const cls = 'cd cd-' + ci.level + (el.classList.contains('cd-big') ? ' cd-big' : '');
      if (el.className !== cls) el.className = cls;
      const row = el.closest('[data-dl-row]');
      if (row) { row.classList.toggle('dl-amber', ci.level === 'amber'); row.classList.toggle('dl-red', ci.level === 'red'); }
      if (ci.over) crossed = true;
    });
    if (crossed && checkDeadlines() && activeScreen() === 'tasks' && !anyModalOpen()) renderTasks();
  }
  function activeScreen() { return document.querySelector('.screen.active')?.dataset.screen || ''; }
  function anyModalOpen() { return !!document.querySelector('.modal-backdrop.show'); }

  // ===== TASK LIST / DETAIL =====
  function taskIcon(t) {
    if (t.isMedDaily) return '✚';
    if (t.isBathDaily) return '≋';
    if (t.isLaundryDaily || t.isCleanDaily || t.isTrashDaily) return '⟲';
    if (t.isDailyRequired) return '↻';
    if (t.isInbox) return '▤';
    if (t.deadline) return '◷';
    return '◈';
  }
  function taskGroup(t) {
    if (isSystemTask(t) || t.isDailyRequired) return 'req';
    if (t.deadline) return 'dl';
    return 'other';
  }
  const GROUPS = [['req', '必須タスク'], ['dl', '期限付きタスク'], ['other', 'その他']];
  const STATUS_ORDER = { in_progress: 0, unaccepted: 1, failed: 2, completed: 3 };
  function gaugeHtml(cur, total, cls) {
    const pct = total ? Math.round(cur / total * 100) : 0;
    return `<div class="gauge ${cls || ''}"><div class="gauge-fill" style="width:${pct}%"></div></div>`;
  }
  function medNextLabel() {
    const n = nextDoseInfo();
    if (!n) return '';
    return '次: ' + (n.n.hhmm || n.n.label) + ' ' + n.med.name;
  }

  function taskCardHtml(t) {
    const st = effectiveStatus(t);
    const p = taskProgress(t);
    const lvl = deadlineLevel(t);
    const meta = [esc(t.trader || '—')];
    if (t.location) meta.push('◎ ' + esc(t.location));
    if (t.isMedDaily && st !== 'completed') { const nx = medNextLabel(); if (nx) meta.push(esc(nx)); }
    return `<div class="task-card status-${st} ${t.id===selectedId?'active':''} ${lvl==='amber'?'dl-amber':''} ${lvl==='red'?'dl-red':''}" data-select="${t.id}" ${t.deadline?'data-dl-row':''}>
      <div class="tc-row1">
        <span class="tc-ico">${taskIcon(t)}</span>
        <span class="tc-title">${esc(t.title)}${t.isExample?'<span class="example-badge">サンプル</span>':''}${t.isDailyRequired&&st!=='completed'?'<span class="status-pill pending_review">毎日必須</span>':''}</span>
        <span class="tc-status st-${st}">${STATUS_LABEL[st]}</span>
      </div>
      <div class="tc-row2">
        <span class="tc-meta">${meta.join(' · ')}</span>
        ${countdownHtml(t)}
      </div>
      <div class="tc-prog">${gaugeHtml(p.done, p.total, st === 'completed' ? 'g-done' : st === 'failed' ? 'g-failed' : '')}<span class="tc-count">${p.done}/${p.total}</span></div>
    </div>`;
  }

  function canEditObjectives(task) {
    const st = effectiveStatus(task);
    if (st === 'in_progress') return true;
    // 日次（服薬・入浴・家事・毎日の必須）は完了後もチェックを戻せる
    return st === 'completed' && (isSystemTask(task) || task.isDailyRequired);
  }

  function objRowHtml(task, s, st, editable) {
    const tg = objTarget(s), cur = objCurrent(s), done = cur >= tg;
    const isSys = isSystemTask(task);
    const canDel = (st === 'in_progress' || st === 'unaccepted') && !isSys;
    const kind = s.kind || 'check';
    let ico = '', text = esc(s.title), extra = '', action = '';
    let late = false;
    if (task.isMedDaily && s.medTime && !done) {
      const now = new Date();
      late = (pad2(now.getHours()) + ':' + pad2(now.getMinutes())) > s.medTime;
    }
    if (kind === 'item') {
      ico = '<span class="obj-ico ico-item">▣</span>';
      if (tg > 1) {
        action = `<button class="btn btn-step" data-obj-dec="${s.id}" ${cur<=0?'disabled':''}>−</button><button class="btn btn-step" data-obj-inc="${s.id}" ${done?'disabled':''}>＋</button>`;
      }
      action += done
        ? `<button class="btn btn-ready is-done" data-obj-unready="${s.id}" title="タップで戻す">✓ 揃えた</button>`
        : `<button class="btn btn-ready" data-obj-ready="${s.id}">揃えた</button>`;
    } else if (kind === 'count') {
      ico = '<span class="obj-ico ico-count">≡</span>';
      action = `<button class="btn btn-step" data-obj-dec="${s.id}" ${cur<=0?'disabled':''}>−</button><button class="btn btn-step" data-obj-inc="${s.id}" ${done?'disabled':''}>＋</button>`;
    } else {
      ico = `<span class="checkbox ${done?'checked':''}"></span>`;
    }
    if (task.isMedDaily && s.medTime) extra = `<span class="obj-time ${late?'late':''}">${esc(s.medTime)}${late?' 時刻超過':''}</span>`;
    const rowAttr = kind === 'check' ? `data-toggle-sub="${s.id}"` : '';
    const gaugeAttr = kind === 'count' && !done ? `data-obj-inc="${s.id}"` : '';
    return `<div class="obj-row kind-${kind} ${done?'done':''} ${late?'late':''} ${editable?'':'ro'}" ${rowAttr}>
      <div class="obj-line">${ico}<span class="obj-text">${text}</span>${extra}${done?'<span class="obj-check">✓</span>':''}</div>
      <div class="obj-meter">
        <div class="gauge ${done?'g-done':''}" ${gaugeAttr}><div class="gauge-fill" style="width:${Math.round(cur/tg*100)}%"></div></div>
        <span class="obj-count">${cur}/${tg}</span>
        ${action}
        ${canDel?`<button class="btn btn-sm btn-x" data-del-sub="${s.id}" title="削除">✕</button>`:''}
      </div>
    </div>`;
  }

  function deliveryRowHtml(task, d, st) {
    const qty = Math.max(1, parseInt(d.qty, 10) || 1);
    const cur = d.done ? qty : 0;
    const canDel = st === 'in_progress' || st === 'unaccepted';
    return `<div class="obj-row kind-delivery ${d.done?'done':''}">
      <div class="obj-line"><span class="obj-ico ico-del">⇥</span><span class="obj-text">${esc(d.name)}を${d.type==='purchase'?'購入して':''}納品</span><span class="obj-tag ${d.type}">${d.type==='purchase'?'購入品':'成果物'}</span>${d.done?'<span class="obj-check">✓</span>':''}</div>
      <div class="obj-meter">
        <div class="gauge ${d.done?'g-done':''}"><div class="gauge-fill" style="width:${d.done?100:0}%"></div></div>
        <span class="obj-count">${cur}/${qty}</span>
        <button class="btn btn-deliver" data-hand-over="${d.id}" ${d.done||st!=='in_progress'?'disabled':''}>${d.done?'納品済':'引き渡す'}</button>
        ${canDel?`<button class="btn btn-sm btn-x" data-del-del="${d.id}" title="削除">✕</button>`:''}
      </div>
    </div>`;
  }

  function renderTasks() {
    checkDeadlines();
    syncBathDailyTask();
    syncChoreDailyTasks();
    ensureDailyRequiredTasks();
    if (state.settings.medLinkDailyTask) syncMedDailyTask();
    const list = document.getElementById('taskList');
    const pending = state.tasks.filter(t => t.status === 'pending_review');
    const normal = state.tasks.filter(t => t.status !== 'pending_review');

    let html = renderBathPanel() + renderChorePanel();
    if (pending.length) {
      html += '<div class="section-title">未確認レビュー<span class="status-pill pending_review">' + pending.length + '</span></div>';
      pending.forEach(t => {
        html += `<div class="task-card status-pending_review ${t.id===selectedId?'active':''}" data-select="${t.id}">
          <div class="tc-row1"><span class="tc-ico">?</span><span class="tc-title">${esc(t.title)}</span><span class="tc-status st-pending_review">未確認</span></div>
          <div class="tc-row2"><span class="tc-meta">微調整＆確認が必要</span></div>
        </div>`;
      });
    }
    const doneCount = normal.filter(t => effectiveStatus(t) === 'completed').length;
    html += `<div class="list-head">
      <div class="section-title" style="margin:0">任務一覧 <span class="list-count">✓ ${doneCount}/${normal.length}</span></div>
      <div class="list-head-actions">
        <button class="btn btn-sm ${showCompleted?'btn-on':''}" id="btnShowDone">${showCompleted?'☑':'☐'} 完了を表示</button>
        <button class="btn btn-sm btn-primary" id="btnNewMain">＋ 追加</button>
      </div>
    </div>`;
    if (!normal.length) html += '<div class="empty">任務なし</div>';
    GROUPS.forEach(([g, label]) => {
      const all = normal.filter(t => taskGroup(t) === g);
      if (!all.length) return;
      const items = all
        .map((t, i) => ({ t, i, st: effectiveStatus(t) }))
        .filter(x => showCompleted || x.st !== 'completed' || x.t.id === selectedId)
        .sort((a, b) => {
          const so = (STATUS_ORDER[a.st] ?? 9) - (STATUS_ORDER[b.st] ?? 9);
          if (so) return so;
          if (g === 'dl') return (Date.parse(a.t.deadline) || 0) - (Date.parse(b.t.deadline) || 0);
          return a.i - b.i;
        });
      const gDone = all.filter(t => effectiveStatus(t) === 'completed').length;
      const collapsed = !!collapsedGroups[g];
      html += `<div class="group-head ${g==='req'?'g-req':g==='dl'?'g-dl':''}" data-group-toggle="${g}">
        <span class="gh-chev">${collapsed?'▸':'▾'}</span><span class="gh-label">${label}</span><span class="gh-count">${gDone}/${all.length}</span>
      </div>`;
      if (!collapsed) {
        html += items.map(x => taskCardHtml(x.t)).join('') || '<div class="empty small">（完了のみ・非表示中）</div>';
      }
    });
    list.innerHTML = html;

    const detail = document.getElementById('taskDetail');
    const task = selectedId ? getTask(selectedId) : null;
    if (!task) {
      detail.innerHTML = '<div class="empty">任務を選択してください</div>';
      return;
    }
    const st = effectiveStatus(task);
    const p = taskProgress(task);
    const dl = formatDeadline(task.deadline);
    const mapLabel = task.location ? esc(task.location) : '任意の場所';

    if (st === 'pending_review') {
      detail.innerHTML = `
        <div class="detail-panel">
          <div class="detail-header">
            <div class="detail-top"><div class="detail-trader">PENDING REVIEW · 未確認</div><div class="detail-map">${mapLabel}</div></div>
            <div class="detail-title">${esc(task.title)}</div>
            <div class="detail-desc">${esc(task.desc||'')}</div>
            <div class="detail-desc" style="margin-top:6px">期限: ${dl ? esc(dl) : 'なし'}</div>
            <div class="section-title" style="margin-top:10px">目標</div>
            ${(task.subs||[]).map(s=>`<div class="obj-card"><div class="obj-text">${s.kind==='item'?'持ち物: ':''}${esc(s.title)}${objTarget(s)>1?' ×'+objTarget(s):''}</div></div>`).join('')||'<div class="empty">なし</div>'}
            <div class="section-title">納品</div>
            ${(task.deliveries||[]).map(d=>`<div class="obj-card"><div class="obj-text">${esc(d.name)} ×${d.qty} (${d.type==='purchase'?'購入品':'成果物'})</div></div>`).join('')||'<div class="empty">なし</div>'}
            <div class="detail-actions" style="margin-top:12px">
              <button class="btn btn-primary" data-approve="${task.id}">承認</button>
              <button class="btn" data-edit-main="${task.id}">編集</button>
              <button class="btn btn-danger" data-discard="${task.id}">破棄</button>
            </div>
          </div>
        </div>`;
      return;
    }

    const editable = canEditObjectives(task);
    const isSys = isSystemTask(task);
    const canAdd = (st === 'in_progress' || st === 'unaccepted') && !isSys;
    const items = (task.subs || []).filter(s => s.kind === 'item');
    const goals = (task.subs || []).filter(s => s.kind !== 'item');
    const dels = task.deliveries || [];
    const secCount = arr => arr.filter(objDone).length + '/' + arr.length;
    const lvl = deadlineLevel(task);
    let deadlineBlock = '';
    if (task.deadline) {
      deadlineBlock = st === 'completed'
        ? `<div class="detail-deadline">期限 ${esc(dl||'')} <span class="dd-ok">期限内に完了</span></div>`
        : `<div class="detail-deadline dl-${lvl}">${lvl==='red'&&countdownInfo(task.deadline)?.over?'':'<span class="dd-label">残り</span>'}<span class="cd cd-big cd-${lvl}" data-cd="${esc(task.deadline)}">${esc(countdownInfo(task.deadline)?.text||'')}</span><span class="dd-at">期限 ${esc(dl||'')}</span></div>`;
    }
    let medTools = '';
    if (task.isMedDaily) {
      const nx = medNextLabel();
      medTools = `<div class="med-tools">${nx&&st!=='completed'?`<span class="med-next-inline">${esc(nx)}</span>`:'<span></span>'}<button class="btn btn-sm" data-open-med-settings>⚙ 薬を管理</button></div>`;
    }

    detail.innerHTML = `
      <div class="detail-panel">
        <div class="detail-header ${st}">
          <div class="detail-top">
            <button class="btn btn-sm btn-back" data-back-list>▲ 一覧</button>
            <div class="detail-topright"><span class="detail-map" title="場所">${mapLabel}</span><span class="tc-status st-${st}">${STATUS_LABEL[st]}</span></div>
          </div>
          <div class="detail-trader">${esc(task.trader||'UNKNOWN')}</div>
          <div class="detail-title"><span class="tc-ico">${taskIcon(task)}</span>${esc(task.title)}${task.isExample?'<span class="example-badge">サンプル</span>':''}</div>
          ${deadlineBlock}
          ${task.desc?`<div class="detail-desc">${esc(task.desc)}</div>`:''}
          ${medTools}
          <div class="progress-row"><span>進捗</span><span class="progress-count">${p.done}/${p.total}</span></div>
          <div class="progress-bar"><div class="progress-fill ${st==='completed'?'done':''} ${st==='failed'?'failed':''}" style="width:${p.pct}%"></div></div>
          <div class="detail-actions">
            ${st==='in_progress'&&!isSys?`<button class="btn btn-danger btn-sm" data-fail-main="${task.id}">失敗にする</button>`:''}
            ${!task.isMedDaily?`<button class="btn btn-sm" data-edit-main="${task.id}">編集</button>`:''}
            ${!isSys?`<button class="btn btn-sm btn-danger" data-del-main="${task.id}">削除</button>`:''}
          </div>
        </div>
        <div class="banner ok ${st==='completed'?'show':''}">◆ TASK COMPLETED ◆</div>
        <div class="banner bad ${st==='failed'?'show':''}">◆ TASK FAILED ◆</div>
        ${lvl==='red'&&st==='in_progress'?'<div class="banner bad show dl-warn">◆ 期限まで3時間未満 ◆</div>':''}
        ${st==='unaccepted'?`<div class="accept-panel"><p>受注すると目標が有効になります</p><button class="btn btn-accept" data-accept="${task.id}">受注する</button></div>`:''}
        ${st==='failed'?`<div class="accept-panel"><p>失敗しました。再開できます</p><button class="btn btn-accept" data-restart="${task.id}">再開する</button></div>`:''}
        <div class="objectives ${st==='unaccepted'?'locked':''} ${editable?'':'ro'}">
          ${st==='unaccepted'?'<div class="lock-note">受注後にチェック／納品が有効（追加は可能）</div>':''}
          ${items.length?`<div class="obj-section"><span>必要物品（持ち物）</span><span class="obj-section-count">${secCount(items)}</span></div>
          ${items.map(s => objRowHtml(task, s, st, editable)).join('')}`:''}
          <div class="obj-section"><span>${task.isMedDaily?'本日の服薬':'目標'}</span><span class="obj-section-count">${secCount(goals)}${canAdd?' <button class="btn btn-sm" data-add-sub>＋ 目標</button>':''}</span></div>
          ${goals.map(s => objRowHtml(task, s, st, editable)).join('') || (task.isMedDaily?'<div class="empty">薬が未登録です。「⚙ 薬を管理」から登録してください</div>':'<div class="empty">なし</div>')}
          ${(dels.length || canAdd)?`<div class="obj-section"><span>納品</span><span class="obj-section-count">${dels.filter(d=>d.done).length}/${dels.length}${canAdd?' <button class="btn btn-sm" data-add-del>＋ 納品</button>':''}</span></div>
          ${dels.map(d => deliveryRowHtml(task, d, st)).join('')}`:''}
          ${!isSys?`<div class="obj-section"><span>報酬</span></div>
          <div class="reward-box ${task.reward?'':'empty-reward'}">${task.reward?esc(task.reward):'未設定（「編集」で入力）'}</div>`:''}
          <div style="height:8px"></div>
        </div>
      </div>`;
  }

  function previewItemHtml(p, mid, idx, disabled) {
    const chips = CHAT_KINDS.map(([k, label]) =>
      `<button class="kind-chip ${p.kind===k?'active':''} ${p.guessKind===k?'guess':''}" data-preview-kind="${k}" data-mid="${mid}" data-idx="${idx}" ${disabled}>${label}</button>`
    ).join('');
    const body = Array.isArray(p.fields) && p.fields.length
      ? `<div class="pc-fields">${p.fields.map(f => `<div class="pc-field"><span class="pc-k">${esc(f.k)}</span><span class="pc-v">${esc(f.v)}</span></div>`).join('')}</div>`
      : `<div class="pc-body">${esc(p.summary)}</div>`;
    return `<div class="pc-item ${p.skip?'skipped':''}">
      <div class="pc-kinds">${chips}</div>
      ${body}
      <div class="pc-meta">${esc(p.meta||'')}</div>
      ${idx >= 0 ? `<button class="btn btn-sm pc-skip" data-preview-skip="${mid}" data-idx="${idx}" ${disabled}>${p.skip?'↺ 戻す（スキップ中）':'この項目をスキップ'}</button>` : ''}
    </div>`;
  }

  function renderChat() {
    const log = document.getElementById('chatLog');
    log.innerHTML = state.chat.map(m => {
      if (m.preview) {
        const p = m.preview;
        const disabled = m.resolved ? 'disabled' : '';
        const isMulti = p.kind === 'multi';
        const inner = isMulti
          ? p.items.map((it, i) => previewItemHtml(it, m.id, i, disabled)).join('')
          : previewItemHtml(p, m.id, -1, disabled);
        return `<div class="bubble bot">
          <div>${esc(m.text)}</div>
          <div class="preview-card">
            <div class="pc-type">${esc(isMulti ? p.label : (CHAT_KINDS.find(x => x[0] === p.kind) || [0, p.label])[1])}</div>
            ${inner}
            <div class="preview-actions">
              <button class="btn btn-primary btn-sm" data-preview-ok="${m.id}" ${disabled}>${isMulti ? 'まとめて追加' : '追加する'}</button>
              <button class="btn btn-sm" data-preview-edit="${m.id}" ${disabled}>修正</button>
              <button class="btn btn-sm btn-danger" data-preview-cancel="${m.id}" ${disabled}>やめる</button>
            </div>
          </div>
        </div>`;
      }
      return `<div class="bubble ${m.role}">${esc(m.text)}</div>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  function renderShop() {
    const el = document.getElementById('shopList');
    if (!state.shopping.length) {
      el.innerHTML = '<div class="empty">買い物リストは空です</div>';
      return;
    }
    el.innerHTML = state.shopping.map(s => `
      <div class="list-item ${s.checked?'checked':''}">
        <div class="checkbox ${s.checked?'checked':''}" data-shop-toggle="${s.id}"></div>
        <div class="obj-body">
          <div class="li-name">${esc(s.name)}${s.isExample?'<span class="example-badge">サンプル</span>':''}</div>
          <div class="li-meta">×${s.qty||1}${s.note?' · '+esc(s.note):''}</div>
        </div>
        ${s.checked?`<button class="btn btn-sm btn-deliver" data-shop-to-task="${s.id}">納品化</button>`:''}
        <button class="btn btn-sm btn-danger" data-shop-del="${s.id}">✕</button>
      </div>`).join('');
  }

  // 服薬設定シート（登録・編集・時刻・通知）。チェックは任務タブの「服薬」任務で行う
  function renderMed() {
    const next = nextDoseInfo();
    const nextEl = document.getElementById('medNext');
    if (!nextEl) return;
    if (next) {
      nextEl.style.display = 'block';
      nextEl.textContent = '次の服薬: ' + next.med.name + ' ' + (next.med.dose||'') + ' @ ' + next.n.label +
        (next.diff >= 0 ? '（あと' + next.diff + '分）' : '（予定時刻超過）');
    } else {
      nextEl.style.display = 'none';
    }
    const perm = document.getElementById('notifPermState');
    if (perm) perm.textContent = !('Notification' in window) ? '通知: 非対応' : ('通知: ' + ({ granted: '許可済み', denied: '拒否', default: '未設定' }[Notification.permission] || Notification.permission));
    const el = document.getElementById('medList');
    const enabled = state.medications.filter(m => m.enabled !== false);
    const rows = medDoseRows();
    const taken = rows.filter(r => r.done).length;
    let html = `<button class="btn btn-primary med-go" data-med-go-task>任務タブで服薬チェック（本日 ${taken}/${rows.length}）</button>`;
    if (!enabled.length) {
      el.innerHTML = html + '<div class="empty">登録された薬はありません</div>';
      return;
    }
    html += '<div class="section-title">登録中の薬</div>';
    enabled.forEach(med => {
      const times = (med.times || []).map(t => normalizeTimeLabel(t).label);
      html += `<div class="list-item med-item">
        <div class="obj-body">
          <div class="li-name">${esc(med.name)} <span class="li-meta">${esc(med.dose||'')}</span>${med.isExample?'<span class="example-badge">サンプル</span>':''}</div>
          <div class="med-times">${times.map(x => `<span class="time-chip">${esc(x)}</span>`).join('')}</div>
        </div>
        <button class="btn btn-sm" data-med-edit="${med.id}">編集</button>
        <button class="btn btn-sm btn-danger" data-med-del="${med.id}">削除</button>
      </div>`;
    });
    el.innerHTML = html;
  }

  // ===== OBJECTIVE CHANGE（チェック／数量／持ち物 共通） =====
  // SE: 前進=check、最後の目標で本当に完了した時だけ complete、戻す=click（入浴/家事を戻す時は従来通り fail）
  function changeObjective(task, sub, mutate) {
    const prevStatus = effectiveStatus(task);
    const prevDone = objDone(sub);
    const prevCur = objCurrent(sub);
    mutate();
    const nowDone = objDone(sub);
    const forward = objCurrent(sub) > prevCur || (!prevDone && nowDone);
    if (objCurrent(sub) === prevCur && prevDone === nowDone) return;
    if (task.isMedDaily && sub.medKey) {
      const [medId, ...rest] = sub.medKey.split('__');
      setMedTaken(medId, rest.join('__'), nowDone);
      scheduleMedNotifications();
    }
    if (task.isBathDaily && sub.isBathSub) {
      state.bathLog[todayKey()] = !!nowDone;
      if (nowDone && state.bathMeta) state.bathMeta.streakWarnedFor = null;
      else if (!nowDone) playSound('fail');
    }
    const isChore = sub.isChoreSub && (task.isLaundryDaily || task.isCleanDaily || task.isTrashDaily);
    if (isChore) {
      const ctype = sub.choreType || task.choreType;
      if (ctype) choreLogMap(ctype)[todayKey()] = !!nowDone;
      if (nowDone && state.choreMeta) state.choreMeta.warnedFor = null;
      else if (!nowDone) playSound('fail');
    }
    syncCompletion(task);
    if (task.isDailyRequired) {
      state.dailyLog[todayKey()] = state.dailyLog[todayKey()] || {};
      state.dailyLog[todayKey()][task.dailyId] = objectivesComplete(task);
    }
    save();
    const just = prevStatus !== 'completed' && effectiveStatus(task) === 'completed';
    const silentUndo = !nowDone && prevDone && ((task.isBathDaily && sub.isBathSub) || isChore);
    if (!silentUndo) playSound(just ? 'complete' : (forward ? 'check' : 'click'));
    if (just) toast('任務完了: ' + task.title);
    maybeShowBathStreakWarning(!!(task.isBathDaily && sub.isBathSub && !nowDone));
    if (isChore) maybeShowChoreWarning(!nowDone);
    renderTasks();
  }

  function updateSubModalLabels() {
    const kind = document.getElementById('subKind').value;
    document.getElementById('subTitleLabel').textContent = kind === 'item' ? '物品名（持ち物・必要物品）' : '目標';
    document.getElementById('subTargetGroup').style.display = kind === 'check' ? 'none' : '';
    document.getElementById('subTargetLabel').textContent = kind === 'item' ? '必要数' : '目標数（回数・数量）';
  }

  function openMedSettings() {
    renderMed();
    openModal('modalMedSettings');
  }

  // ===== MODALS =====
  function openModal(id) { document.getElementById(id).classList.add('show'); playSound('click'); }
  function closeModal(id) { document.getElementById(id).classList.remove('show'); }

  // ===== EVENTS =====
  function bind() {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });

    document.getElementById('btnMute').addEventListener('click', () => {
      muted = !muted;
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
      document.getElementById('btnMute').textContent = muted ? '🔇' : '🔊';
      document.getElementById('btnMute').classList.toggle('active', muted);
      if (!muted) playSound('click');
    });

    document.getElementById('btnSettings').addEventListener('click', () => { updateDataLayerStatus(); openModal('modalSettings'); });

    document.querySelectorAll('[data-close]').forEach(el => {
      el.addEventListener('click', () => { playSound('click'); closeModal(el.getAttribute('data-close')); });
    });
    document.querySelectorAll('.modal-backdrop').forEach(bd => {
      bd.addEventListener('click', e => { if (e.target === bd) { playSound('click'); bd.classList.remove('show'); } });
    });
    const bathPop = document.getElementById('bathStreakPopup');
    if (bathPop) {
      bathPop.addEventListener('click', e => {
        if (e.target === bathPop || e.target.closest('[data-close-bath-warn]')) {
          playSound('click');
          bathPop.classList.remove('show');
        }
      });
    }

    // Task list delegation
    const chorePop = document.getElementById('choreWarnPopup');
    if (chorePop) {
      chorePop.addEventListener('click', e => {
        if (e.target === chorePop || e.target.closest('[data-close-chore-warn]')) {
          playSound('click');
          chorePop.classList.remove('show');
        }
      });
    }

    document.getElementById('taskList').addEventListener('click', e => {
      const bathBtn = e.target.closest('[data-bath]');
      if (bathBtn) {
        setBathToday(bathBtn.getAttribute('data-bath') === '1');
        return;
      }
      const outingBtn = e.target.closest('[data-outing-tm]');
      if (outingBtn) {
        setTomorrowOuting(outingBtn.getAttribute('data-outing-tm') === '1');
        return;
      }
      const choreBtn = e.target.closest('[data-chore]');
      if (choreBtn) {
        setChoreToday(choreBtn.getAttribute('data-chore'), choreBtn.getAttribute('data-chore-done') === '1');
        return;
      }
      if (e.target.id === 'btnNewMain' || e.target.closest('#btnNewMain')) {
        editingMainId = null;
        document.getElementById('modalMainTitle').textContent = 'メインタスク作成';
        document.getElementById('mainTitle').value = '';
        document.getElementById('mainTrader').value = '';
        document.getElementById('mainDesc').value = '';
        document.getElementById('mainDeadline').value = '';
        document.getElementById('mainLocation').value = '';
        document.getElementById('mainReward').value = '';
        openModal('modalMain');
        return;
      }
      if (e.target.closest('#btnShowDone')) {
        showCompleted = !showCompleted;
        localStorage.setItem(SHOW_DONE_KEY, showCompleted ? '1' : '0');
        playSound('click'); renderTasks(); return;
      }
      const gh = e.target.closest('[data-group-toggle]');
      if (gh) {
        const g = gh.getAttribute('data-group-toggle');
        collapsedGroups[g] = !collapsedGroups[g];
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedGroups));
        playSound('click'); renderTasks(); return;
      }
      const card = e.target.closest('[data-select]');
      if (card) {
        selectedId = card.getAttribute('data-select');
        playSound('click');
        renderTasks();
        const det = document.getElementById('taskDetail');
        if (det && window.matchMedia && window.matchMedia('(max-width: 899px)').matches) {
          requestAnimationFrame(() => det.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        }
      }
    });

    document.getElementById('taskDetail').addEventListener('click', e => {
      const t = e.target.closest('[data-accept],[data-restart],[data-fail-main],[data-edit-main],[data-del-main],[data-add-sub],[data-add-del],[data-toggle-sub],[data-del-sub],[data-hand-over],[data-del-del],[data-approve],[data-discard],[data-obj-inc],[data-obj-dec],[data-obj-ready],[data-obj-unready],[data-open-med-settings],[data-back-list]');
      if (!t) return;
      const task = selectedId ? getTask(selectedId) : null;

      if (t.hasAttribute('data-back-list')) {
        playSound('click');
        document.querySelector('#screenTasks .screen-body')?.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (t.hasAttribute('data-open-med-settings')) { openMedSettings(); return; }

      if (t.hasAttribute('data-approve')) {
        const id = t.getAttribute('data-approve');
        const tk = getTask(id);
        if (!tk) return;
        tk.status = 'unaccepted';
        state.pendingReviewIds = state.pendingReviewIds.filter(x => x !== id);
        save(); playSound('click'); toast('承認しました（未受注）'); renderTasks(); return;
      }
      if (t.hasAttribute('data-discard')) {
        const id = t.getAttribute('data-discard');
        if (!confirm('この未確認任務を破棄しますか？')) return;
        state.tasks = state.tasks.filter(x => x.id !== id);
        state.pendingReviewIds = state.pendingReviewIds.filter(x => x !== id);
        if (selectedId === id) selectedId = state.tasks[0]?.id || null;
        save(); playSound('click'); renderTasks(); return;
      }
      if (t.hasAttribute('data-accept')) {
        const tk = getTask(t.getAttribute('data-accept'));
        if (!tk || tk.status !== 'unaccepted') return;
        tk.status = 'in_progress'; tk.acceptedAt = Date.now(); tk.failSoundPlayed = false;
        save(); playSound('start'); checkDeadlines(); renderTasks(); return;
      }
      if (t.hasAttribute('data-restart')) {
        const tk = getTask(t.getAttribute('data-restart'));
        if (!tk) return;
        tk.subs.forEach(s => setObjDone(s, false));
        tk.deliveries.forEach(d => d.done = false);
        tk.status = 'unaccepted'; tk.acceptedAt = null; tk.failSoundPlayed = false;
        save(); playSound('click'); renderTasks(); return;
      }
      if (t.hasAttribute('data-fail-main')) {
        const tk = getTask(t.getAttribute('data-fail-main'));
        if (!tk || effectiveStatus(tk) !== 'in_progress') return;
        if (!confirm('失敗にしますか？')) return;
        tk.status = 'failed'; tk.failSoundPlayed = true;
        save(); playSound('fail'); renderTasks(); return;
      }
      if (t.hasAttribute('data-edit-main')) {
        const id = t.getAttribute('data-edit-main');
        const tk = getTask(id);
        if (!tk) return;
        editingMainId = id;
        document.getElementById('modalMainTitle').textContent = 'メインタスク編集';
        document.getElementById('mainTitle').value = tk.title;
        document.getElementById('mainTrader').value = tk.trader || '';
        document.getElementById('mainDesc').value = tk.desc || '';
        document.getElementById('mainDeadline').value = toLocalInput(tk.deadline);
        document.getElementById('mainLocation').value = tk.location || '';
        document.getElementById('mainReward').value = tk.reward || '';
        openModal('modalMain'); return;
      }
      if (t.hasAttribute('data-del-main')) {
        const id = t.getAttribute('data-del-main');
        const victim = getTask(id);
        if (victim && isSystemTask(victim)) { toast('システム任務は削除できません'); return; }
        if (!confirm(victim && victim.isDailyRequired ? '毎日の必須タスクを削除しますか？（明日以降も出なくなります）' : '削除しますか？')) return;
        if (victim && victim.isDailyRequired) state.dailyRequired = state.dailyRequired.filter(d => d.id !== victim.dailyId);
        state.tasks = state.tasks.filter(x => x.id !== id);
        if (selectedId === id) selectedId = state.tasks[0]?.id || null;
        save(); playSound('click'); renderTasks(); return;
      }
      if (t.hasAttribute('data-add-sub')) {
        document.getElementById('subTitle').value = '';
        document.getElementById('subKind').value = 'check';
        document.getElementById('subTarget').value = '1';
        updateSubModalLabels();
        openModal('modalSub'); return;
      }
      if (t.hasAttribute('data-add-del')) {
        document.getElementById('delName').value = '';
        document.getElementById('delQty').value = '1';
        document.getElementById('delType').value = 'deliverable';
        openModal('modalDelivery'); return;
      }
      if (!task) return;
      if (t.hasAttribute('data-toggle-sub')) {
        if (!canEditObjectives(task)) return;
        const sub = task.subs.find(s => s.id === t.getAttribute('data-toggle-sub'));
        if (!sub) return;
        changeObjective(task, sub, () => setObjDone(sub, !objDone(sub)));
        return;
      }
      if (t.hasAttribute('data-obj-inc') || t.hasAttribute('data-obj-dec') || t.hasAttribute('data-obj-ready') || t.hasAttribute('data-obj-unready')) {
        if (!canEditObjectives(task)) return;
        const id = t.getAttribute('data-obj-inc') || t.getAttribute('data-obj-dec') || t.getAttribute('data-obj-ready') || t.getAttribute('data-obj-unready');
        const sub = task.subs.find(s => s.id === id);
        if (!sub) return;
        if (t.hasAttribute('data-obj-inc')) changeObjective(task, sub, () => setObjCurrent(sub, objCurrent(sub) + 1));
        else if (t.hasAttribute('data-obj-dec')) changeObjective(task, sub, () => setObjCurrent(sub, objCurrent(sub) - 1));
        else if (t.hasAttribute('data-obj-ready')) changeObjective(task, sub, () => setObjDone(sub, true));
        else changeObjective(task, sub, () => setObjDone(sub, false));
        return;
      }
      if (t.hasAttribute('data-del-sub')) {
        task.subs = task.subs.filter(s => s.id !== t.getAttribute('data-del-sub'));
        syncCompletion(task); save(); playSound('click'); renderTasks(); return;
      }
      if (t.hasAttribute('data-hand-over')) {
        if (effectiveStatus(task) !== 'in_progress') return;
        const del = task.deliveries.find(d => d.id === t.getAttribute('data-hand-over'));
        if (!del || del.done) return;
        del.done = true;
        const just = syncCompletion(task);
        save(); playSound(just ? 'complete' : 'deliver'); renderTasks(); return;
      }
      if (t.hasAttribute('data-del-del')) {
        task.deliveries = task.deliveries.filter(d => d.id !== t.getAttribute('data-del-del'));
        syncCompletion(task); save(); playSound('click'); renderTasks(); return;
      }
    });

    document.getElementById('btnSaveMain').addEventListener('click', () => {
      const title = document.getElementById('mainTitle').value.trim();
      if (!title) return;
      const trader = document.getElementById('mainTrader').value.trim() || '自分';
      const desc = document.getElementById('mainDesc').value.trim();
      const dlVal = document.getElementById('mainDeadline').value;
      const deadline = dlVal ? new Date(dlVal).toISOString() : null;
      const loc = (document.getElementById('mainLocation')?.value || '').trim();
      const reward = (document.getElementById('mainReward')?.value || '').trim();
      if (editingMainId) {
        const t = getTask(editingMainId);
        if (t) { t.title = title; t.trader = trader; t.desc = desc; t.deadline = deadline; t.location = loc; t.reward = reward; t.isExample = false; }
        if (t && t.isDailyRequired) {
          const def = state.dailyRequired.find(d => d.id === t.dailyId);
          if (def) { def.title = title; def.location = loc; }
          t.deadline = null; // 毎日タスクは期限なし（時刻はリマインドのみ）
        }
      } else {
        const t = {
          id: uid(), title, trader, desc, deadline, location: loc, reward, isExample: false,
          status: 'unaccepted', failSoundPlayed: false, acceptedAt: null,
          subs: [], deliveries: []
        };
        state.tasks.push(t); selectedId = t.id;
      }
      save(); closeModal('modalMain'); playSound('click'); checkDeadlines(); renderTasks();
    });

    document.getElementById('btnSaveSub').addEventListener('click', () => {
      const title = document.getElementById('subTitle').value.trim();
      if (!title || !selectedId) return;
      const task = getTask(selectedId);
      const kind = document.getElementById('subKind').value;
      const target = kind === 'check' ? 1 : Math.max(1, parseInt(document.getElementById('subTarget').value, 10) || 1);
      task.subs.push(makeObjective(title, kind, target));
      if (task.status === 'completed') task.status = 'in_progress';
      save(); closeModal('modalSub'); playSound('click'); renderTasks();
    });

    document.getElementById('btnSaveDel').addEventListener('click', () => {
      const name = document.getElementById('delName').value.trim();
      if (!name || !selectedId) return;
      const task = getTask(selectedId);
      task.deliveries.push({
        id: uid(), name,
        qty: Math.max(1, parseInt(document.getElementById('delQty').value,10)||1),
        type: document.getElementById('delType').value, done: false
      });
      if (task.status === 'completed') task.status = 'in_progress';
      save(); closeModal('modalDelivery'); playSound('click'); renderTasks();
    });

    // Chat
    document.getElementById('chatSend').addEventListener('click', sendChat);
    const chatInputEl = document.getElementById('chatInput');
    const isTouchDevice = () => (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || ('ontouchstart' in window);
    const autoGrow = () => { chatInputEl.style.height = 'auto'; chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 160) + 'px'; };
    chatInputEl.addEventListener('input', autoGrow);
    chatInputEl.addEventListener('keydown', e => {
      // スマホ: Enter は改行（送信はボタン）。PC: Enter=送信 / Shift+Enter=改行
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      if (isTouchDevice() || e.shiftKey) return;
      e.preventDefault(); sendChat();
    });

    function lastOpenPreview() {
      for (let i = state.chat.length - 1; i >= 0; i--) {
        const m = state.chat[i];
        if (m.preview) return m.resolved ? null : m;
      }
      return null;
    }

    function sendChat() {
      const input = document.getElementById('chatInput');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      autoGrow();
      state.chat.push({ id: uid(), role: 'user', text, ts: Date.now() });
      const parsed = parseChat(text);
      if (!parsed) {
        state.chat.push({ id: uid(), role: 'bot', text: 'すみません、理解できませんでした。内容（何を・いつ・どこで）を書いて送ってください。', ts: Date.now() });
      } else if (parsed.kind === 'correction') {
        // 「サブタスクではなく〜」等は任務にしない → 直前のプレビューの種類を変更
        const target = lastOpenPreview();
        let reply;
        if (!target) {
          reply = '変更できる未確定のプレビューがありません。内容をもう一度送って、カードの種類ボタンで選んでください。';
        } else if (!parsed.targetKind) {
          reply = 'どの種類にしますか？上のカードの種類ボタン（メイン任務／サブタスク／毎日の必須／買い物／服薬）で選んでください。';
        } else if (target.preview.kind === 'multi') {
          const open = target.preview.items.filter(it => !it.skip);
          if (open.length === 1) {
            const i = target.preview.items.indexOf(open[0]);
            target.preview.items[i] = reparseAs(open[0], parsed.targetKind);
            reply = '種類を「' + (CHAT_KINDS.find(x => x[0] === parsed.targetKind) || [0, ''])[1] + '」に変更しました。';
          } else {
            reply = '複数の項目があります。上のカードで項目ごとに種類ボタンを選んでください。';
          }
        } else {
          target.preview = reparseAs(target.preview, parsed.targetKind);
          reply = '種類を「' + (CHAT_KINDS.find(x => x[0] === parsed.targetKind) || [0, ''])[1] + '」に変更しました。上のカードで確認して「追加する」を押してください。';
        }
        state.chat.push({ id: uid(), role: 'bot', text: reply, ts: Date.now() });
      } else {
        const mid = uid();
        state.chat.push({
          id: mid, role: 'bot',
          text: parsed.kind === 'multi'
            ? parsed.items.length + '件に分けました。種類を確認して「まとめて追加」を押してください。'
            : 'こう追加します。種類を確認して「追加する」を押してください。',
          preview: parsed, resolved: false, ts: Date.now()
        });
        pendingPreview = mid;
      }
      save(); playSound('click'); renderChat();
    }

    document.getElementById('chatLog').addEventListener('click', e => {
      const ok = e.target.closest('[data-preview-ok]');
      const edit = e.target.closest('[data-preview-edit]');
      const cancel = e.target.closest('[data-preview-cancel]');
      const kindBtn = e.target.closest('[data-preview-kind]');
      const skipBtn = e.target.closest('[data-preview-skip]');
      if (kindBtn || skipBtn) {
        const el = kindBtn || skipBtn;
        const msg = state.chat.find(m => m.id === (kindBtn ? el.getAttribute('data-mid') : el.getAttribute('data-preview-skip')));
        if (!msg || msg.resolved || !msg.preview) return;
        const idx = parseInt(el.getAttribute('data-idx'), 10);
        const multi = msg.preview.kind === 'multi';
        const cur = multi ? msg.preview.items[idx] : msg.preview;
        if (!cur) return;
        let next = cur;
        if (kindBtn) next = reparseAs(cur, el.getAttribute('data-preview-kind'));
        else next = Object.assign({}, cur, { skip: !cur.skip });
        if (multi) msg.preview.items[idx] = next; else msg.preview = next;
        save(); playSound('click'); renderChat(); return;
      }
      if (ok) {
        const id = ok.getAttribute('data-preview-ok');
        const msg = state.chat.find(m => m.id === id);
        if (!msg || msg.resolved) return;
        applyPreview(msg.preview);
        msg.resolved = true;
        state.chat.push({ id: uid(), role: 'bot', text: '追加しました。', ts: Date.now() });
        save(); playSound('start'); renderChat();
        try { renderTasks(); renderShop(); renderMed(); } catch (_) {}
        return;
      }
      if (cancel) {
        const id = cancel.getAttribute('data-preview-cancel');
        const msg = state.chat.find(m => m.id === id);
        if (!msg || msg.resolved) return;
        msg.resolved = true;
        state.chat.push({ id: uid(), role: 'bot', text: 'キャンセルしました。', ts: Date.now() });
        save(); playSound('click'); renderChat(); return;
      }
      if (edit) {
        const id = edit.getAttribute('data-preview-edit');
        const msg = state.chat.find(m => m.id === id);
        if (!msg || msg.resolved) return;
        msg.resolved = true;
        const sug = msg.preview?.source || msg.preview?.summary || '';
        document.getElementById('chatInput').value = sug;
        document.getElementById('chatInput').focus();
        state.chat.push({ id: uid(), role: 'bot', text: '入力欄に内容を戻しました。直して再送信してください。', ts: Date.now() });
        save(); playSound('click'); renderChat(); return;
      }
    });

    // Shopping
    document.getElementById('btnAddShop').addEventListener('click', () => {
      const name = document.getElementById('shopName').value.trim();
      if (!name) return;
      const qty = Math.max(1, parseInt(document.getElementById('shopQty').value,10)||1);
      state.shopping.push({ id: uid(), name, qty, checked: false, note: '', isExample: false });
      document.getElementById('shopName').value = '';
      save(); playSound('click'); renderShop();
    });

    document.getElementById('shopList').addEventListener('click', e => {
      const tog = e.target.closest('[data-shop-toggle]');
      const del = e.target.closest('[data-shop-del]');
      const toTask = e.target.closest('[data-shop-to-task]');
      if (tog) {
        const s = state.shopping.find(x => x.id === tog.getAttribute('data-shop-toggle'));
        if (!s) return;
        s.checked = !s.checked; save(); playSound('check'); renderShop(); return;
      }
      if (del) {
        state.shopping = state.shopping.filter(x => x.id !== del.getAttribute('data-shop-del'));
        save(); playSound('click'); renderShop(); return;
      }
      if (toTask) {
        const s = state.shopping.find(x => x.id === toTask.getAttribute('data-shop-to-task'));
        if (!s) return;
        // add as purchase delivery on inbox or new task
        let host = state.tasks.find(t => t.isInbox && effectiveStatus(t) !== 'failed');
        if (!host) {
          host = {
            id: uid(), title: '買い物納品', trader: '買い物',
            desc: '買い物リストから変換', isExample: false, status: 'in_progress',
            deadline: null, failSoundPlayed: false, acceptedAt: Date.now(),
            subs: [], deliveries: [], isInbox: false
          };
          state.tasks.push(host);
        }
        host.deliveries.push({ id: uid(), name: s.name, qty: s.qty || 1, type: 'purchase', done: false });
        if (host.status === 'completed') host.status = 'in_progress';
        state.shopping = state.shopping.filter(x => x.id !== s.id);
        selectedId = host.id;
        save(); playSound('start'); toast('購入品の納品タスクに変換しました'); renderShop(); return;
      }
    });

    // Medication
    document.getElementById('subKind').addEventListener('change', updateSubModalLabels);
    document.getElementById('btnOpenMedSettings').addEventListener('click', () => { closeModal('modalSettings'); openMedSettings(); });
    document.getElementById('btnAddMed').addEventListener('click', () => {
      editingMedId = null;
      document.getElementById('modalMedTitle').textContent = '薬を登録';
      document.getElementById('btnSaveMed').textContent = '登録';
      document.getElementById('medName').value = '';
      document.getElementById('medDose').value = '1錠';
      document.getElementById('medTimes').value = '朝';
      openModal('modalMed');
    });

    document.getElementById('btnSaveMed').addEventListener('click', () => {
      const name = document.getElementById('medName').value.trim();
      if (!name) return;
      const dose = document.getElementById('medDose').value.trim() || '1回分';
      let times = dedupeTimes(
        document.getElementById('medTimes').value.split(/[、,\s]+/).map(s => s.trim()).filter(Boolean)
      );
      if (!times.length) times = ['08:00'];
      if (editingMedId) {
        const med = state.medications.find(m => m.id === editingMedId);
        if (med) { med.name = name; med.dose = dose; med.times = times; med.isExample = false; }
        editingMedId = null;
        syncMedDailyTask(); scheduleMedNotifications();
        save(); closeModal('modalMed'); playSound('click'); renderMed(); renderTasks();
        toast('薬を更新しました');
        return;
      }
      const existing = state.medications.find(m =>
        m.enabled !== false && String(m.name || '').trim() === name
      );
      if (existing) {
        existing.times = dedupeTimes((existing.times || []).concat(times));
        existing.dose = dose || existing.dose;
        existing.isExample = false;
        syncMedDailyTask(); scheduleMedNotifications();
        save(); closeModal('modalMed'); playSound('click'); renderMed(); renderTasks();
        toast('同名の薬に時刻をマージしました');
        return;
      }
      state.medications.push({
        id: uid(), name, dose, times, linkToDailyTask: true, enabled: true, isExample: false
      });
      syncMedDailyTask(); scheduleMedNotifications();
      save(); closeModal('modalMed'); playSound('click'); renderMed(); renderTasks();
    });

    document.getElementById('btnNotifPerm').addEventListener('click', async () => {
      if (!('Notification' in window)) { toast('このブラウザは通知非対応です'); return; }
      const perm = await Notification.requestPermission();
      toast(perm === 'granted' ? '通知を許可しました（アプリ表示中のみ）' : '通知が拒否されました');
      if (perm === 'granted') scheduleMedNotifications();
      renderMed();
      playSound('click');
    });

    document.getElementById('medList').addEventListener('click', e => {
      const edit = e.target.closest('[data-med-edit]');
      const del = e.target.closest('[data-med-del]');
      const go = e.target.closest('[data-med-go-task]');
      if (go) {
        closeModal('modalMedSettings');
        const mt = state.tasks.find(x => x.isMedDaily);
        if (mt) selectedId = mt.id;
        switchTab('tasks');
        return;
      }
      if (edit) {
        const med = state.medications.find(m => m.id === edit.getAttribute('data-med-edit'));
        if (!med) return;
        editingMedId = med.id;
        document.getElementById('modalMedTitle').textContent = '薬を編集';
        document.getElementById('btnSaveMed').textContent = '保存';
        document.getElementById('medName').value = med.name || '';
        document.getElementById('medDose').value = med.dose || '';
        document.getElementById('medTimes').value = (med.times || []).map(t => TIME_TO_SLOT[t] || t).join(', ');
        openModal('modalMed');
        return;
      }
      if (del) {
        if (!confirm('この薬を削除しますか？')) return;
        const id = del.getAttribute('data-med-del');
        state.medications = state.medications.filter(m => m.id !== id);
        syncMedDailyTask(); scheduleMedNotifications(); save(); playSound('click'); renderMed(); renderTasks();
      }
    });

    // Settings import/export
    document.getElementById('btnExport').addEventListener('click', () => {
      const data = exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'daily-tasks-export.json';
      a.click();
      URL.revokeObjectURL(a.href);
      playSound('click'); toast('エクスポートしました');
    });

    document.getElementById('importFile').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const n = importData(json);
        closeModal('modalSettings');
        toast(n + '件の任務を未確認として取り込みました');
        selectedId = state.pendingReviewIds[0] || selectedId;
        switchTab('tasks');
        playSound('start');
      } catch (err) {
        toast('インポート失敗: ' + err.message);
      }
      e.target.value = '';
    });

    document.getElementById('btnResetDemo').addEventListener('click', () => {
      if (!confirm('サンプルデータで初期化しますか？（現在のデータは消えます）')) return;
      state = exampleState();
      save();
      selectedId = state.tasks.find(t => t.status === 'in_progress')?.id || state.tasks[0]?.id;
      syncMedDailyTask();
      syncBathDailyTask();
      syncChoreDailyTasks();
      closeModal('modalSettings');
      switchTab('tasks');
      toast('サンプルで初期化しました');
    });
  }

  // ===== INIT =====
  async function init() {
    state = await loadStateAsync();
    selectedId = state.tasks.find(t => effectiveStatus(t) === 'in_progress')?.id
      || state.tasks.find(t => t.status === 'pending_review')?.id
      || state.tasks[0]?.id
      || null;
    document.getElementById('btnMute').textContent = muted ? '🔇' : '🔊';
    document.getElementById('btnMute').classList.toggle('active', muted);
    bind();
    syncMedDailyTask();
    syncBathDailyTask();
    syncChoreDailyTasks();
    checkDeadlines();
    scheduleMedNotifications();
    switchTab('tasks');
    updateDataLayerStatus();
    maybeShowBathStreakWarning(false);
    maybeShowChoreWarning(false);

    if (window.DataLayer && DataLayer.requestPersist) {
      DataLayer.requestPersist().then((ok) => {
        if (ok) console.log('Persistent storage granted');
      });
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).then(reg => {
        console.log('SW registered', reg.scope);
      }).catch(err => console.warn('SW failed', err));
    }

    setInterval(tickCountdowns, 1000);
    setInterval(() => {
      const changed = checkDeadlines();
      // 日付・服薬の時刻超過・期限の色を定期反映（モーダル表示中は再描画しない）
      if (activeScreen() === 'tasks' && !anyModalOpen()) renderTasks();
      else if (changed && activeScreen() === 'tasks') renderTasks();
      if (document.getElementById('modalMedSettings')?.classList.contains('show')) renderMed();
    }, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { init(); });
  else init();
})();
