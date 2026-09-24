const APP_TITLE = '학생 작품모음';
const SHEET_NAME = 'Students';
const PADLET_STATE_SHEET_NAME = 'PadletStates';
const PUSH_SHEET_NAME = 'PushSubscriptions';
const PADLET_CHECK_MINUTES = 5;
const PROP_PUSH_PREFIX = 'push:';
const PROP_PADLET_PREFIX = 'padlet:';

const PUSH_SERVER_URL = 'https://okgu-push-server030.vercel.app';
const PUSH_SECRET = 'nK3iursOcEsaINl6Kijt2P9v5CRcFVNc';
const PWA_APP_URL = 'https://rlasksk030.github.io/student-padlet-alarm/';

// 학생 명단(이름·핀번호·패들렛 링크)은 코드에 두지 않는다.
// 예전에는 이 자리에 실제 학급 명단이 상수로 박혀 있었고, 저장소가 공개라
// 누구나 읽을 수 있었다. 게다가 시트를 못 읽으면 그 명단으로 로그인까지
// 통과했다. 이제 명단은 스프레드시트에만 있고, 못 읽으면 안전하게 실패한다.
const STUDENTS_UNAVAILABLE_MESSAGE =
  '학생 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';

function doGet(e) {
  if (e && e.parameter && e.parameter.fn) return handleJsonpRpc_(e);

  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle(APP_TITLE)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handleJsonpRpc_(e) {
  const callback = String((e.parameter && e.parameter.callback) || 'callback');
  const safeCallback = /^[A-Za-z_$][0-9A-Za-z_$]*(\.[A-Za-z_$][0-9A-Za-z_$]*)*$/.test(callback)
    ? callback
    : 'callback';
  const fnName = String((e.parameter && e.parameter.fn) || '');

  let args = [];
  try {
    args = JSON.parse((e.parameter && e.parameter.p) || '[]');
    if (!Array.isArray(args)) args = [];
  } catch (error) {
    args = [];
  }

  let payload;
  try {
    const fn = globalThis[fnName];
    if (typeof fn !== 'function') throw new Error(fnName + ' is not defined');
    payload = { ok: true, result: fn.apply(null, args) };
  } catch (error) {
    payload = { ok: false, error: error && error.message ? error.message : String(error) };
  }

  return ContentService
    .createTextOutput(safeCallback + '(' + JSON.stringify(payload) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function login(payload) {
  const number = normalize_(payload && payload.number);
  const pin = normalize_(payload && payload.pin);

  if (!number || !pin) {
    return { ok: false, message: '학생 번호와 핀번호를 모두 입력해 주세요.' };
  }

  const roster = readStudents_();
  // 자료를 못 읽은 것과 핀번호가 틀린 것은 다르다. 섞으면 교사가 원인을 못 찾는다.
  if (!roster) return { ok: false, message: STUDENTS_UNAVAILABLE_MESSAGE };

  const student = findStudentInRoster_(roster, number, pin);
  if (!student) {
    return { ok: false, message: '번호 또는 핀번호를 다시 확인해 주세요.' };
  }

  return {
    ok: true,
    student: {
      number: student.number,
      name: student.name,
      title: `${student.name}의 작품모음`,
      padletUrl: student.padletUrl,
    },
  };
}

function getLoginStudents() {
  const roster = readStudents_();
  // 빈 목록을 조용히 내려보내면 화면만 비고 이유를 알 수 없다. 오류로 알린다.
  if (!roster) throw new Error(STUDENTS_UNAVAILABLE_MESSAGE);
  return roster.map((student) => ({
    number: student.number,
    name: student.name,
    label: `${student.number}번 ${student.name}`,
  }));
}

function savePushSubscription(payload) {
  const student = requireStudent_(payload);
  if (!student.ok) return student;

  let subscription;
  try {
    subscription = JSON.parse(String(payload && payload.subscriptionJson || '{}'));
  } catch (error) {
    return { ok: false, message: '알림 등록 정보가 올바르지 않습니다.' };
  }
  if (!subscription || !subscription.endpoint) {
    return { ok: false, message: '알림 endpoint가 없습니다.' };
  }

  savePushSubscription_(student, subscription);
  return { ok: true, enabled: true, message: '패들렛 새 글 알림이 켜졌습니다.' };
}

function getMyPushStatus(payload) {
  const student = requireStudent_(payload);
  if (!student.ok) return student;

  const rows = getPushRows_();
  for (let i = 0; i < rows.length; i++) {
    if (normalize_(rows[i].number) === normalize_(student.number) && rows[i].active && rows[i].subscription) {
      return { ok: true, enabled: true };
    }
  }
  return { ok: true, enabled: false };
}

function disablePushSubscription(payload) {
  const student = requireStudent_(payload);
  if (!student.ok) return student;

  disablePushSubscription_(student.number);
  return { ok: true, enabled: false, message: '패들렛 새 글 알림이 꺼졌습니다.' };
}

function sendTestPush(payload) {
  const student = requireStudent_(payload);
  if (!student.ok) return student;

  return sendPushToStudent_(
    student,
    '학생 작품모음 알림 테스트',
    `${student.name} 학생 작품모음 알림이 정상 등록되었습니다.`,
    'padlet-test-' + Date.now(),
    student.padletUrl || PWA_APP_URL
  );
}

function authorizeExternalRequestOnce() {
  const response = UrlFetchApp.fetch(PUSH_SERVER_URL.replace(/\/$/, '') + '/api/send-push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + PUSH_SECRET },
    payload: JSON.stringify({
      subscriptions: [],
      title: '학생 작품모음',
      body: '권한 승인 테스트',
      tag: 'auth-test',
      url: PWA_APP_URL,
    }),
    muteHttpExceptions: true,
  });

  return {
    ok: true,
    responseCode: response.getResponseCode(),
    responseText: response.getContentText(),
  };
}

function setupPadletPostAlertTrigger() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction && trigger.getHandlerFunction() === 'checkPadletPostsAndNotify') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  initializePadletPostAlertState();

  ScriptApp.newTrigger('checkPadletPostsAndNotify')
    .timeBased()
    .everyMinutes(PADLET_CHECK_MINUTES)
    .create();

  return `패들렛 새 글 알림 트리거를 ${PADLET_CHECK_MINUTES}분 간격으로 설정했습니다.`;
}

