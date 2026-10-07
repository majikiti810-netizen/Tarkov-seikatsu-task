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
    return {
      tasks: [
        {
          id: 'ex_m1', title: '朝の作戦準備', trader: 'Prapor風 / 自分',
          desc: '【サンプル】起床〜作業開始までの一連任務',
          isExample: true, status: 'in_progress', deadline: null,
          failSoundPlayed: false, acceptedAt: Date.now() - 3600000,
          subs: [
            { id: 'ex_s1', title: 'アラームを止めて水を飲む', done: true },
            { id: 'ex_s2', title: 'メールの未読を確認', done: false },
            { id: 'ex_s3', title: '今日のカレンダーを開く', done: false }
          ],
          deliveries: [
            { id: 'ex_d1', name: '朝食ログ', qty: 1, type: 'deliverable', done: false },
            { id: 'ex_d2', name: 'プロテインバー', qty: 1, type: 'purchase', done: false }
          ]
        },
        {
          id: 'ex_m2', title: 'デスク・クリアランス', trader: 'Therapist風 / 自分',
          desc: '【サンプル】受注前の任務',
          isExample: true, status: 'unaccepted', deadline: null,
          failSoundPlayed: false, acceptedAt: null,
          subs: [
            { id: 'ex_s4', title: '机の上を片付ける', done: false },
            { id: 'ex_s5', title: '明日のタスクを3つ書く', done: false }
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
      choreMeta: { lastSeenDay: null, warnedFor: null }
    };
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
    migrateMedications(p);
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

  function taskProgress(task) {
    const items = [...(task.subs||[]), ...(task.deliveries||[])];
    const total = items.length;
    const done = items.filter(i => i.done).length;
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

  function syncMedDailyTask() {
    if (!state.settings.medLinkDailyTask) {
      state.tasks = state.tasks.filter(t => !t.isMedDaily);
      save();
      return;
    }
    const task = ensureMedDailyTask();
    const wanted = [];
    state.medications.filter(m => m.enabled && m.linkToDailyTask !== false).forEach(med => {
      (med.times || []).forEach(t => {
        const n = normalizeTimeLabel(t);
        wanted.push({
          key: medLogKey(med.id, n.key),
          title: med.name + ' ' + (med.dose || '') + ' @ ' + n.label,
          done: isMedTaken(med.id, n.key)
        });
      });
    });
    // rebuild subs preserving ids where possible
    const byTitle = {};
    task.subs.forEach(s => { byTitle[s.title] = s; });
    task.subs = wanted.map(w => {
      const prev = byTitle[w.title];
      return { id: prev ? prev.id : uid(), title: w.title, done: w.done, medKey: w.key };
    });
    if (task.status === 'unaccepted') task.status = 'in_progress';
    syncCompletion(task);
    if (task.status === 'completed' && !objectivesComplete(task)) task.status = 'in_progress';
    if (objectivesComplete(task) && task.subs.length) task.status = 'completed';
    else if (task.status === 'completed') task.status = 'in_progress';
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
  }

  // ===== BATH (入浴) =====
  function hasOutingOn(dayKey) {
    if (!dayKey) return false;
    if (state.localOutings && state.localOutings[dayKey]) return true;
    return (state.tasks || []).some(t => {
      if (!t || isSystemTask(t)) return false;
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
  // 1文から 任務 / 日時・期限 / 場所 / 持ち物 / 買うもの / メモ を抽出する。
  function parseChat(text) {
    const CP = (typeof window !== 'undefined' && window.ChatParser) || null;
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (!CP) {
      return { kind: 'todo', label: 'サブタスク / ToDo', source: raw, title: raw, summary: raw,
        meta: '「インボックス」任務のサブタスクとして追加' };
    }
    return CP.parseChat(raw, { medications: state.medications || [] });
  }

  function applyPreview(p) {
    if (!p) return;
    if (p.kind === 'shopping') {
      p.items.forEach(name => {
        state.shopping.push({ id: uid(), name, qty: 1, checked: false, note: p.note ? ('チャット ' + p.note) : 'チャット', isExample: false });
      });
      save();
      toast('買い物リストに追加しました');
      return;
    }
    if (p.kind === 'medication') {
      const times = dedupeTimes(p.times || []);
      if (p.mergeIntoId) {
        const existing = state.medications.find(m => m.id === p.mergeIntoId);
        if (existing) {
          const before = dedupeTimes(existing.times);
          existing.times = dedupeTimes(before.concat(times));
          existing.isExample = false;
          const added = existing.times.filter(t => !before.includes(t));
          syncMedDailyTask();
          scheduleMedNotifications();
          save();
          toast(added.length ? ('時刻を追加しました（' + added.join(', ') + '）') : '変更なし（既に登録済み）');
          return;
        }
      }
      // name-match fallback merge
      const byName = state.medications.find(m =>
        m.enabled !== false && String(m.name || '').trim() === String(p.name || '').trim()
      );
      if (byName) {
        const before = dedupeTimes(byName.times);
        byName.times = dedupeTimes(before.concat(times));
        byName.isExample = false;
        syncMedDailyTask();
        scheduleMedNotifications();
        save();
        toast('既存の服薬にマージしました');
        return;
      }
      state.medications.push({
        id: uid(), name: p.name, dose: p.dose || '1回分',
        times, linkToDailyTask: true, enabled: true, isExample: false
      });
      syncMedDailyTask();
      scheduleMedNotifications();
      save();
      toast('服薬を登録しました');
      return;
    }
    if (p.kind === 'main_task') {
      const subs = (p.bring || []).map(it => ({ id: uid(), title: '持ち物: ' + it, done: false }));
      subs.push({ id: uid(), title: '実施する', done: false });
      const descParts = [];
      if (p.memo) descParts.push('メモ: ' + p.memo);
      if ((p.buy || []).length) descParts.push('買うもの: ' + p.buy.join('、') + (p.buyHint ? '（' + p.buyHint + '）' : '') + ' → 買い物リスト');
      const t = {
        id: uid(), title: p.title, trader: p.trader || 'チャット',
        desc: descParts.join('\n') || 'チャットから追加', isExample: false, status: 'unaccepted',
        deadline: p.deadline, location: p.location || '',
        failSoundPlayed: false, acceptedAt: null,
        subs,
        deliveries: []
      };
      state.tasks.push(t);
      (p.buy || []).forEach(name => {
        state.shopping.push({ id: uid(), name, qty: 1, checked: false,
          note: 'チャット（' + p.title + (p.buyHint ? '・' + p.buyHint : '') + '）', isExample: false });
      });
      selectedId = t.id;
      ensureBathDailyTask();
      save();
      toast('任務を追加しました（未受注）' + ((p.buy || []).length ? ' ＋買い物' + p.buy.length + '件' : ''));
      return;
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
      inbox.subs.push({ id: uid(), title: p.title, done: false });
      if (inbox.status === 'completed') inbox.status = 'in_progress';
      selectedId = inbox.id;
      save();
      toast('ToDo を追加しました');
    }
  }

  // ===== IMPORT / EXPORT =====
  function exportData() {
    const payload = {
      schemaVersion: '1.0',
      exportedAt: new Date().toISOString(),
      mainTasks: state.tasks.filter(t => !isSystemTask(t)).map(t => ({
        title: t.title, trader: t.trader, desc: t.desc, deadline: t.deadline,
        location: t.location || '',
        status: t.status,
        subs: (t.subs||[]).map(s => ({ title: s.title, done: !!s.done })),
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
        status: 'pending_review',
        failSoundPlayed: false,
        acceptedAt: null,
        isExample: false,
        subs: (mt.subs || []).map(s => ({ id: uid(), title: s.title || '目標', done: false })),
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

  function renderTasks() {
    checkDeadlines();
    syncBathDailyTask();
    syncChoreDailyTasks();
    const list = document.getElementById('taskList');
    const pending = state.tasks.filter(t => t.status === 'pending_review');
    const normal = state.tasks.filter(t => t.status !== 'pending_review');

    let html = renderBathPanel() + renderChorePanel();
    if (pending.length) {
      html += '<div class="section-title">未確認レビュー<span class="status-pill pending_review">' + pending.length + '</span></div>';
      pending.forEach(t => {
        html += `<div class="task-card status-pending_review ${t.id===selectedId?'active':''}" data-select="${t.id}">
          <div class="tc-title">${esc(t.title)}<span class="status-pill pending_review">未確認</span></div>
          <div class="tc-meta">微調整＆確認が必要</div>
        </div>`;
      });
    }
    html += '<div class="section-title">任務一覧<button class="btn btn-sm btn-primary" id="btnNewMain">＋ 追加</button></div>';
    if (!normal.length) html += '<div class="empty">任務なし</div>';
    normal.forEach(t => {
      const st = effectiveStatus(t);
      const p = taskProgress(t);
      html += `<div class="task-card status-${st} ${t.id===selectedId?'active':''}" data-select="${t.id}">
        <div class="tc-title">${esc(t.title)}${t.isExample?'<span class="example-badge">サンプル</span>':''}<span class="status-pill ${st}">${STATUS_LABEL[st]}</span></div>
        <div class="tc-meta">${esc(t.trader||'—')} · ${p.done}/${p.total}${t.location?' · 場所: '+esc(t.location):''}</div>
      </div>`;
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

    if (st === 'pending_review') {
      detail.innerHTML = `
        <div class="detail-panel">
          <div class="detail-header">
            <div class="detail-trader">PENDING REVIEW · 未確認</div>
            <div class="detail-title">${esc(task.title)}</div>
            <div class="detail-desc">${esc(task.desc||'')}</div>
            <div class="detail-desc" style="margin-top:6px">期限: ${dl ? esc(dl) : 'なし'}</div>
            ${task.location?`<div class="detail-desc detail-location">場所: ${esc(task.location)}</div>`:''}
            <div class="section-title" style="margin-top:10px">サブタスク</div>
            ${(task.subs||[]).map(s=>`<div class="obj-card"><div class="obj-text">${esc(s.title)}</div></div>`).join('')||'<div class="empty">なし</div>'}
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

    detail.innerHTML = `
      <div class="detail-panel">
        <div class="detail-header ${st}">
          <div class="detail-trader">${esc(task.trader||'UNKNOWN')} · ${STATUS_LABEL[st]}</div>
          <div class="detail-title">${esc(task.title)}${task.isExample?'<span class="example-badge">サンプル</span>':''}<span class="status-pill ${st}">${STATUS_LABEL[st]}</span></div>
          ${task.desc?`<div class="detail-desc">${esc(task.desc)}</div>`:''}
          <div class="detail-desc" style="margin-top:4px">期限: ${dl?esc(dl):'なし'}</div>
          ${task.location?`<div class="detail-desc detail-location">場所: ${esc(task.location)}</div>`:''}
          <div class="progress-row"><span>OBJECTIVES</span><span class="progress-count">${p.done}/${p.total}</span></div>
          <div class="progress-bar"><div class="progress-fill ${st==='completed'?'done':''} ${st==='failed'?'failed':''}" style="width:${p.pct}%"></div></div>
          <div class="detail-actions">
            ${st==='in_progress'?`<button class="btn btn-danger btn-sm" data-fail-main="${task.id}">失敗にする</button>`:''}
            <button class="btn btn-sm" data-edit-main="${task.id}">編集</button>
            ${!isSystemTask(task)?`<button class="btn btn-sm btn-danger" data-del-main="${task.id}">削除</button>`:''}
          </div>
        </div>
        <div class="banner ok ${st==='completed'?'show':''}">◆ TASK COMPLETED ◆</div>
        <div class="banner bad ${st==='failed'?'show':''}">◆ TASK FAILED ◆</div>
        ${st==='unaccepted'?`<div class="accept-panel"><p>受注すると目標が有効になります</p><button class="btn btn-accept" data-accept="${task.id}">受注する</button></div>`:''}
        ${st==='failed'?`<div class="accept-panel"><p>失敗しました。再開できます</p><button class="btn btn-accept" data-restart="${task.id}">再開する</button></div>`:''}
        <div class="objectives ${st==='unaccepted'?'locked':''}">
          ${st==='unaccepted'?'<div class="lock-note">受注後にチェック／納品が有効（追加は可能）</div>':''}
          <div class="section-title" style="padding:0 12px">サブタスク ${(st==='in_progress'||st==='unaccepted')&&!isSystemTask(task)?'<button class="btn btn-sm" data-add-sub>＋</button>':''}</div>
          ${(task.subs||[]).map(s => `
            <div class="obj-card ${s.done?'done':''}">
              <div class="checkbox ${s.done?'checked':''}" data-toggle-sub="${s.id}"></div>
              <div class="obj-body"><div class="obj-text">${esc(s.title)}</div></div>
              ${(st==='in_progress'||st==='unaccepted')&&!isSystemTask(task)?`<button class="btn btn-sm btn-danger" data-del-sub="${s.id}">✕</button>`:''}
            </div>`).join('') || '<div class="empty">なし</div>'}
          <div class="section-title" style="padding:0 12px">納品 ${(st==='in_progress'||st==='unaccepted')?'<button class="btn btn-sm" data-add-del>＋</button>':''}</div>
          ${(task.deliveries||[]).map(d => `
            <div class="obj-card ${d.done?'done':''}">
              <div class="obj-body">
                <div class="obj-text">${esc(d.name)} ×${d.qty}</div>
                <span class="obj-tag ${d.type}">${d.type==='purchase'?'購入品':'成果物'}</span>
              </div>
              <button class="btn btn-deliver" data-hand-over="${d.id}" ${d.done||st!=='in_progress'?'disabled':''}>${d.done?'納品済':'納品する'}</button>
              ${(st==='in_progress'||st==='unaccepted')?`<button class="btn btn-sm btn-danger" data-del-del="${d.id}">✕</button>`:''}
            </div>`).join('') || '<div class="empty">なし</div>'}
          <div style="height:8px"></div>
        </div>
      </div>`;
  }

  function renderChat() {
    const log = document.getElementById('chatLog');
    log.innerHTML = state.chat.map(m => {
      if (m.preview) {
        const p = m.preview;
        const disabled = m.resolved ? 'disabled' : '';
        return `<div class="bubble bot">
          <div>${esc(m.text)}</div>
          <div class="preview-card">
            <div class="pc-type">${esc(p.label)}</div>
            ${Array.isArray(p.fields) && p.fields.length
              ? `<div class="pc-fields">${p.fields.map(f => `<div class="pc-field"><span class="pc-k">${esc(f.k)}</span><span class="pc-v">${esc(f.v)}</span></div>`).join('')}</div>`
              : `<div class="pc-body">${esc(p.summary)}</div>`}
            <div class="pc-meta">${esc(p.meta||'')}</div>
            <div class="preview-actions">
              <button class="btn btn-primary btn-sm" data-preview-ok="${m.id}" ${disabled}>追加する</button>
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

  function renderMed() {
    const next = nextDoseInfo();
    const nextEl = document.getElementById('medNext');
    if (next) {
      nextEl.style.display = 'block';
      nextEl.textContent = '次の服薬: ' + next.med.name + ' ' + (next.med.dose||'') + ' @ ' + next.n.label +
        (next.diff >= 0 ? '（あと' + next.diff + '分）' : '（予定時刻超過）');
    } else {
      nextEl.style.display = 'none';
    }

    const el = document.getElementById('medList');
    const enabled = state.medications.filter(m => m.enabled !== false);
    if (!enabled.length) {
      el.innerHTML = '<div class="empty">登録された薬はありません</div>';
      return;
    }
    let html = '<div class="section-title">今日のチェック</div>';
    enabled.forEach(med => {
      html += `<div style="margin-bottom:10px">
        <div class="tc-title" style="margin-bottom:4px">${esc(med.name)} <span class="li-meta">${esc(med.dose||'')}</span>${med.isExample?'<span class="example-badge">サンプル</span>':''}
          <button class="btn btn-sm btn-danger" data-med-del="${med.id}" style="float:right">削除</button>
        </div>`;
      (med.times||[]).forEach(t => {
        const n = normalizeTimeLabel(t);
        const taken = isMedTaken(med.id, n.key);
        html += `<div class="list-item ${taken?'checked':''}">
          <div class="checkbox ${taken?'checked':''}" data-med-take="${med.id}" data-time="${esc(n.key)}"></div>
          <div class="li-name">${esc(n.label)}</div>
          <div class="li-meta">${taken?'服用済':'未服用'}</div>
        </div>`;
      });
      html += '</div>';
    });
    el.innerHTML = html;
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
        openModal('modalMain');
        return;
      }
      const card = e.target.closest('[data-select]');
      if (card) {
        selectedId = card.getAttribute('data-select');
        playSound('click');
        renderTasks();
      }
    });

    document.getElementById('taskDetail').addEventListener('click', e => {
      const t = e.target.closest('[data-accept],[data-restart],[data-fail-main],[data-edit-main],[data-del-main],[data-add-sub],[data-add-del],[data-toggle-sub],[data-del-sub],[data-hand-over],[data-del-del],[data-approve],[data-discard]');
      if (!t) return;
      const task = selectedId ? getTask(selectedId) : null;

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
        tk.subs.forEach(s => s.done = false);
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
        openModal('modalMain'); return;
      }
      if (t.hasAttribute('data-del-main')) {
        const id = t.getAttribute('data-del-main');
        const victim = getTask(id);
        if (victim && isSystemTask(victim)) { toast('システム任務は削除できません'); return; }
        if (!confirm('削除しますか？')) return;
        state.tasks = state.tasks.filter(x => x.id !== id);
        if (selectedId === id) selectedId = state.tasks[0]?.id || null;
        save(); playSound('click'); renderTasks(); return;
      }
      if (t.hasAttribute('data-add-sub')) {
        document.getElementById('subTitle').value = '';
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
        if (effectiveStatus(task) !== 'in_progress') return;
        const sub = task.subs.find(s => s.id === t.getAttribute('data-toggle-sub'));
        if (!sub) return;
        sub.done = !sub.done;
        // if med daily sub, sync med log
        if (task.isMedDaily && sub.medKey) {
          const [medId, ...rest] = sub.medKey.split('__');
          const timeKey = rest.join('__');
          setMedTaken(medId, timeKey, sub.done);
        }
        if (task.isBathDaily && sub.isBathSub) {
          state.bathLog[todayKey()] = !!sub.done;
          if (sub.done && state.bathMeta) state.bathMeta.streakWarnedFor = null;
          else if (!sub.done) playSound('fail');
        }
        if (sub.isChoreSub && (task.isLaundryDaily || task.isCleanDaily || task.isTrashDaily)) {
          const ctype = sub.choreType || task.choreType;
          if (ctype) choreLogMap(ctype)[todayKey()] = !!sub.done;
          if (sub.done && state.choreMeta) state.choreMeta.warnedFor = null;
          else if (!sub.done) playSound('fail');
        }
        const just = syncCompletion(task);
        save();
        const choreUndo = sub.isChoreSub && !sub.done && (task.isLaundryDaily || task.isCleanDaily || task.isTrashDaily);
        if (!(task.isBathDaily && sub.isBathSub && !sub.done) && !choreUndo) {
          playSound(just ? 'complete' : 'check');
        }
        maybeShowBathStreakWarning(!!(task.isBathDaily && sub.isBathSub && !sub.done));
        if (choreUndo || (sub.isChoreSub && sub.done)) maybeShowChoreWarning(!!choreUndo);
        renderTasks(); return;
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
      if (editingMainId) {
        const t = getTask(editingMainId);
        if (t) { t.title = title; t.trader = trader; t.desc = desc; t.deadline = deadline; t.location = loc; t.isExample = false; }
      } else {
        const t = {
          id: uid(), title, trader, desc, deadline, location: loc, isExample: false,
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
      task.subs.push({ id: uid(), title, done: false });
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
    document.getElementById('chatInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });

    function sendChat() {
      const input = document.getElementById('chatInput');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      state.chat.push({ id: uid(), role: 'user', text, ts: Date.now() });
      const parsed = parseChat(text);
      if (!parsed) {
        state.chat.push({ id: uid(), role: 'bot', text: 'すみません、理解できませんでした。', ts: Date.now() });
      } else {
        const mid = uid();
        state.chat.push({
          id: mid, role: 'bot',
          text: 'こう追加します。よければ「追加する」を押してください。',
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
      if (ok) {
        const id = ok.getAttribute('data-preview-ok');
        const msg = state.chat.find(m => m.id === id);
        if (!msg || msg.resolved) return;
        applyPreview(msg.preview);
        msg.resolved = true;
        state.chat.push({ id: uid(), role: 'bot', text: '追加しました。', ts: Date.now() });
        save(); playSound('check'); renderChat();
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
        save(); playSound('deliver'); toast('購入品の納品タスクに変換しました'); renderShop(); return;
      }
    });

    // Medication
    document.getElementById('btnAddMed').addEventListener('click', () => {
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
      const existing = state.medications.find(m =>
        m.enabled !== false && String(m.name || '').trim() === name
      );
      if (existing) {
        existing.times = dedupeTimes((existing.times || []).concat(times));
        existing.dose = dose || existing.dose;
        existing.isExample = false;
        syncMedDailyTask(); scheduleMedNotifications();
        save(); closeModal('modalMed'); playSound('click'); renderMed();
        toast('同名の薬に時刻をマージしました');
        return;
      }
      state.medications.push({
        id: uid(), name, dose, times, linkToDailyTask: true, enabled: true, isExample: false
      });
      syncMedDailyTask(); scheduleMedNotifications();
      save(); closeModal('modalMed'); playSound('click'); renderMed();
    });

    document.getElementById('btnNotifPerm').addEventListener('click', async () => {
      if (!('Notification' in window)) { toast('このブラウザは通知非対応です'); return; }
      const perm = await Notification.requestPermission();
      toast(perm === 'granted' ? '通知を許可しました（アプリ表示中のみ）' : '通知が拒否されました');
      if (perm === 'granted') scheduleMedNotifications();
      playSound('click');
    });

    document.getElementById('medList').addEventListener('click', e => {
      const take = e.target.closest('[data-med-take]');
      const del = e.target.closest('[data-med-del]');
      if (take) {
        const medId = take.getAttribute('data-med-take');
        const timeKey = take.getAttribute('data-time');
        const taken = !isMedTaken(medId, timeKey);
        setMedTaken(medId, timeKey, taken);
        playSound('check');
        renderMed();
        // refresh tasks if visible
        return;
      }
      if (del) {
        if (!confirm('この薬を削除しますか？')) return;
        const id = del.getAttribute('data-med-del');
        state.medications = state.medications.filter(m => m.id !== id);
        syncMedDailyTask(); save(); playSound('click'); renderMed();
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

    setInterval(() => {
      if (checkDeadlines()) {
        if (document.querySelector('.screen.active')?.dataset.screen === 'tasks') renderTasks();
      }
      if (document.querySelector('.screen.active')?.dataset.screen === 'med') renderMed();
    }, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { init(); });
  else init();
})();
