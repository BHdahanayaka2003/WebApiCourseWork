import { openDb } from './db.js';
import { seedIfEmpty, startSimulator } from './seed.js';
import { createApp } from './app.js';

const db = openDb(process.env.DB_PATH || './data/slsea.db');
const t0 = Date.now();
const n = seedIfEmpty(db, { demoPassword: process.env.DEMO_PASSWORD });
console.log(`[boot] seed/catch-up inserted ${n} readings in ${Date.now() - t0} ms`);
if (process.env.SIMULATE !== 'false') startSimulator(db);
const port = Number(process.env.PORT || 3000);
createApp(db).listen(port, '0.0.0.0', () => console.log(`[boot] listening on :${port}  docs at /docs`));
