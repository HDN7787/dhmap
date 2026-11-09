export async function onRequest(context) {
  const { env, params } = context;
  const siteId = parseInt(params.id, 10);
  if (!siteId || Number.isNaN(siteId)) return new Response('Invalid', { status: 400 });
  try {
    const site = await env.DB.prepare("SELECT id, url FROM sites WHERE id = ? AND status IN ('active', 'blocked')").bind(siteId).first();
    if (!site) return new Response('Not found', { status: 404 });
    
    // 简单粗暴地给 D1 里的点击量 +1（生产环境不要这么干，会产生大量写操作，但小站足够了）
    await env.DB.prepare('UPDATE sites SET click_rank_24h = click_rank_24h + 1 WHERE id = ?').bind(siteId).run();
    
    return Response.redirect(site.url, 302);
  } catch (err) { return new Response('Internal error', { status: 500 }); }
}