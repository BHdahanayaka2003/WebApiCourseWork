import { deviceKey } from './auth.js';
const id = process.argv[2];
if (!id) { console.error('usage: npm run device-key -- <METER_ID>'); process.exit(1); }
console.log(deviceKey(id));
