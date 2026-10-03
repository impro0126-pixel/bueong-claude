#!/usr/bin/env node
/*
 * 가계부 MCP 서버 (클로드 데스크탑 앱용, 의존성 없음)
 * - 클로드 데스크탑이 캡처를 읽고 이 서버의 도구를 호출해 받은편지함에 거래를 기록.
 * - 가계부엉(네이티브앱)이 그 받은편지함을 받아 입력.
 * - 앱이 받은편지함 옆에 두는 사본(state.json)은 읽기만 한다: 이름(get_names)과 기간별 거래(get_transactions).
 * 통신: newline-delimited JSON-RPC 2.0 over stdio (MCP stdio transport)
 *
 * 받은편지함 자리 (2026-09-17 6단계부터 한 곳):
 *  - 가계부엉 폴더의 `inbox.json` — **정본.** 읽기(중복 판정)도 쓰기도 여기 하나.
 *    폴더는 아이클라우드 드라이브, 아이클라우드를 끈 맥이면 앱 샌드박스 안 Documents (`bueongDir`).
 * 웹앱(가계부.app)은 은퇴했다. `KAKEIBO_DIR` 은 설정 파일을 옛 자리에서 옮겨 올 때만 읽는다.
 */
const fs = require('fs');
const path = require('path');

// 옛 웹앱 자리. 지금은 설정 파일(가계부-config.json)을 한 번 옮겨 오는 데만 쓴다.
const OLD_KAKEIBO_DIR = (process.env.KAKEIBO_DIR || '').trim();

// 가계부엉(네이티브앱)의 받은편지함 자리. 앱(`CloudContainer.documents`)과 같은 규칙으로 고른다.
//  ① BUEONG_DIR 을 적었으면 그것.
//  ② 아이클라우드 드라이브 앱 컨테이너의 Documents — 보통은 여기.
//  ③ 아이클라우드를 끈 맥이면 앱이 샌드박스 안 Documents 로 물러선다. 거기도 본다(2026-10-03).
//     이게 없으면 아이클라우드를 끈 사람은 클로드가 「앱을 한 번 띄우세요」라는 틀린 말만 했다.
// 아이클라우드를 쓰다 끈 맥은 두 폴더가 다 남아 있을 수 있다. 그때는 맥 앱이 사본(state.json)을
// 더 최근에 쓴 쪽이 지금 앱이 보는 자리다. 사본이 어느 쪽에도 없으면 아이클라우드 쪽.
// 앱이 도중에 자리를 바꿀 수 있으니 상수로 박지 않고 도구를 부를 때마다 고른다.
const HOME = require('os').homedir();
const ICLOUD_CONTAINER = path.join(HOME, 'Library', 'Mobile Documents', 'iCloud~com~bueong~app');
const ICLOUD_DIR = path.join(ICLOUD_CONTAINER, 'Documents');
const LOCAL_DIR = path.join(HOME, 'Library', 'Containers', 'com.bueong.app', 'Data', 'Documents');
const ENV_BUEONG_DIR = (process.env.BUEONG_DIR || '').trim();

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
// { dir, where } — where 는 'env' | 'icloud' | 'local'. 둘 다 없으면 아이클라우드 자리를 돌려주고,
// 쓰기는 writeInboxAll 이 「앱을 한 번 띄우세요」로 멈춘다(컨테이너를 손으로 파지 않는다).
function bueongDir() {
  if (ENV_BUEONG_DIR) return { dir: ENV_BUEONG_DIR, where: 'env' };
  const hasICloud = fs.existsSync(ICLOUD_CONTAINER);
  const hasLocal = fs.existsSync(LOCAL_DIR);
  if (hasICloud && hasLocal) {
    const ti = Math.max(mtime(path.join(ICLOUD_DIR, 'state.json')), mtime(path.join(ICLOUD_DIR, '.state.json.icloud')));
    const tl = mtime(path.join(LOCAL_DIR, 'state.json'));
    return tl > ti ? { dir: LOCAL_DIR, where: 'local' } : { dir: ICLOUD_DIR, where: 'icloud' };
  }
  if (hasLocal) return { dir: LOCAL_DIR, where: 'local' };
  return { dir: ICLOUD_DIR, where: 'icloud' };
}
const inboxFile = () => path.join(bueongDir().dir, 'inbox.json');

// 앱 샌드박스 폴더는 macOS 가 「다른 앱의 데이터」로 지킨다. 폴더가 있다는 것까지는 보여도 안쪽은
// 막힐 수 있다(이 맥의 클로드 코드에서 실제로 「Operation not permitted」, 2026-10-03).
// 막히면 날것 오류 대신 무엇을 하면 되는지 말한다. 막히지 않았으면 null.
const BLOCKED_HELP = '맥이 클로드의 가계부엉 폴더 접근을 막았습니다(아이클라우드 드라이브가 꺼져 있어 앱이 자기 폴더에만 자료를 둔 상태). ' +
  '가장 쉬운 길은 시스템 설정 → Apple 계정 → iCloud → iCloud Drive 를 켜고 가계부엉을 한 번 껐다 켜는 것입니다. ' +
  '아이클라우드를 안 쓰려면, 맥이 「Claude 가 다른 앱의 데이터에 접근하려고 합니다」라고 물을 때 허용을 누르세요.';
function blockedLocal() {
  const { dir, where } = bueongDir();
  if (where !== 'local') return null;
  try { fs.readdirSync(dir); return null; }
  catch (e) { return (e && (e.code === 'EPERM' || e.code === 'EACCES')) ? BLOCKED_HELP : null; }
}

// 맥 가계부엉이 받은편지함 옆에 두는 자료 사본(「클로드 연동」을 켠 맥에서만 쓴다). 서버는 읽기만 한다.
// get_names 는 이름만, get_transactions 는 사용자가 물은 기간의 거래만 꺼낸다(2026-10-03 결정).
// 통장 잔액·원금·연말정산 설정·목표는 어느 도구로도 싣지 않는다.
const stateFile = () => path.join(bueongDir().dir, 'state.json');

// 받은편지함을 쓸 자리 목록. 지금은 한 곳뿐이지만, writeInboxAll 이 여러 자리를 받는 모양은
// 그대로 둔다 — 자리마다 성공/실패를 솔직히 보고하는 안전장치를 잃지 않기 위해서.
function inboxTargets() {
  return [{ label: '가계부엉', file: inboxFile() }];
}

// 클로드 설정(카드 목록·가맹점 학습 규칙)은 **맥 로컬**에 둔다. 웹앱 샌드박스는 은퇴했고,
// 아이클라우드 폴더는 파일이 `.icloud` 자리표시로 내려가면 「설정 없음」으로 읽힌다.
const CONFIG_DIR = (process.env.KAKEIBO_CONFIG_DIR || '').trim() ||
  path.join(require('os').homedir(), 'Library', 'Application Support', 'kakeibo-mcp');
