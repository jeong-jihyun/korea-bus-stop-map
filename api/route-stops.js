// Vercel 서버리스 함수
const { handleRouteStops } = require('../lib/core');

module.exports = async (req, res) => {
  const [code, body] = await handleRouteStops(req.query || {});
  if (code === 200 && !body.failed && !body.demo) res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  res.status(code).json(body);
};
