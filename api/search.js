// Vercel 서버리스 함수: /api/search
const { handle } = require('../lib/core');

module.exports = async (req, res) => {
  const [code, body] = await handle(req.query || {});
  // 성공한 결과만 5분 캐시 (오류는 캐시하지 않음)
  if (code === 200) res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.status(code).json(body);
};
