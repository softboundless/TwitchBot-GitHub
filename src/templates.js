import fs from 'node:fs';

// Шаблоны прогнозов: { name, title, outcomes: string[], window: seconds }.
// name — имя шаблона, title — название прогноза (у старых шаблонов name отсутствует,
// тогда имя шаблона = title). Хранятся в templates.json, ключ — имя шаблона строчными.
export class Templates {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.map = new Map(Object.entries(j));
    } catch {
      this.map = new Map();
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2) + '\n');
  }

  get(name) {
    return this.map.get(name.toLowerCase()) ?? null;
  }

  set(name, tpl) {
    this.map.set(name.toLowerCase(), tpl);
    this.save();
  }

  delete(name) {
    const ok = this.map.delete(name.toLowerCase());
    if (ok) this.save();
    return ok;
  }

  names() {
    return [...this.map.values()].map((t) => t.name ?? t.title);
  }

  list() {
    return [...this.map.values()];
  }
}
