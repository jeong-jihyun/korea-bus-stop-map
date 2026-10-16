// 전국 버스정류장 지도 - 간단한 서버 (외부 패키지 없음, Node 18 이상)
// 하는 일: 브라우저 대신 공공데이터포털(TAGO) API를 호출해서 결과를 정리해 돌려줍니다.
const http = require('http');
const fs = require('fs');
const path = require('path');

// .env 파일에서 키 읽기
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* .env 없으면 데모 모드 */ }

const KEY = process.env.TAGO_API_KEY || '';
const PORT = process.env.PORT || 3000;
const BASE = 'https://apis.data.go.kr/1613000';

// ---------- 공공데이터 API 호출 ----------
async function tago(service, op, params) {
  const key = KEY.includes('%') ? KEY : encodeURIComponent(KEY); // Encoding/Decoding 키 둘 다 허용
  const qs = Object.entries({ ...params, _type: 'json' })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const res = await fetch(`${BASE}/${service}/${op}?serviceKey=${key}&${qs}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error('공공데이터 API 응답을 읽지 못했어요. 인증키와 활용신청 상태를 확인하세요. (' + text.slice(0, 100) + ')'); }
  const header = json.response && json.response.header;
  if (header && header.resultCode && header.resultCode !== '00') {
    throw new Error(`API 오류 ${header.resultCode}: ${header.resultMsg}`);
  }
  const items = json.response && json.response.body && json.response.body.items;
  if (!items || items === '') return [];
  const item = items.item;
  return item == null ? [] : Array.isArray(item) ? item : [item];
}

// 두 좌표 사이 거리(m)
function dist(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- 실제 검색 ----------
// 1) 내 위치 근처 정류장 -> 어느 도시(cityCode)인지 알아냄
// 2) 그 도시에서 버스 번호로 노선 찾기
// 3) 노선이 지나는 정류장 중 내 위치 반경 안에 있는 것만 고르기
async function search(bus, lat, lng, radius) {
  const near = await tago('BusSttnInfoInqireService', 'getCrdntPrxmtSttnList',
    { gpsLati: lat, gpsLong: lng, numOfRows: 30, pageNo: 1 });
  const cities = [...new Set(near.map((s) => s.citycode).filter(Boolean))];
  if (!cities.length) return { error: '이 위치 근처에서 정류장 정보를 찾지 못했어요.' };

  for (const cityCode of cities) {
    const found = await tago('BusRouteInfoInqireService', 'getRouteNoList',
      { cityCode, routeNo: bus, numOfRows: 50, pageNo: 1 });
    const routes = found.filter((r) => String(r.routeno) === bus).slice(0, 6);
    if (!routes.length) continue;

    const stops = new Map();
    for (const r of routes) {
      const list = await tago('BusRouteInfoInqireService', 'getRouteAcctoThrghSttnList',
        { cityCode, routeId: r.routeid, numOfRows: 300, pageNo: 1 });
      for (const s of list) {
        const d = dist(lat, lng, +s.gpslati, +s.gpslong);
        if (d > radius) continue;
        const e = stops.get(s.nodeid) ||
          { nodeId: s.nodeid, name: s.nodenm, no: s.nodeno, lat: +s.gpslati, lng: +s.gpslong, distance: Math.round(d), routeIds: [] };
        e.routeIds.push(r.routeid);
        stops.set(s.nodeid, e);
      }
    }
    return {
      cityCode,
      routes: routes.map((r) => ({ routeId: r.routeid, routeNo: r.routeno, type: r.routetp, from: r.startnodenm, to: r.endnodenm })),
      stops: [...stops.values()].sort((a, b) => a.distance - b.distance),
    };
  }
  return { error: `이 근처 지역에서 "${bus}"번 버스를 찾지 못했어요.` };
}

// ---------- 데모 모드 (인증키 없을 때 가짜 데이터) ----------
function demo(bus, lat, lng, radius) {
  const names = ['시청앞', '서울광장', '덕수궁', '대한문', '프레스센터', '남대문시장', '서울역버스환승센터', '숭례문', '을지로입구', '명동입구'];
  const stops = names.map((name, i) => {
    const ang = (i / names.length) * Math.PI * 2;
    const r = Math.min(radius, 1200) * (0.25 + 0.7 * ((i * 37) % 10) / 10);
    return {
      nodeId: 'DEMO' + i, name, no: String(1000 + i),
      lat: lat + (r * Math.cos(ang)) / 111000,
      lng: lng + (r * Math.sin(ang)) / (111000 * Math.cos((lat * Math.PI) / 180)),
      distance: Math.round(r), routeIds: ['DEMO'],
    };
  }).sort((a, b) => a.distance - b.distance);
  return {
    demo: true, cityCode: 'DEMO',
    routes: [{ routeId: 'DEMO', routeNo: bus, type: '샘플', from: '샘플 기점', to: '샘플 종점' }],
    stops,
  };
}

// ---------- 서버 ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/search') {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    const bus = (u.searchParams.get('bus') || '').trim();
    const lat = parseFloat(u.searchParams.get('lat'));
    const lng = parseFloat(u.searchParams.get('lng'));
    const radius = Math.min(parseInt(u.searchParams.get('radius') || '1000', 10) || 1000, 5000);
    if (!bus || Number.isNaN(lat) || Number.isNaN(lng)) return send(400, { error: '버스 번호와 위치가 필요해요.' });
    try { send(200, KEY ? await search(bus, lat, lng, radius) : demo(bus, lat, lng, radius)); }
    catch (e) { send(502, { error: e.message }); }
    return;
  }
  // 정적 파일
  const file = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : u.pathname);
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}  (${KEY ? '실제 데이터 모드' : '데모 모드 - .env에 TAGO_API_KEY를 넣으면 실제 데이터'})`);
});
