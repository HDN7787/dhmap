export async function onRequest(context) {
  const { env, params } = context;
  const siteId = parseInt(params.id, 10);
  if (!siteId) return new Response('Invalid ID', { status: 400 });

  try {
    // 查数据库
    const site = await env.DB.prepare(`
      SELECT s.*, c.name as category_name 
      FROM sites s JOIN categories c ON c.id = s.category_id 
      WHERE s.id = ? AND s.status = 'active'
    `).bind(siteId).first();

    if (!site) return new Response('Not Found', { status: 404 });

    // 生成 SEO 友好的 HTML 字符串
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${site.title} - ${site.category_name} - 导航map</title>
  <meta name="description" content="${site.description || `导航map为您提供${site.title}的官网入口、网站简介和所属分类。`}" />
  <meta name="keywords" content="${site.title}, ${site.registrable_domain}, ${site.category_name}, 网址导航" />
  <style>
    body { font-family: system-ui, sans-serif; background: #f6f7f9; padding: 40px 20px; display: flex; justify-content: center; margin: 0; }
    .card { background: #fff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.05); width: 100%; max-width: 600px; text-align: center; }
    h1 { margin-top: 0; font-size: 28px; color: #111; }
    .desc { color: #6b7280; font-size: 16px; line-height: 1.6; margin: 20px 0; }
    .meta { font-size: 13px; color: #9ca3af; margin-bottom: 30px; }
    .btn { display: inline-block; padding: 12px 32px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; font-size: 16px; transition: background .2s; margin-bottom: 16px; }
    .btn:hover { background: #1d4ed8; }
    .back { display: block; color: #6b7280; text-decoration: none; font-size: 14px; }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${site.title}</h1>
    <div class="desc">${site.description || '这个站点很懒，还没有写描述。'}</div>
    <div class="meta">所属分类：${site.category_name} | 收录域名：${site.registrable_domain}</div>
    <a href="/go/${site.id}" target="_blank" class="btn">立即访问网站</a>
    <a href="/" class="back">← 返回首页</a>
  </div>
</body>
</html>`;

    // 返回 HTML，并告诉浏览器/CDN 缓存 1 小时
    return new Response(html, {
      headers: { 
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (err) {
    return new Response('Internal Server Error', { status: 500 });
  }
}