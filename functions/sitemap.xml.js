export async function onRequest(context) {
  const { env } = context;
  try {
    // 只抓取 active 状态的站点，限制 5000 条防止过大
    const { results } = await env.DB.prepare(`
      SELECT id, updated_at FROM sites WHERE status = 'active' ORDER BY id DESC LIMIT 5000
    `).all();

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
    
    // 首页
    xml += `  <url><loc>https://dhmap.pages.dev/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>\n`;

    // 详情页长尾
    results.forEach(site => {
      const date = site.updated_at ? site.updated_at.split(' ')[0] : new Date().toISOString().split('T')[0];
      xml += `  <url><loc>https://dhmap.pages.dev/site/${site.id}</loc><lastmod>${date}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>\n`;
    });

    xml += `</urlset>`;

    return new Response(xml, {
      headers: { 
        'Content-Type': 'application/xml',
        'Cache-Control': 'public, max-age=86400' // 缓存一天
      }
    });
  } catch (err) {
    return new Response('Error', { status: 500 });
  }
}