import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTarotClient as createTarot, TarotError } from '../src/tarot.js';

test('диагностика пустого ответа сохраняет токены и причину, но не содержимое', async () => {
  const logs = [];
  const tarot = createTarot({ apiKey: 'test-secret' }, async () => ({
    ok: true, status: 200,
    headers: { get: (name) => name === 'x-ratelimit-remaining-requests' ? '999' : null },
    json: async () => ({
      model: 'vendor/model:free',
      choices: [{ finish_reason: 'length', message: { content: null, reasoning: 'PRIVATE_REASONING' } }],
      usage: { prompt_tokens: 40, completion_tokens: 512, total_tokens: 552,
        completion_tokens_details: { reasoning_tokens: 512 }, secret: 'test-secret' },
    }),
  }), () => 1000, (line) => logs.push(line));
  await assert.rejects(tarot('PRIVATE_QUESTION'), /не вернула текст/);
  assert.equal(logs.length, 1);
  const record = JSON.parse(logs[0].slice('[tarot] '.length));
  assert.equal(record.outcome, 'empty_content');
  assert.equal(record.finish_reason, 'length');
  assert.equal(record.reasoning_tokens, 512);
  assert.equal(record.has_reasoning, true);
  assert.equal(record.has_text, false);
  assert.equal(record.rate_remaining_requests, 999);
  assert.equal(record.rate_remaining_tokens, null);
  assert.equal(record.response_model, 'vendor/model:free');
  assert.doesNotMatch(logs[0], /PRIVATE_|test-secret/);
});

test('диагностика успешного ответа и HTTP ошибки не раскрывает текст', async () => {
  const logs = [];
  let calls = 0;
  const tarot = createTarot({ apiKey: 'test-secret' }, async () => ++calls === 1 ? {
    ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'PRIVATE_ANSWER' } }] }),
  } : { ok: false, status: 503 }, Date.now, (line) => logs.push(line));
  assert.equal(await tarot('PRIVATE_QUESTION'), 'PRIVATE_ANSWER');
  await assert.rejects(tarot('PRIVATE_QUESTION'), /недоступна/);
  const records = logs.map((line) => JSON.parse(line.slice('[tarot] '.length)));
  assert.equal(records[0].outcome, 'success');
  assert.equal(records[0].text_chars, 14);
  assert.equal(records[1].outcome, 'api_error');
  assert.equal(records[1].http_status, 503);
  assert.doesNotMatch(logs.join(''), /PRIVATE_|test-secret/);
});

test('сбой логирования не ломает ответы и освобождает блокировку', async () => {
  const tarot = createTarot({ apiKey: 'fake' }, async () => ({ ok: true,
    json: async () => ({ choices: [{ message: { content: 'Ответ' } }] }),
  }), Date.now, () => { throw new Error('logger unavailable'); });
  assert.equal(await tarot('вопрос'), 'Ответ');
  assert.equal(await tarot('снова'), 'Ответ');
});

test('расклад без ключа не вызывает API', async () => {
  for (const options of [{}, { apiKey: ' ' }, { model: 'openai/gpt-oss-20b' }]) {
    const tarot = createTarot(options, () => assert.fail('API не должен вызываться'));
    await assert.rejects(tarot('вопрос'), /GROQCLOUD_API_KEY/);
  }
});

test('расклад использует Groq Cloud без параметров OpenRouter', async () => {
  const tarot = createTarot({ apiKey: 'test-secret' }, async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'openai/gpt-oss-20b');
    assert.deepEqual(body.messages[1], { role: 'user', content: 'вопрос' });
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.stream, false);
    assert.equal(body.max_completion_tokens, 2048);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.include_reasoning, false);
    assert.equal(body.provider, undefined);
    assert.equal(body.models, undefined); // Нет списка платных резервных моделей.
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return { ok: true, json: async () => ({ choices: [{ message: { content: ' Карты говорят да. ' } }] }) };
  });
  assert.equal(await tarot('вопрос'), 'Карты говорят да.');
});

