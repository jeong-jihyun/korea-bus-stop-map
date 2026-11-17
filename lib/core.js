// 검색 로직 (로컬 server.js 와 Vercel api/search.js 가 함께 사용)
const seoulApi = require('./seoul');
const BASE = 'https://apis.data.go.kr/1613000';

// ---------- 공공데이터 API 호출 ----------
async function tago(service, op, params) {
  const KEY = process.env.TAGO_API_KEY || '';
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
  if (seoulApi.inSeoul(lat, lng)) return seoulApi.search(bus, lat, lng, radius, dist); // 서울은 서울시 API
  const near = await tago('BusSttnInfoInqireService', 'getCrdntPrxmtSttnList',
    { gpsLati: lat, gpsLong: lng, numOfRows: 30, pageNo: 1 });
  const cities = [...new Set(near.map((s) => s.citycode).filter(Boolean))];
  if (!cities.length) return { error: '이 위치 근처에서 정류장 정보를 찾지 못했어요. 서울 등 일부 지역은 이 공공 데이터에 없을 수 있어요. 지도에서 다른 지역(예: 대전)을 눌러 보세요.' };

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


// ---------- 내 주변 정류장 + 거기 서는 버스 번호 ----------
// 1) 좌표 근처 정류장 조회  2) 정류장마다 경유 노선(버스 번호) 조회
async function nearby(lat, lng, radius) {
  if (seoulApi.inSeoul(lat, lng)) { // 서울은 서울시 API
    const r = await seoulApi.nearby(lat, lng, radius, dist);
    if (!r.stops.length) return { error: '이 위치 근처에서 서울 정류장을 찾지 못했어요. 반경을 넓혀 보세요.' };
    return r;
  }
  const list = await tago('BusSttnInfoInqireService', 'getCrdntPrxmtSttnList',
    { gpsLati: lat, gpsLong: lng, numOfRows: 30, pageNo: 1 });
  const stops = list.map((s) => ({
    nodeId: s.nodeid, name: s.nodenm, no: s.nodeno, cityCode: s.citycode,
    lat: +s.gpslati, lng: +s.gpslong,
    distance: Math.round(dist(lat, lng, +s.gpslati, +s.gpslong)),
  })).filter((s) => s.distance <= radius).sort((a, b) => a.distance - b.distance).slice(0, 10);
  if (!stops.length) {
    return { error: '이 위치 근처에서 정류장 정보를 찾지 못했어요. 서울 등 일부 지역은 이 공공 데이터에 없을 수 있어요. 지도에서 다른 지역(예: 대전)을 눌러 보세요.' };
  }
  let failed = 0, lastErr = '';
  await Promise.all(stops.map(async (s) => {
    try {
      const rs = await tago('BusSttnInfoInqireService', 'getSttnThrghRouteList',
        { cityCode: s.cityCode, nodeid: s.nodeId, nodeId: s.nodeId, numOfRows: 50, pageNo: 1 });
      const seen = new Set();
      s.routes = rs.filter((r) => { const k = r.routeno + '|' + r.routetp; if (seen.has(k)) return false; seen.add(k); return true; })
        .map((r) => ({ routeNo: String(r.routeno), type: r.routetp, from: r.startnodenm, to: r.endnodenm }))
        .sort((a, b) => a.routeNo.localeCompare(b.routeNo, 'ko', { numeric: true }));
    } catch (e) { failed++; lastErr = e.message; s.routes = []; }
  }));
  return { stops, routesError: failed === stops.length ? lastErr : null };
}

function demoNearby(lat, lng, radius) {
  const base = demo('', lat, lng, radius).stops.slice(0, 6);
  const sets = [['102', '5', '급행1'], ['102', '911'], ['5', '48', '602'], ['102'], ['911', '급행1'], ['48']];
  return { demo: true, stops: base.map((s, i) => ({ ...s, cityCode: 'DEMO', routes: sets[i % sets.length].map((n) => ({ routeNo: n, type: '샘플', from: '', to: '' })) })), routesError: null };
}

async function handleNearby(query) {
  const lat = parseFloat(query.lat);
  const lng = parseFloat(query.lng);
  const radius = Math.min(parseInt(query.radius || '500', 10) || 500, 3000);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return [400, { error: '위치가 필요해요.' }];
  try {
    const hasKey = !!process.env.TAGO_API_KEY;
    return [200, hasKey ? await nearby(lat, lng, radius) : demoNearby(lat, lng, radius)];
  } catch (e) { return [502, { error: e.message }]; }
}

// ---------- 지역 선택 / 전국 검색 ----------
// 도시 코드 목록 (전국 어느 도시가 데이터에 있는지)
async function cities() {
  const items = await tago('BusRouteInfoInqireService', 'getCtyCodeList', {});
  const list = items.map((x) => ({ code: String(x.citycode), name: x.cityname }));
  list.push({ code: 'seoul', name: '서울특별시' }); // TAGO 에 없어서 서울시 API 로 따로 처리
  return list.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

// 동시에 n개씩만 호출 (공공데이터 서버에 한꺼번에 몰리지 않게)
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0, failed = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { failed++; out[k] = null; }
    }
  }));
  return { out, failed };
}

