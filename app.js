"use strict";
// ── 追加の型定義 ─────────────────────────────────────────
// ── DOM ヘルパー ────────────────────────────────────────
function $(id) {
    return document.getElementById(id);
}
// ── UI メッセージ定数 ────────────────────────────────────
const MSG_EVENT_DELETED = '予定を削除しました';
const MSG_VAC_DELETED = '削除しました';
const MSG_SUGGEST_EMPTY = '提案データが見つかりません。再表示してください';
const msgEventAdded = (label) => `${label}を登録しました`;
const msgVacAdded = (workdays) => `${workdays}日分の有給を登録しました`;
const msgVacModalAdded = (date, label) => `${date} ${label}を登録しました`;
const msgSuggestAdded = (count) => `${count}日の有給をカレンダーに登録しました`;
const msgHolidayFetchFailed = (year) => `${year}年の取得に失敗しました`;
const msgHolidayFetched = (year, fetched, count) => `${year}年の祝日データを${fetched ? '取得' : '確認'}しました（${count}件）`;
const msgCompanyOffAdded = (date) => `${date}を会社休日に登録しました`;
// ── 状態 ─────────────────────────────────────────────────
const state = {
    mgmtYear: new Date().getFullYear(),
    viewYear: new Date().getFullYear(),
    viewMonth: new Date().getMonth() + 1,
    settings: {},
    grantRules: [],
    companyOffDow: [0, 6],
    companyOffDates: [],
    vacations: [],
    holidays: {},
    cachedYears: [],
    modalDate: null,
    saboSugCache: {},
    events: [],
};
// ── Utils ──────────────────────────────────────────────
function toKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function isHoliday(k) { return !!state.holidays[k]; }
function isWeekend(k) {
    const w = new Date(k + 'T12:00:00').getDay();
    return w === 0 || w === 6;
}
function isCompanyOff(k) {
    const dow = new Date(k + 'T12:00:00').getDay();
    return state.companyOffDow.includes(dow) || state.companyOffDates.some(d => d.date === k);
}
function isWorkday(k) { return !isHoliday(k) && !isCompanyOff(k); }
function isOffDay(k) { return !isWorkday(k); }
function fmt(d) {
    return d ? new Date(d + 'T12:00:00').toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' }) : '';
}
function workHours() { return parseFloat(state.settings.work_hours_per_day) || 8; }
function applyWorkHoursMax() { }
function hasHolidaysForYear(year) {
    return Object.keys(state.holidays).some(k => k.startsWith(year + '-'));
}
// ── 祝日フェッチ（外部API直接） ──────────────────────────
async function fetchAndSaveHolidays(year) {
    const res = await fetch(`https://holidays-jp.github.io/api/v1/${year}/date.json`);
    if (!res.ok)
        throw new Error(`${year}年の祝日データ取得に失敗しました`);
    const data = await res.json();
    await repo.saveHolidayData(year, data);
    return Object.keys(data).length;
}
async function ensureHolidays(year) {
    if (!(await repo.isYearFetched(year))) {
        await fetchAndSaveHolidays(year);
    }
}
// ── トースト・タブ切り替え ────────────────────────────────
function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
}
function swStab(id, el) {
    document.querySelectorAll('.stab-pane').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
    $(id).classList.add('active');
    el?.classList.add('active');
}
function sw(id) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tab,.nav-item,.bnav-item').forEach(t => t.classList.remove('active'));
    $(id).classList.add('active');
    document.querySelectorAll(`.nav-item[onclick*="'${id}'"],.bnav-item[onclick*="'${id}'"]`)
        .forEach(t => t.classList.add('active'));
    location.hash = id;
    window.scrollTo(0, 0);
    if (id === 'suggest')
        renderSug();
    if (id === 'settings')
        renderSettings();
}
// ── Grant calc ─────────────────────────────────────────
function calcRefDate(hire, mgmtYear) {
    const first = new Date(hire);
    first.setMonth(first.getMonth() + 6);
    for (let n = 0; n <= 60; n++) {
        const ref = new Date(first);
        ref.setMonth(ref.getMonth() + n * 12);
        if (ref.getFullYear() > mgmtYear)
            break;
        if (ref.getFullYear() === mgmtYear)
            return ref;
    }
    return null;
}
function calcGrant() {
    if (!state.settings.hire_date)
        return null;
    const hire = new Date(state.settings.hire_date + 'T12:00:00');
    const ref = calcRefDate(hire, state.mgmtYear);
    if (!ref)
        return null;
    const months = (ref.getFullYear() - hire.getFullYear()) * 12 + (ref.getMonth() - hire.getMonth());
    const rules = [...state.grantRules].sort((a, b) => a.months - b.months);
    let grant = 0;
    for (const r of rules) {
        if (months >= r.months)
            grant = r.days;
    }
    return grant + (parseFloat(state.settings.carryover) || 0);
}
function calcMgmtYearFromView() {
    if (!state.settings.hire_date)
        return state.viewYear;
    const hire = new Date(state.settings.hire_date + 'T12:00:00');
    const viewMonthKey = `${state.viewYear}-${String(state.viewMonth).padStart(2, '0')}-01`;
    const refInViewYear = calcRefDate(hire, state.viewYear);
    if (refInViewYear && toKey(refInViewYear) <= viewMonthKey)
        return state.viewYear;
    const refInPrevYear = calcRefDate(hire, state.viewYear - 1);
    if (refInPrevYear)
        return state.viewYear - 1;
    return state.viewYear;
}
function getVacSets() {
    const full = new Set(), half = new Set(), hourly = new Map();
    for (const v of state.vacations) {
        let d = new Date(v.start_date + 'T12:00:00');
        const e = new Date(v.end_date + 'T12:00:00');
        while (d <= e) {
            const k = toKey(d);
            if (isWorkday(k)) {
                if (v.type === 'full')
                    full.add(k);
                else if (v.type === 'hourly')
                    hourly.set(k, (hourly.get(k) ?? 0) + (v.hours ?? 0));
                else
                    half.add(k);
            }
            d.setDate(d.getDate() + 1);
        }
    }
    return { full, half, hourly };
}
function calcUsedDays() {
    const { full, half, hourly } = getVacSets();
    const wh = workHours();
    let totalHours = 0;
    hourly.forEach(h => totalHours += h);
    return full.size + half.size * 0.5 + totalHours / wh;
}
function getEventSet() {
    const map = new Map();
    for (const e of state.events) {
        if (!map.has(e.date))
            map.set(e.date, []);
        map.get(e.date).push(e);
    }
    return map;
}
// ── Dashboard ──────────────────────────────────────────
function renderDashboard() {
    const { full, half, hourly } = getVacSets();
    const used = parseFloat(calcUsedDays().toFixed(2));
    const grant = calcGrant();
    const remain = grant !== null ? Math.max(0, grant - used) : null;
    const rate = grant ? Math.round(used / grant * 100) : 0;
    $('m-total').textContent = grant !== null ? String(grant) : '-';
    $('m-used').textContent = String(full.size);
    $('m-half').textContent = String(half.size);
    let hourlyTotal = 0;
    hourly.forEach(h => hourlyTotal += h);
    $('m-hours').textContent = hourlyTotal > 0 ? hourlyTotal + 'h' : '0h';
    const remEl = $('m-remain');
    remEl.textContent = remain !== null ? remain.toFixed(1) : '-';
    remEl.className = 'metric-value ' + (remain === null ? '' : remain <= 0 ? 'mv-red' : remain <= 5 ? 'mv-amber' : 'mv-green');
    $('rate-txt').textContent = rate + '%';
    const prog = $('prog');
    prog.style.width = Math.min(rate, 100) + '%';
    prog.style.background = rate >= 100 ? 'var(--red)' : rate >= 70 ? '#BA7517' : 'var(--green)';
    const today = new Date();
    const mLeft = Math.max(1, (new Date(state.mgmtYear + 1, 2, 31).getTime() - today.getTime()) / (1000 * 60 * 60 * 24 * 30));
    $('status-msg').textContent = grant === null
        ? '設定タブで入社年月日を入力してください'
        : remain <= 0 ? '今年の有給は消化完了です！'
            : '月あたり約' + (remain / mLeft).toFixed(1) + '日の取得が必要です';
    const infoBox = $('grant-info-box');
    if (!state.settings.hire_date) {
        infoBox.innerHTML = '<div class="stat-note">設定タブで入社年月日を入力してください</div>';
    }
    else {
        const hire = new Date(state.settings.hire_date + 'T12:00:00');
        const ref = calcRefDate(hire, state.mgmtYear);
        const row = (label, value) => `<div class="grant-row"><span class="lk">${label}</span><span class="lv">${value}</span></div>`;
        if (!ref) {
            infoBox.innerHTML =
                row('入社年月日', hire.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })) +
                    '<div class="stat-note" style="margin-top:8px">この年度に基準日がありません</div>';
        }
        else {
            const months = (ref.getFullYear() - hire.getFullYear()) * 12 + (ref.getMonth() - hire.getMonth());
            const yrs = Math.floor(months / 12), mos = months % 12;
            const tenureStr = yrs > 0 ? (mos > 0 ? `${yrs}年${mos}ヶ月` : `${yrs}年`) : `${mos}ヶ月`;
            const rules = [...state.grantRules].sort((a, b) => a.months - b.months);
            let baseDays = 0, appliedRule = null;
            for (const r of rules) {
                if (months >= r.months) {
                    baseDays = r.days;
                    appliedRule = r;
                }
            }
            const carryover = parseFloat(state.settings.carryover) || 0;
            infoBox.innerHTML =
                row('入社年月日', hire.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })) +
                    row('基準日', ref.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })) +
                    row('勤続', tenureStr) +
                    row('適用ルール', appliedRule ? `${appliedRule.months}ヶ月以上` : '該当なし') +
                    row('基本付与日数', `${baseDays}日`) +
                    row('繰越日数', `${carryover}日`) +
                    row('合計付与日数', `${baseDays + carryover}日`);
        }
    }
    renderVList();
    renderEventList();
}
function renderVList() {
    const filtered = [...state.vacations]
        .sort((a, b) => a.start_date.localeCompare(b.start_date));
    const wh = workHours();
    let html = filtered.length === 0 ? '<div class="empty-msg">登録なし</div>' : '';
    filtered.forEach(v => {
        let tl, bc;
        if (v.type === 'full') {
            tl = '全日';
            bc = 'badge-green';
        }
        else if (v.type === 'hourly') {
            tl = `${v.hours}時間(${((v.hours ?? 0) / wh).toFixed(2)}日)`;
            bc = 'badge-purple';
        }
        else {
            tl = v.type === 'half-am' ? '午前半日' : '午後半日';
            bc = 'badge-amber';
        }
        const label = v.start_date === v.end_date ? fmt(v.start_date) : fmt(v.start_date) + '〜' + fmt(v.end_date);
        html += `<div class="vitem"><span>${label} <span class="badge ${bc}">${tl}</span></span>
      <button class="btn-danger" onclick="removeVac(${v.id})">削除</button></div>`;
    });
    $('vlist-dash').innerHTML = html;
}
function renderEventList() {
    const filtered = [...state.events]
        .sort((a, b) => a.date.localeCompare(b.date));
    let html = filtered.length === 0 ? '<div class="empty-msg">登録なし</div>' : '';
    filtered.forEach(e => {
        const tl = e.type === 'hourly' ? `${e.hours}h` : '終日';
        html += `<div class="vitem">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${fmt(e.date)} ${e.label}</span>
      <span class="badge badge-blue" style="flex-shrink:0;margin:0 6px">${tl}</span>
      <button class="btn-danger" style="flex-shrink:0" onclick="removeEvent(${e.id})">削除</button></div>`;
    });
    $('elist-dash').innerHTML = html;
}
// ── Calendar ───────────────────────────────────────────
function renderCalendar() {
    const y = state.viewYear, m = state.viewMonth;
    $('cal-title').textContent = y + '年' + m + '月';
    const mh = Object.entries(state.holidays).filter(([k]) => k.startsWith(`${y}-${String(m).padStart(2, '0')}`));
    $('cal-sub').textContent = mh.length ? '祝日：' + mh.map(([, n]) => n).join('・') : '';
    const first = new Date(y, m - 1, 1), last = new Date(y, m, 0);
    const { full, half, hourly } = getVacSets();
    const eventSet = getEventSet();
    const todayKey = toKey(new Date());
    const wh = workHours();
    let html = '';
    for (let i = 0; i < first.getDay(); i++)
        html += '<div class="cd empty"></div>';
    for (let d = 1; d <= last.getDate(); d++) {
        const k = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dow = new Date(k + 'T12:00:00').getDay();
        const isH = isHoliday(k), isCo = isCompanyOff(k), isWe = isWeekend(k);
        const isV = full.has(k), isHf = half.has(k), isHr = hourly.has(k);
        const hasVac = isV || isHf || isHr;
        const evs = eventSet.get(k) ?? [];
        const isEv = evs.length > 0;
        let cls = 'cd';
        if (dow === 0)
            cls += ' sunday';
        else if (dow === 6)
            cls += ' saturday';
        if (k === todayKey)
            cls += ' today';
        if (isH)
            cls += ' holiday';
        if (isCo && !isWe)
            cls += ' company-off';
        if (isV)
            cls += ' vacation';
        else if (isHf)
            cls += ' half';
        else if (isHr)
            cls += ' hourly';
        else if (isEv)
            cls += ' event';
        if (isOffDay(k))
            cls += ' nonwork';
        const hname = state.holidays[k] ?? (isCo && !isWe ? state.companyOffDates.find(c => c.date === k)?.name ?? '会社休日' : '');
        let statusText = '';
        if (isV)
            statusText = '全日有給';
        else if (isHf)
            statusText = state.vacations.find(v => v.start_date <= k && k <= v.end_date && (v.type === 'half-am' || v.type === 'half-pm'))?.type === 'half-am' ? '午前半休' : '午後半休';
        else if (isHr) {
            const h = hourly.get(k);
            statusText = h + 'h' + (h >= wh ? ' (全日)' : '');
        }
        else if (isEv)
            statusText = evs.map(e => e.type === 'hourly' ? e.label + '(' + e.hours + 'h)' : e.label).join(' ');
        const extraBadge = hasVac && isEv ? `<div class="cd-extra">+${evs.length}</div>` : '';
        html += `<div class="${cls}" onclick="openModal('${k}')">
      <div class="cd-num">${d}</div>
      ${hname ? `<div class="cd-hname">${hname}</div>` : ''}
      ${statusText ? `<div class="cd-status">${statusText}</div>` : ''}
      ${extraBadge}
    </div>`;
    }
    $('cal-grid').innerHTML = html;
    const minHours = parseFloat(state.settings.min_work_hours) || 0;
    const summaryEl = $('cal-work-summary');
    if (minHours > 0) {
        let workDayCount = 0, vacHours = 0, evtHours = 0;
        for (let d2 = 1; d2 <= last.getDate(); d2++) {
            const k2 = `${y}-${String(m).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
            if (isWeekend(k2) || isHoliday(k2) || isCompanyOff(k2))
                continue;
            workDayCount++;
            if (full.has(k2))
                vacHours += wh;
            else if (half.has(k2))
                vacHours += wh / 2;
            else if (hourly.has(k2))
                vacHours += hourly.get(k2);
            if (eventSet.has(k2)) {
                for (const ev of eventSet.get(k2)) {
                    if (ev.type === 'hourly')
                        evtHours += ev.hours ?? 0;
                    else
                        evtHours += wh;
                }
            }
        }
        const totalWork = workDayCount * wh;
        const actualWork = totalWork - vacHours - evtHours;
        const diff = actualWork - minHours;
        const diffStr = diff >= 0 ? `+${diff.toFixed(1)}` : `${diff.toFixed(1)}`;
        const diffColor = diff >= 0 ? 'var(--green)' : 'var(--red)';
        const evtPart = evtHours > 0 ? ` − 時間外予定${evtHours.toFixed(1)}h` : '';
        summaryEl.style.display = 'block';
        summaryEl.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center">
      <span>当月稼働: <strong>${actualWork.toFixed(1)}h</strong>（所定${totalWork}h − 有給${vacHours.toFixed(1)}h${evtPart}）</span>
      <span>精算幅下限: <strong>${minHours}h</strong></span>
      <span style="font-weight:500;color:${diffColor}">差分: ${diffStr}h</span>
    </div>`;
    }
    else {
        summaryEl.style.display = 'none';
    }
}
// ── Modal ─────────────────────────────────────────────
function openModal(k) {
    const { full, half, hourly } = getVacSets();
    const evs = getEventSet().get(k) ?? [];
    const vac = state.vacations.find(v => v.start_date <= k && k <= v.end_date &&
        (full.has(k) ? v.type === 'full' : half.has(k) ? v.type === 'half-am' || v.type === 'half-pm' : hourly.has(k) ? v.type === 'hourly' : false));
    if (vac || evs.length) {
        state.modalDate = k;
        const d2 = new Date(k + 'T12:00:00');
        $('modal-date-label').textContent = d2.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
        $('modal-hour-row').classList.remove('visible');
        $('modal-event-row').classList.remove('visible');
        const wh = workHours();
        let rows = '';
        if (vac) {
            const vacLabel = vac.type === 'full' ? '全日有給'
                : vac.type === 'half-am' ? '午前半休'
                    : vac.type === 'half-pm' ? '午後半休'
                        : `時間休 ${vac.hours}h(${((vac.hours ?? 0) / wh).toFixed(2)}日)`;
            rows += `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:0.5px solid var(--border)">
        <span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${vacLabel}</span>
        <button class="btn-danger" style="flex-shrink:0" onclick="removeVac(${vac.id})">削除</button>
      </div>`;
        }
        rows += evs.map(e => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:0.5px solid var(--border)">
      <span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${e.type === 'hourly' ? e.label + '（' + e.hours + 'h）' : e.label + '（終日）'}</span>
      <button class="btn-danger" style="flex-shrink:0" onclick="removeEvent(${e.id})">削除</button>
    </div>`).join('');
        $('modal-opts').innerHTML = rows + (isWorkday(k) ? `<button class="modal-opt" style="margin-top:8px" onclick="resetModalOpts()">＋ 追加登録</button>` : '');
        $('modal-overlay').classList.remove('hidden');
        return;
    }
    if (!isWorkday(k))
        return;
    state.modalDate = k;
    const d = new Date(k + 'T12:00:00');
    $('modal-date-label').textContent = d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
    $('modal-opts').innerHTML =
        `<button class="modal-opt opt-full" onclick="confirmVac('full')">全日休暇</button>
     <button class="modal-opt opt-half" onclick="confirmVac('half-am')">午前半日休暇</button>
     <button class="modal-opt opt-half" onclick="confirmVac('half-pm')">午後半日休暇</button>
     <button class="modal-opt opt-hour" onclick="showHourInput()">時間休暇</button>
     <button class="modal-opt" style="border-color:var(--border2)" onclick="showEventInput()">稼働時間外予定</button>`;
    $('modal-hour-row').classList.remove('visible');
    $('modal-event-row').classList.remove('visible');
    applyWorkHoursMax();
    $('modal-hours').value = '1';
    $('modal-hours-max').textContent = `(最大${workHours()}時間)`;
    $('modal-overlay').classList.remove('hidden');
}
function showEventInput() {
    $('modal-hour-row').classList.remove('visible');
    $('modal-event-row').classList.add('visible');
    $('modal-event-label').value = '';
    $('modal-event-type').value = 'allday';
    $('modal-event-hours-wrap').style.display = 'none';
}
function toggleEventHours() {
    const t = $('modal-event-type').value;
    $('modal-event-hours-wrap').style.display = t === 'hourly' ? 'flex' : 'none';
}
async function confirmEvent() {
    const k = state.modalDate;
    if (!k)
        return;
    const label = $('modal-event-label').value.trim() || '時間外予定';
    const type = $('modal-event-type').value;
    const hours = type === 'hourly' ? parseInt($('modal-event-hours').value) || 1 : null;
    const maxH = await repo.getWorkHours();
    if (type === 'hourly') {
        if (!hours || hours <= 0) {
            toast('時間数は正の値を入力してください');
            return;
        }
        if (hours > maxH) {
            toast(`時間数は${maxH}時間以下にしてください`);
            return;
        }
    }
    const existingEvents = await repo.getEventUsageByDate(k);
    const usedEventH = existingEvents.reduce((sum, e) => sum + (e.type === 'allday' ? maxH : (e.hours ?? 0)), 0);
    const existingVacs = await repo.getVacationUsageByDate(k);
    const usedVacH = existingVacs.reduce((sum, v) => {
        if (v.type === 'full')
            return sum + maxH;
        if (v.type === 'half-am' || v.type === 'half-pm')
            return sum + maxH / 2;
        return sum + (v.hours ?? 0);
    }, 0);
    const newH = type === 'allday' ? maxH : (hours ?? 0);
    if (usedEventH + usedVacH + newH > maxH) {
        toast(`その日の合計時間が所定労働時間（${maxH}h）を超えます`);
        return;
    }
    const id = await repo.insertEvent(state.mgmtYear, k, label, type, hours ?? null);
    state.events.push({ id, date: k, label, type, hours, year: state.mgmtYear });
    closeModal();
    renderCalendar();
    renderDashboard();
    toast(msgEventAdded(label));
}
async function removeEvent(id) {
    await repo.deleteEvent(id);
    state.events = state.events.filter(e => e.id !== id);
    closeModal();
    renderCalendar();
    renderDashboard();
    toast(MSG_EVENT_DELETED);
}
function resetModalOpts() {
    $('modal-opts').innerHTML =
        `<button class="modal-opt opt-full" onclick="confirmVac('full')">全日休暇</button>
    <button class="modal-opt opt-half" onclick="confirmVac('half-am')">午前半日休暇</button>
    <button class="modal-opt opt-half" onclick="confirmVac('half-pm')">午後半日休暇</button>
    <button class="modal-opt opt-hour" onclick="showHourInput()">時間休暇</button>
    <button class="modal-opt" style="border-color:var(--border2)" onclick="showEventInput()">稼働時間外予定</button>`;
    $('modal-hour-row').classList.remove('visible');
    $('modal-event-row').classList.remove('visible');
    applyWorkHoursMax();
    $('modal-hours').value = '1';
    $('modal-hours-max').textContent = `(最大${workHours()}時間)`;
}
function showHourInput() {
    $('modal-event-row').classList.remove('visible');
    $('modal-hour-row').classList.add('visible');
}
function closeModal(e) {
    if (e && e.target !== $('modal-overlay'))
        return;
    $('modal-overlay').classList.add('hidden');
    state.modalDate = null;
}
async function confirmVac(type) {
    const k = state.modalDate;
    if (!k)
        return;
    const hours = type === 'hourly' ? parseInt($('modal-hours').value) || 1 : null;
    const maxH = await repo.getWorkHours();
    if (type === 'hourly') {
        if (!hours || hours <= 0) {
            toast('時間数は正の値を入力してください');
            return;
        }
        if (hours > maxH) {
            toast(`時間数は${maxH}時間以下にしてください`);
            return;
        }
    }
    const evtRows = await repo.getEventUsageByDate(k);
    const usedEventH = evtRows.reduce((sum, e) => sum + (e.type === 'allday' ? maxH : (e.hours ?? 0)), 0);
    const newVacH = type === 'full' ? maxH : type === 'hourly' ? (hours ?? 0) : maxH / 2;
    if (usedEventH + newVacH > maxH) {
        toast(`その日の合計時間が所定労働時間（${maxH}h）を超えます`);
        return;
    }
    const existing = await repo.getVacationsOverlapping(k, k);
    if (existing.length > 0) {
        toast(`${k} は既に有給が登録されています`);
        return;
    }
    const id = await repo.insertVacation(state.mgmtYear, k, k, type, hours ?? null);
    state.vacations.push({ id, start_date: k, end_date: k, type, hours, year: state.mgmtYear });
    closeModal();
    const wh = workHours();
    const label = type === 'full' ? '全日'
        : type === 'hourly' ? `${hours}時間休(${((hours ?? 0) / wh).toFixed(2)}日)`
            : type === 'half-am' ? '午前半休' : '午後半休';
    renderCalendar();
    renderDashboard();
    toast(msgVacModalAdded(fmt(k), label));
}
function toggleHoursInput() {
    const t = $('add-type').value;
    $('add-hours').style.display = t === 'hourly' ? '' : 'none';
}
async function addVac() {
    const s = $('add-s').value;
    const e = $('add-e').value || s;
    const t = $('add-type').value;
    const hours = t === 'hourly' ? parseInt($('add-hours').value) || 1 : null;
    if (!s)
        return;
    const endDate = e < s ? s : e;
    const maxH = await repo.getWorkHours();
    if (t === 'hourly') {
        if (!hours || hours <= 0) {
            toast('時間数は正の値を入力してください');
            return;
        }
        if (hours > maxH) {
            toast(`時間数は${maxH}時間以下にしてください`);
            return;
        }
    }
    if (t === 'hourly' || t === 'half-am' || t === 'half-pm') {
        const evtRows = await repo.getEventUsageByDate(s);
        const usedEventH = evtRows.reduce((sum, ev) => sum + (ev.type === 'allday' ? maxH : (ev.hours ?? 0)), 0);
        const newVacH = t === 'hourly' ? (hours ?? 0) : maxH / 2;
        if (usedEventH + newVacH > maxH) {
            toast(`その日の合計時間が所定労働時間（${maxH}h）を超えます`);
            return;
        }
    }
    const offDows = await repo.getCompanyOffDow();
    const offDates = await repo.getCompanyOffDateSet();
    const holidayDates = await repo.getHolidayDatesBetween(s, endDate);
    const workdays = [];
    let cur = new Date(s + 'T12:00:00');
    const last = new Date(endDate + 'T12:00:00');
    while (cur <= last) {
        const k = cur.toISOString().slice(0, 10);
        const dow = cur.getDay();
        if (!offDows.includes(dow) && !offDates.has(k) && !holidayDates.has(k))
            workdays.push(k);
        cur.setDate(cur.getDate() + 1);
    }
    if (workdays.length === 0) {
        toast('選択期間内に稼働日がありません');
        return;
    }
    const existing = await repo.getVacationsOverlapping(s, endDate);
    for (const v of existing) {
        for (const d of workdays) {
            if (v.start_date <= d && d <= v.end_date) {
                toast(`${d} は既に有給が登録されています`);
                return;
            }
        }
    }
    await repo.insertVacation(state.mgmtYear, s, endDate, t, hours ?? null);
    await reloadVacations();
    renderCalendar();
    renderDashboard();
    toast(msgVacAdded(workdays.length));
}
async function removeVac(id) {
    await repo.deleteVacation(id);
    state.vacations = state.vacations.filter(v => v.id !== id);
    closeModal();
    renderCalendar();
    renderDashboard();
    toast(MSG_VAC_DELETED);
}
async function refreshMgmtYear() {
    const newMgmtYear = calcMgmtYearFromView();
    if (newMgmtYear === state.mgmtYear)
        return;
    state.mgmtYear = newMgmtYear;
    if (!hasHolidaysForYear(newMgmtYear)) {
        const holidays = await repo.getHolidays(newMgmtYear);
        Object.assign(state.holidays, holidays);
    }
    const [vacations, events] = await Promise.all([
        repo.getVacations(newMgmtYear),
        repo.getEvents(newMgmtYear),
    ]);
    state.vacations = vacations;
    state.events = events;
}
async function goToday() {
    const today = new Date();
    state.viewYear = today.getFullYear();
    state.viewMonth = today.getMonth() + 1;
    if (!hasHolidaysForYear(state.viewYear))
        loadHolidaysForYear(state.viewYear);
    await refreshMgmtYear();
    renderCalendar();
    renderDashboard();
}
async function prevM() {
    state.viewMonth--;
    if (state.viewMonth < 1) {
        state.viewMonth = 12;
        state.viewYear--;
    }
    if (!hasHolidaysForYear(state.viewYear))
        loadHolidaysForYear(state.viewYear);
    await refreshMgmtYear();
    renderCalendar();
    renderDashboard();
}
async function nextM() {
    state.viewMonth++;
    if (state.viewMonth > 12) {
        state.viewMonth = 1;
        state.viewYear++;
    }
    if (!hasHolidaysForYear(state.viewYear))
        loadHolidaysForYear(state.viewYear);
    await refreshMgmtYear();
    renderCalendar();
    renderDashboard();
}
async function loadHolidaysForYear(year) {
    const holidays = await repo.getHolidays(year);
    Object.assign(state.holidays, holidays);
    renderCalendar();
}
// ── 取得提案 ────────────────────────────────────────────
function isSugApplied(workdays) {
    if (!workdays || workdays.length === 0)
        return false;
    return workdays.every(d => state.vacations.some(v => v.start_date <= d && d <= v.end_date));
}
function calcStreakWith(vacKeys) {
    const vacSet = new Set(vacKeys);
    function expandFrom(startKey) {
        let s = new Date(startKey + 'T12:00:00'), e = new Date(startKey + 'T12:00:00');
        while (true) {
            const prev = new Date(s);
            prev.setDate(prev.getDate() - 1);
            if (isOffDay(toKey(prev)) || vacSet.has(toKey(prev)))
                s = prev;
            else
                break;
        }
        while (true) {
            const next = new Date(e);
            next.setDate(next.getDate() + 1);
            if (isOffDay(toKey(next)) || vacSet.has(toKey(next)))
                e = next;
            else
                break;
        }
        return { s, e };
    }
    let minS = null, maxE = null;
    for (const k of vacKeys) {
        const { s, e } = expandFrom(k);
        if (!minS || s < minS)
            minS = s;
        if (!maxE || e > maxE)
            maxE = e;
    }
    if (!minS || !maxE)
        return null;
    for (let d = new Date(minS); d <= maxE; d.setDate(d.getDate() + 1)) {
        const k = toKey(d);
        if (!isOffDay(k) && !vacSet.has(k))
            return null;
    }
    let count = 0;
    for (let d = new Date(minS); d <= maxE; d.setDate(d.getDate() + 1))
        count++;
    return { days: count, start: toKey(minS), end: toKey(maxE) };
}
function calcSaboSuggestions(yr) {
    const workdays = [];
    for (let m = 1; m <= 12; m++) {
        const dim = new Date(yr, m, 0).getDate();
        for (let d = 1; d <= dim; d++) {
            const k = `${yr}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            if (isWorkday(k))
                workdays.push(k);
        }
    }
    const results = [];
    const checkedIds = new Set();
    for (let i = 0; i < workdays.length; i++) {
        const k1 = workdays[i];
        (() => {
            const id = `s1-${k1}`;
            if (checkedIds.has(id))
                return;
            checkedIds.add(id);
            const streak = calcStreakWith([k1]);
            if (!streak || streak.days < 4)
                return;
            results.push({ id, workdays: [k1], useDays: 1, offDays: streak.days, start: streak.start, end: streak.end, month: parseInt(k1.split('-')[1]) });
        })();
        const near = [];
        for (let j = i + 1; j < workdays.length && j <= i + 21; j++)
            near.push(workdays[j]);
        for (const k2 of near) {
            const id = `s2-${k1}|${k2}`;
            if (checkedIds.has(id))
                continue;
            checkedIds.add(id);
            const streak = calcStreakWith([k1, k2]);
            if (!streak || streak.days < 4)
                continue;
            const s1 = calcStreakWith([k1]), s2 = calcStreakWith([k2]);
            if (streak.days <= Math.max(s1?.days ?? 0, s2?.days ?? 0))
                continue;
            if (!hasHolidayInStreak(streak))
                continue;
            results.push({ id, workdays: [k1, k2], useDays: 2, offDays: streak.days, start: streak.start, end: streak.end, month: parseInt(k1.split('-')[1]) });
        }
        for (let ni = 0; ni < near.length; ni++) {
            const k2 = near[ni];
            for (let nj = ni + 1; nj < near.length && nj <= ni + 14; nj++) {
                const k3 = near[nj];
                const id = `s3-${k1}|${k2}|${k3}`;
                if (checkedIds.has(id))
                    continue;
                checkedIds.add(id);
                const streak = calcStreakWith([k1, k2, k3]);
                if (!streak || streak.days < 4)
                    continue;
                const best2 = Math.max(calcStreakWith([k1, k2])?.days ?? 0, calcStreakWith([k1, k3])?.days ?? 0, calcStreakWith([k2, k3])?.days ?? 0);
                if (streak.days <= best2)
                    continue;
                if (!hasHolidayInStreak(streak))
                    continue;
                results.push({ id, workdays: [k1, k2, k3], useDays: 3, offDays: streak.days, start: streak.start, end: streak.end, month: parseInt(k1.split('-')[1]) });
            }
        }
    }
    results.sort((a, b) => {
        const effA = a.offDays / a.useDays, effB = b.offDays / b.useDays;
        return effB - effA || b.offDays - a.offDays || a.useDays - b.useDays;
    });
    const grouped = {};
    for (const r of results) {
        const holidaysInStreak = [];
        for (let d = new Date(r.start + 'T12:00:00'); toKey(d) <= r.end; d.setDate(d.getDate() + 1)) {
            const k = toKey(d);
            if (isHoliday(k))
                holidaysInStreak.push(k);
        }
        const groupKey = holidaysInStreak.join('|') || r.start;
        if (!grouped[groupKey])
            grouped[groupKey] = {};
        const cur = grouped[groupKey][r.useDays];
        if (!cur || r.offDays > cur.offDays || (r.offDays === cur.offDays && r.useDays < cur.useDays)) {
            grouped[groupKey][r.useDays] = r;
        }
    }
    return Object.values(grouped)
        .flatMap(g => Object.values(g))
        .sort((a, b) => a.start.localeCompare(b.start) || a.useDays - b.useDays)
        .map(r => ({
        ...r,
        desc: `${r.start.slice(5).replace('-', '/')}〜${r.end.slice(5).replace('-', '/')}（有給: ${r.workdays.map(d => d.slice(5).replace('-', '/')).join('・')}）`
    }));
}
function hasHolidayInStreak(streak) {
    for (let d = new Date(streak.start + 'T12:00:00'); toKey(d) <= streak.end; d.setDate(d.getDate() + 1)) {
        const k = toKey(d);
        if (isHoliday(k) || (isCompanyOff(k) && !isWeekend(k)))
            return true;
    }
    return false;
}
async function renderSug() {
    const yr = parseInt($('sug-year').value) || state.mgmtYear;
    if (!(await repo.isYearFetched(yr))) {
        $('sug-list').innerHTML = `<div class="empty-msg">${yr}年の祝日データが取得されていません。<br>設定の「祝日管理」から取得してください。</div>`;
        return;
    }
    if (!hasHolidaysForYear(yr)) {
        $('sug-list').innerHTML = '<div class="empty-msg" style="padding:16px 0">読み込み中...</div>';
        await loadHolidaysForYear(yr);
    }
    $('sug-list').innerHTML = '<div class="empty-msg" style="padding:16px 0">計算中...</div>';
    setTimeout(() => {
        const rawSugs = calcSaboSuggestions(yr);
        const sortKey = $('sug-sort')?.value ?? 'date';
        const sugs = [...rawSugs].sort((a, b) => {
            if (sortKey === 'days')
                return b.offDays - a.offDays || a.useDays - b.useDays || a.start.localeCompare(b.start);
            return a.start.localeCompare(b.start) || b.offDays - a.offDays;
        });
        state.saboSugCache[yr] = {};
        sugs.forEach(s => { state.saboSugCache[yr][s.id] = s; });
        const monthFilter = $('sug-month')?.value;
        const filtered = monthFilter
            ? sugs.filter(s => {
                const m = parseInt(monthFilter);
                for (let d = new Date(s.start + 'T12:00:00'); toKey(d) <= s.end; d.setDate(d.getDate() + 1)) {
                    if (d.getFullYear() === yr && d.getMonth() + 1 === m)
                        return true;
                }
                return false;
            })
            : sugs;
        let html = '';
        filtered.forEach(s => {
            const isApp = isSugApplied(s.workdays);
            const eid = s.id.replace(/'/g, '');
            const eff = s.offDays / s.useDays;
            const isRec = eff >= 3 && s.offDays >= 4;
            html += `<div class="sug-item${isApp ? ' applied' : ''}" onclick="applySugSabo('${eid}',${yr})">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:3px">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:14px;font-weight:500">${s.offDays}連休${isApp ? ' ✓' : ''}</span>
            ${isRec ? '<span class="badge-rec">おすすめ</span>' : ''}
          </div>
          <span class="badge ba">${s.useDays}日使用</span>
        </div>
        <div style="font-size:12px;color:var(--tx2)">${s.desc}</div>
      </div>`;
        });
        if (!html)
            html = '<div class="empty-msg">4連休以上になる提案が見つかりませんでした</div>';
        $('sug-list').innerHTML = html;
    }, 0);
}
async function applySugSabo(id, yr) {
    const s = state.saboSugCache[yr]?.[id];
    if (!s) {
        toast(MSG_SUGGEST_EMPTY);
        return;
    }
    const workdays = s.workdays;
    for (const d of workdays) {
        if (!state.vacations.some(v => v.start_date <= d && d <= v.end_date)) {
            const newId = await repo.insertVacation(yr, d, d, 'full', null);
            state.vacations.push({ id: newId, start_date: d, end_date: d, type: 'full', hours: null, year: yr });
        }
    }
    const firstDate = new Date(workdays[0] + 'T12:00:00');
    state.viewYear = yr;
    state.viewMonth = firstDate.getMonth() + 1;
    renderSug();
    renderDashboard();
    sw('dashboard');
    renderCalendar();
    toast(msgSuggestAdded(workdays.length));
}
// ── Settings ───────────────────────────────────────────
async function saveSetting(key, value) {
    await repo.upsertSetting(key, value);
    state.settings[key] = value;
    if (key === 'work_hours_per_day') {
        applyWorkHoursMax();
        renderCalendar();
    }
    if (key === 'min_work_hours')
        renderCalendar();
    renderDashboard();
}
async function reloadVacations() {
    state.vacations = await repo.getVacations(state.mgmtYear);
}
function renderSettings() {
    $('hire-date').value = state.settings.hire_date ?? '';
    $('carryover').value = state.settings.carryover ?? '0';
    $('work-hours').value = state.settings.work_hours_per_day ?? '8';
    $('min-hours').value = state.settings.min_work_hours ?? '';
    const dows = ['日', '月', '火', '水', '木', '金', '土'];
    $('dow-checks').innerHTML = dows.map((d, i) => `<label style="display:flex;align-items:center;gap:4px;font-size:13px;cursor:pointer">
      <input type="checkbox" ${state.companyOffDow.includes(i) ? 'checked' : ''} onchange="toggleDow(${i})"> ${d}
    </label>`).join('');
    $('co-list').innerHTML = state.companyOffDates.length === 0
        ? '<div class="empty-msg">登録なし</div>'
        : state.companyOffDates.map(c => `<div class="vitem">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.date} <span class="badge bb">${c.name}</span></span>
        <button class="btn-danger" style="flex-shrink:0" onclick="removeCoOff('${c.date}')">削除</button>
       </div>`).join('');
    const sortedRules = [...state.grantRules].sort((a, b) => a.months - b.months);
    $('rules-list').innerHTML =
        `<div class="rule-header"><span>勤続期間</span><span>付与日数</span><span></span></div>` +
            sortedRules.map(r => {
                const yrs = Math.floor(r.months / 12), mos = r.months % 12;
                const label = mos === 0 ? `${yrs}年以上` : `${yrs}年${mos}ヶ月以上`;
                return `<div class="rule-row">
        <span style="font-size:13px">${label}</span>
        <div style="display:flex;align-items:center;gap:4px">
          <input type="number" class="rule-input" value="${r.days}" min="1" max="40" step="0.5" style="width:60px"
            onchange="updateRule(${r.months},this.value)">
          <span class="rule-unit">日</span>
        </div>
        <button class="btn-danger" onclick="removeRule(${r.months})">削除</button>
      </div>`;
            }).join('');
    renderHolidayPanel();
}
function renderHolidayPanel() {
    const ty = new Date().getFullYear();
    const defaultYears = [ty - 1, ty, ty + 1];
    const years = [...new Set([...defaultYears, ...state.cachedYears.map(r => r.year)])].sort((a, b) => a - b);
    $('holiday-years').innerHTML = years.map(yr => {
        const cached = state.cachedYears.find(r => r.year === yr);
        const count = cached?.count ?? 0, ok = count > 0;
        return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:0.5px solid var(--border)">
      <span style="font-size:13px;min-width:52px">${yr}年</span>
      <span class="status-chip ${ok ? 'chip-ok' : 'chip-ng'}">${ok ? count + '件' : '未取得'}</span>
      <span id="fy-status-${yr}" style="font-size:12px;color:var(--tx3)"></span>
      <button class="btn-ghost" style="margin-left:auto" onclick="fetchYear(${yr},true)">${ok ? '再取得' : '取得'}</button>
    </div>`;
    }).join('');
    const inp = $('fetch-year-input');
    if (inp && !inp.value)
        inp.value = String(ty);
}
async function fetchSpecificYear() {
    const inp = $('fetch-year-input');
    const statusEl = $('fetch-specific-status');
    const year = parseInt(inp.value);
    if (isNaN(year) || year < 2000 || year > 2099) {
        statusEl.textContent = '2000〜2099の年を入力してください';
        statusEl.style.color = 'var(--red)';
        return;
    }
    statusEl.textContent = `${year}年を取得中...`;
    statusEl.style.color = 'var(--tx3)';
    await fetchYear(year, true);
    statusEl.textContent = '';
}
async function fetchYear(year, force = false) {
    const el = document.getElementById('fy-status-' + year);
    if (el)
        el.textContent = '取得中...';
    let fetched = false, count = 0;
    try {
        const alreadyCached = await repo.isYearFetched(year);
        if (!alreadyCached || force) {
            count = await fetchAndSaveHolidays(year);
            fetched = true;
        }
        else {
            count = await repo.getHolidayCount(year);
        }
        const [holidays, cachedYears] = await Promise.all([repo.getHolidays(year), repo.getCachedHolidayYears()]);
        Object.assign(state.holidays, holidays);
        state.cachedYears = cachedYears;
        if (el)
            el.textContent = fetched ? `完了 (${count}件)` : 'キャッシュ済み';
        renderHolidayPanel();
        renderCalendar();
        toast(msgHolidayFetched(year, fetched, count));
    }
    catch (err) {
        if (el)
            el.textContent = '失敗: ' + (err instanceof Error ? err.message : String(err));
        toast(msgHolidayFetchFailed(year));
    }
}
async function toggleDow(i) {
    const idx = state.companyOffDow.indexOf(i);
    if (idx >= 0)
        state.companyOffDow.splice(idx, 1);
    else
        state.companyOffDow.push(i);
    await repo.replaceCompanyOffDow(state.companyOffDow);
    renderCalendar();
    renderSettings();
}
async function addCoOff() {
    const date = $('co-date').value;
    const name = $('co-name').value || '会社休日';
    if (!date)
        return;
    if (state.companyOffDates.some(c => c.date === date)) {
        toast(`${date} はすでに登録されています`);
        return;
    }
    await repo.upsertCompanyOffDate(date, name);
    state.companyOffDates.push({ date, name });
    state.companyOffDates.sort((a, b) => a.date.localeCompare(b.date));
    renderCalendar();
    renderSettings();
    toast(msgCompanyOffAdded(date));
}
async function removeCoOff(date) {
    await repo.deleteCompanyOffDate(date);
    state.companyOffDates = state.companyOffDates.filter(c => c.date !== date);
    renderCalendar();
    renderSettings();
}
async function updateRule(months, v) {
    const r = state.grantRules.find(r => r.months === months);
    if (!r)
        return;
    r.days = parseFloat(v);
    await repo.replaceGrantRules(state.grantRules);
    renderDashboard();
}
async function removeRule(months) {
    state.grantRules = state.grantRules.filter(r => r.months !== months);
    await repo.replaceGrantRules(state.grantRules);
    renderSettings();
    renderDashboard();
}
function addRule() {
    const last = Math.max(...state.grantRules.map(r => r.months));
    state.grantRules.push({ months: last + 12, days: 20 });
    repo.replaceGrantRules(state.grantRules);
    renderSettings();
}
async function resetRules() {
    if (!confirm('付与ルールを標準ルールに初期化しますか？'))
        return;
    state.grantRules = [[6, 10], [18, 11], [30, 12], [42, 14], [54, 16], [66, 18], [78, 20]].map(([months, days]) => ({ months, days }));
    await repo.replaceGrantRules(state.grantRules);
    renderSettings();
    renderDashboard();
}
// ── Init ───────────────────────────────────────────────
async function loadYear(year) {
    const [settings, grantRules, companyOffDow, companyOffDates, vacations, events, holidays] = await Promise.all([
        repo.getAllSettings(),
        repo.getGrantRules(),
        repo.getCompanyOffDow(),
        repo.getCompanyOffDates(),
        repo.getVacations(year),
        repo.getEvents(year),
        repo.getHolidays(year),
    ]);
    state.mgmtYear = year;
    state.settings = settings;
    state.grantRules = grantRules;
    state.companyOffDow = companyOffDow;
    state.companyOffDates = companyOffDates;
    state.vacations = vacations;
    state.events = events;
    Object.assign(state.holidays, holidays);
}
async function init() {
    await getDb();
    const ty = new Date().getFullYear();
    const today = toKey(new Date());
    $('add-s').value = today;
    $('add-e').value = today;
    $('co-date').value = today;
    const sugYearSel = $('sug-year');
    const sugYears = [ty - 1, ty, ty + 1];
    for (const y of sugYears) {
        const o = document.createElement('option');
        o.value = String(y);
        o.textContent = y + '年';
        if (y === ty)
            o.selected = true;
        sugYearSel.appendChild(o);
    }
    const cachedYears = await repo.getCachedHolidayYears();
    state.cachedYears = cachedYears;
    await Promise.all(cachedYears.map(async (r) => {
        const holidays = await repo.getHolidays(r.year);
        Object.assign(state.holidays, holidays);
    }));
    await loadYear(ty);
    await refreshMgmtYear();
    renderDashboard();
    renderCalendar();
    const validTabs = ['dashboard', 'suggest', 'settings'];
    const hash = location.hash.replace('#', '');
    if (validTabs.includes(hash))
        sw(hash);
}
// ハッシュに対応するタブを即時適用（フラッシュ防止）
;
(() => {
    const validTabs = ['dashboard', 'suggest', 'settings'];
    const hash = location.hash.replace('#', '');
    if (!validTabs.includes(hash))
        return;
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    $(hash).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(t => t.classList.remove('active'));
    const navEl = document.querySelector(`.nav-item[onclick*="'${hash}'"]`);
    if (navEl)
        navEl.classList.add('active');
})();
init();