const CONFIG = path.join(CONFIG_DIR, '가계부-config.json');

// 옛 자리(웹앱 샌드박스)에서 새 자리로 설정을 한 번 옮긴다. 옛 파일은 지우지 않는다 — 되돌릴 길을 남긴다.
// 서버가 뜰 때 딱 한 번만 시도하고 실패를 삼키면 위험하다 — 그 순간 옛 파일이 잠깐 잠겨 있었을 뿐인데
// (예: 다른 프로그램이 쓰는 중) get_config 는 "설정 없음"이라 하고, 그 말을 들은 클로드가 set_config 를
// 부르면 `{}` 에서 새로 시작해 학습규칙(merchantRules)이 통째로 사라진다 — 다시는 못 옮겨 온다(새 파일이
// 이미 생겼으니). 그래서 이관을 함수로 만들어 **매 도구 호출 앞에서 다시 시도**하고, 실패 이유를 기억해
// doGetConfig/doSetConfig 가 "정말 설정이 없음"과 "옮기다 실패함"을 구별하게 한다.
let configMigrationError = null;   // 이 프로세스에서 마지막으로 겪은 이관 실패 이유. 성공/불필요면 null.
function ensureConfigMigrated() {
  if (fs.existsSync(CONFIG)) { configMigrationError = null; return; }   // 이미 있음 — 할 일 없음(싼 검사)
  if (!OLD_KAKEIBO_DIR) return;                                         // 옮겨 올 옛 자리 자체가 없음
  const old = path.join(OLD_KAKEIBO_DIR, '가계부-config.json');
  if (!fs.existsSync(old)) return;                                      // 옛 파일도 없음 — 정말 처음 씀
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // 원자적 복사: 임시파일에 먼저 쓰고 rename. 복사 중 실패해도 CONFIG 자리엔 부분파일이 안 남는다.
    const tmpFile = CONFIG + '.tmp-' + process.pid;
    fs.copyFileSync(old, tmpFile);
    fs.renameSync(tmpFile, CONFIG);
    configMigrationError = null;
  } catch (e) {
    configMigrationError = (e && e.message) || String(e);
  }
}

// inbox 파일 내 중복 방지용 키. 서로 다른 거래(같은 날·금액이라도 수단/입금계좌/내용 다름)는 구분되게 충분히 상세히.
const txKey = t => `${t.date}|${Number(t.amount)}|${(t.payment || '').trim()}|${(t.toAccount || '').trim()}|${(t.desc || '').trim()}`;

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 가맹점명 정규화: 공백 제거 + 소문자 + 흔한 지점/번호 꼬리 제거. "스타벅스 강남점"과 "STARBUCKS"를 같은 키로 모으기 위한 것.
function normMerchant(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[0-9]+호점?$/,'')
    .replace(/(점|지점|본점|매장)$/,'')
    .trim();
}

// 학습된 가맹점 규칙 조회: 정규화 완전일치 우선, 없으면 부분포함.
function lookupRule(rules, desc) {
  if (!rules) return null;
  const n = normMerchant(desc);
  if (!n) return null;
  if (rules[n]) return rules[n];
  for (const [k, v] of Object.entries(rules)) {
    if (!k) continue;
    if (n.includes(k) || k.includes(n)) return v;
  }
  return null;
}

// "없는 파일"과 "깨진 파일"을 구분해 읽는다. 없음 → fallback(새로 시작), 깨짐 → 중단.
//  깨진 inbox를 빈 것으로 간주하고 덮어쓰면 아직 처리 안 된 대기 거래가 통째로 증발한다.
function readJSONStrict(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return fallback; }                       // 파일 없음 → 정상적인 첫 시작
  try { return JSON.parse(raw); }
  catch (e) {
    throw new Error(
      `${path.basename(file)} 이(가) 깨져 있어(JSON 파싱 실패) 덮어쓰지 않고 중단합니다. ` +
      `대기 거래 유실 방지용 보호입니다. 파일을 열어 복구하거나, 비어도 된다면 파일을 지우고 다시 시도하세요. (${e.message})`
    );
  }
}

// 원자적 쓰기: 임시파일에 쓰고 rename. 쓰다 프로세스가 죽어도 원본은 온전하게 남는다.
function writeJSONAtomic(file, obj) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// 받은편지함을 모든 자리에 같은 내용으로 쓴다.
// 한 자리가 못 써도 **통째로 실패시키지 않는다** — 부엉의 아이클라우드 폴더는 그 맥에서 앱을
// 한 번도 안 띄웠으면 아예 없다. 대신 자리마다 성공·실패를 그대로 돌려주어 도구 답이 솔직하게 만든다.
//
// ⚠️ **아이클라우드 컨테이너는 손으로 만들지 않는다.** `~/Library/Mobile Documents/` 아래는
// 아이클라우드 데몬이 관리하는 자리다. 앱이 등록하기 전에 우리가 폴더를 파면 동기화가 안 되는
// 껍데기가 생기고, 거기에 쓰고도 「기록함」으로 보고하게 된다 — 클로드는 성공했다는데 아이폰에는
// 영영 안 오는, 가장 찾기 어려운 고장이다. 그래서 컨테이너가 없으면 **그 자리는 건너뛰고 왜인지
// 말한다.** 컨테이너 안쪽(Documents)은 있으면 쓰고 없으면 만든다.
function isUnderICloudDrive(file) {
  return path.resolve(file).startsWith(path.join(HOME, 'Library', 'Mobile Documents') + path.sep);
}
function writeInboxAll(obj) {
  return inboxTargets().map(t => {
    try {
      const dir = path.dirname(t.file);
      if (!fs.existsSync(dir)) {
        // 아이클라우드 컨테이너 자체(= Documents 의 부모)가 없으면 앱이 아직 한 번도 안 떴다는 뜻.
        const container = path.dirname(dir);
        if (isUnderICloudDrive(t.file) && !fs.existsSync(container)) {
          return { label: t.label, file: t.file, ok: false, skipped: true,
                   error: '가계부엉 폴더가 아직 없습니다 — 이 맥에서 가계부엉 앱을 한 번 켜고, 설정에서 「클로드 연동」을 켜 주세요' };
        }
        fs.mkdirSync(dir, { recursive: true });
      }
      writeJSONAtomic(t.file, obj);
      return { label: t.label, file: t.file, ok: true };
    } catch (e) {
      return { label: t.label, file: t.file, ok: false, error: (e && e.message) || String(e) };
    }
  });
}

