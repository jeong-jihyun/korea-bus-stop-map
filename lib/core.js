// 검색 로직 (로컬 server.js 와 Vercel api/search.js 가 함께 사용)
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

module.exports = { handle };