function initializePadletPostAlertState() {
  const students = getStudents_();
  const stateStore = getPadletStateStore_();
  const stateMap = stateStore.map;
  const now = new Date().toISOString();
  const results = [];

  students.forEach((student) => {
    if (!student.padletUrl) return;
    const key = padletStateKey_(student);
    try {
      const snapshot = fetchPadletSnapshot_(student.padletUrl);
      upsertPadletState_(stateStore, key, {
        number: student.number,
        name: student.name,
        padletUrl: student.padletUrl,
        fingerprint: snapshot.fingerprint,
        lastChecked: now,
        lastChanged: '',
        lastNotified: '',
        status: '초기화 완료',
        error: '',
      });
      results.push({ name: student.name, ok: true });
    } catch (error) {
      upsertPadletState_(stateStore, key, {
        number: student.number,
        name: student.name,
        padletUrl: student.padletUrl,
        fingerprint: '',
        lastChecked: now,
        lastChanged: '',
        lastNotified: '',
        status: '초기화 실패',
        error: error.message,
      });
      results.push({ name: student.name, ok: false, error: error.message });
    }
  });

  return { ok: true, results: results };
}

function checkPadletPostsAndNotify() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, message: '이미 확인 작업이 실행 중입니다.' };

  try {
    const students = getStudents_();
    const stateStore = getPadletStateStore_();
    const stateMap = stateStore.map;
    const now = new Date().toISOString();
    const results = [];

    students.forEach((student) => {
      if (!student.padletUrl) return;
      const key = padletStateKey_(student);
      const oldState = stateMap[key] || {};

      try {
        const snapshot = fetchPadletSnapshot_(student.padletUrl);
        const changed = oldState.fingerprint && oldState.fingerprint !== snapshot.fingerprint;
        let sendResult = null;

        if (changed) {
          sendResult = sendPushToStudent_(
            student,
            '학생 작품모음',
            `${student.name} 학생 패들렛에 새 글이 올라왔어요.`,
            'padlet-new-' + student.number + '-' + Date.now(),
            student.padletUrl
          );
        }

        upsertPadletState_(stateStore, key, {
          number: student.number,
          name: student.name,
          padletUrl: student.padletUrl,
          fingerprint: snapshot.fingerprint,
          lastChecked: now,
          lastChanged: changed ? now : (oldState.lastChanged || ''),
          lastNotified: changed && sendResult && sendResult.ok ? now : (oldState.lastNotified || ''),
          status: changed ? '변경 감지 및 푸시 시도' : (oldState.fingerprint ? '변경 없음' : '첫 상태 저장'),
          error: sendResult && !sendResult.ok ? (sendResult.message || '') : '',
        });

        results.push({
          name: student.name,
          changed: !!changed,
          push: sendResult || null,
        });
      } catch (error) {
        upsertPadletState_(stateStore, key, {
          number: student.number,
          name: student.name,
          padletUrl: student.padletUrl,
          fingerprint: oldState.fingerprint || '',
          lastChecked: now,
          lastChanged: oldState.lastChanged || '',
          lastNotified: oldState.lastNotified || '',
          status: '확인 실패',
          error: error.message,
        });
        results.push({ name: student.name, changed: false, error: error.message });
      }
    });

    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

function testPadletFetchFirstStudent() {
  const student = getStudents_().filter((item) => item.padletUrl)[0];
  if (!student) return { ok: false, message: '패들렛 링크가 없습니다.' };
  const snapshot = fetchPadletSnapshot_(student.padletUrl);
  return {
    ok: true,
    student: student.name,
    fingerprint: snapshot.fingerprint,
    sample: snapshot.sample,
  };
}

function getPadletAlertStatus() {
  const students = getStudents_();
  const stateStore = getPadletStateStore_();
  const triggers = ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction && trigger.getHandlerFunction() === 'checkPadletPostsAndNotify')
    .length;

  return {
    ok: true,
    triggerCount: triggers,
    students: students.map(function(student) {
      const key = padletStateKey_(student);
      const oldState = stateStore.map[key] || {};
      let currentFingerprint = '';
      let fetchOk = false;
      let error = '';
      try {
        const snapshot = fetchPadletSnapshot_(student.padletUrl);
        currentFingerprint = snapshot.fingerprint;
        fetchOk = true;
      } catch (err) {
        error = err.message;
      }
      return {
        number: student.number,
        name: student.name,
        hasPush: getSubscriptionsForStudent_(student.number).length > 0,
        hasSavedState: !!oldState.fingerprint,
        fetchOk: fetchOk,
        wouldChange: !!(oldState.fingerprint && currentFingerprint && oldState.fingerprint !== currentFingerprint),
        error: error,
      };
    }),
  };
}

