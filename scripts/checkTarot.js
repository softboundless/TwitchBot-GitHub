// Один запрос к Groq Cloud. Не запускает бота и не отправляет сообщения в Twitch.
import { createTarot, TarotError } from '../src/tarot.js';
const tarot = createTarot({ apiKey: process.env.GROQCLOUD_API_KEY, model: process.env.GROQCLOUD_MODEL });
try {
  await tarot('Как пройдёт сегодняшний игровой стрим?');
  console.log('TAROT_OK: Groq Cloud returned text');
} catch (error) {
  console.error('TAROT_ERROR: ' + (error instanceof TarotError ? error.message : 'Internal check error'));
  process.exitCode = 1;
}
