import fs from 'node:fs';
import path from 'node:path';

// Один файл на канал. Публикуем новое состояние только после успешной записи.
export class CommandSettings {
  constructor(file) {
    this.file = file;
    this.disabled = new Set();
    if (!file) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(data) || data.some((cmd) => typeof cmd !== 'string' || !cmd.startsWith('!'))) {
        throw new Error('Некорректный список отключённых команд');
      }
      this.disabled = new Set(data);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  isDisabled(cmd) { return this.disabled.has(cmd); }

  setDisabled(cmd, disabled) {
    const next = new Set(this.disabled);
    if (disabled) next.add(cmd);
    else next.delete(cmd);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify([...next].sort(), null, 2) + '\n');
        fs.renameSync(temp, this.file);
      } catch (error) {
        try { fs.unlinkSync(temp); } catch {}
        throw error;
      }
    }
    this.disabled = next;
  }
}
