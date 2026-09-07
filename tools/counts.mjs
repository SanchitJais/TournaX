import {all} from '../src/db.js';
const t=all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
for (const r of t) console.log(r.name.padEnd(24), all('SELECT COUNT(*) n FROM '+r.name)[0].n);
