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
      // 搜索不分页（限制前50条），保持简单
      sql = `SELECT s.id, s.title, s.description, s.registrable_domain, s.status, c.name AS category_name 
             FROM sites s JOIN categories c ON c.id = s.category_id 
             WHERE s.status IN ('active', 'blocked') AND (s.title LIKE ? OR s.description LIKE ?) 
             ORDER BY s.click_rank_24h DESC, s.id DESC LIMIT 50`;
      params = [`%${q}%`, `%${q}%`];
    } else if (categorySlug) {
      // 分类查询：支持分页
      sql = `SELECT s.id, s.title, s.description, s.registrable_domain, s.status, c.name AS category_name 
             FROM sites s JOIN categories c ON c.id = s.category_id 
             WHERE c.slug = ? AND s.status IN ('active', 'blocked') 
             ORDER BY s.click_rank_24h DESC, s.id DESC LIMIT ? OFFSET ?`;
      params = [categorySlug, pageSize, offset];
    } else {
      return Response.json({ error: 'MISSING_PARAM' }, { status: 400 });
    }

    const { results } = await env.DB.prepare(sql).bind(...params).all();
    
    // 返回数据，并设置缓存头：浏览器缓存 1 分钟，CDN 节点缓存 1 小时
    return Response.json(results, {
      headers: {
        'Cache-Control': 'public, max-age=60, s-maxage=3600'
      }
    });
  } catch (err) {
    return Response.json({ error: 'DB_ERROR', message: err.message }, { status: 500 });
  }
}