// ---- 도구 구현 ----
function doGetConfig() {
  ensureConfigMigrated();
  const cfg = readJSON(CONFIG, null);
  if (!cfg) {
    if (configMigrationError) {
      return `옛 설정을 새 자리로 옮기지 못했습니다 — ${configMigrationError}. 권한 등 원인을 고친 뒤 다시 부르면 자동으로 다시 옮겨집니다. ` +
        `그 전에 set_config 로 새로 저장하면 옛 학습규칙(merchantRules)을 잃으니 지금은 저장하지 마세요.`;
    }
    return '아직 저장된 설정이 없습니다. 먼저 get_names 로 앱에 등록된 카드·통장 이름을 읽고, 그 가운데 (1)일상지출 주력카드 (2)자동차·교통 카드 (3)이체·급여 통장 이 무엇인지 사용자에게 물어 set_config 로 저장하세요. get_names 가 사본이 없다고 하면 쓰는 카드·통장 이름부터 물으세요.';
  }
  const rules = cfg.merchantRules || {};
  const ruleCount = Object.keys(rules).length;
  let out = '현재 설정:\n' + JSON.stringify(cfg, null, 2);
  if (ruleCount) {
    out += `\n\n학습된 가맹점 규칙 ${ruleCount}개. hits≥3 은 자동적용해도 됨. hits<3 은 이번에도 사용자에게 한번 확인하고 set_config로 hits를 올리세요.`;
  }
  return out;
}

// set_config 는 "덮어쓰기"가 아니라 "부분 병합"이다.
//  - cards/accounts/기본결제수단: 인자로 준 것만 교체, 안 주면 기존 유지.
//  - merchantRules: 가맹점 단위로 병합하고 hits(확인 횟수)를 누적한다 → "쓸수록 똑똑" 학습의 저장소.
function doSetConfig(args) {
  ensureConfigMigrated();
  // 새 자리에 파일이 아직 없는데 옛 자리엔 있다 — 방금 이관을 시도했는데도 안 됐다는 뜻(위 함수가
  // 실패했거나, 옛 파일이 이번에도 읽기 불가). 여기서 그냥 진행하면 아래 prev 가 `{}` 가 되어
  // 학습규칙(merchantRules)을 통째로 덮어써 잃는다 — 저장을 멈추고 사람이 알아채게 한다.
  if (!fs.existsSync(CONFIG)) {
    const old = OLD_KAKEIBO_DIR ? path.join(OLD_KAKEIBO_DIR, '가계부-config.json') : '';
    if (old && fs.existsSync(old)) {
      throw new Error(
        `옛 설정(${old})을 새 자리로 옮기지 못해 저장을 멈춥니다 — 지금 저장하면 학습규칙을 잃습니다. ` +
        `(${configMigrationError || '원인 불명'})`
      );
    }
  }
  // 없는 파일은 "새로 시작"(fallback {}), 깨진 파일은 예외로 중단 — 깨진 채로 병합하면 조용히 비워진다.
  const prev = readJSONStrict(CONFIG, {});
  const cfg = {
    version: 1,
    받은편지함: inboxFile(),
    cards: args.cards !== undefined ? args.cards : (prev.cards || []),
    accounts: args.accounts !== undefined ? args.accounts : (prev.accounts || []),
    기본결제수단: args.defaultPayments !== undefined ? args.defaultPayments : (prev.기본결제수단 || {}),
    merchantRules: (prev.merchantRules && typeof prev.merchantRules === 'object') ? prev.merchantRules : {}
  };
  let learned = 0;
  if (args.merchantRules && typeof args.merchantRules === 'object') {
    for (const [rawKey, v] of Object.entries(args.merchantRules)) {
      if (!v || typeof v !== 'object') continue;
      const key = normMerchant(v.merchant || rawKey);
      if (!key) continue;
      const ex = cfg.merchantRules[key];
      // confirm:false 는 "아직 확정 아님(hits 안 올림)". 기본은 사용자 확인 1회로 간주해 hits+1.
      const bump = v.confirm === false ? 0 : 1;
      cfg.merchantRules[key] = {
        merchant: v.merchant || (ex && ex.merchant) || rawKey,
        category: v.category != null ? v.category : (ex ? ex.category : ''),
        payment: v.payment != null ? v.payment : (ex ? ex.payment : ''),
        hits: (ex ? ex.hits : 0) + bump,
        learnedAt: ex ? ex.learnedAt : todayStr(),
        updatedAt: todayStr()
      };
      learned++;
    }
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeJSONAtomic(CONFIG, cfg);
  let msg = '설정을 저장했어요 ✓';
  if (learned) msg += ` (가맹점 규칙 ${learned}개 학습/갱신)`;
  return msg;
}

// 사본에서 이름만 추린다. 사본이 없거나 못 읽으면 null — 「이름이 없다」와 「사본이 없다」를 섞지 않는다.
function appNames() {
  const st = readJSON(stateFile(), null);
  if (!st || typeof st !== 'object') return null;
  const pick = (list, more) => (Array.isArray(list) ? list : [])
    .filter(x => x && typeof x.name === 'string' && x.name.trim())
    .map(x => ({ name: x.name.trim(), ...more(x) }));
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    exportedAt: str(st.exportedAt) || '',
    accounts: pick(st.accounts, a => ({ type: str(a.type), bank: str(a.bank) })),
    cards: pick(st.cards, c => ({ type: str(c.type), company: str(c.company) })),
    categories: pick(st.categories, c => ({ type: str(c.type) })),
    liabilities: pick(st.liabilities, () => ({}))
  };
}

function doGetNames() {
  const blocked = blockedLocal();
  if (blocked) throw new Error(blocked);
  const app = appNames();
  if (!app) {
    // 아직 안 내려온 아이클라우드 파일은 `.state.json.icloud` 자리표시로만 있다.
    const placeholder = fs.existsSync(path.join(path.dirname(stateFile()), '.state.json.icloud'));
    return (placeholder
      ? '가계부엉 사본이 아직 아이클라우드에서 안 내려왔습니다. 잠시 뒤 다시 부르세요. '
      : '가계부엉 사본(state.json)이 없습니다. 맥에서 가계부엉을 켜고 설정 → 「클로드 연동」을 켜면 생깁니다. ') +
      '그 전에는 사용자에게 쓰는 카드·통장 이름을 물어 set_config 로 저장하고 진행하세요.';
  }
  const line = x => '- ' + x.name + [x.type, x.bank, x.company].filter(Boolean).map(v => ` (${v})`).join('');
  const sec = (title, list) => `${title} ${list.length}개\n` + (list.length ? list.map(line).join('\n') : '- (없음)');
  const exp = app.categories.filter(c => c.type !== 'income'), inc = app.categories.filter(c => c.type === 'income');
  let out = '가계부엉에 등록된 이름입니다. payment·toAccount·category 는 **이 글자 그대로** 보내세요.\n' +
    `사본 시각: ${app.exportedAt || '모름'} (UTC)\n\n` +
    [sec('통장', app.accounts), sec('카드', app.cards), sec('지출 분류', exp), sec('수입 분류', inc)].join('\n\n');
  if (app.liabilities.length) out += '\n\n' + sec('부채(원금 상환 이체의 toAccount 로 씀)', app.liabilities);
  const age = app.exportedAt ? (Date.now() - Date.parse(app.exportedAt)) / 86400000 : NaN;
  if (Number.isFinite(age) && age > 7) {
    out += `\n\n⚠️ 사본이 ${Math.floor(age)}일 전 것입니다. 그 뒤 앱에서 이름을 바꿨을 수 있으니, 맥에서 가계부엉을 한 번 켜 달라고 하세요.`;
  }
  out += '\n\n여기 없는 카드·통장·분류가 캡처에 나오면 추측하지 말고, 사용자에게 앱에 추가할지 물으세요.';
  return out;
}