test('HTTP и сетевые ошибки не раскрывают секреты; занятость освобождается после ошибки', async () => {
  let calls = 0;
  const tarot = createTarot({ apiKey: 'test-secret' }, async () => {
    if (++calls === 1) return { ok: false, status: 401, json: async () => ({ secret: 'test-secret' }) };
    throw new Error('Network error test-secret');
  });
  await assert.rejects(tarot('вопрос'), /Неверный ключ Groq Cloud/);
  await assert.rejects(tarot('вопрос'), { message: 'Не удалось получить расклад от Groq Cloud' });
});

test('общий ограничитель не допускает параллельных API-запросов', async () => {
  let finish;
  const tarot = createTarot({ apiKey: 'fake' }, () => new Promise((resolve) => { finish = resolve; }));
  const first = tarot('раз');
  await assert.rejects(tarot('два'), /ещё готовится/);
  finish({ ok: true, json: async () => ({ output: [] }) });
  await assert.rejects(first, /не вернула текст/);
});

test('пустая модель выбирает GPT OSS, явно заданная модель сохраняется', async () => {
  for (const model of ['', '  ', 'vendor/model:free']) {
    const tarot = createTarot({ apiKey: 'fake', model }, async (_, options) => {
      assert.equal(JSON.parse(options.body).model, model.trim() || 'openai/gpt-oss-20b');
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Ответ' } }] }) };
    });
    assert.equal(await tarot('вопрос'), 'Ответ');
  }
});

test('429 включает общую паузу и учитывает Retry-After без автоповторов', async () => {
  for (const header of ['120', 'Thu, 01 Jan 1970 00:02:00 GMT', 'bad', null]) {
    let clock = 0, calls = 0;
    const tarot = createTarot({ apiKey: 'fake' }, async () => {
      calls++;
      return { ok: false, status: 429, headers: { get: () => header } };
    }, () => clock);
    await assert.rejects(tarot('вопрос'), /Лимит Groq Cloud/);
    clock = 59_000;
    await assert.rejects(tarot('снова'), /подождите/);
    assert.equal(calls, 1);
    clock = header === 'bad' || header === null ? 60_000 : 120_000;
    await assert.rejects(tarot('снова'), /Лимит Groq Cloud/);
    assert.equal(calls, 2);
  }
});

test('HTTP-ошибки и ошибки внутри HTTP 200 не вызывают повторный запрос', async () => {
  for (const status of [400, 401, 402, 403, 404, 429, 500, 502, 503]) {
    for (const ok of [false, true]) {
      let calls = 0;
      const tarot = createTarot({ apiKey: 'fake' }, async () => {
        calls++;
        return { ok, status, json: async () => ({ error: { code: status, message: 'SECRET' } }) };
      });
      await assert.rejects(tarot('вопрос'), (error) => error instanceof TarotError && !error.message.includes('SECRET'));
      assert.equal(calls, 1);
    }
  }
});

test('таймаут, повреждённый JSON, пустой ответ и отказ дают безопасную ошибку', async () => {
  const cases = [
    { json: async () => { throw new SyntaxError('SECRET'); }, expected: /Не удалось/ },
    { json: async () => null, expected: /не вернула текст/ },
    { json: async () => ({ choices: [{ message: { content: null, refusal: 'SECRET' } }] }), expected: /отказалась/ },
    { json: async () => ({ choices: [{ message: { content: {} } }] }), expected: /не вернула текст/ },
    { json: async () => ({ choices: [{ finish_reason: 'error', error: { code: 503 }, message: { content: 'partial' } }] }), expected: /недоступна/ },
  ];
  for (const item of cases) {
    const tarot = createTarot({ apiKey: 'fake' }, async () => ({ ok: true, json: item.json }));
    await assert.rejects(tarot('вопрос'), item.expected);
  }
  for (const name of ['TimeoutError', 'AbortError']) {
    const tarot = createTarot({ apiKey: 'fake' }, async () => { throw Object.assign(new Error('SECRET'), { name }); });
    await assert.rejects(tarot('вопрос'), /Истекло время/);
  }
});
