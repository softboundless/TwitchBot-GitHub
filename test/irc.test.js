import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwitchChat } from '../src/irc.js';

test('TwitchChat помечает входящее сообщение каналом и отвечает в тот же канал', () => {
  const chat = new TwitchChat({
    channels: ['cacto0o', 'tiltocacto0o'],
    tokenStore: { login: 'PeeacefullBot' },
  });
  let message;
  chat.on('chat', (value) => {
    message = value;
  });

  chat.handleLine(
    '@badges=broadcaster/1;display-name=Tilto;id=message-1;mod=0 :tiltocacto0o!user@host PRIVMSG #tiltocacto0o :!команды',
  );

  assert.equal(message.channel, 'tiltocacto0o');
  assert.equal(message.login, 'tiltocacto0o');
  assert.equal(message.isBroadcaster, true);

  const sent = [];
  chat.ws = { readyState: WebSocket.OPEN, send: (line) => sent.push(line) };
  chat.say('Ответ', { channel: message.channel, replyTo: message.id });
  assert.deepEqual(sent, ['@reply-parent-msg-id=message-1 PRIVMSG #tiltocacto0o :Ответ']);
});

test('TwitchChat не передаёт обработчикам сообщения из неподключённого канала', () => {
  const chat = new TwitchChat({ channels: ['cacto0o', 'tiltocacto0o'], tokenStore: { login: 'PeeacefullBot' } });
  let calls = 0;
  chat.on('chat', () => calls++);

  chat.handleLine(':viewer!user@host PRIVMSG #otherchannel :!команды');

  assert.equal(calls, 0);
});
