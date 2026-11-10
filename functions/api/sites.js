export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const categorySlug = url.searchParams.get('category');
  const q = url.searchParams.get('q');
  const page = parseInt(url.searchParams.get('page')) || 1;
  const pageSize = parseInt(url.searchParams.get('pageSize')) || 18;
  const offset = (page - 1) * pageSize;

  try {
    let sql = '';
    let params = [];

    if (q) {
      sql = `SELECT s.id, s.title, s.description, s.registrable_domain, s.status, c.name AS category_name 
             FROM sites s JOIN categories c ON c.id = s.category_id 
             WHERE s.status IN ('active', 'blocked') AND (s.title LIKE ? OR s.description LIKE ?) 
             ORDER BY s.click_rank_24h DESC, s.id DESC LIMIT 50`;
      params = [`%${q}%`, `%${q}%`];
    } else if (categorySlug) {
      sql = `SELECT s.id, s.title, s.description, s.registrable_domain, s.status, c.name AS category_name 
             FROM sites s JOIN categories c ON c.id = s.category_id 
             WHERE c.slug = ? AND s.status IN ('active', 'blocked') 
             ORDER BY s.click_rank_24h DESC, s.id DESC LIMIT ? OFFSET ?`;
      params = [categorySlug, pageSize, offset];
    } else {
      return Response.json({ error: 'MISSING_PARAM' }, { status: 400 });
    }

    const { results } = await env.DB.prepare(sql).bind(...params).all();
    
    // 【核心修改】不缓存 API 结果，保证数据实时
    return Response.json(results, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
      }
    });
  } catch (err) {
    return Response.json({ error: 'DB_ERROR', message: err.message }, { status: 500 });
  }
}