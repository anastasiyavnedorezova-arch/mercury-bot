import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export const KEYS = ['AI_TEXT_PROVIDER', 'AI_STATEMENT_PROVIDER', 'AI_VOICE_PROVIDER'];
export class SwitchError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
export function selectProviders(env) {
  return Object.fromEntries(KEYS.map(k => [k, (env[k] || 'openai').trim().toLowerCase()]));
}
export function updateProviders(source, provider) {
  if (!['openai', 'yandex'].includes(provider)) throw new SwitchError('INVALID_PROVIDER');
  // Reject ambiguous assignments; do not rewrite any other setting or secret.
  let result = source;
  for (const key of KEYS) {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'gm');
    const matches = result.match(pattern) || [];
    if (matches.length > 1) throw new SwitchError('DUPLICATE_PROVIDER_SETTING');
    result = matches.length ? result.replace(pattern, `${key}=${provider}`) : result.trimEnd() + `\n${key}=${provider}\n`;
  }
  return result;
}
export async function atomicWrite(file, content, { uid, gid } = {}) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    if (uid !== undefined && gid !== undefined) await handle.chown(uid, gid);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.rename(temporary, file);
  } finally { await handle?.close(); await fs.rm(temporary, { force: true }); }
}
export async function switchAI({ envPath, stateDir, provider, rollback = false, checkOnly = false, parse, probe, restart, ready, onStep = () => {} }) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDir, 'lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (err) { if (err.code === 'EEXIST') throw new SwitchError('SWITCH_ALREADY_RUNNING'); throw err; }
  try {
    const stat = await fs.lstat(envPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new SwitchError('ENV_PERMISSIONS');
    const original = await fs.readFile(envPath, 'utf8');
    let updated;
    if (rollback) {
      const record = JSON.parse(await fs.readFile(path.join(stateDir, 'latest.json'), 'utf8'));
      if (digest(original) !== record.afterHash) throw new SwitchError('ROLLBACK_CONFIG_CHANGED');
      if (!/^[a-f0-9-]+\.env$/.test(record.backup)) throw new SwitchError('ROLLBACK_SNAPSHOT_INVALID');
      updated = await fs.readFile(path.join(stateDir, record.backup), 'utf8');
      if (digest(updated) !== record.beforeHash) throw new SwitchError('ROLLBACK_SNAPSHOT_INVALID');
    } else updated = updateProviders(original, provider);
    const target = parse(updated);
    onStep('Checking text, statement and voice APIs using synthetic/public samples.');
    await probe(target);
    if (checkOnly) return { changed: false, checked: true };
    if (updated === original) return { changed: false, checked: true };
    if (await fs.readFile(envPath, 'utf8') !== original) throw new SwitchError('ENV_CHANGED_DURING_CHECK');
    const backup = `${crypto.randomUUID()}.env`;
    await atomicWrite(path.join(stateDir, backup), original);
    const journal = { backup, beforeHash: digest(original), afterHash: digest(updated), time: new Date().toISOString() };
    // Record intent before changing the environment; crash recovery remains possible.
    await atomicWrite(path.join(stateDir, 'latest.json'), JSON.stringify(journal));
    await atomicWrite(envPath, updated, stat);
    try {
      onStep('Restarting selected service and checking readiness.');
      await restart(); await ready(target);
    } catch {
      // Do not overwrite a concurrent operator change during recovery.
      if (digest(await fs.readFile(envPath, 'utf8')) !== digest(updated)) throw new SwitchError('RECOVERY_CONFIG_CHANGED');
      await atomicWrite(envPath, original, stat);
      let restored = false;
      try { await restart(); await ready(parse(original)); restored = true; } catch { /* report explicitly below */ }
      throw new SwitchError(restored ? 'SWITCH_FAILED_PREVIOUS_RESTORED' : 'SWITCH_FAILED_RECOVERY_NEEDS_ATTENTION');
    }
    return { changed: true, backup: path.join(stateDir, backup), providers: selectProviders(target) };
  } finally { await fs.rmdir(lock); }
}
