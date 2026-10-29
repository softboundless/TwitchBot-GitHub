import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const secret = String(process.env.TRACK_BRIDGE_SECRET ?? '').trim();
const publicUrl = String(process.env.TRACK_BRIDGE_PUBLIC_URL ?? '').trim();

if (secret.length < 32) {
  console.error('TRACK_BRIDGE_SECRET должен содержать не менее 32 символов');
  process.exit(1);
}

let parsedUrl;
try {
  parsedUrl = new URL(publicUrl);
} catch {
  console.error('TRACK_BRIDGE_PUBLIC_URL должен быть корректным URL');
  process.exit(1);
}
if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password ||
    parsedUrl.pathname !== '/api/track' || parsedUrl.search || parsedUrl.hash) {
  console.error('TRACK_BRIDGE_PUBLIC_URL должен иметь вид https://ваш-домен/api/track без логина, пароля и параметров');
  process.exit(1);
}

const templatePath = path.join(rootDir, 'browser', 'yandex-track-bridge.user.js.template');
const outputDir = path.join(rootDir, 'private');
const outputPath = path.join(outputDir, 'yandex-track-bridge.private.user.js');
const template = await fs.readFile(templatePath, 'utf8');
const rendered = template
  .replace('__TRACK_BRIDGE_HOST__', parsedUrl.hostname)
  .replace('__TRACK_BRIDGE_URL_JSON__', JSON.stringify(publicUrl))
  .replace('__TRACK_BRIDGE_SECRET_JSON__', JSON.stringify(secret));

await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
await fs.writeFile(outputPath, rendered, { encoding: 'utf8', mode: 0o600 });
console.log(outputPath);