// 사본의 거래를 기간으로 잘라 돌려준다. 지출 질문에 답하고, 보내기 전에 이미 들어간 거래를 거르는 데 쓴다.
// 금액은 사본에 적힌 그대로다. 합계는 여기서 내지 않는다 — 월할·환급(음수)·이체를 어떻게 볼지는 질문마다 다르다.
const TX_LIMIT = 500;
function doGetTransactions(args) {
  const blocked = blockedLocal();
  if (blocked) throw new Error(blocked);
  const st = readJSON(stateFile(), null);
  if (!st || !Array.isArray(st.transactions)) {
    return '가계부엉 사본(state.json)이 없어 거래를 읽을 수 없습니다. 맥에서 가계부엉을 켜고 설정 → 「클로드 연동」을 켜면 생깁니다.';
  }
  const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const today = todayStr();
  const from = isDay(args.from) ? args.from : today.slice(0, 8) + '01';
  const to = isDay(args.to) ? args.to : '9999-12-31';
  if (from > to) throw new Error('from 이 to 보다 뒤입니다');
  const eq = (want, got) => !want || String(got || '').trim() === String(want).trim();
  const rows = st.transactions
    .filter(t => t && isDay(t.date) && t.date >= from && t.date <= to &&
                 eq(args.payment, t.payment) && eq(args.category, t.category) && eq(args.type, t.type))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const shown = rows.slice(0, TX_LIMIT);
  const cell = v => String(v == null ? '' : v).replace(/[|\n]/g, ' ').trim();
  let out = `가계부엉 거래 ${rows.length}건 (${from} 부터 ${to === '9999-12-31' ? '끝' : to} 까지` +
    [args.payment && ` · 결제수단 ${args.payment}`, args.category && ` · 분류 ${args.category}`, args.type && ` · 유형 ${args.type}`].filter(Boolean).join('') + ')\n' +
    `사본 시각: ${typeof st.exportedAt === 'string' ? st.exportedAt : '모름'} (UTC) — 그 뒤에 앱에서 넣거나 고친 것은 여기 없습니다.\n` +
    '날짜 | 유형 | 내용 | 금액 | 결제수단 | 분류 | 입금 계좌 | 월할\n' +
    shown.map(t => [t.date, t.type, t.desc, t.amount, t.payment, t.category, t.toAccount,
                    Number(t.splitMonths) > 1 ? t.splitMonths + '개월' : ''].map(cell).join(' | ')).join('\n');
  if (rows.length > shown.length) out += `\n… ${rows.length - shown.length}건 더 있습니다. 기간을 좁혀 다시 부르세요.`;
  out += '\n\n읽는 법: expense=지출(음수는 환급), income=수입, accountTransfer=내 통장끼리 이체(지출 아님), transfer=남에게 보낸 이체. ' +
    '「소수점 쓰기」를 켠 장부는 금액의 마지막 두 자리가 소수점 아래입니다. 합계를 말할 때는 무엇을 더했는지 같이 밝히세요.';
  return out;
}