function sendPushToStudent_(student, title, body, tag, url) {
  const subscriptions = getSubscriptionsForStudent_(student.number);
  if (!subscriptions.length) {
    return { ok: false, sent: 0, message: '등록된 알림 기기가 없습니다.' };
  }
  return callPushServer_(subscriptions, title, body, tag, url || PWA_APP_URL);
}

function getSubscriptionsForStudent_(number) {
  const rows = getPushRows_();
  const subscriptions = [];

  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].active || normalize_(rows[i].number) !== normalize_(number)) continue;
    if (rows[i].subscription && rows[i].subscription.endpoint) subscriptions.push(rows[i].subscription);
  }
  return subscriptions;
}

function callPushServer_(subscriptions, title, body, tag, url) {
  if (!PUSH_SERVER_URL || PUSH_SERVER_URL.indexOf('YOUR-VERCEL-APP') >= 0) {
    return { ok: false, message: 'PUSH_SERVER_URL을 설정해 주세요.' };
  }

  try {
    const response = UrlFetchApp.fetch(PUSH_SERVER_URL.replace(/\/$/, '') + '/api/send-push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + PUSH_SECRET },
      payload: JSON.stringify({
        subscriptions: subscriptions,
        title: title || '학생 작품모음',
        body: body || '새 알림이 있어요.',
        tag: tag || ('padlet-' + Date.now()),
        url: url || PWA_APP_URL,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        badgeCount: 1,
      }),
      muteHttpExceptions: true,
    });

    const text = response.getContentText();
    let payload = {};
    try { payload = JSON.parse(text); } catch (error) { payload = { raw: text }; }
    if (response.getResponseCode() >= 300) {
      return { ok: false, message: '푸시 서버 오류: ' + text };
    }
    payload.ok = true;
    return payload;
  } catch (error) {
    return { ok: false, message: '푸시 전송 실패: ' + error.message };
  }
}

