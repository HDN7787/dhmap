export async function onRequest(context) {
  const { env, request, params } = context;
  const subId = parseInt(params.id, 10);

  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return Response.json({ message: '未登录' }, { status: 401 });

  try {
    const token = auth.split(' ')[1];
    const payloadBase64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(payloadBase64));
    const userId = payload.userId;

    const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ? AND user_id = ?').bind(subId, userId).first();
    if (!sub) return Response.json({ message: '记录不存在或无权操作' }, { status: 403 });

    // --- 处理 DELETE（撤回） ---
    if (request.method === 'DELETE') {
      if (!['pending', 'under_review'].includes(sub.status)) {
        return Response.json({ message: '只有审核中的投稿才能撤回' }, { status: 400 });
      }
      
      // 【关键修改】：软删除，状态改为 deleted，保留痕迹
      await env.DB.prepare("UPDATE submissions SET status = 'deleted' WHERE id = ?").bind(subId).run();
      
      return Response.json({ success: true, message: '撤回成功' });
    }

    // --- 处理 PUT（修改并重新提交） ---
    if (request.method === 'PUT') {
      if (sub.status !== 'rejected') {
        return Response.json({ message: '只有被拒绝的投稿才能修改重新提交' }, { status: 400 });
      }
      const { title, description, category_id } = await request.json();
      await env.DB.prepare(`
        UPDATE submissions 
        SET title = ?, description = ?, category_id = ?, status = 'pending', created_at = datetime('now')
        WHERE id = ?
      `).bind(title, description, category_id || sub.category_id, subId).run();
      return Response.json({ success: true, message: '修改成功，已重新提交审核' });
    }

    return new Response('Method Not Allowed', { status: 405 });
  } catch (err) {
    return Response.json({ message: '服务器错误: ' + err.message }, { status: 500 });
  }
}