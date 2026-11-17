// Vercel 서버리스 함수: 노선을 달리는 버스의 현재 위치 (실시간)
const { handleBuses } = require('../lib/core');

module.exports = async (req, res) => {
  const [code, body] = await handleBuses(req.query || {});
  if (code === 200 && !body.demo) res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');
  res.status(code).json(body);
};