function requireStudent_(payload) {
  const number = normalize_(payload && payload.number);
  const pin = normalize_(payload && payload.pin);
  if (!number || !pin) return { ok: false, message: '다시 로그인해 주세요.' };

  const roster = readStudents_();
  if (!roster) return { ok: false, message: STUDENTS_UNAVAILABLE_MESSAGE };

  const student = findStudentInRoster_(roster, number, pin);
  if (!student) return { ok: false, message: '번호 또는 핀번호를 다시 확인해 주세요.' };
  student.ok = true;
  return student;
}

function findStudentInRoster_(roster, number, pin) {
  return roster.find((item) => {
    return normalize_(item.number) === number && normalize_(item.pin) === pin;
  });
}

function findStudentByLogin_(number, pin) {
  return findStudentInRoster_(getStudents_(), number, pin);
}

function readStudents_() {
  const sheet = getSheet_();
  if (!sheet) return null;

  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return null;

  const headers = values[0].map(normalizeHeader_);
  const numberIndex = findHeader_(headers, ['번호', 'number', 'no']);
  const nameIndex = findHeader_(headers, ['학생명', '이름', 'name']);
  const pinIndex = findHeader_(headers, ['핀번호', 'pin', 'password']);
  const padletIndex = findHeader_(headers, ['패들렛링크', '패들렛', 'padlet', 'padleturl']);

  if (numberIndex < 0 || pinIndex < 0 || padletIndex < 0) return null;

  return values
    .slice(1)
    .map((row) => ({
      number: row[numberIndex],
      name: nameIndex >= 0 ? row[nameIndex] : '',
      pin: row[pinIndex],
      padletUrl: row[padletIndex],
    }))
    .filter((item) => item.pin && item.padletUrl);
}

// 명단을 못 읽었을 때 예전 코드는 내장 명단으로 넘어갔다. 지금은 빈 목록이다.
// 빈 목록이면 어떤 번호·핀번호도 맞지 않으므로 로그인이 통과하지 않는다.
function getStudents_() {
  return readStudents_() || [];
}

function getSheet_() {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return null;
    return spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.getSheets()[0];
  } catch (error) {
    return null;
  }
}

function getSpreadsheet_() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet();
  } catch (error) {
    return null;
  }
}

function getScriptProps_() {
  return PropertiesService.getScriptProperties();
}

function savePushSubscription_(student, subscription) {
  const spreadsheet = getSpreadsheet_();
  if (spreadsheet) {
    const sheet = getPushSheet_(spreadsheet);
    const data = sheet.getDataRange().getValues();
    const row = [
      student.number,
      student.name,
      String(subscription.endpoint),
      JSON.stringify(subscription),
      new Date().toISOString(),
      true,
    ];

    for (let i = 1; i < data.length; i++) {
      const sameEndpoint = String(data[i][2] || '') === String(subscription.endpoint);
      const sameStudent = normalize_(data[i][0]) === normalize_(student.number);
      if (sameEndpoint || sameStudent) {
        sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
        return;
      }
    }
    sheet.appendRow(row);
    return;
  }

  getScriptProps_().setProperty(PROP_PUSH_PREFIX + normalize_(student.number), JSON.stringify({
    number: student.number,
    name: student.name,
    endpoint: String(subscription.endpoint),
    subscription: subscription,
    registeredAt: new Date().toISOString(),
    active: true,
  }));
}

function getPushRows_() {
  const spreadsheet = getSpreadsheet_();
  if (spreadsheet) {
    const sheet = getPushSheet_(spreadsheet);
    const data = sheet.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      let subscription = null;
      try { subscription = JSON.parse(data[i][3] || '{}'); } catch (error) {}
      rows.push({
        number: String(data[i][0] || ''),
        name: String(data[i][1] || ''),
        endpoint: String(data[i][2] || ''),
        subscription: subscription,
        active: data[i][5] === true || data[i][5] === 'TRUE' || data[i][5] === 'true',
      });
    }
    return rows;
  }

  const props = getScriptProps_().getProperties();
  return Object.keys(props)
    .filter((key) => key.indexOf(PROP_PUSH_PREFIX) === 0)
    .map((key) => {
      try {
        return JSON.parse(props[key] || '{}');
      } catch (error) {
        return null;
      }
    })
    .filter((row) => row && row.number);
}