// 버스 번호로 노선 찾기: city 가 'all' 이면 전국 모든 도시, 아니면 그 도시만
async function routesByNumber(bus, city, cityName) {
  const list = city === 'all' ? await cities() : [{ code: String(city), name: cityName || '' }];
  const { out, failed } = await pool(list, 8, async (c) => {
    if (c.code === 'seoul') return seoulApi.routesByNumber(bus);
    const found = await tago('BusRouteInfoInqireService', 'getRouteNoList',
      { cityCode: c.code, routeNo: bus, numOfRows: 50, pageNo: 1 });
    return found.filter((r) => String(r.routeno) === bus).map((r) => ({
      cityCode: c.code, cityName: c.name, routeId: r.routeid, routeNo: String(r.routeno),
      type: r.routetp, from: r.startnodenm, to: r.endnodenm,
    }));
  });
  const routes = out.filter(Boolean).flat();
  return { routes, searched: list.length, failed };
}

// 노선 하나가 지나는 모든 정류장 (순서대로)
async function routeStops(city, routeId) {
  if (city === 'seoul') return seoulApi.routeStops(routeId);
  const list = await tago('BusRouteInfoInqireService', 'getRouteAcctoThrghSttnList',
    { cityCode: city, routeId, numOfRows: 300, pageNo: 1 });
  const stops = list.map((s) => ({
    nodeId: s.nodeid, name: s.nodenm, no: s.nodeno, lat: +s.gpslati, lng: +s.gpslong, order: +s.nodeord || 0,
  })).filter((s) => !Number.isNaN(s.lat) && !Number.isNaN(s.lng))
    .sort((a, b) => a.order - b.order);
  return { stops };
}

function demoCities() { return [{ code: '25', name: '대전광역시(샘플)' }, { code: '21', name: '부산광역시(샘플)' }]; }
function demoRoutes(bus) {
  return { demo: true, searched: 2, failed: 0, routes: [
    { cityCode: '25', cityName: '대전광역시(샘플)', routeId: 'DEMO1', routeNo: bus, type: '샘플', from: '샘플 기점', to: '샘플 종점' },
    { cityCode: '21', cityName: '부산광역시(샘플)', routeId: 'DEMO2', routeNo: bus, type: '샘플', from: '샘플 기점', to: '샘플 종점' }] };
}
function demoRouteStops() {
  const names = ['기점', '시청앞', '역앞', '대학교', '공원', '종점'];
  return { demo: true, stops: names.map((n, i) => ({ nodeId: 'D' + i, name: '샘플 ' + n, no: String(1000 + i), lat: 36.3504 + i * 0.004, lng: 127.3845 + i * 0.003, order: i + 1 })) };
}

async function handleCities() {
  try { return [200, { cities: process.env.TAGO_API_KEY ? await cities() : demoCities() }]; }
  catch (e) { return [502, { error: e.message }]; }
}

async function handleRoutes(query) {
  const bus = String(query.bus || '').trim();
  const city = String(query.city || '').trim();
  if (!bus || !city) return [400, { error: '버스 번호와 지역이 필요해요.' }];
  try {
    if (!process.env.TAGO_API_KEY) return [200, demoRoutes(bus)];
    const r = await routesByNumber(bus, city, String(query.cityName || ''));
    return [200, r];
  } catch (e) { return [502, { error: e.message }]; }
}

async function handleRouteStops(query) {
  const city = String(query.city || '').trim();
  const routeId = String(query.routeId || '').trim();
  if (!city || !routeId) return [400, { error: '지역과 노선이 필요해요.' }];
  try {
    return [200, process.env.TAGO_API_KEY ? await routeStops(city, routeId) : demoRouteStops()];
  } catch (e) { return [502, { error: e.message }]; }
}

// 요청 값 검사 + 실제/데모 선택
async function handle(query) {
  const bus = String(query.bus || '').trim();
  const lat = parseFloat(query.lat);
  const lng = parseFloat(query.lng);
  const radius = Math.min(parseInt(query.radius || '1000', 10) || 1000, 5000);
  if (!bus || Number.isNaN(lat) || Number.isNaN(lng)) return [400, { error: '버스 번호와 위치가 필요해요.' }];
  try {
    const hasKey = !!process.env.TAGO_API_KEY;
    return [200, hasKey ? await search(bus, lat, lng, radius) : demo(bus, lat, lng, radius)];
  } catch (e) { return [502, { error: e.message }]; }
}

module.exports = { handle, handleNearby, handleCities, handleRoutes, handleRouteStops };
