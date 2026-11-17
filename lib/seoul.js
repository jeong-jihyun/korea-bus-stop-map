// 서울시 버스 API (국토교통부 TAGO 에는 서울이 없어서 따로 연결)
//  - 정류소정보조회: https://www.data.go.kr/data/15000303/openapi.do
//  - 노선정보조회  : https://www.data.go.kr/data/15000193/openapi.do
// 인증키는 SEOUL_API_KEY, 없으면 TAGO_API_KEY 와 같은 공공데이터포털 키를 그대로 사용
const BASE = 'http://ws.bus.go.kr/api/rest';

const ROUTE_TYPES = { 0: '공용', 1: '공항', 2: '마을', 3: '간선', 4: '지선', 5: '순환', 6: '광역', 7: '인천', 8: '경기', 9: '폐지' };

// 서울 대략적인 범위 (이 안이면 서울 API 를 먼저 사용)
function inSeoul(lat, lng) {
  return lat >= 37.428 && lat <= 37.702 && lng >= 126.764 && lng <= 127.185;
}

function hasKey() { return !!(process.env.SEOUL_API_KEY || process.env.TAGO_API_KEY); }

// 서울 API 는 기본이 XML 이라, <itemList> 묶음을 간단히 객체 배열로 바꿈
function parseXml(xml) {
  const pick = (s, tag) => {
    const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : '';
  };
  const code = pick(xml, 'headerCd');
  const msg = pick(xml, 'headerMsg');
  const items = [];
  const re = /<itemList>([\s\S]*?)<\/itemList>/g;
  let m;
  while ((m = re.exec(xml))) {
    const o = {};
    const tre = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let t;
    while ((t = tre.exec(m[1]))) o[t[1]] = t[2].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
    items.push(o);
  }
  return { code, msg, items };
}

async function seoul(path, params) {
  const KEY = process.env.SEOUL_API_KEY || process.env.TAGO_API_KEY || '';
  const key = KEY.includes('%') ? KEY : encodeURIComponent(KEY);
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${BASE}/${path}?serviceKey=${key}&${qs}`);
  const text = await res.text();
  if (!text.includes('<msgHeader>')) {
    throw new Error('서울 버스 API 응답을 읽지 못했어요. 공공데이터포털에서 "서울특별시_정류소정보조회 서비스"와 "서울특별시_노선정보조회 서비스" 활용신청이 승인됐는지 확인하세요. (' + text.slice(0, 80) + ')');
  }
  const r = parseXml(text);
  if (r.code === '0') return r.items;
  if (r.code === '4') return []; // 결과 없음
  throw new Error(`서울 버스 API 오류 ${r.code}: ${r.msg}`);
}

// 내 주변 정류장 + 거기 서는 버스 번호
async function nearby(lat, lng, radius, dist) {
  const list = await seoul('stationinfo/getStaionsByPosList', { tmX: lng, tmY: lat, radius: Math.min(radius, 1500) });
  const stops = list.map((s) => ({
    nodeId: s.stationId, name: s.stationNm, no: s.arsId && s.arsId !== '0' ? s.arsId : '', cityCode: 'seoul',
    lat: +s.gpsY, lng: +s.gpsX,
    distance: Math.round(+s.dist || dist(lat, lng, +s.gpsY, +s.gpsX)),
  })).filter((s) => !Number.isNaN(s.lat) && !Number.isNaN(s.lng))
    .sort((a, b) => a.distance - b.distance).slice(0, 10);
  if (!stops.length) return { stops: [], routesError: null };

  let failed = 0, lastErr = '';
  await Promise.all(stops.map(async (s) => {
    try {
      const rs = await seoul('stationinfo/getRouteByStation', { arsId: s.no });
      const seen = new Set();
      s.routes = rs.filter((r) => { if (seen.has(r.busRouteId)) return false; seen.add(r.busRouteId); return true; })
        .map((r) => ({ routeNo: r.busRouteNm, type: ROUTE_TYPES[r.busRouteType] || '', from: r.stStationNm || '', to: r.edStationNm || '' }))
        .sort((a, b) => a.routeNo.localeCompare(b.routeNo, 'ko', { numeric: true }));
    } catch (e) { failed++; lastErr = e.message; s.routes = []; }
  }));
  return { stops, routesError: failed === stops.length ? lastErr : null };
}

// 버스 번호로 노선 찾기 (서울)
async function routesByNumber(bus) {
  const list = await seoul('busRouteInfo/getBusRouteList', { strSrch: bus });
  return list.filter((r) => r.busRouteNm === bus).map((r) => ({
    cityCode: 'seoul', cityName: '서울특별시', routeId: r.busRouteId, routeNo: r.busRouteNm,
    type: ROUTE_TYPES[r.routeType] || '', from: r.stStationNm || '', to: r.edStationNm || '',
  }));
}

// 노선이 지나는 모든 정류장 (순서대로)
async function routeStops(routeId) {
  const list = await seoul('busRouteInfo/getStaionByRoute', { busRouteId: routeId });
  // 회차지(transYn=Y)를 지나면 반대 방향(dir 1)
  let turn = list.findIndex((s) => s.transYn === 'Y');
  if (turn < 0 && list[0] && list[0].trnstnid) turn = list.findIndex((s) => s.station === list[0].trnstnid);
  const stops = list.map((s, i) => ({
    nodeId: s.station, name: s.stationNm, no: s.arsId && s.arsId !== '0' ? s.arsId : '',
    lat: +s.gpsY, lng: +s.gpsX, order: +s.seq || 0, dir: turn >= 0 && i > turn ? 1 : 0,
  })).filter((s) => !Number.isNaN(s.lat) && !Number.isNaN(s.lng)).sort((a, b) => a.order - b.order);
  return { stops };
}

// 노선을 달리는 버스의 현재 위치 (서울특별시_버스위치정보조회 서비스)
async function buses(routeId) {
  const list = await seoul('buspos/getBusPosByRtid', { busRouteId: routeId });
  return list.map((b) => ({
    id: b.vehId, plate: b.plainNo, lat: +b.gpsY, lng: +b.gpsX,
    nodeId: b.lastStnId, order: +b.sectOrd || 0, atStop: b.stopFlag === '1',
    lowFloor: b.busType === '1', full: b.isFullFlag === '1', time: b.dataTm || '',
  })).filter((b) => !Number.isNaN(b.lat) && !Number.isNaN(b.lng) && b.lat > 0);
}

// 내 위치 + 버스 번호 (내 주변 모드)
async function search(bus, lat, lng, radius, dist) {
  const routes = (await routesByNumber(bus)).slice(0, 6);
  if (!routes.length) return { error: `서울에서 "${bus}"번 버스를 찾지 못했어요.` };
  const stops = new Map();
  for (const r of routes) {
    const { stops: list } = await routeStops(r.routeId);
    for (const s of list) {
      const d = dist(lat, lng, s.lat, s.lng);
      if (d > radius) continue;
      const e = stops.get(s.nodeId) || { nodeId: s.nodeId, name: s.name, no: s.no, lat: s.lat, lng: s.lng, distance: Math.round(d), routeIds: [] };
      e.routeIds.push(r.routeId);
      stops.set(s.nodeId, e);
    }
  }
  return {
    cityCode: 'seoul',
    routes: routes.map((r) => ({ routeId: r.routeId, routeNo: r.routeNo, type: r.type, from: r.from, to: r.to })),
    stops: [...stops.values()].sort((a, b) => a.distance - b.distance),
  };
}

module.exports = { inSeoul, hasKey, nearby, routesByNumber, routeStops, buses, search };