function configNames() {
  const cfg = readJSON(CONFIG, null);
  const s = new Set();
  if (cfg) {
    (cfg.cards || []).forEach(c => c && c.name && s.add(String(c.name).trim()));
    (cfg.accounts || []).forEach(a => a && a.name && s.add(String(a.name).trim()));
  }
  return s;
}
function suggestName(name, names) {
  const n = String(name || '').replace(/\s/g, '');
  for (const x of names) { const xn = x.replace(/\s/g, ''); if (xn === n || xn.includes(n) || n.includes(xn)) return x; }
  return null;
}
// 급여명세서 → 가계부엉 월별 급여 표(부엉 9단계). 가계부엉 InboxSalary 가 읽는 모양으로만 싣는다.
const SALARY_FIELDS = ['salary', 'nonTax', 'pension', 'health', 'ltc', 'emp', 'incomeTax', 'localTax'];
function cleanSalary(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('salary 는 {year, months} 객체여야 합니다');
  const year = Number(s.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('salary.year 는 연도(정수)여야 합니다');
  const months = {}, warns = [];
  for (const [m, row] of Object.entries(s.months || {})) {
    const mi = Number(m);
    if (!Number.isInteger(mi) || mi < 1 || mi > 12 || !row || typeof row !== 'object') { warns.push(`급여명세서 달 "${m}" 건너뜀`); continue; }
    const out = {};
    for (const k of SALARY_FIELDS) {
      if (row[k] === undefined || row[k] === null || row[k] === '') continue;
      const v = Number(String(row[k]).replace(/,/g, ''));
      if (!Number.isFinite(v) || v < 0) { warns.push(`급여명세서 ${mi}월 ${k} 숫자 아님 — 뺌`); continue; }
      out[k] = Math.round(v);
    }
    if (Object.keys(out).length) months[String(mi)] = out;
  }
  // 넣을 달이 하나도 없으면 싣지 않는다 — 빈 묶음은 가계부엉이 「읽지 못함」으로 남겨 받은편지함을 막는다.
  if (!Object.keys(months).length) throw new Error('salary.months 에 넣을 달이 없습니다' + (warns.length ? ' (' + warns.join(' / ') + ')' : ''));
  return { year, months, warns };
}

function doAddTransactions(args) {
  ensureConfigMigrated();   // config 를 아직 못 옮겼으면 여기서도 다시 시도 — 실패해도 거래 기록 자체는 막지 않는다
  const NEW = Array.isArray(args.transactions) ? args.transactions : [];
  const hasOps = Array.isArray(args.balances) || Array.isArray(args.cardTotals) ||
                 Array.isArray(args.edits) || Array.isArray(args.deletes) || typeof args.verified === 'boolean' ||
                 args.salary !== undefined;
  if (!NEW.length && !hasOps) return '추가할 거래가 없습니다.';
  const blocked = blockedLocal();
  if (blocked) throw new Error(blocked);
  const INBOX = inboxFile();
  const cur = readJSONStrict(INBOX, { version: 1, transactions: [] });
  if (!cur.transactions) cur.transactions = [];
  const cfg = readJSON(CONFIG, null) || {};
  const names = configNames();
  // 앱 사본이 있으면 그것이 정본이다 — 설정(config)의 이름은 사람이 불러 준 것이라 낡거나 틀릴 수 있다.
  const app = appNames();
  const appPay = app && new Set([...app.accounts, ...app.cards].map(x => x.name));
  const appTo = app && new Set([...app.accounts, ...app.liabilities].map(x => x.name));
  const appCat = app && new Set(app.categories.map(x => x.name));
  const nameWarns = new Set();
  const checkName = (kind, value, set) => {
    const v = String(value || '').trim();
    if (!v || !set || !set.size || set.has(v)) return;
    const sug = suggestName(v, set);
    nameWarns.add(`${kind} "${v}" 은(는) 가계부엉에 없는 이름${sug ? ` → "${sug}" 아닌가요?` : ''}`);
  };
  const rules = cfg.merchantRules || {};
  const seen = new Set(cur.transactions.map(txKey));
  let added = 0, skipped = 0, autofilled = 0; const warns = [], taxWarns = [];
  const VALID_TYPES = new Set(['expense', 'income', 'accountTransfer', 'transfer']);
  // 계좌이체에서 뜻이 있는 세법분류 — 가계부엉·웹앱이 받는 통장 종류로 다는 값(ACCOUNT_TAX_MAP)과 같다.
  // 엔진은 유형을 가리지 않고 분류로 세지만, 이체에 「의료비」 같은 값이 붙으면 공제가 부풀어서 여기서 막는다.
  // 「연금계좌」는 엔진이 세지 않는 이름이라(연금저축·IRP 만 센다) 이체에는 받지 않는다.
  const TRANSFER_TAX_CATS = new Set(['연금저축', 'IRP', '청약저축']);
  const VALID_TAX_CATS = new Set(['의료비', '교육비', '기부금', '고향사랑기부', '정치자금기부', '월세', '보장성보험료', '연금저축', 'IRP', '연금계좌', '청약저축', '주택대출이자', '전세자금원리금']);
  // 급여명세서는 거래보다 먼저 검사한다 — 틀린 salary 가 거래를 다 모은 뒤에야 호출 전체를 멈추지 않게.
  // 같은 해면 달을 합친다(아직 맥이 안 넣은 달을 덮어 잃지 않게). 다른 해가 남아 있으면 멈춘다.
  let salaryMonths = 0;
  if (args.salary !== undefined) {
    const s = cleanSalary(args.salary);
    const prev = cur.salary && typeof cur.salary === 'object' ? cur.salary : null;
    const prevMonths = prev && prev.months && typeof prev.months === 'object' ? prev.months : {};
    if (prev && Number(prev.year) !== s.year && Object.keys(prevMonths).length) {
      throw new Error(`${prev.year}년 급여명세서가 아직 가계부엉에 안 들어갔습니다 — 맥 가계부엉을 켜서 반영한 뒤 다시 보내세요`);
    }
    cur.salary = { year: s.year, months: { ...(prev && Number(prev.year) === s.year ? prevMonths : {}), ...s.months } };
    salaryMonths = Object.keys(s.months).length;
    taxWarns.push(...s.warns);
  }
  for (const t of NEW) {
    if (!t || !t.date || !t.desc || !Number.isFinite(Number(t.amount)) || Number(t.amount) === 0) { skipped++; continue; }   // 음수 허용(보험금 환급 = 건강지출 차감 등)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) { skipped++; continue; }   // YYYY-MM-DD 아니면 건너뜀(유령거래 방지)
    const obj = {
      date: t.date, desc: t.desc, amount: Number(t.amount),
      payment: t.payment || '', category: t.category || '',
      type: VALID_TYPES.has(t.type) ? t.type : 'expense', cashReceipt: !!t.cashReceipt
    };
    // 연말정산 세법분류: 지출과 계좌이체(연금·청약 납입)에만 유효. 오타 방지를 위해 허용 목록 밖은 버리고 경고한다.
    // 이체에는 대상(taxBeneficiary)을 싣지 않는다 — 엔진이 연금계좌 공제를 본인 것만 센다.
    if (t.taxCategory) {
      if (obj.type === 'accountTransfer') {
        if (TRANSFER_TAX_CATS.has(t.taxCategory)) obj.taxCategory = t.taxCategory;
        else taxWarns.push(`"${obj.desc}" 이체 세법분류는 연금저축·IRP·청약저축만 됩니다 — 무시함`);
      }
      else if (obj.type !== 'expense') taxWarns.push(`"${obj.desc}" 세법분류는 지출·계좌이체에만 적용됩니다 — 무시함`);
      else if (!VALID_TAX_CATS.has(t.taxCategory)) taxWarns.push(`세법분류 "${t.taxCategory}" 알 수 없음 — 무시함`);
      else {
        obj.taxCategory = t.taxCategory;
        if (t.taxBeneficiary) obj.taxBeneficiary = t.taxBeneficiary;
      }
    }
    // 학습된 가맹점 규칙 자동적용: 클로드가 category/payment를 비워 보내면 config의 규칙으로 채운다(서버측 안전망).
    if (obj.type === 'expense' && (!obj.category || !obj.payment)) {
      const r = lookupRule(rules, obj.desc);
      if (r) {
        if (!obj.category && r.category) { obj.category = r.category; autofilled++; }
        if (!obj.payment && r.payment) { obj.payment = r.payment; }
      }
    }
    if (t.toAccount) obj.toAccount = t.toAccount;
    // 연납·다개월 일시결제 월할: 2 이상 정수만 의미 있음(1·미지정 = 월할 없음). 앱이 "월할 보기"에서 N개월 균등 배분.
    { const sm = parseInt(t.splitMonths, 10); if (Number.isFinite(sm) && sm > 1) obj.splitMonths = Math.min(sm, 60); }
    const k = txKey(obj);
    if (seen.has(k)) { skipped++; continue; }
    if (app) {
      checkName('결제수단', obj.payment, appPay);
      checkName('입금 계좌', obj.toAccount, appTo);
      checkName('분류', obj.category, appCat);
    } else if (names.size && obj.payment && !names.has(obj.payment.trim())) {
      const sug = suggestName(obj.payment, names);
      warns.push(`결제수단 "${obj.payment}" 미등록${sug ? ` → "${sug}" 아닌가요?` : ''}`);
    }
    seen.add(k); cur.transactions.push(obj); added++;
  }
  // 단언/카드합계/수정 작업은 현재 상태에 대한 주장이므로 통째로 덮어쓴다.
  if (Array.isArray(args.balances)) cur.balances = args.balances;
  if (Array.isArray(args.cardTotals)) cur.cardTotals = args.cardTotals;
  if (Array.isArray(args.edits)) {
    // set.taxCategory 만 검사한다: 허용 값이거나 빈 글자(표시 지우기). 틀린 값은 그 칸만 빼고,
    // 바꿀 칸이 하나도 안 남은 수정은 통째로 뺀다(가계부엉도 빈 set 은 버린다). 나머지 칸은 예전처럼 그대로 싣는다.
    cur.edits = args.edits.flatMap(e => {
      if (!e || typeof e !== 'object' || !e.set || typeof e.set !== 'object' || !('taxCategory' in e.set)) return [e];
      const set = { ...e.set };
      const tc = typeof set.taxCategory === 'string' ? set.taxCategory.trim() : set.taxCategory;
      const isTransfer = e.find && e.find.type === 'accountTransfer';
      if (tc === '') set.taxCategory = '';
      else if (typeof tc !== 'string' || !VALID_TAX_CATS.has(tc)) {
        taxWarns.push(`수정 세법분류 "${set.taxCategory}" 알 수 없음 — 그 칸 뺌`); delete set.taxCategory;
      } else if (isTransfer && !TRANSFER_TAX_CATS.has(tc)) {
        taxWarns.push(`이체 수정 세법분류는 연금저축·IRP·청약저축만 됩니다 ("${tc}") — 그 칸 뺌`); delete set.taxCategory;
      } else set.taxCategory = tc;
      return Object.keys(set).length ? [{ ...e, set }] : [];
    });
  }
  if (app && Array.isArray(cur.edits) && Array.isArray(args.edits)) {
    cur.edits.forEach(e => e && e.set && checkName('분류', e.set.category, appCat));
  }
  if (Array.isArray(args.deletes)) cur.deletes = args.deletes;
  // verified 는 "이 파일이 완전한 명세서인가"에 대한 주장이라 켜고 끄기가 둘 다 뜻이 있다.
  if (typeof args.verified === 'boolean') cur.verified = args.verified;
  cur.version = 1;
  const writes = writeInboxAll(cur);
  // 한 곳도 못 썼으면 그건 진짜 실패다. 거래를 기록했다고 말하면 안 된다.
  if (!writes.some(w => w.ok)) {
    throw new Error('받은편지함을 한 곳에도 쓰지 못했습니다 — ' +
      writes.map(w => `${w.label}: ${w.error}`).join(' / '));
  }
  let msg = `가계부 받은편지함에 ${added}건 기록 (중복 ${skipped}건 제외).`;
  const extra = [];
  if (autofilled) extra.push(`학습규칙 자동분류 ${autofilled}`);
  if (args.salary !== undefined) extra.push(`급여명세서 ${salaryMonths}개월`);
  if (args.balances) extra.push(`잔액대조 ${args.balances.length}`);
  if (args.cardTotals) extra.push(`카드합계 ${args.cardTotals.length}`);
  if (args.edits) extra.push(`수정 ${cur.edits.length}`);
  if (args.deletes) extra.push(`삭제 ${args.deletes.length}`);
  if (typeof args.verified === 'boolean') extra.push(`완전명세 ${args.verified ? 'on' : 'off'}`);
  if (extra.length) msg += ' (' + extra.join(' · ') + ' 포함)';
  if (warns.length) msg += `\n⚠️ ${warns.join(' / ')} — config 등록명과 정확히 일치해야 매칭됩니다.`;
  if (nameWarns.size) {
    msg += `\n⚠️ ${[...nameWarns].join(' / ')} — 받은편지함에는 들어갔지만 이대로 반영하면 없는 이름으로 남습니다. ` +
      `get_names 로 이름을 확인해 사용자에게 알리고, 분류는 반영 뒤 edits 로 고치거나 앱에 그 이름을 추가하게 하세요.`;
  }
  if (taxWarns.length) msg += `\n⚠️ ${taxWarns.join(' / ')}`;
  msg += `\n가계부엉을 열면 받은편지함 뱃지가 떠요.`;
  return msg;
}

const TOOLS = [
  {
    name: 'get_names',
    description: '가계부엉 앱에 등록된 통장·카드·분류·부채 **이름**을 가져온다(금액·거래는 안 가져온다). ' +
      '거래를 넣기 전에 먼저 불러 payment·toAccount·category 를 이 이름 그대로 쓸 것 — 사용자에게 카드 이름을 묻기 전에 이것부터. ' +
      '사본이 없다고 나오면 사용자에게 이름을 물어 set_config 로 저장.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_transactions',
    description: '가계부엉에 이미 들어 있는 거래를 기간으로 읽는다(읽기 전용, 맥 앱이 둔 사본 기준). ' +
      '쓰는 때: ① 「이번 달 얼마 썼지」 같은 지출 질문 ② 캡처를 넣기 전에 그 기간에 이미 들어간 거래를 확인해 겹치는 것을 빼고 보낼 때. ' +
      '통장 잔액은 주지 않는다. 답 첫머리의 사본 시각을 보고, 오래됐으면 그 사실을 사용자에게 말할 것.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD. 비우면 이번 달 1일' },
        to: { type: 'string', description: 'YYYY-MM-DD. 비우면 끝까지' },
        payment: { type: 'string', description: '이 결제수단만 (get_names 의 이름 그대로)' },
        category: { type: 'string', description: '이 분류만 (get_names 의 이름 그대로)' },
        type: { type: 'string', enum: ['expense', 'income', 'accountTransfer', 'transfer'] }
      }
    }
  },
  {
    name: 'get_config',
    description: '클로드가 기억해 둔 기본결제수단과 가맹점 학습규칙을 가져온다. 거래를 분류하기 전에 get_names 와 함께 호출. 카드·통장 이름은 get_names 가 정본이고, 사본이 없을 때만 사용자에게 물어 set_config 로 저장.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_config',
    description:
      '사용자의 카드/계좌/기본결제수단을 저장한다. 부분 병합이라 준 필드만 바뀌고 나머지·기존 학습규칙은 유지된다. ' +
      'cards: [{name, company}], accounts: [{name, bank, type}], 기본결제수단: {일상, 자동차교통, 이체급여}. ' +
      'merchantRules: 사용자가 가맹점의 카테고리/결제수단을 확인해줄 때마다 저장 → 다음엔 자동분류(쓸수록 똑똑해지는 학습). 사용자 확인 1회당 hits가 1씩 누적된다.',
    inputSchema: {
      type: 'object',
      properties: {
        cards: { type: 'array', items: { type: 'object' } },
        accounts: { type: 'array', items: { type: 'object' } },
        defaultPayments: { type: 'object', description: '{일상, 자동차교통, 이체급여} 기본결제수단' },
        merchantRules: {
          type: 'object',
          description:
            '가맹점명 → 규칙 맵. { "스타벅스": {merchant:"스타벅스", category:"식비", payment:"주력카드"} } 형태. ' +
            'category/payment는 config 등록명과 일치. 사용자가 확정하지 않은 잠정 추론이면 그 값에 confirm:false 를 넣어 hits를 올리지 않는다.'
        }
      }
    }
  },
  {
    name: 'add_transactions',
    description:
      '통장·카드 캡처(또는 텍스트)에서 추출한 거래를 가계부에 추가한다. ' +
      '⚠️ 거래와 함께 대조값을 **반드시 같은 호출에** 실을 것: 통장 내역이면 balances(그 계좌 최신 잔액), 카드 거래는 cardTotals 를 **거래가 걸친 달마다 하나씩**(9월 말부터 10월 초를 넣으면 9월·10월 둘 다) — 카드 합계 대조는 달 단위라 합계를 안 보낸 달은 아무것도 확인되지 않는다. 합계는 카드사 앱·명세서의 그 달 이용 합계를 쓰고, 여러 카드가 합쳐진 금액(토스 등)은 쓰지 말 것. ' +
      '이 둘이 받은편지함 「잔액·합계 대조」 칸의 유일한 입력이라, 빠지면 대조 칸이 아예 안 뜨고 빠진·겹친 거래를 못 잡는다. 화면에 잔액·합계가 없을 때만 생략. ' +
      'balances·cardTotals·edits 는 덧붙이기가 아니라 덮어쓰기라 나눠 보내면 앞의 것이 사라진다 — 한 번에 묶어 보낼 것. ' +
      '먼저 get_names 로 앱에 등록된 이름을, get_config 로 기본결제수단·학습규칙을 확인. 분류는 get_names 의 이름 중에서 고르고, 사본이 없을 때만 다음 기본값을 쓴다 — 약국·병원→건강, 카페·편의점·배달·식당→식비, 네이버페이·쿠팡·올리브영→생활용품, 주유·택시·하이패스·대중교통→교통/차량, 애플·넷플릭스·구독→구독료, 휴대폰요금→통신, 전기·가스·수도→공과금, 기부·후원→기부, 관리비·월세→주거. ' +
      '결제수단(payment): 캡처에 명시되면 그것, 아니면 config의 기본결제수단. "취소"·"승인취소" 거래는 제외. 애매하면 사용자에게 물을 것. ' +
      '이미 들어간 거래의 상호 표기를 고칠 때도 edits[].set.desc 로 보내면 되고, 금액·날짜 정정과 똑같이 받은편지함에서 사용자가 확인해야 반영된다.',
    inputSchema: {
      type: 'object',
      properties: {
        transactions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'YYYY-MM-DD' },
              desc: { type: 'string', description: '상호/내용' },
              amount: { type: 'number', description: '양수. **사람 눈에 보이는 금액**을 그대로 — 12,000원이면 12000, $12.34 면 12.34. 앱이 제 「소수점 쓰기」 설정에 맞춰 저장한다(소수는 그 설정이 켜진 장부에서만 받는다)' },
              payment: { type: 'string', description: '카드/계좌 이름 (get_names 의 이름과 정확히 일치)' },
              category: { type: 'string', description: '분류 이름 (get_names 의 이름과 정확히 일치)' },
              type: { type: 'string', enum: ['expense', 'income', 'accountTransfer', 'transfer'] },
              toAccount: { type: 'string', description: 'accountTransfer일 때 입금 계좌' },
              cashReceipt: { type: 'boolean' },
              taxCategory: {
                type: 'string',
                enum: ['의료비', '교육비', '기부금', '고향사랑기부', '정치자금기부', '월세', '보장성보험료', '연금저축', 'IRP', '연금계좌', '청약저축', '주택대출이자', '전세자금원리금'],
                description: '연말정산 세법분류. 지출(expense)과 계좌이체(accountTransfer)에만 유효. 병원·약국·한의원→의료비, 학원·교재·등록금→교육비, 후원·기부→기부금, 생명·손해보험료→보장성보험료, 월세→월세, 전세대출 원리금상환→전세자금원리금. ' +
                  '계좌이체는 연금저축·IRP·청약저축만 받는다(연금저축·IRP·청약 통장으로 넣은 돈). 비워 보내도 가계부엉이 받는 통장 종류로 채우지만, 알면 적을 것. 해당 없으면 생략.'
              },
              taxBeneficiary: { type: 'string', enum: ['self', 'spouse', 'dependent'], description: '세액공제 귀속자. 기본 self(본인)' },
              splitMonths: { type: 'integer', minimum: 2, maximum: 60, description: '연납·다개월 일시결제 월할 개월수. 사용자가 "연간결제/연납"이라 하면 12, 반기납 6, 분기납 3. 앱 "월할 보기"에서 결제월부터 N개월 균등 배분. 매월 결제·내구재·선불충전은 생략.' }
            },
            required: ['date', 'desc', 'amount']
          }
        },
        balances: {
          type: 'array',
          description: '통장 캡처의 최신 잔액 단언. 통장 거래를 보낼 때는 꼭 같이 보낼 것. 앱이 추가 후 계산잔액과 대조해 빠진/중복 거래를 잡는다.',
          items: { type: 'object', properties: { date: { type: 'string' }, account: { type: 'string', description: 'get_names 의 통장 이름' }, balance: { type: 'number' } }, required: ['account', 'balance'] }
        },
        cardTotals: {
          type: 'array',
          description: '카드 합계 단언 [{card, month(YYYY-MM), total}]. 카드 거래가 걸친 달마다, 카드마다 한 줄씩 보낼 것(달 단위 대조라 빠진 달은 확인이 안 된다). 앱이 그 달 카드 거래합계와 대조.',
          items: { type: 'object', properties: { card: { type: 'string' }, month: { type: 'string' }, total: { type: 'number' } }, required: ['card', 'total'] }
        },
        edits: {
          type: 'array',
          description: '기존 거래 수정. find로 1건 찾아 set 값으로 교체. 받은편지함에 "✏️수정 후보"로 뜨고 확인 후 적용. ' +
            '오수정 방지를 위해 find에 date·amount를 둘 다 줄 것 — 하나라도 없거나 2건 이상 걸리면 앱이 건너뛴다. ' +
            'set에 splitMonths(월할 개월, 1=해제)·category(분류)·desc(상호 표기)·taxCategory(세법분류, 빈 문자열이면 지우기)도 가능. ' +
            '연금·청약 이체에 빠진 세법분류를 채울 때도 edits 로 보낸다(이체는 연금저축·IRP·청약저축만). ' +
            'desc 정정도 금액·날짜와 똑같이 받은편지함에 뜨고 사용자가 확인해야 반영된다.',
          items: {
            type: 'object',
            properties: {
              find: { type: 'object', description: '{date, amount, payment?, desc?, type?, toAccount?}' },
              set: {
                type: 'object',
                description: '{date?,amount?,splitMonths?,category?,desc?,taxCategory?} — desc는 상호/내용 표기 정정' +
                  '("주식회사 두잇(20:20)"→"두잇", "APPLE_KCP"→"애플원"). 빈 문자열·공백만 주면 앱이 그 수정 op를 통째로 버린다.',
                properties: {
                  date: { type: 'string', description: 'YYYY-MM-DD' },
                  amount: { type: 'number' },
                  splitMonths: { type: 'integer', description: '월할 개월. 1이면 해제' },
                  category: { type: 'string', description: 'get_names 의 분류 이름' },
                  desc: { type: 'string', description: '고칠 상호/내용. 비우지 말 것' },
                  taxCategory: {
                    type: 'string',
                    enum: ['', '의료비', '교육비', '기부금', '고향사랑기부', '정치자금기부', '월세', '보장성보험료', '연금저축', 'IRP', '연금계좌', '청약저축', '주택대출이자', '전세자금원리금'],
                    description: '연말정산 세법분류. 빈 문자열이면 표시를 지운다. 계좌이체는 연금저축·IRP·청약저축만(find.type 을 accountTransfer 로 주면 서버가 검사)'
                  }
                }
              }
            },
            required: ['find', 'set']
          }
        },
        deletes: {
          type: 'array',
          description: '기존 거래 삭제. 받은편지함에 "🗑️지울 거래"로 뜨고 사용자가 확인해야 실제로 지워진다. ' +
            '되돌릴 수 없으니 find에 date·amount를 둘 다 줄 것 — 하나라도 없거나 정확히 1건을 가리키지 않으면 앱이 실행하지 않는다. ' +
            '중복 입력분 정리·승인취소 거래 제거에 쓴다.',
          items: { type: 'object', properties: { find: { type: 'object', description: '{date, amount, payment?, desc?, type?, toAccount?}' } }, required: ['find'] }
        },
        salary: {
          type: 'object',
          description: '급여명세서 캡처 → 가계부엉 월별 급여 표. {year, months:{"3":{salary,nonTax,pension,health,ltc,emp,incomeTax,localTax}}} 원 단위. ' +
            'salary=총지급액, nonTax=비과세, ltc=장기요양, emp=고용보험. 맥 가계부엉이 확인 없이 넣고, 이미 넣은 달은 다시 안 덮는다. ' +
            '명세서의 연말정산소득세·연말정산지방소득세(전년도 정산분) 줄은 넣지 말 것.',
          properties: {
            year: { type: 'integer' },
            months: { type: 'object', description: '달("1"부터 "12") → 칸 객체' }
          },
          required: ['year', 'months']
        },
        verified: {
          type: 'boolean',
          description: '완전한 명세서를 넘겼다는 표시. 켜면 앱이 ±3일 의심 단계와 수정 후보 자동감지를 건너뛴다. ' +
            '카드 명세서·통장 거래내역을 그 기간 전부 빠짐없이 넘길 때만 켤 것. 일부만 캡처한 경우엔 켜지 말 것.'
        }
      }
    }
  }
];

