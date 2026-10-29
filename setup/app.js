'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('settings-form');
  const groupTitles = { core: 'Основные команды', moderation: 'Модерация и управление', games: 'Игровые команды', fun: 'Игровые команды', music: 'Музыка', utility: 'Полезное', admin: 'Управление играми', control: 'Управление командами' };
  let config;
  let values = {};
  let secretsSet = new Set();
  let clearSecrets = new Set();
  let deletedKeys = new Set();
  let chatDisabledCommands = new Map();
  let enableChatCommands = new Map();
  let dirty = false;
  let saving = false;
  let channelTimer;

  function el(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function status(message, kind = '') {
    const notice = $('notice');
    notice.textContent = message;
    notice.className = `notice ${kind}`;
    notice.hidden = !message;
  }

  function changed(key, value) {
    values[key] = String(value);
    deletedKeys.delete(key);
    dirty = true;
    $('save-heading').textContent = 'Есть несохранённые изменения';
    $('save-detail').textContent = 'Сохраните настройки, затем перезапустите бота.';
    if (key === 'MUSIC_ENABLED') updateMusic();
    if (key === 'TWITCH_CHANNELS' || key === 'TWITCH_CHANNEL') {
      clearTimeout(channelTimer);
      channelTimer = setTimeout(() => { renderScopes(); renderChannels(); }, 350);
    }
    if (key === 'GAMES_ENABLED' || key === 'GAMES_CHANNELS' || key === 'MUSIC_CHANNELS') renderCommands();
  }

  function channels() {
    return [...new Set(String(values.TWITCH_CHANNELS || values.TWITCH_CHANNEL || '')
      .toLowerCase().split(',').map((channel) => channel.trim().replace(/^#/, '')).filter((channel) => /^[a-z0-9_]{1,25}$/.test(channel)))];
  }

  function suffix(channel) { return channel.toUpperCase(); }
  function commandKey(channel = $('command-scope').value) { return channel ? `DISABLED_COMMANDS_${suffix(channel)}` : 'DISABLED_COMMANDS'; }
  function disabled(key) { return new Set(String(values[key] || '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)); }
  function chatDisabled(command, channel) {
    return Boolean(channel && chatDisabledCommands.get(channel)?.has(command) && !enableChatCommands.get(channel)?.has(command));
  }
  function setChatEnabled(command, channel, enabled) {
    if (!channel) return;
    if (enabled && chatDisabledCommands.get(channel)?.has(command)) {
      if (!enableChatCommands.has(channel)) enableChatCommands.set(channel, new Set());
      enableChatCommands.get(channel).add(command);
    } else {
      enableChatCommands.get(channel)?.delete(command);
    }
  }
  function isDynamic(key) { return /^(DISABLED_COMMANDS_|MODS_|AUTO_PIN_MESSAGE_)/.test(key); }

  function fieldGroup(field) {
    if (['AUTO_PIN_OFFLINE_DELAY_MS', 'AUTO_UNBAN_INTERVAL', 'AUTO_UNBAN_MAX_PER_MINUTE', 'TRACK_BRIDGE_HOST', 'TRACK_BRIDGE_PORT', 'TRACK_BRIDGE_MAX_AGE_MS', 'FOSSABOT_API_TIMEOUT_MS'].includes(field.key)) return 'advanced';
    const group = String(field.group || '').toLowerCase();
    if (['twitch', 'games', 'pin', 'unban', 'music', 'advanced'].includes(group)) return group;
    if (/twitch|подключ|основн/.test(group)) return 'twitch';
    if (/games|игр|доступ/.test(group)) return 'games';
    if (/unban|разбан/.test(group)) return 'unban';
    if (/pin|закреп/.test(group)) return 'pin';
    if (/music|музык/.test(group)) return 'music';
    return 'advanced';
  }

  function makeField(field) {
    const id = `setting-${field.key}`;
    const val = values[field.key] ?? field.default ?? '';
    const wrapper = el('div', 'field');
    const label = el('label', 'field-label', field.label || field.key);
    label.htmlFor = id;
    const help = field.help ? el('small', 'field-help', field.help) : null;
    if (help) help.id = `${id}-help`;
    const variable = el('span', 'field-key', field.key);
    let input;
    if (field.type === 'select') {
      input = el('select');
      for (const item of field.options || []) {
        const option = el('option', '', typeof item === 'string' ? item : item.label);
        option.value = typeof item === 'string' ? item : item.value;
        input.append(option);
      }
      input.value = String(val);
    } else {
      input = el('input');
      input.type = field.type === 'boolean' ? 'checkbox' : ['password', 'number'].includes(field.type) ? field.type : 'text';
      if (field.type === 'boolean') {
        input.className = 'switch';
        input.setAttribute('role', 'switch');
        input.checked = String(val) === 'true';
      } else if (field.type === 'password') {
        input.value = '';
        input.autocomplete = 'new-password';
        input.placeholder = secretsSet.has(field.key) ? 'Сохранено — оставьте пустым, чтобы не менять' : 'Введите значение';
        input.spellcheck = false;
      } else {
        input.value = String(val);
        if (field.min !== undefined) input.min = String(field.min);
        if (field.max !== undefined) input.max = String(field.max);
        if (field.type === 'number') input.step = '1';
        if (field.placeholder) input.placeholder = field.placeholder;
        else if (String(field.default || '')) input.placeholder = String(field.default);
        input.spellcheck = false;
      }
    }
    input.id = id;
    input.name = field.key;
    if (help) input.setAttribute('aria-describedby', help.id);
    input.addEventListener(field.type === 'select' || field.type === 'boolean' ? 'change' : 'input', () => {
      changed(field.key, field.type === 'boolean' ? input.checked : input.value);
    });
    if (field.type === 'boolean') {
      wrapper.classList.add('toggle-field');
      const copy = el('div', 'toggle-copy');
      copy.append(label, variable);
      if (help) copy.append(help);
      wrapper.append(input, copy);
    } else {
      wrapper.append(label, variable, input);
      if (help) wrapper.append(help);
    }
    if (field.type === 'password' && secretsSet.has(field.key)) {
      const tools = el('div', 'secret-tools');
      tools.append(el('span', 'secret-status', 'Значение сохранено'));
      const clear = el('label', 'check-line');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) clearSecrets.add(field.key);
        else clearSecrets.delete(field.key);
        input.disabled = checkbox.checked;
        input.value = '';
        changed(field.key, '');
      });
      clear.append(checkbox, document.createTextNode('Удалить сохранённое'));
      tools.append(clear);
      wrapper.append(tools);
    }
    return wrapper;
  }

  function renderFields() {
    for (const name of ['twitch', 'games', 'pin', 'unban', 'music', 'advanced']) $('fields-' + name).replaceChildren();
    for (const field of config.fields) {
      if (['MUSIC_ENABLED', 'DISABLED_COMMANDS'].includes(field.key) || isDynamic(field.key)) continue;
      $('fields-' + fieldGroup(field)).append(makeField(field));
    }
    for (const name of ['twitch', 'games', 'pin', 'unban', 'music', 'advanced']) {
      const area = $('fields-' + name);
      if (!area.children.length) area.append(el('p', 'muted', 'Дополнительных параметров нет.'));
    }
  }

  function renderScopes() {
    const scope = $('command-scope');
    const selected = scope.value;
    scope.replaceChildren();
    const global = el('option', '', 'Все каналы');
    global.value = '';
    scope.append(global);
    for (const channel of channels()) {
      const option = el('option', '', `#${channel}`);
      option.value = channel;
      scope.append(option);
    }
    scope.value = channels().includes(selected) ? selected : '';
    renderCommands();
  }

  function lockReason(command, channel) {
    if (channel && disabled('DISABLED_COMMANDS').has(command.name)) return 'Отключено для всех';
    if (command.group === 'games' && command.name !== '!вкл') {
      if (values.GAMES_ENABLED === 'false') return 'Игры отключены';
      const allowed = String(values.GAMES_CHANNELS || '').toLowerCase().split(',').map((item) => item.trim().replace(/^#/, '')).filter(Boolean);
      if (channel && allowed.length && !allowed.includes(channel)) return 'Игры в другом канале';
    }
    if (command.name === '!трек') {
      if (values.MUSIC_ENABLED !== 'true') return 'Музыка отключена';
      const allowed = String(values.MUSIC_CHANNELS || '').toLowerCase().split(',').map((item) => item.trim().replace(/^#/, '')).filter(Boolean);
      if (channel && allowed.length && !allowed.includes(channel)) return 'Музыка в другом канале';
    }
    return '';
  }

  function visibleCommands() {
    const query = $('command-search').value.trim().toLowerCase();
    return config.commands.filter((command) => `${command.name} ${command.description}`.toLowerCase().includes(query));
  }

  function setCommands(enabled) {
    const key = commandKey();
    const blocked = disabled(key);
    const channel = $('command-scope').value;
    for (const command of visibleCommands()) {
      if (lockReason(command, channel)) continue;
      if (enabled) blocked.delete(command.name);
      else blocked.add(command.name);
      setChatEnabled(command.name, channel, enabled);
    }
    changed(key, [...blocked].join(','));
    renderCommands();
  }

  function renderCommands() {
    if (!config) return;
    const list = $('command-list');
    list.replaceChildren();
    const channel = $('command-scope').value;
    const blocked = disabled(commandKey(channel));
    const commands = visibleCommands();
    const grouped = new Map();
    for (const command of commands) {
      const group = command.group || 'Команды';
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group).push(command);
    }
    for (const [group, entries] of grouped) {
      list.append(el('h3', 'command-group-title', groupTitles[group] || group));
      for (const command of entries) {
        const reason = lockReason(command, channel);
        const chatBlocked = chatDisabled(command.name, channel);
        const hint = reason || (chatBlocked ? 'Отключено в чате' : enableChatCommands.get(channel)?.has(command.name) ? 'Включится после сохранения' : '');
        const row = el('label', `command-row${reason ? ' is-locked' : ''}`);
        const input = el('input', 'switch');
        input.type = 'checkbox';
        input.setAttribute('role', 'switch');
        input.setAttribute('aria-label', `${command.name} — ${command.description}`);
        input.checked = !blocked.has(command.name) && !reason && !chatBlocked;
        input.disabled = Boolean(reason);
        input.addEventListener('change', () => {
          const current = disabled(commandKey(channel));
          if (input.checked) current.delete(command.name);
          else current.add(command.name);
          setChatEnabled(command.name, channel, input.checked);
          changed(commandKey(channel), [...current].join(','));
          renderCommands();
          // Keep keyboard navigation on the switch after the list redraws.
          const next = [...list.querySelectorAll('input')].find((item) => item.getAttribute('aria-label') === input.getAttribute('aria-label'));
          next?.focus({ preventScroll: true });
        });
        const copy = el('span', 'command-copy');
        copy.append(el('code', '', command.name), el('span', 'command-description', command.description));
        row.append(input, copy);
        if (hint) row.append(el('span', 'command-reason', hint));
        list.append(row);
      }
    }
    if (!commands.length) list.append(el('p', 'empty-commands', 'Команды не найдены. Попробуйте другой запрос.'));
    const active = config.commands.filter((command) => !blocked.has(command.name) && !lockReason(command, channel) && !chatDisabled(command.name, channel)).length;
    $('command-count').textContent = `${active} из ${config.commands.length} включено`;
    $('command-hint').textContent = channel ? `Дополнительные ограничения для #${channel}` : 'Общие настройки для всех каналов';
    $('enable-visible').disabled = !commands.some((command) => !lockReason(command, channel));
    $('disable-visible').disabled = $('enable-visible').disabled;
  }

  function renderChannels() {
    $('channel-access').replaceChildren();
    $('channel-pins').replaceChildren();
    const list = channels();
    if (!list.length) {
      for (const id of ['channel-access', 'channel-pins']) $(id).append(el('p', 'muted', 'Добавьте каналы в разделе «Подключение», чтобы настроить их отдельно.'));
      return;
    }
    for (const channel of list) {
      const modsKey = `MODS_${suffix(channel)}`;
      const access = el('div', 'channel-card');
      const head = el('div', 'channel-card-head');
      head.append(el('span', 'channel-name', `#${channel}`));
      const override = el('label', 'check-line');
      const check = el('input');
      check.type = 'checkbox';
      check.setAttribute('aria-label', `Отдельный список администраторов для #${channel}`);
      check.checked = Object.hasOwn(values, modsKey) && !deletedKeys.has(modsKey);
      override.append(check, document.createTextNode('Отдельный список'));
      head.append(override);
      const field = makeField({ key: modsKey, label: `Администраторы #${channel}`, help: 'Логины через запятую. Пусто — без дополнительных администраторов.' });
      field.hidden = !check.checked;
      const inherit = el('p', 'muted', 'Используется общий список MODS и правила доступа модераторов.');
      inherit.hidden = check.checked;
      check.addEventListener('change', () => {
        field.hidden = !check.checked;
        inherit.hidden = check.checked;
        if (check.checked) changed(modsKey, field.querySelector('input').value);
        else {
          changed(modsKey, '');
          delete values[modsKey];
          deletedKeys.add(modsKey);
        }
      });
      access.append(head, field, inherit);
      $('channel-access').append(access);
      const pin = el('div', 'channel-card');
      const pinKey = `AUTO_PIN_MESSAGE_${suffix(channel)}`;
      const pinHead = el('div', 'channel-card-head');
      pinHead.append(el('span', 'channel-name', `#${channel}`));
      const pinOverride = el('label', 'check-line');
      const pinCheck = el('input');
      pinCheck.type = 'checkbox';
      pinCheck.setAttribute('aria-label', `Отдельный текст закрепа для #${channel}`);
      pinCheck.checked = Object.hasOwn(values, pinKey) && !deletedKeys.has(pinKey);
      pinOverride.append(pinCheck, document.createTextNode('Отдельный текст'));
      pinHead.append(pinOverride);
      const pinField = makeField({ key: pinKey, label: `Текст закрепа для #${channel}`, help: 'Введите сообщение для этого канала. Снимите «Отдельный текст», чтобы снова использовать общий текст закрепа.' });
      pinField.hidden = !pinCheck.checked;
      const commonPin = el('p', 'muted', 'Используется общий текст закрепа.');
      commonPin.hidden = pinCheck.checked;
      pinCheck.addEventListener('change', () => {
        pinField.hidden = !pinCheck.checked;
        commonPin.hidden = pinCheck.checked;
        if (pinCheck.checked) changed(pinKey, pinField.querySelector('input').value);
        else {
          changed(pinKey, '');
          delete values[pinKey];
          deletedKeys.add(pinKey);
        }
      });
      pin.append(pinHead, pinField, commonPin);
      $('channel-pins').append(pin);
    }
  }

  function updateMusic() {
    const enabled = values.MUSIC_ENABLED === 'true';
    for (const input of form.querySelectorAll('input[name="music-profile"]')) input.checked = input.value === String(enabled);
    $('music-off').hidden = enabled;
    $('music-fields').hidden = !enabled;
    $('music-state').textContent = enabled ? 'Включено' : 'Отключено';
    $('music-state').className = `badge${enabled ? ' success' : ''}`;
    for (const field of config.fields) {
      if (field.group === 'music' && fieldGroup(field) === 'advanced') {
        const input = document.getElementById(`setting-${field.key}`);
        if (input) input.closest('.field').hidden = !enabled;
      }
    }
    renderCommands();
  }

  async function load({ saved = false } = {}) {
    $('loading').hidden = false;
    $('retry').hidden = true;
    try {
      const response = await fetch('/api/config', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Не удалось загрузить настройки (HTTP ${response.status}).`);
      config = await response.json();
      if (!Array.isArray(config.fields) || !Array.isArray(config.commands) || !config.csrfToken) throw new Error('Сервер вернул неполные настройки. Перезапустите панель.');
      values = { ...config.values };
      secretsSet = new Set(config.secretsSet || []);
      clearSecrets = new Set();
      deletedKeys = new Set();
      chatDisabledCommands = new Map(Object.entries(config.chatDisabledCommands || {}).map(([channel, names]) => [channel, new Set(Array.isArray(names) ? names : [])]));
      enableChatCommands = new Map();
      for (const field of config.fields) {
        if (field.type === 'password') { delete values[field.key]; continue; }
        if (!Object.hasOwn(values, field.key) && !isDynamic(field.key)) values[field.key] = String(field.default ?? '');
      }
      if (!Object.hasOwn(values, 'MUSIC_ENABLED')) values.MUSIC_ENABLED = 'false';
      renderFields();
      renderScopes();
      renderChannels();
      updateMusic();
      $('file-state').textContent = config.exists ? '.env найден' : 'Первая настройка';
      $('file-state').className = `badge${config.exists ? ' success' : ''}`;
      $('save-heading').textContent = saved ? 'Настройки сохранены' : 'Настройки готовы к сохранению';
      $('save-detail').textContent = saved ? 'Перезапустите бота, чтобы применить изменения.' : 'Сохраним .env в папке этой копии бота.';
      dirty = false;
      form.hidden = false;
      if (!saved) status('');
    } catch (error) {
      status(error.message || 'Не удалось загрузить настройки.', 'error');
      $('retry').hidden = false;
    } finally {
      $('loading').hidden = true;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || !config) return;
    clearTimeout(channelTimer);
    saving = true;
    form.inert = true;
    $('save-button').disabled = true;
    $('save-button').textContent = 'Сохраняем…';
    status('');
    try {
      const submitted = { ...values };
      for (const field of config.fields) {
        if (field.type === 'password' && !String(submitted[field.key] || '').trim()) delete submitted[field.key];
      }
      for (const key of deletedKeys) delete submitted[key];
      const chatEnables = Object.fromEntries([...enableChatCommands].filter(([channel, names]) => channels().includes(channel) && names.size).map(([channel, names]) => [channel, [...names]]));
      const response = await fetch('/api/config', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Setup-Token': config.csrfToken },
        body: JSON.stringify({ values: submitted, clearSecrets: [...clearSecrets], deleteKeys: [...deletedKeys], enableChatCommands: chatEnables }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error(result.error || `Не удалось сохранить настройки (HTTP ${response.status}).`);
      status(result.message || 'Настройки сохранены в .env. Перезапустите бота, чтобы применить изменения.', 'success');
      await load({ saved: true });
    } catch (error) {
      status(error.message || 'Не удалось сохранить настройки.', 'error');
      $('notice').scrollIntoView({ block: 'center', behavior: 'smooth' });
    } finally {
      saving = false;
      form.inert = false;
      $('save-button').disabled = false;
      $('save-button').replaceChildren(el('span', '', '↓'), document.createTextNode(' Сохранить .env'));
    }
  });

  $('command-scope').addEventListener('change', renderCommands);
  $('command-search').addEventListener('input', renderCommands);
  $('enable-visible').addEventListener('click', () => setCommands(true));
  $('disable-visible').addEventListener('click', () => setCommands(false));
  $('retry').addEventListener('click', () => load());
  for (const input of form.querySelectorAll('input[name="music-profile"]')) input.addEventListener('change', () => { if (input.checked) changed('MUSIC_ENABLED', input.value); });
  window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });

  const navigation = [...document.querySelectorAll('.sidebar nav a')];
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) {
        for (const link of navigation) {
          const active = link.hash === `#${entry.target.id}`;
          link.classList.toggle('active', active);
          if (active) link.setAttribute('aria-current', 'location');
          else link.removeAttribute('aria-current');
        }
      }
    }, { rootMargin: '-10% 0px -65% 0px', threshold: 0 });
    for (const section of document.querySelectorAll('section.panel')) observer.observe(section);
  }
  load();
})();
