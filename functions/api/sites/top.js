export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const window = url.searchParams.get('window') || '24h';
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '9', 10)));

  try {
    const sql = `SELECT s.id, s.title, s.description, s.registrable_domain, s.status, c.name AS category_name 
                 FROM click_rankings r JOIN sites s ON s.id = r.site_id JOIN categories c ON c.id = s.category_id 
                 WHERE r.window = ? ORDER BY r.rank ASC LIMIT ?`;
    const { results } = await env.DB.prepare(sql).bind(window, limit).all();
    
    return Response.json(results, {
      headers: {
        'Cache-Control': 'no-store'
      }
    });
  } catch (err) {
    return Response.json({ error: 'DB_ERROR' }, { status: 500 });
  }
}