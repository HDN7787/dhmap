export async function onRequest(context) {
  const { env, request } = context;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const auth = request.headers.get('Authorization');
  if (!auth) return new Response('Unauthorized', { status: 401 });

  try {
    const body = await request.json();
    const { id, title, description, category_id, status } = body;

    // 如果是快捷上下架操作 (只传了 id 和 status)
    if (id && status && title === undefined) {
      await env.DB.prepare(`UPDATE sites SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(status, id).run();
      return Response.json({ success: true });
    }

    // 如果是完整编辑操作
    await env.DB.prepare(`
      UPDATE sites 
      SET title = ?, description = ?, category_id = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(title, description, category_id, status, id).run();

    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ message: err.message }, { status: 500 });
  }
}