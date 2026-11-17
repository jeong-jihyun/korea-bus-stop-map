// Vercel 서버리스 함수
const { handleCities } = require('../lib/core');

module.exports = async (req, res) => {
  const [code, body] = await handleCities(req.query || {});
  if (code === 200 && !body.failed && !body.demo) res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');
  res.status(code).json(body);
};
