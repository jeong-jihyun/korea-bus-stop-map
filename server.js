// 로컬 실행용 서버 (외부 패키지 없음, Node 18 이상)
// 배포(Vercel)에서는 이 파일 대신 api/search.js 가 쓰입니다.
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

const core = require('./lib/core');
const API = { '/api/search': core.handle, '/api/nearby': core.handleNearby, '/api/cities': core.handleCities, '/api/routes': core.handleRoutes, '/api/route-stops': core.handleRouteStops };
const PORT = process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (API[u.pathname]) {
    const [code, body] = await API[u.pathname](Object.fromEntries(u.searchParams));
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(body));
  }
  const file = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : u.pathname);
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}  (${process.env.TAGO_API_KEY ? '실제 데이터 모드' : '데모 모드 - .env에 TAGO_API_KEY를 넣으면 실제 데이터'})`);
});
