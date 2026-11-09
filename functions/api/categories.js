export async function onRequest(context) {
  const { env } = context;
  try {
    const { results } = await env.DB.prepare('SELECT id, name, slug, sort_order FROM categories ORDER BY sort_order ASC').all();
    return Response.json(results, {
      headers: {
        'Cache-Control': 'public, max-age=86400, s-maxage=86400' // 缓存 24 小时
      }
    });
  } catch (err) {
    return Response.json({ error: 'DB_ERROR' }, { status: 500 });
  }
}