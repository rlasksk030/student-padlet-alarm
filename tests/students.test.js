// 학생 명단이 코드에 없다는 것, 그리고 명단을 못 읽었을 때 로그인이
// 통과하지 않는다는 것을 지킨다. 실제 학생 자료는 쓰지 않는다.
// 여기 나오는 이름·핀번호는 전부 명백한 가짜다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

// 가짜 학급. 실제 학생과 아무 관련이 없다.
const HEADERS = ['번호', '학생명', '핀번호', '패들렛링크'];
const FAKE_ROWS = [
  ['1', '학생01', '0000', 'https://padlet.com/example/board-01'],
  ['2', '학생02', '0001', 'https://padlet.com/example/board-02'],
];

// Apps Script 전역을 최소한으로만 흉내 낸다.
function load({ sheet = 'ok' } = {}) {
  const sheets = {
    ok: () => [HEADERS, ...FAKE_ROWS],
    empty: () => [HEADERS],          // 머리글만 있고 학생이 없음
    nothing: () => [],               // 완전히 빈 시트
    badHeaders: () => [['a', 'b', 'c', 'd'], ...FAKE_ROWS],
  };
  const spreadsheet = sheet === 'missing' ? null : {
    getSheetByName: () => ({ getDataRange: () => ({ getDisplayValues: sheets[sheet] }) }),
    getSheets: () => [{ getDataRange: () => ({ getDisplayValues: sheets[sheet] }) }],
  };
  const props = new Map();
  const context = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v),
        deleteProperty: (k) => props.delete(k),
      }),
    },
    UrlFetchApp: { fetch: () => { throw new Error('테스트에서는 외부 호출을 하지 않는다'); } },
    HtmlService: { createTemplateFromFile: () => ({}), createHtmlOutputFromFile: () => ({}), XFrameOptionsMode: {} },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => t }), MimeType: {} },
    ScriptApp: { getProjectTriggers: () => [] },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { sleep: () => {} },
  };
  vm.createContext(context);
  new vm.Script(SOURCE, { filename: 'Code.gs' }).runInContext(context);
  return context;
}

test('학생 명단이 소스에 들어 있지 않다', () => {
  assert.equal(SOURCE.includes('FALLBACK_STUDENTS'), false);
  // number/name/pin/padletUrl 을 함께 담은 리터럴이 하나도 없어야 한다.
  const literal = /\{\s*number:\s*'[^']*'\s*,\s*name:\s*'[^']*'\s*,\s*pin:\s*'[^']*'/;
  assert.equal(literal.test(SOURCE), false);
  // 4자리 핀번호 문자열이 소스에 남아 있지 않다.
  assert.deepEqual(SOURCE.match(/pin:\s*'\d{4}'/g), null);
});

test('시트가 정상이면 명단을 읽고 로그인이 된다', () => {
  const app = load();
  assert.equal(app.getStudents_().length, 2);
  assert.equal(app.getLoginStudents().length, 2);
  const ok = app.login({ number: '1', pin: '0000' });
  assert.equal(ok.ok, true);
  assert.equal(ok.student.number, '1');
  const wrong = app.login({ number: '1', pin: '9999' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /번호 또는 핀번호/);
});

test('명단을 못 읽으면 로그인이 통과하지 않고 이유를 정확히 알린다', () => {
  for (const sheet of ['missing', 'empty', 'nothing', 'badHeaders']) {
    const app = load({ sheet });
    // 내장 명단으로 넘어가지 않는다. (VM realm 이 달라 길이로 확인한다)
    assert.equal(app.getStudents_().length, 0, sheet);
    // 어떤 번호·핀번호 조합도 통과하지 못한다.
    for (const [number, pin] of [['1', '0000'], ['2', '0001'], ['1', '1234']]) {
      const r = app.login({ number, pin });
      assert.equal(r.ok, false, `${sheet} ${number}`);
      assert.match(r.message, /학생 정보를 불러오지 못했습니다/, sheet);
    }
    // "핀번호가 틀렸다" 가 아니라 "자료를 못 읽었다" 로 구분해서 알린다.
    assert.equal(app.login({ number: '1', pin: '0000' }).message.includes('핀번호를 다시 확인'), false, sheet);
    // 로그인 화면 명단은 조용히 비지 않고 오류로 알린다.
    assert.throws(() => app.getLoginStudents(), /학생 정보를 불러오지 못했습니다/, sheet);
    // 알림 등록 같은 인증 필요한 동작도 막힌다.
    const push = app.savePushSubscription({ number: '1', pin: '0000', subscriptionJson: '{"endpoint":"x"}' });
    assert.equal(push.ok, false, sheet);
  }
});

test('명단은 시트에서만 오고 코드에는 기본값이 없다', () => {
  const app = load({ sheet: 'missing' });
  assert.equal(typeof app.readStudents_, 'function');
  assert.equal(app.readStudents_(), null);
  // 안내 문구는 한 곳에서만 정의하고, 실제 응답이 그 문구를 쓴다.
  assert.match(SOURCE, /const STUDENTS_UNAVAILABLE_MESSAGE\s*=/);
  assert.match(app.login({ number: '1', pin: '0000' }).message, /불러오지 못했습니다/);
});

test('브라우저로 나가는 파일에 학생 자료가 없다', () => {
  for (const file of ['index.html', 'teacher.html', 'sw.js', 'manifest.json', 'teacher-manifest.json']) {
    const t = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.equal(/pin:\s*'\d{4}'/.test(t), false, file);
    assert.equal(/padlet\.com\/[^/]+\/breakout-room\//.test(t), false, file);
  }
});
