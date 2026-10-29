import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const strict = process.argv.includes('--strict');
const ignoredDirs = new Set(['.git', 'node_modules']);
const privateDirs = new Set(['tokens', 'data', 'private', 'artifacts', '.venv-ynison', '.venv', '__pycache__']);
function privateFile(name) {
  const parts = name.replaceAll('\\', '/').split('/');
  const base = parts.at(-1);
  return parts.some(p => privateDirs.has(p)) ||
    (base === '.env' || base.startsWith('.env.')) && base !== '.env.example' ||
    /\.(?:pem|key|p12|pfx|log|zip|bak)$/i.test(base) || /\.private\.user\.js$/.test(base) ||
    ['templates.json', 'gameTemplates.json'].includes(base);
}
function walk(dir, prefix = '') {
  const names = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (ignoredDirs.has(entry.name)) continue;
    if (entry.isSymbolicLink()) { names.push(name); continue; }
    if (entry.isDirectory()) {
      if (!strict && privateDirs.has(entry.name)) continue;
      names.push(...walk(path.join(dir, entry.name), name + '/'));
    } else if (strict || !privateFile(name)) names.push(name);
  }
  return names;
}

let files;
// Проверяем отслеживаемые Git файлы, в том числе случайно добавленные секреты.
try {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (path.resolve(top).toLowerCase() === path.resolve(root).toLowerCase()) {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    files = [...new Set([...tracked, ...walk(root)])];
  }
} catch {}
files ??= walk(root);
const problems = [];
for (const file of files) {
  if (privateFile(file)) { problems.push(`${file}: приватный или созданный при работе файл`); continue; }
  const filename = path.join(root, file);
  if (!fs.existsSync(filename)) continue;
  if (fs.lstatSync(filename).isSymbolicLink()) { problems.push(`${file}: символическая ссылка`); continue; }
  const text = fs.readFileSync(filename, 'utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) problems.push(`${file}: приватный ключ`);
  if (/\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}|gsk_[a-zA-Z0-9]{30,})\b/.test(text)) problems.push(`${file}: похоже на API-токен`);
}
if (problems.length) {
  console.error('Проверка публикации не пройдена:\n' + problems.map(p => `- ${p}`).join('\n'));
  process.exitCode = 1;
} else console.log(`Проверено ${files.length} файлов: приватные файлы и известные форматы секретов не найдены${strict ? ' (строгая проверка архива)' : ''}. Это не заменяет просмотр git diff --cached перед публикацией.`);