// 클로드 데스크톱에는 안내문 파일(CLAUDE.md)이 없다 — 여기 적은 것이 그쪽 클로드가 받는 규칙의 전부다.
const INSTRUCTIONS = [
  '가계부엉(아이폰·맥 가계부 앱)의 받은편지함에 거래를 넣는 도구다. 사용자가 카드·통장 캡처나 지출 내역을 주면 거래를 읽어 add_transactions 로 보내고, 사용자는 앱의 받은편지함에서 확인해 반영한다.',
  '순서: ① get_names 로 앱에 등록된 통장·카드·분류 이름을 읽는다 ② get_config 로 기본결제수단과 학습된 가맹점 규칙을 읽는다 ③ 거래를 뽑아 분류한다 ④ get_transactions 로 그 기간에 이미 들어간 거래를 보고 겹치는 것(날짜·금액·결제수단이 같은 것)을 뺀다 ⑤ add_transactions 한 번에 거래와 대조값(balances·cardTotals)을 같이 보낸다.',
  'payment·toAccount·category 는 get_names 의 이름을 글자 그대로 쓴다. 목록에 없는 카드·통장·분류가 나오면 추측하지 말고 사용자에게 앱에 추가할지 묻는다.',
  '분류나 결제수단이 애매하면 조용히 고르지 말고 번호 선택지로 묻는다. 사용자가 확인해 준 가맹점은 set_config 의 merchantRules 로 저장한다 — hits 가 3 이상인 규칙은 묻지 않고 적용해도 된다.',
  '「취소」·「승인취소」 거래는 넣지 않는다. 금액·날짜·상호는 캡처에 적힌 그대로 쓴다.',
  '지출 질문은 get_transactions 로 읽어 답한다. 이체(accountTransfer)는 지출에 넣지 않고, 합계에 무엇을 더했는지 밝힌다. 통장 잔액은 이 도구로 알 수 없으니 앱 화면을 보라고 안내한다.'
].join('\n');

