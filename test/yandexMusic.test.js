import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYandexHelperOutput } from '../src/yandexMusic.js';

test('parseYandexHelperOutput: распознаёт играющий трек и очищает переносы', () => {
  const result = parseYandexHelperOutput(
    '{"status":"playing","artist":"babyteen,  Harle","title":"schizo\\n"}\n',
  );
  assert.deepEqual(result, { status: 'playing', artist: 'babyteen, Harle', title: 'schizo' });
});

test('parseYandexHelperOutput: распознаёт отсутствие воспроизведения', () => {
  assert.deepEqual(parseYandexHelperOutput('{"status":"idle"}\n'), { status: 'idle' });
});

test('parseYandexHelperOutput: отклоняет ошибку и повреждённый ответ', () => {
  assert.throws(() => parseYandexHelperOutput('{"status":"error","error":"YnisonError"}\n'), /YnisonError/);
  assert.throws(() => parseYandexHelperOutput('not json\n'), /некорректный JSON/);
  assert.throws(() => parseYandexHelperOutput(''), /пустой ответ/);
});
