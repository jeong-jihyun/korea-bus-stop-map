// Vercel 서버리스 함수: /api/nearby (내 주변 정류장 + 서는 버스 번호)
const { handleNearby } = require('../lib/core');

module.exports = async (req, res) => {
  const [code, body] = await handleNearby(req.query || {});
  if (code === 200 && !body.routesError) res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.status(code).json(body);
};