function disablePushSubscription_(number) {
  const spreadsheet = getSpreadsheet_();
  if (spreadsheet) {
    const sheet = getPushSheet_(spreadsheet);
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (normalize_(data[i][0]) === normalize_(number)) {
        sheet.getRange(i + 1, 6).setValue(false);
      }
    }
    return;
  }

  const key = PROP_PUSH_PREFIX + normalize_(number);
  const raw = getScriptProps_().getProperty(key);
  if (!raw) return;
  try {
    const row = JSON.parse(raw);
    row.active = false;
    getScriptProps_().setProperty(key, JSON.stringify(row));
  } catch (error) {}
}

function getPushSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(PUSH_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(PUSH_SHEET_NAME);
  const headers = ['번호', '이름', 'Endpoint', 'SubscriptionJSON', '등록시간', '활성'];
  ensureHeaders_(sheet, headers);
  return sheet;
}

function getPadletStateSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(PADLET_STATE_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(PADLET_STATE_SHEET_NAME);
  const headers = ['Key', '번호', '이름', 'PadletUrl', 'Fingerprint', 'LastChecked', 'LastChanged', 'LastNotified', 'Status', 'Error'];
  ensureHeaders_(sheet, headers);
  return sheet;
}

function ensureHeaders_(sheet, headers) {
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  headers.forEach((header, index) => {
    if (current[index] !== header) sheet.getRange(1, index + 1).setValue(header).setFontWeight('bold');
  });
}

function getPadletStateStore_() {
  const spreadsheet = getSpreadsheet_();
  if (spreadsheet) {
    const sheet = getPadletStateSheet_(spreadsheet);
    return { type: 'sheet', sheet: sheet, map: getPadletStateMapFromSheet_(sheet) };
  }

  const props = getScriptProps_().getProperties();
  const map = {};
  Object.keys(props)
    .filter((key) => key.indexOf(PROP_PADLET_PREFIX) === 0)
    .forEach((key) => {
      try {
        const value = JSON.parse(props[key] || '{}');
        const stateKey = key.substring(PROP_PADLET_PREFIX.length);
        map[stateKey] = value;
      } catch (error) {}
    });
  return { type: 'props', map: map };
}

function getPadletStateMapFromSheet_(sheet) {
  const values = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const key = String(values[i][0] || '').trim();
    if (!key) continue;
    map[key] = {
      row: i + 1,
      fingerprint: String(values[i][4] || ''),
      lastChecked: String(values[i][5] || ''),
      lastChanged: String(values[i][6] || ''),
      lastNotified: String(values[i][7] || ''),
    };
  }
  return map;
}

function upsertPadletState_(store, key, data) {
  const row = [
    key,
    data.number || '',
    data.name || '',
    data.padletUrl || '',
    data.fingerprint || '',
    data.lastChecked || '',
    data.lastChanged || '',
    data.lastNotified || '',
    data.status || '',
    data.error || '',
  ];

  if (store.type === 'sheet') {
    if (store.map[key] && store.map[key].row) {
      store.sheet.getRange(store.map[key].row, 1, 1, row.length).setValues([row]);
    } else {
      store.sheet.appendRow(row);
      store.map[key] = { row: store.sheet.getLastRow(), fingerprint: data.fingerprint || '' };
    }
  } else {
    getScriptProps_().setProperty(PROP_PADLET_PREFIX + key, JSON.stringify({
      number: data.number || '',
      name: data.name || '',
      padletUrl: data.padletUrl || '',
      fingerprint: data.fingerprint || '',
      lastChecked: data.lastChecked || '',
      lastChanged: data.lastChanged || '',
      lastNotified: data.lastNotified || '',
      status: data.status || '',
      error: data.error || '',
    }));
    store.map[key] = {
      fingerprint: data.fingerprint || '',
      lastChecked: data.lastChecked || '',
      lastChanged: data.lastChanged || '',
      lastNotified: data.lastNotified || '',
    };
  }
}

function fetchPadletSnapshot_(url) {
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; OKGU-Padlet-Monitor/1.0)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code >= 400) throw new Error(`Padlet 응답 오류 ${code}`);
  if (/security check/i.test(text)) {
    throw new Error('Padlet 보안 확인 화면이 반환되었습니다. 자동 확인이 막힐 수 있습니다.');
  }

  const normalized = normalizePadletContent_(text);
  if (normalized.length < 200) throw new Error('패들렛 내용을 충분히 읽지 못했습니다.');

  return {
    fingerprint: sha256Hex_(normalized),
    sample: normalized.substring(0, 240),
  };
}

