import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 64 * 1024;

function cleanText(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseYandexHelperOutput(stdout) {
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error('Ynison helper вернул пустой ответ');

  let result;
  try {
    result = JSON.parse(lines.at(-1));
  } catch {
    throw new Error('Ynison helper вернул некорректный JSON');
  }

  if (result?.status === 'idle') return { status: 'idle' };
  if (result?.status === 'playing') {
    const artist = cleanText(result.artist);
    const title = cleanText(result.title);
    if (!title) throw new Error('Ynison helper не вернул название трека');
    return {
      status: 'playing',
      artist: artist || 'Неизвестный исполнитель',
      title,
    };
  }

  const reason = cleanText(result?.error) || 'неизвестная ошибка Ynison helper';
  throw new Error(reason);
}

export class YandexMusic {
  constructor({ token, pythonPath, scriptPath, timeoutMs = 20_000, spawnProcess = spawn }) {
    this.token = String(token ?? '').trim();
    this.pythonPath = pythonPath;
    this.scriptPath = scriptPath;
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
  }

  get isConfigured() {
    return Boolean(this.token);
  }

  async getCurrentTrack() {
    if (!this.isConfigured) throw new Error('YANDEX_MUSIC_TOKEN не задан');

    return new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.YANDEX_MUSIC_TOKEN;

      const child = this.spawnProcess(this.pythonPath, [this.scriptPath], {
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };

      const appendLimited = (current, chunk) => {
        const next = current + chunk.toString('utf8');
        return next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next;
      };

      child.stdout.on('data', (chunk) => {
        stdout = appendLimited(stdout, chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr = appendLimited(stderr, chunk);
      });
      child.once('error', (error) => finish(new Error(`не удалось запустить Ynison helper: ${error.message}`)));
      child.once('close', (code, signal) => {
        if (code !== 0) {
          const detail = cleanText(stderr) || `код ${code ?? 'null'}, сигнал ${signal ?? 'нет'}`;
          return finish(new Error(`Ynison helper завершился с ошибкой: ${detail}`));
        }
        try {
          finish(null, parseYandexHelperOutput(stdout));
        } catch (error) {
          finish(error);
        }
      });

      const timer = setTimeout(() => {
        child.kill();
        finish(new Error(`Ynison helper не ответил за ${this.timeoutMs} мс`));
      }, this.timeoutMs);

      child.stdin.end(`${this.token}\n`);
    });
  }
}
