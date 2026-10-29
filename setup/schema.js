import { parseEnv } from 'node:util';
import { FUN_USAGE } from '../src/funCommands.js';

const field = (key, label, group, type, value, help = '', extra = {}) =>
  ({ key, label, group, type, default: value, help, ...extra });
export const fields = [
  field('TWITCH_CLIENT_ID', 'Client ID приложения Twitch', 'twitch', 'text', '', 'Из консоли dev.twitch.tv/console/apps. Это приложение, а не логин бота.'),
  field('TWITCH_CLIENT_SECRET', 'Client Secret приложения Twitch', 'twitch', 'password', '', 'Секрет приложения. После сохранения значение скрывается.'),
  field('TWITCH_CHANNELS', 'Каналы Twitch', 'twitch', 'text', '', 'Логины через запятую, без ссылок. Первый канал — основной; порядок сохраняет привязку owner.json.'),
  field('ALLOW_CHANNEL_MODERATORS', 'Доступ модераторов канала', 'twitch', 'boolean', 'true', 'Владелец всегда имеет доступ. Модераторы определяются по бейджу текущего чата.'),
  field('MODS', 'Дополнительные администраторы', 'twitch', 'text', '', 'Необязательно. Логины через запятую: доступ во всех каналах без отдельного переопределения.'),
  field('POLL_DEFAULT_SECONDS', 'Длительность опроса, секунд', 'twitch', 'number', '120', '', { min: 15, max: 1800 }),
  field('PRED_DEFAULT_SECONDS', 'Длительность прогноза, секунд', 'twitch', 'number', '60', '', { min: 30, max: 1800 }),
  field('GAMES_ENABLED', 'Игровые команды', 'games', 'boolean', 'true', 'Общий переключатель всех игр.'),
  field('GAMES_CHANNELS', 'Каналы с играми', 'games', 'text', '', 'Пусто — все настроенные каналы.'),
  field('GAMES_DEFAULT_MODE', 'Начальный доступ к играм', 'games', 'select', 'off', 'Для новых данных. После запуска режим сохраняется командами !вкл, !выкл, !выклвип.', { options: [{ value: 'off', label: 'Владелец и модераторы' }, { value: 'on', label: 'Все зрители' }, { value: 'vip', label: 'Временные VIP и модераторы' }] }),
  field('FUN_COMMANDS_URL', 'Ссылка на описание игр', 'games', 'text', '', 'Необязательно. Ссылка для !инфо и напоминания раз в 30 минут в режиме для всех.'),
  field('GROQCLOUD_API_KEY', 'API-ключ Groq', 'games', 'password', '', 'Только для !расклад. Остальные игры работают без ключа.'),
  field('GROQCLOUD_MODEL', 'Модель Groq', 'games', 'text', 'openai/gpt-oss-20b', 'Идентификатор модели из вашего аккаунта Groq.'),
  field('AUTO_PIN', 'Автоматический закреп', 'pin', 'boolean', 'false', 'Проверка при запуске и смене состояния стрима. Текст задаётся ниже для каждого канала.'),
  field('AUTO_PIN_CHANNELS', 'Каналы с автозакрепом', 'pin', 'text', '', 'Пусто — все настроенные каналы.'),
  field('AUTO_PIN_MESSAGE', 'Общий текст закрепа', 'pin', 'text', '', 'Используется, если у канала нет отдельного текста.'),
  field('AUTO_PIN_OFFLINE_DELAY_MS', 'Пауза после конца стрима, мс', 'pin', 'number', '3000', '', { min: 0, max: 60000 }),
  field('AUTO_UNBAN', 'Автоматический разбан', 'unban', 'boolean', 'false', 'Включайте только для нужного аккаунта и каналов.'),
  field('AUTO_UNBAN_CHANNELS', 'Каналы с авторазбаном', 'unban', 'text', '', 'Пусто — только первый канал.'),
  field('AUTO_UNBAN_TARGET', 'Кого разбанивать', 'unban', 'text', '', 'Логин Twitch.'),
  field('AUTO_UNBAN_ONLYFROM', 'После каких модераторов', 'unban', 'text', '', 'Логины через запятую. Пусто — после любого модератора.'),
  field('AUTO_UNBAN_ON_START', 'Разбан при запуске', 'unban', 'boolean', 'false', 'При запуске автор исходного бана не проверяется.'),
  field('AUTO_UNBAN_INTERVAL', 'Интервал проверки связи, секунд', 'unban', 'number', '1', '', { min: 1, max: 3600 }),
  field('AUTO_UNBAN_MAX_PER_MINUTE', 'Максимум разбанов за минуту', 'unban', 'number', '100', '', { min: 1, max: 100 }),
  field('MUSIC_ENABLED', 'Музыка и команда !трек', 'music', 'boolean', 'false', 'Выключено — музыкальные подключения не запускаются, !трек игнорируется.'),
  field('MUSIC_CHANNELS', 'Каналы с !трек', 'music', 'text', '', 'Пусто — все настроенные каналы. Команда доступна зрителям.'),
  field('YANDEX_MUSIC_TOKEN', 'OAuth-токен Яндекс Музыки', 'music', 'password', '', 'Для определения трека через Python. Для браузерного моста необязателен.'),
  field('YANDEX_MUSIC_PYTHON', 'Путь к Python', 'music', 'text', '', 'Пусто — .venv-ynison в папке бота. Требуется только для варианта с токеном Яндекса.'),
  field('TRACK_COOLDOWN_MS', 'Пауза между !трек, мс', 'music', 'number', '5000', '', { min: 0, max: 3600000 }),
  field('TRACK_BRIDGE_SECRET', 'Секрет браузерного моста', 'music', 'password', '', 'Для моста задайте случайную строку длиной от 32 символов.'),
  field('TRACK_BRIDGE_HOST', 'Адрес браузерного моста', 'music', 'text', '127.0.0.1', 'На VPS обычно оставьте 127.0.0.1 и используйте HTTPS reverse proxy.'),
  field('TRACK_BRIDGE_PORT', 'Порт браузерного моста', 'music', 'number', '8787', '', { min: 1024, max: 65535 }),
  field('TRACK_BRIDGE_MAX_AGE_MS', 'Актуальность трека, мс', 'music', 'number', '15000', '', { min: 5000, max: 3600000 }),
  field('TRACK_BRIDGE_PUBLIC_URL', 'HTTPS-адрес /api/track', 'music', 'text', '', 'Для создания userscript: https://ваш-домен/api/track. Не нужен в варианте без музыки.'),
  field('FOSSABOT_TRACK_API_ENABLED', 'Резервная интеграция Fossabot', 'music', 'boolean', 'false', 'Дополнительная интеграция; требует настроенного моста.'),
  field('FOSSABOT_TRACK_CHANNELS', 'Каналы Fossabot', 'music', 'text', '', 'Пусто — все каналы, в которых разрешена музыка.'),
  field('FOSSABOT_API_TIMEOUT_MS', 'Тайм-аут Fossabot, мс', 'music', 'number', '5000', '', { min: 1000, max: 60000 }),
];

