"use strict";
const DB_NAME = 'vacation-planner-db';
const DB_VERSION = 1;
let _db = null;
async function getDb() {
    if (_db)
        return _db;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = req.result;
            const oldVersion = e.oldVersion;
            const hs = db.createObjectStore('holidays', { keyPath: 'date' });
            hs.createIndex('year', 'year');
            db.createObjectStore('holiday_fetch_log', { keyPath: 'year' });
            const settings = db.createObjectStore('settings', { keyPath: 'key' });
            const grantRules = db.createObjectStore('grant_rules', { keyPath: 'months' });
            const companyOffDow = db.createObjectStore('company_off_dow', { keyPath: 'dow' });
            db.createObjectStore('company_off_dates', { keyPath: 'date' });
            const events = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
            events.createIndex('year', 'year');
            events.createIndex('date', 'date');
            const vacations = db.createObjectStore('vacations', { keyPath: 'id', autoIncrement: true });
            vacations.createIndex('year', 'year');
            vacations.createIndex('start_date', 'start_date');
            if (oldVersion === 0) {
                settings.put({ key: 'work_hours_per_day', value: '8' });
                for (const [months, days] of [[6, 10], [18, 11], [30, 12], [42, 14], [54, 16], [66, 18], [78, 20]]) {
                    grantRules.put({ months, days });
                }
                companyOffDow.put({ dow: 0 });
                companyOffDow.put({ dow: 6 });
            }
        };
        req.onsuccess = () => { _db = req.result; resolve(_db); };
        req.onerror = () => reject(req.error);
    });
}
