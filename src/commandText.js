// Невидимый хвост сообщения не является аргументом команды.
// Не удаляем символы внутри текста: ZWJ/ZWNJ нужны языкам и составным emoji.
export function normalizeCommandText(text) {
  return String(text ?? '').replace(/[\s\u034f\u200b\u2060\u2063\u2800\ufeff]+$/u, '').trimStart();
}
