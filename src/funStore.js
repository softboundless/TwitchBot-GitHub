import fs from 'node:fs';
import path from 'node:path';

const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const login = (s) => /^[a-z0-9_]{1,25}$/.test(s) && s !== '__proto__';

export function newPlayer() {
  return { balance: 0, liters: 0, weight: 0, hits: 0, survivals: 0, deaths: 0, cooldowns: {} };
}

function validate(data) {
  if (data?.version !== 1 || !data.players || typeof data.players !== 'object' || Array.isArray(data.players)) {
    throw new Error('Неверный формат игровых данных');
  }
  for (const [name, p] of Object.entries(data.players)) {
    if (!login(name) || !p || !['balance', 'liters', 'hits', 'survivals', 'deaths'].every((key) => integer(p[key])) ||
        (Object.hasOwn(p, 'weight') && !integer(p.weight)) ||
        !p.cooldowns || typeof p.cooldowns !== 'object' || Array.isArray(p.cooldowns) ||
        !Object.values(p.cooldowns).every(integer)) throw new Error('Повреждены игровые данные');
  }
  if (data.escrow !== null) {
    const e = data.escrow;
    if (!e || !login(e.initiator) || !login(e.recipient) || e.initiator === e.recipient ||
        !Object.hasOwn(data.players, e.initiator) || !Object.hasOwn(data.players, e.recipient) ||
        !integer(e.bet) || e.bet < 50) throw new Error('Повреждены данные дуэли');
  }
}

// Один файл на канал. Запись временного файла + rename исключает обрыв JSON.
// Изменения публикуются в памяти только после успешного сохранения.
export class FunStore {
  constructor(file) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { version: 1, players: {}, escrow: null };
    }
    validate(this.data);
    // Совместимость с сохранениями до появления веса.
    for (const p of Object.values(this.data.players)) if (!Object.hasOwn(p, 'weight')) p.weight = 0;
    // После перезапуска незавершённая дуэль отменяется, обе ставки возвращаются.
    if (this.data.escrow) {
      this.transact((data) => {
        const { initiator, recipient, bet } = data.escrow;
        data.players[initiator].balance += bet;
        data.players[recipient].balance += bet;
        data.escrow = null;
      });
    }
  }

  transact(update) {
    const next = structuredClone(this.data);
    const result = update(next);
    validate(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
    this.data = next;
    return result;
  }

  player(name) {
    return Object.hasOwn(this.data.players, name) ? this.data.players[name] : newPlayer();
  }
}