const core = {
  '!poll': 'Создать опрос', '!endpoll': 'Закончить опрос', '!pred': 'Создать прогноз',
  '!+pred': 'Сохранить шаблон прогноза', '!-pred': 'Удалить шаблон прогноза',
  '!predwin': 'Выбрать победивший исход', '!predstop': 'Закрыть приём ставок', '!predcancel': 'Отменить прогноз',
  '!g': 'Сменить категорию стрима', '!+g': 'Сохранить шаблон категории', '!-g': 'Удалить шаблон категории',
  '!шаблоны': 'Показать шаблоны', '!скок': 'Калькулятор', '!трек': 'Текущий трек', '!пинг': 'Проверка ответа бота',
  '!откл': 'Отключить команду через чат',
};
const funLabels = {
  '!кд': 'Общая задержка игр', '!вкл': 'Игры для всех / включить команду', '!выкл': 'Игры только для модераторов', '!выклвип': 'Игры для временных VIP',
  '!добавить': 'Добавить временного VIP', '!удалить': 'Удалить временного VIP', '!дуэль': 'Дуэль на баланс', '!принять': 'Принять дуэль',
  '!кредит': 'Получить игровые монеты', '!бал': 'Баланс', '!балтоп': 'Топ баланса', '!каз': 'Казино', '!кража': 'Украсть монеты', '!додеп': 'Пополнить игровой баланс', '!сбп': 'Перевести монеты',
  '!рулетка': 'Рулетка', '!стат': 'Статистика рулетки', '!пиво': 'Выпить пиво', '!литры': 'Количество литров', '!топпиво': 'Топ по пиву',
  '!жрать': 'Поесть', '!вес': 'Вес', '!вестоп': 'Топ веса', '!топвес': 'Топ веса (синоним)', '!пивостатус': 'Пивной статус', '!пиворулетка': 'Пивная рулетка',
  '!кальян': 'Покурить кальян', '!тяги': 'Количество тяг', '!топтяги': 'Топ тяг', '!инфо': 'Справка об играх', '!шип': 'Случайная пара', '!совместимость': 'Совместимость',
  '!iq': 'Случайный IQ', '!я': 'Шуточное описание', '!кликуха': 'Случайная кличка', '!шар': 'Ответ на вопрос', '!расклад': 'Расклад через Groq', '!поцеловать': 'Поцеловать пользователя',
};
export const commands = [
  ...Object.entries(core).map(([name, description]) => ({ name, description, group: name === '!трек' ? 'music' : 'core' })),
  ...Object.entries(FUN_USAGE).map(([name, usage]) => ({ name, description: funLabels[name] || usage || name, group: 'games' })),
];
export const defaults = Object.fromEntries(fields.map(f => [f.key, f.default]));
export const secretKeys = fields.filter(f => f.type === 'password').map(f => f.key);
export const channelSuffix = channel => channel.toUpperCase();
export function channelList(value) {
  return [...new Set(String(value || '').split(',').map(s => s.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
}
export function dynamicKeys(values) {
  return channelList(values.TWITCH_CHANNELS).flatMap(c => ['MODS_', 'AUTO_PIN_MESSAGE_', 'DISABLED_COMMANDS_'].map(p => p + channelSuffix(c)));
}

export function validateValues(values) {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value) || value.length > 8000) throw new Error(`Недопустимое значение ${key}: нужна одна строка.`);
  }
  for (const f of fields) {
    const value = values[f.key] ?? f.default;
    if (f.type === 'boolean' && !['true', 'false'].includes(value)) throw new Error(`${f.label}: выберите включено или выключено.`);
    if (f.type === 'select' && !f.options.some(o => o.value === value)) throw new Error(`${f.label}: неизвестный вариант.`);
    if (f.type === 'number' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < f.min || Number(value) > f.max)) throw new Error(`${f.label}: число от ${f.min} до ${f.max}.`);
  }
  if (!values.TWITCH_CLIENT_ID?.trim() || !values.TWITCH_CLIENT_SECRET?.trim()) throw new Error('Заполните Client ID и Client Secret приложения Twitch.');
  const channels = channelList(values.TWITCH_CHANNELS);
  if (!channels.length) throw new Error('Укажите хотя бы один канал Twitch.');
  const loginFields = ['TWITCH_CHANNELS', 'MODS', 'GAMES_CHANNELS', 'MUSIC_CHANNELS', 'AUTO_PIN_CHANNELS', 'AUTO_UNBAN_CHANNELS', 'AUTO_UNBAN_TARGET', 'AUTO_UNBAN_ONLYFROM', 'FOSSABOT_TRACK_CHANNELS', ...Object.keys(values).filter(k => k.startsWith('MODS_'))];
  for (const key of loginFields) {
    const list = channelList(values[key]);
    if (list.some(c => !/^[a-z0-9_]{1,25}$/.test(c) || c === '__proto__')) throw new Error(`${key}: нужны логины Twitch через запятую, без ссылок.`);
    if (key.endsWith('_CHANNELS') && key !== 'TWITCH_CHANNELS' && list.some(c => !channels.includes(c))) throw new Error(`${key}: сначала добавьте эти каналы в основной список.`);
    if (key === 'AUTO_UNBAN_TARGET' && list.length > 1) throw new Error('Для авторазбана нужен один логин.');
    if (Object.hasOwn(values, key)) values[key] = list.join(',');
  }
  const known = new Set(commands.map(c => c.name));
  for (const key of Object.keys(values).filter(k => k === 'DISABLED_COMMANDS' || k.startsWith('DISABLED_COMMANDS_'))) {
    const list = [...new Set(values[key].split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
    if (list.some(c => !known.has(c))) throw new Error(`${key}: найдена неизвестная команда.`);
    values[key] = list.join(',');
  }
  if (values.AUTO_UNBAN === 'true' && !values.AUTO_UNBAN_TARGET) throw new Error('Укажите логин для авторазбана.');
  if (values.AUTO_PIN === 'true') {
    for (const c of channelList(values.AUTO_PIN_CHANNELS || values.TWITCH_CHANNELS)) {
      if (!(values['AUTO_PIN_MESSAGE_' + channelSuffix(c)] ?? values.AUTO_PIN_MESSAGE)?.trim()) throw new Error(`Укажите текст закрепа для ${c}.`);
    }
  }
  for (const key of ['FUN_COMMANDS_URL', 'TRACK_BRIDGE_PUBLIC_URL']) {
    if (!values[key]) continue;
    let url; try { url = new URL(values[key]); } catch { throw new Error(`${key}: нужен полный HTTP(S)-адрес.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${key}: нужен HTTP(S)-адрес без пароля.`);
    if (key === 'TRACK_BRIDGE_PUBLIC_URL' && (url.protocol !== 'https:' || url.pathname !== '/api/track' || url.search || url.hash)) throw new Error('TRACK_BRIDGE_PUBLIC_URL: используйте https://ваш-домен/api/track без параметров.');
  }
  if (values.TRACK_BRIDGE_SECRET && values.TRACK_BRIDGE_SECRET.length < 32) throw new Error('Секрет браузерного моста должен содержать минимум 32 символа.');
  return values;
}

export function serializeEnv(values) {
  const lines = ['# Настройки Twitch Bot. Этот файл содержит секреты: не публикуйте его.', '# Изменения применяются после перезапуска бота.', ''];
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\x00]/.test(value)) throw new Error(`Невозможно сохранить ${key}.`);
    const quote = ['"', "'", '`'].find(q => !value.includes(q));
    if (!quote) throw new Error(`${key}: нельзя одновременно использовать все три вида кавычек.`);
    const line = `${key}=${quote}${value}${quote}`;
    if (parseEnv(line)[key] !== value) throw new Error(`Не удалось безопасно сохранить ${key}.`);
    lines.push(line);
  }
  return lines.join('\n') + '\n';
}
