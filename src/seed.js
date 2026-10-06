import { tx } from './db.js';
import { hashPassword } from './auth.js';

const SLOT = 15 * 60 * 1000;           // fixed 15-minute reporting interval
const LK_OFFSET_H = 5.5;               // Sri Lanka Standard Time, no DST
export const floorSlot = (ms) => Math.floor(ms / SLOT) * SLOT;
export const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const GEO = {
  Western: ['WP', 6.9, 79.9, ['Colombo', 'Gampaha', 'Kalutara']],
  Central: ['CP', 7.3, 80.6, ['Kandy', 'Matale', 'Nuwara Eliya']],
  Southern: ['SP', 6.1, 80.5, ['Galle', 'Matara', 'Hambantota']],
  Northern: ['NP', 9.5, 80.2, ['Jaffna', 'Kilinochchi', 'Mannar', 'Vavuniya', 'Mullaitivu']],
  Eastern: ['EP', 7.7, 81.5, ['Batticaloa', 'Ampara', 'Trincomalee']],
  'North Western': ['NW', 7.5, 80.0, ['Kurunegala', 'Puttalam']],
  'North Central': ['NC', 8.3, 80.5, ['Anuradhapura', 'Polonnaruwa']],
  Uva: ['UV', 6.9, 81.1, ['Badulla', 'Monaragala']],
  Sabaragamuwa: ['SG', 6.7, 80.4, ['Ratnapura', 'Kegalle']],
};
const EXTRA_SUBS = ['Colombo', 'Gampaha', 'Kandy', 'Galle', 'Kurunegala'];
const FIRST = ['Nimal', 'Kamala', 'Saman', 'Dilani', 'Ruwan', 'Priya', 'Arjun', 'Fathima', 'Kasun', 'Anushka', 'Tharaka', 'Selvam', 'Ishara', 'Mohamed', 'Chamari'];
const LAST = ['Perera', 'Fernando', 'Silva', 'Jayasuriya', 'Wickramasinghe', 'Rajapaksa', 'Kumar', 'Nadarajah', 'Hussain', 'Bandara', 'Gunawardena', 'Senanayake'];