function normalizePadletContent_(html) {
  let text = String(html || '');
  const usefulMatches = [];
  const patterns = [
    /"posts"\s*:\s*(\[[\s\S]{100,}?\])\s*,\s*"[A-Za-z_]+"/i,
    /"wall_posts"\s*:\s*(\[[\s\S]{100,}?\])\s*,\s*"[A-Za-z_]+"/i,
    /"postsById"\s*:\s*(\{[\s\S]{100,}?\})\s*,\s*"[A-Za-z_]+"/i,
    /"postEntities"\s*:\s*(\{[\s\S]{100,}?\})\s*,\s*"[A-Za-z_]+"/i,
    /"subject"\s*:\s*"[^"]+"[\s\S]{0,2000}?"created_at"\s*:\s*"[^"]+"/ig,
    /"id"\s*:\s*"[^"]+"[\s\S]{0,800}?"updated_at"\s*:\s*"[^"]+"/ig,
  ];

  patterns.forEach((pattern) => {
    const matches = text.match(pattern);
    if (matches) usefulMatches.push(matches.join('\n'));
  });

  if (usefulMatches.length) text = usefulMatches.join('\n');

  const normalized = text
    .replace(/data:image\/[^"')\s]+/g, '')
    .replace(/\bdata-version=["'][^"']+["']/gi, '')
    .replace(/\bdata-release=["'][^"']+["']/gi, '')
    .replace(/\bdata-build=["'][^"']+["']/gi, '')
    .replace(/\bdata-country=["'][^"']+["']/gi, '')
    .replace(/\bv-\d{12,}-[a-z0-9-]+/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]+src=["'][^"']+["'][^>]*><\/script>/gi, '')
    .replace(/<link[^>]+href=["'][^"']+\.(?:js|css)(?:\?[^"']*)?["'][^>]*>/gi, '')
    .replace(/nonce=["'][^"']+["']/gi, '')
    .replace(/csrf[^"']*["'][^"']+["']/gi, '')
    .replace(/"csrfToken"\s*:\s*"[^"]*"/gi, '')
    .replace(/"buildId"\s*:\s*"[^"]*"/gi, '')
    .replace(/"assetPrefix"\s*:\s*"[^"]*"/gi, '')
    .replace(/"version"\s*:\s*"[^"]*"/gi, '')
    .replace(/"currentTime"\s*:\s*"?\d+"?/gi, '')
    .replace(/"requestId"\s*:\s*"[^"]*"/gi, '')
    .replace(/\b\d{13}\b/g, '')
    .replace(/https:\/\/padlet\.net\/[^"')\s]+/gi, '')
    .replace(/https:\/\/assets\.padletcdn\.com\/[^"')\s]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const postLike = extractPostLikeTokens_(normalized);
  return postLike || normalized;
}

function extractPostLikeTokens_(text) {
  const tokens = [];
  const patterns = [
    /"id"\s*:\s*"([A-Za-z0-9_-]{8,})"/g,
    /"hashid"\s*:\s*"([A-Za-z0-9_-]{8,})"/g,
    /"subject"\s*:\s*"((?:\\.|[^"\\]){1,300})"/g,
    /"body"\s*:\s*"((?:\\.|[^"\\]){1,500})"/g,
    /"created_at"\s*:\s*"([^"]+)"/g,
    /"updated_at"\s*:\s*"([^"]+)"/g,
  ];

  patterns.forEach(function(pattern) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      tokens.push(match[0]);
      if (tokens.length > 1000) break;
    }
  });

  if (tokens.length < 3) return '';
  tokens.sort();
  return tokens.join('\n');
}

function padletStateKey_(student) {
  return `${normalize_(student.number)}|${normalize_(student.padletUrl)}`;
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map((byte) => {
      const unsigned = byte < 0 ? byte + 256 : byte;
      return (`0${unsigned.toString(16)}`).slice(-2);
    })
    .join('');
}

function findHeader_(headers, candidates) {
  return headers.findIndex((header) => candidates.includes(header));
}

function normalizeHeader_(value) {
  return normalize_(value).replace(/\s+/g, '').toLowerCase();
}

function normalize_(value) {
  return String(value || '').trim();
}
