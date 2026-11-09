export async function onRequest(context) {
  const { env, request } = context;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  
  try {
    const { submissionId, action } = await request.json();
    const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(submissionId).first();
    if (!sub) return Response.json({ message: '找不到记录' }, { status: 404 });

    if (action === 'pass') {
      // 1. 写入 sites 表
      await env.DB.prepare(`
        INSERT INTO sites (url, registrable_domain, title, description, category_id, status) 
        VALUES (?, ?, ?, ?, ?, 'active')
      `).bind(sub.url, sub.registrable_domain, sub.title, sub.description, sub.category_id).run();
      
      // 2. 更新 submissions 状态
      await env.DB.prepare('UPDATE submissions SET status = \'published\' WHERE id = ?').bind(submissionId).run();
    } else {
      await env.DB.prepare('UPDATE submissions SET status = \'rejected\' WHERE id = ?').bind(submissionId).run();
    }
    return Response.json({ success: true });
  } catch (err) { return Response.json({ message: err.message }, { status: 500 }); }
}