function rng(seed) {                   // mulberry32: deterministic seed data
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const h2 = (a, b) => rng((Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) >>> 0)();
const slug = (s) => s.toLowerCase().replace(/\s+/g, '-');

function power(inst, t) {
  const lh = ((t / 3600000 + LK_OFFSET_H) % 24 + 24) % 24;
  const sun = lh > 6 && lh < 18 ? Math.sin(Math.PI * (lh - 6) / 12) : 0;   // diurnal curve
  if (sun === 0) return 0;
  const day = Math.floor((t + LK_OFFSET_H * 3600000) / 86400000);
  const cloud = 0.55 + 0.45 * h2(inst.province_id, day);                     // regional weather per day
  const noise = 0.9 + 0.2 * h2(inst.id, Math.floor(t / SLOT));
  return Math.round(inst.capacity_kw * 0.85 * Math.pow(sun, 1.2) * cloud * noise * 1000) / 1000;
}


export function fillReadings(db, untilMs, historyDays = 7) {
  const floor = floorSlot(untilMs);
  const earliest = floor - (historyDays * 24 * 4 - 1) * SLOT;
  const insts = db.prepare("SELECT id, capacity_kw, province_id FROM installation_geo WHERE status='active'").all();
  const last = db.prepare('SELECT ts, energy_kwh FROM readings WHERE installation_id=? ORDER BY ts DESC LIMIT 1');
  const ins = db.prepare('INSERT OR IGNORE INTO readings(installation_id,ts,power_kw,energy_kwh,voltage_v) VALUES (?,?,?,?,?)');
  let n = 0;
  tx(db, () => {
    for (const inst of insts) {
      const l = last.get(inst.id);
      let start = l ? Date.parse(l.ts) + SLOT : earliest;
      let energy = l ? l.energy_kwh : 800 + h2(inst.id, 1) * 6000;
      for (let t = Math.max(start, earliest); t <= floor; t += SLOT) {
        const p = power(inst, t);
        energy += p * 0.25;
        const v = 230 + (p > 0 ? 2 : 0) + (h2(inst.id, t / SLOT + 7) - 0.5) * 8;
        ins.run(inst.id, isoSec(t), p, Math.round(energy * 1000) / 1000, Math.round(v * 10) / 10);
        n++;
      }
    }
  });
  return n;
}

export function seedIfEmpty(db, { demoPassword = 'SolarLK#2026' } = {}) {
  if (db.prepare('SELECT COUNT(*) c FROM provinces').get().c === 0) {
    const r = rng(2026);
    const now = isoSec(Date.now());
    tx(db, () => {
      const insP = db.prepare('INSERT INTO provinces(code,name) VALUES (?,?)');
      const insD = db.prepare('INSERT INTO districts(province_id,name) VALUES (?,?)');
      const insS = db.prepare('INSERT INTO substations(district_id,name,voltage_level_kv,capacity_mva) VALUES (?,?,?,?)');
      const insI = db.prepare(`INSERT INTO installations(substation_id,meter_id,name,owner_name,capacity_kw,latitude,longitude,status,installed_on,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const subs = [];
      for (const [pname, [code, lat, lng, dists]] of Object.entries(GEO)) {
        const pid = Number(insP.run(code, pname).lastInsertRowid);
        for (const dname of dists) {
          const did = Number(insD.run(pid, dname).lastInsertRowid);
          const sid = Number(insS.run(did, `${dname} Grid Substation`, 33, 31.5).lastInsertRowid);
          subs.push({ sid, lat, lng, weight: pname === 'Western' ? 3 : 1 });
          if (EXTRA_SUBS.includes(dname)) {
            const sid2 = Number(insS.run(did, `${dname} North Grid Substation`, 33, 20).lastInsertRowid);
            subs.push({ sid: sid2, lat, lng, weight: 2 });
          }
        }
      }
      const total = subs.reduce((a, s) => a + s.weight, 0);
      for (let i = 1; i <= 240; i++) {
        let x = r() * total, s = subs[0];
        for (const c of subs) { x -= c.weight; if (x <= 0) { s = c; break; } }
        const owner = `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
        const cap = Math.round((3 + r() * 12) * 10) / 10;
        const yr = 2021 + Math.floor(r() * 5);
        insI.run(s.sid, `SLM-${String(i).padStart(6, '0')}`, `${owner} Rooftop`, owner, cap,
          Math.round((s.lat + (r() - 0.5) * 0.6) * 1e5) / 1e5, Math.round((s.lng + (r() - 0.5) * 0.6) * 1e5) / 1e5,
          i % 40 === 0 ? 'inactive' : 'active', `${yr}-0${1 + Math.floor(r() * 9)}-15`, now, now);
      }
      // Users: 1 national, 9 provincial, 25 district (jurisdiction-scoped read clients)
      const insU = db.prepare('INSERT INTO users(email,password_hash,full_name,role,province_id,district_id) VALUES (?,?,?,?,?,?)');
      const pw = hashPassword(demoPassword);
      insU.run('national@slsea.lk', pw, 'National Operations', 'national', null, null);
      for (const p of db.prepare('SELECT id,name FROM provinces').all())
        insU.run(`${slug(p.name)}.provincial@slsea.lk`, pw, `${p.name} Provincial Officer`, 'provincial', p.id, null);
      for (const d of db.prepare('SELECT id,name,province_id FROM districts').all())
        insU.run(`${slug(d.name)}.district@slsea.lk`, pw, `${d.name} District Officer`, 'district', d.province_id, d.id);
    });
  }
  return fillReadings(db, Date.now());
}


export function startSimulator(db) {
  const tick = () => { try { fillReadings(db, Date.now()); } catch (e) { console.error('[sim]', e.message); } };
  const wait = SLOT - (Date.now() % SLOT) + 2000;
  setTimeout(() => { tick(); setInterval(tick, SLOT).unref(); }, wait).unref();
}
