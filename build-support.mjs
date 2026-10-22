import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export async function publishableFiles(dir) {
  const result=[];
  for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
    const name=entry.name.toLowerCase();
    if(name.startsWith('.')||name==='__pycache__'||/\.(?:pyc|pyo|log|tmp)$/.test(name)||['thumbs.db','desktop.ini'].includes(name))continue;
    if(entry.isSymbolicLink())throw new Error('Symbolic links are not allowed.');
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())result.push(...await publishableFiles(full));else if(entry.isFile())result.push(full);
  }
  return result.sort();
}

// Authenticate the old container with this key and this path before reusing it.
// A plaintext hash alone would not prove that its old ciphertext is usable.
export async function encryptedContainer(relative, plaintext, key, oldFile) {
  try {
    const previous = await fs.readFile(oldFile);
    if (previous.length >= 28) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, previous.subarray(0, 12));
      decipher.setAAD(Buffer.from(relative));
      decipher.setAuthTag(previous.subarray(-16));
      const decoded = Buffer.concat([decipher.update(previous.subarray(12, -16)), decipher.final()]);
      if (decoded.equals(plaintext)) return { bytes: previous, reused: true };
    }
  } catch (error) {
    // Missing, corrupt, changed-key, and changed-AAD containers are rebuilt.
    if (error.code === 'EACCES' || error.code === 'EPERM') throw error;
  }
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(relative));
  return { bytes: Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]), reused: false };
}