// ---- JSON-RPC over stdio ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function ok(id, res) { send({ jsonrpc: '2.0', id, result: res }); }
function err(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handleToolCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  try {
    let text;
    if (name === 'get_names') text = doGetNames();
    else if (name === 'get_transactions') text = doGetTransactions(args);
    else if (name === 'get_config') text = doGetConfig();
    else if (name === 'set_config') text = doSetConfig(args);
    else if (name === 'add_transactions') text = doAddTransactions(args);
    else { return ok(id, { content: [{ type: 'text', text: '알 수 없는 도구: ' + name }], isError: true }); }
    ok(id, { content: [{ type: 'text', text }] });
  } catch (e) {
    ok(id, { content: [{ type: 'text', text: '오류: ' + (e && e.message) }], isError: true });
  }
}

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      ok(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'bueong', version: '1.1.1' },
        instructions: INSTRUCTIONS
      });
      break;
    case 'notifications/initialized':
    case 'initialized':
      break; // 알림 — 응답 없음
    case 'tools/list':
      ok(id, { tools: TOOLS });
      break;
    case 'tools/call':
      handleToolCall(id, params);
      break;
    case 'ping':
      ok(id, {});
      break;
    default:
      if (id !== undefined && id !== null) err(id, -32601, 'Method not found: ' + method);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line);
  }
});
// 입력이 끝나면 저절로 꺼지게 둔다. 여기서 process.exit 을 부르면 파이프에 아직 못 내보낸 답이 잘린다
// (도구 목록처럼 긴 답에서 실제로 잘렸다, 2026-10-03).
process.stdin.on('end', () => { process.exitCode = 0; });
