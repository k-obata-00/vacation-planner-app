"use strict";
// ── 型定義（app.ts からも参照） ──────────────────────────
// ── IDBRequest ヘルパー ──────────────────────────────────
function req2p(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
function getAllFromStore(store) {
    return req2p(store.getAll());
}
function getAllFromIndex(index, key) {
    return req2p(index.getAll(key));
}
// 複数操作トランザクション（await を挟まず同期的にキュー）
function txRun(storeNames, fn) {
    return getDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(new Error('Transaction aborted'));
        fn(tx);
    }));
}
// ── リポジトリ ───────────────────────────────────────────
const repo = {
    // 設定
    async getAllSettings() {
        const db = await getDb();
        const rows = await getAllFromStore(db.transaction('settings', 'readonly').objectStore('settings'));
        return Object.fromEntries(rows.map(r => [r.key, r.value]));
    },
    async upsertSetting(key, value) {
        const db = await getDb();
        await req2p(db.transaction('settings', 'readwrite').objectStore('settings').put({ key, value }));
    },
    async getWorkHours() {
        const db = await getDb();
        const row = await req2p(db.transaction('settings', 'readonly').objectStore('settings').get('work_hours_per_day'));
        return parseFloat(row?.value ?? '8');
    },
    // 付与ルール
    async getGrantRules() {
        const db = await getDb();
        const rows = await getAllFromStore(db.transaction('grant_rules', 'readonly').objectStore('grant_rules'));
        return rows.sort((a, b) => a.months - b.months);
    },
    replaceGrantRules(rules) {
        return txRun('grant_rules', tx => {
            const store = tx.objectStore('grant_rules');
            store.clear();
            for (const r of rules)
                store.put({ months: r.months, days: r.days });
        });
    },
    // 会社休日（曜日）
    async getCompanyOffDow() {
        const db = await getDb();
        const rows = await getAllFromStore(db.transaction('company_off_dow', 'readonly').objectStore('company_off_dow'));
        return rows.map(r => r.dow);
    },
    replaceCompanyOffDow(dows) {
        return txRun('company_off_dow', tx => {
            const store = tx.objectStore('company_off_dow');
            store.clear();
            for (const d of dows)
                store.put({ dow: d });
        });
    },
    // 会社休日（特定日）
    async getCompanyOffDates() {
        const db = await getDb();
        const rows = await getAllFromStore(db.transaction('company_off_dates', 'readonly').objectStore('company_off_dates'));
        return rows.sort((a, b) => a.date.localeCompare(b.date));
    },
    async getCompanyOffDateSet() {
        const db = await getDb();
        const rows = await getAllFromStore(db.transaction('company_off_dates', 'readonly').objectStore('company_off_dates'));
        return new Set(rows.map(r => r.date));
    },
    async upsertCompanyOffDate(date, name) {
        const db = await getDb();
        await req2p(db.transaction('company_off_dates', 'readwrite').objectStore('company_off_dates').put({ date, name }));
    },
    async deleteCompanyOffDate(date) {
        const db = await getDb();
        await req2p(db.transaction('company_off_dates', 'readwrite').objectStore('company_off_dates').delete(date));
    },
    // 社外予定
    async getEvents(year) {
        const db = await getDb();
        const tx = db.transaction('events', 'readonly');
        const store = tx.objectStore('events');
        const rows = year !== undefined
            ? await getAllFromIndex(store.index('year'), year)
            : await getAllFromStore(store);
        return rows.sort((a, b) => a.date.localeCompare(b.date));
    },
    async getEventUsageByDate(date) {
        const db = await getDb();
        const rows = await getAllFromIndex(db.transaction('events', 'readonly').objectStore('events').index('date'), date);
        return rows.map(r => ({ type: r.type, hours: r.hours }));
    },
    async insertEvent(year, date, label, type, hours) {
        const db = await getDb();
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        return req2p(db.transaction('events', 'readwrite').objectStore('events').add({ year, date, label, type, hours, created_at: now }));
    },
    async deleteEvent(id) {
        const db = await getDb();
        await req2p(db.transaction('events', 'readwrite').objectStore('events').delete(id));
    },
    // 有給
    async getVacations(year) {
        const db = await getDb();
        const tx = db.transaction('vacations', 'readonly');
        const store = tx.objectStore('vacations');
        const rows = year !== undefined
            ? await getAllFromIndex(store.index('year'), year)
            : await getAllFromStore(store);
        return rows.sort((a, b) => a.start_date.localeCompare(b.start_date));
    },
    async getVacationUsageByDate(date) {
        const db = await getDb();
        const rows = await getAllFromStore(db.transaction('vacations', 'readonly').objectStore('vacations'));
        return rows
            .filter(v => v.start_date <= date && date <= v.end_date)
            .map(v => ({ type: v.type, hours: v.hours }));
    },
    async getVacationsOverlapping(startDate, endDate) {
        const db = await getDb();
        const rows = await getAllFromStore(db.transaction('vacations', 'readonly').objectStore('vacations'));
        return rows
            .filter(v => !(v.end_date < startDate || v.start_date > endDate))
            .map(v => ({ start_date: v.start_date, end_date: v.end_date }));
    },
    async insertVacation(year, startDate, endDate, type, hours) {
        const db = await getDb();
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        return req2p(db.transaction('vacations', 'readwrite').objectStore('vacations').add({ year, start_date: startDate, end_date: endDate, type, hours, created_at: now }));
    },
    async deleteVacation(id) {
        const db = await getDb();
        await req2p(db.transaction('vacations', 'readwrite').objectStore('vacations').delete(id));
    },
    // 祝日
    async isYearFetched(year) {
        const db = await getDb();
        const row = await req2p(db.transaction('holiday_fetch_log', 'readonly').objectStore('holiday_fetch_log').get(year));
        return !!row;
    },
    async getHolidays(year) {
        const db = await getDb();
        const rows = await getAllFromIndex(db.transaction('holidays', 'readonly').objectStore('holidays').index('year'), year);
        return Object.fromEntries(rows.map(r => [r.date, r.name]));
    },
    async getHolidayCount(year) {
        const db = await getDb();
        return req2p(db.transaction('holidays', 'readonly').objectStore('holidays').index('year').count(year));
    },
    saveHolidayData(year, data) {
        return txRun(['holidays', 'holiday_fetch_log'], tx => {
            const hs = tx.objectStore('holidays');
            const fl = tx.objectStore('holiday_fetch_log');
            const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
            for (const [date, name] of Object.entries(data)) {
                hs.put({ date, year, name, fetched_at: now });
            }
            fl.put({ year, fetched_at: now });
        });
    },
    async getCachedHolidayYears() {
        const db = await getDb();
        const rows = await getAllFromStore(db.transaction('holidays', 'readonly').objectStore('holidays'));
        const yearCounts = {};
        for (const r of rows)
            yearCounts[r.year] = (yearCounts[r.year] ?? 0) + 1;
        return Object.entries(yearCounts)
            .map(([year, count]) => ({ year: Number(year), count }))
            .sort((a, b) => a.year - b.year);
    },
    async getHolidayDatesBetween(startDate, endDate) {
        const db = await getDb();
        const rows = await getAllFromStore(db.transaction('holidays', 'readonly').objectStore('holidays'));
        return new Set(rows.filter(r => r.date >= startDate && r.date <= endDate).map(r => r.date));
    },
};
