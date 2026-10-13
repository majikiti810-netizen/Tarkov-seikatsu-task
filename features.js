/*! 生活サポート機能の純粋ロジック（DOM非依存・テスト可能）
 *  期限ポップアップしきい値 / 寝過ごしリカバリー判定 / 月末の振り返り集計 / MacroDroid用スケジュール */
(function (root) {
  'use strict';
  const H = 3600e3;
  const THRESHOLDS = ['24h', '3h', 'over'];
  const pad2 = n => String(n).padStart(2, '0');
  const dayKey = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

  function isSys(t) { return !!(t && (t.isMedDaily || t.isBathDaily || t.isLaundryDaily || t.isCleanDaily || t.isTrashDaily)); }
  function isDone(t) { return t.status === 'completed' || t._done === true; }

  // 期限までの残りから、到達済みの最も強いしきい値を返す
  function deadlineThreshold(deadlineIso, now) {
    const dl = Date.parse(deadlineIso);
    if (isNaN(dl)) return null;
    const r = dl - now;
    if (r <= 0) return 'over';
    if (r < 3 * H) return '3h';
    if (r < 24 * H) return '24h';
    return null;
  }

  // 表示すべき赤ポップアップ（1タスク×1しきい値につき1回）。shown: { taskId: ['24h', ...] }
  // 起動時に一気に複数しきい値を越えていても、最も強いもの1件だけ出し、弱いものは表示済み扱い。
  function pendingDeadlinePopups(tasks, shown, now) {
    const out = [];
    (tasks || []).forEach(t => {
      if (!t || !t.deadline || isSys(t)) return;
      if (t.status === 'pending_review' || isDone(t)) return;
      const th = deadlineThreshold(t.deadline, now);
      if (!th) return;
      const seen = (shown && shown[t.id]) || [];
      if (seen.indexOf(th) >= 0) return;
      // 期限切れは受注済み（進行中/失敗）のみ。未受注は 24h/3h の予告だけ
      if (th === 'over' && t.status === 'unaccepted') return;
      out.push({ id: t.id, title: t.title, threshold: th, deadline: t.deadline });
    });
    const rank = { over: 0, '3h': 1, '24h': 2 };
    out.sort((a, b) => rank[a.threshold] - rank[b.threshold] || Date.parse(a.deadline) - Date.parse(b.deadline));
    return out;
  }
  function markPopupShown(shown, id, threshold) {
    const idx = THRESHOLDS.indexOf(threshold);
    const cur = new Set(shown[id] || []);
    THRESHOLDS.slice(0, idx + 1).forEach(x => cur.add(x));
    shown[id] = Array.from(cur);
    return shown;
  }

  // 寝過ごしリカバリーを出すか。
  // meta: { lastOpenDay, recoveryShownDay }, overdueDoseMins: 未チェックで時刻を過ぎた服薬の「超過分」の配列
  function shouldShowRecovery(now, meta, overdueDoseMins) {
    const d = new Date(now);
    const today = dayKey(d);
    meta = meta || {};
    if (meta.recoveryShownDay === today) return false;
    const firstOpenToday = meta.lastOpenDay !== today;
    if (firstOpenToday && d.getHours() >= 11) return true;
    return (overdueDoseMins || []).some(m => m >= 120);
  }

  // 「今日の立て直し」の内訳
  function recoveryPlan(tasks, now) {
    const strict = [], movable = [], snoozed = [];
    (tasks || []).forEach(t => {
      if (!t || t.status === 'pending_review' || isDone(t) || isSys(t)) return;
      if (t.deadline) {
        if (t.status === 'in_progress' || t.status === 'unaccepted') strict.push(t);
        return;
      }
      if (isSys(t) || t.isDailyRequired) return;
      if (t.status !== 'in_progress' && t.status !== 'unaccepted') return;
      if (t.snoozeUntil && Date.parse(t.snoozeUntil) > now) snoozed.push(t);
      else movable.push(t);
    });
    strict.sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline));
    return { strict, movable, snoozed };
  }

  // 後回し先の時刻。later=今日の後で（3時間後、ただし22時を越えるなら明日8時）、tomorrow=明日8:00
  function snoozeTarget(now, which) {
    const d = new Date(now);
    if (which === 'later') {
      const t = new Date(now + 3 * H);
      if (t.getHours() < 22 && dayKey(t) === dayKey(d)) { t.setSeconds(0, 0); return t.toISOString(); }
    }
    const tm = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8, 0, 0, 0);
    return tm.toISOString();
  }
  // 期限付きは絶対に動かさない
  function canSnooze(t) {
    return !!t && !t.deadline && !isSys(t) && !t.isDailyRequired && t.status !== 'pending_review';
  }

  // 月末の振り返り（ym = 'YYYY-MM'）
  function monthlySummary(state, ym, opts) {
    opts = opts || {};
    const inMonth = k => typeof k === 'string' && k.slice(0, 7) === ym;
    const countLog = log => {
      let done = 0, total = 0;
      Object.keys(log || {}).forEach(k => { if (inMonth(k)) { total++; if (log[k]) done++; } });
      return { done, total };
    };
    const tasks = (state.tasks || []).filter(t => !isSys(t) && !t.isDailyRequired && !t.isExample);
    const monthOf = iso => { if (!iso) return null; const d = new Date(iso); return isNaN(d) ? null : dayKey(d).slice(0, 7); };
    let tDone = 0, tFailed = 0, tOpen = 0;
    tasks.forEach(t => {
      const ref = t.completedAt || t.deadline || (t.acceptedAt ? new Date(t.acceptedAt).toISOString() : null) || t.createdAt;
      const m = typeof ref === 'number' ? monthOf(new Date(ref).toISOString()) : monthOf(ref);
      if (m !== ym) return;
      if (t.status === 'completed' || t._done) tDone++;
      else if (t.status === 'failed') tFailed++;
      else if (t.status === 'in_progress') tOpen++;
    });
    let dDone = 0, dTotal = 0;
    Object.keys(state.dailyLog || {}).forEach(k => {
      if (!inMonth(k)) return;
      Object.values(state.dailyLog[k] || {}).forEach(v => { dTotal++; if (v) dDone++; });
    });
    let medChecked = 0;
    Object.keys(state.medLog || {}).forEach(k => { if (inMonth(k)) medChecked += Object.values(state.medLog[k] || {}).filter(Boolean).length; });
    const dosesPerDay = opts.dosesPerDay || 0;
    const daysElapsed = opts.daysElapsed || 0;
    const health = { total: 0, byMood: {} };
    (state.healthLog || []).forEach(e => {
      if (!inMonth(e.day)) return;
      health.total++;
      health.byMood[e.mood] = (health.byMood[e.mood] || 0) + 1;
    });
    const decided = tDone + tFailed;
    return {
      ym,
      tasks: { done: tDone, failed: tFailed, open: tOpen, rate: decided ? Math.round(tDone / decided * 100) : null },
      daily: { done: dDone, total: dTotal },
      bath: countLog(state.bathLog), laundry: countLog(state.laundryLog),
      clean: countLog(state.cleanLog), trash: countLog(state.trashLog),
      meds: { checked: medChecked, planned: dosesPerDay * daysElapsed },
      health
    };
  }

  // 体調ログ：直近 n 日を日付ごとにまとめる
  function healthHistory(log, now, days) {
    const out = [];
    for (let i = 0; i < (days || 7); i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const k = dayKey(d);
      out.push({ day: k, entries: (log || []).filter(e => e.day === k).sort((a, b) => b.ts - a.ts) });
    }
    return out;
  }

  // MacroDroid 用：今後の時刻つき項目 [{id,title,time,type,url}]（time はローカル 'YYYY-MM-DDTHH:MM'）
  function localStamp(d) { return dayKey(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function buildSchedule(items, now, baseUrl, horizonH) {
    const lim = now + (horizonH || 48) * H;
    return (items || [])
      .filter(x => x && x.at >= now && x.at <= lim)
      .sort((a, b) => a.at - b.at)
      .map(x => ({
        id: x.id, title: x.title, type: x.type,
        time: localStamp(new Date(x.at)),
        url: (baseUrl || '') + '#/alarm?id=' + encodeURIComponent(x.taskId || x.id)
      }));
  }
  function parseDeepLink(hash) {
    const m = /^#\/(alarm|task)\?(.*)$/.exec(hash || '');
    if (!m) return null;
    const q = {};
    m[2].split('&').forEach(kv => { const [k, v] = kv.split('='); if (k) q[decodeURIComponent(k)] = decodeURIComponent(v || ''); });
    return q.id ? { route: m[1], id: q.id } : null;
  }

  const API = { deadlineThreshold, pendingDeadlinePopups, markPopupShown, shouldShowRecovery, recoveryPlan,
    snoozeTarget, canSnooze, monthlySummary, healthHistory, buildSchedule, parseDeepLink, dayKey };
  root.LifeFeatures = API;
})(typeof window !== 'undefined' ? window : globalThis);
