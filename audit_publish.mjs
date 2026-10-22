// Audit the exact tracked tree before pushing. Never print secret values.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const root = process.cwd();
const files = execFileSync('git', ['ls-files', '-z'], {cwd: root}).toString('utf8').split('\0').filter(Boolean);
const key = (await fs.readFile(path.join(root, '.private/key.txt'), 'utf8')).trim();
assert(/^[A-Za-z0-9_-]{43}$/.test(key), 'expected a 256-bit private access key');
const secrets = [Buffer.from(key), Buffer.from(key, 'base64url')];
try {
  secrets.push(Buffer.from((await fs.readFile(path.join(root, '../复习中心/.runtime/mobile-pair-token.txt'), 'utf8')).trim()));
} catch {}
const forbidden = /(^|\/)(\.private|\.runtime|我的复习记录|恢复冲突|node_modules|outputs)(\/|$)/;
let bytes = 0;
const hashes = new Map();
for (const name of files) {
  assert(!forbidden.test(name), `private/runtime file staged: ${name}`);
  const data = execFileSync('git', ['show', ':' + name], {cwd: root, maxBuffer: 128 * 1024 * 1024});
  if (name.startsWith('site/secrets/')) assert(data.equals(await fs.readFile(path.join(root, name))), `ciphertext changed in Git staging: ${name}`);
  assert(data.length < 95 * 1024 * 1024, `file too large for ordinary Git: ${name}`);
  for (const secret of secrets) if (secret.length) assert(!data.includes(secret), `credential present in staged file: ${name}`);
  assert(!name.startsWith('site/content/'), `plaintext course file in site: ${name}`);
  bytes += data.length;
  hashes.set(name, crypto.createHash('sha256').update(data).digest('hex'));
}
assert(files.includes('site/index.html'), 'publish tree must include built entry');
assert(files.includes('site/sw.js'), 'publish tree must include service worker');
assert(files.includes('.github/workflows/pages.yml'), 'publish workflow missing');
const manifest=JSON.parse(execFileSync('git',['show',':site/manifest.json'],{cwd:root,maxBuffer:4*1024*1024}));
assert(Object.keys(manifest.static_hashes || {}).length > 0, 'public resource hashes missing');
for (const [name, expected] of Object.entries(manifest.static_hashes)) {
  assert.equal(hashes.get('site/'+name), expected, `published static bytes differ from manifest: ${name}`);
}
for (const entry of Object.values(manifest.files)) {
  assert.equal(hashes.get('site/'+entry.url),entry.cipher_sha256,`published ciphertext differs from manifest: ${entry.url}`);
}
console.log(JSON.stringify({tracked_files: files.length, size_mib: Math.round(bytes / 1048576 * 10) / 10, credentials: 'absent', personal_record_files: 'absent', plaintext_courses: 'absent',published_hashes:'verified'}));
