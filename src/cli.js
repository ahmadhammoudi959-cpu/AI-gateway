// Maintenance commands:
//   node src/cli.js reset-password <email> <new-password>
//   node src/cli.js create-admin <email> <password>
import { loadConfig, resolveSecrets } from './config.js';
import { openDb } from './db.js';
import { hashPassword } from './util.js';

const [cmd, email, password] = process.argv.slice(2);
if (!['reset-password', 'create-admin'].includes(cmd) || !email || !password) {
  console.log('Usage:\n  node src/cli.js reset-password <email> <new-password>\n  node src/cli.js create-admin <email> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}
const cfg = loadConfig();
resolveSecrets(cfg);
const db = await openDb(cfg);
const hash = await hashPassword(password);
if (cmd === 'create-admin') {
  await db.query(
    `INSERT INTO admins (email, name, password_hash) VALUES ($1, '', $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, session_version = admins.session_version + 1`,
    [email.toLowerCase(), hash],
  );
  console.log(`Admin ${email} is ready.`);
} else {
  const { rows } = await db.query(
    'UPDATE admins SET password_hash = $2, session_version = session_version + 1 WHERE email = $1 RETURNING id',
    [email.toLowerCase(), hash],
  );
  console.log(rows[0] ? `Password updated for ${email}.` : `No admin with email ${email}.`);
}
await db.close();
