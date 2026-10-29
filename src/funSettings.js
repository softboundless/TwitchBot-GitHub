import fs from 'node:fs';
import path from 'node:path';

function validate(data) {
  if (data?.version !== 1 || !['on', 'off', 'vip'].includes(data.mode) ||
      !Number.isSafeInteger(data.cooldown) || data.cooldown < 0 || data.cooldown > 1_000_000_000 ||
      !Array.isArray(data.tempVips) || data.tempVips.some((name) =>
        typeof name !== 'string' || !/^[a-z0-9_]{1,25}$/.test(name) || name === '__proto__')) {
    throw new Error('Некорректные настройки игровых команд');
  }
}

export class FunSettings {
  constructor(file, { defaultMode = 'off' } = {}) {
    this.file = file;
    this.data = { version: 1, mode: defaultMode, cooldown: 0, tempVips: [] };
    validate(this.data);
    if (!file) return;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    validate(this.data);
  }

  update(changes) {
    const next = { ...this.data, ...changes };
    validate(next);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temp, this.file);
      } catch (error) {
        try { fs.unlinkSync(temp); } catch {}
        throw error;
      }
    }
    this.data = next;
  }
}
