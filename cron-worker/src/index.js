export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutomatedPipeline(env));
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/trigger') {
      await runAutomatedPipeline(env);
      return new Response('✅ 严格净化版采集完成', { status: 200 });
    }
    return new Response('运行中', { status: 200 });
  }
};

async function runAutomatedPipeline(env) {
  const { DB } = env;
  if (!DB) return console.error('❌ 找不到 D1 数据库绑定');

  console.log('🟢 [1/4] 严格采集启动...');
  let allCandidateItems = [];

  // 示例：这里依然保留你需要的几个源，你可以自行扩充
  // 1. 社区小说源
  try {
    const res = await fetch('https://raw.githubusercontent.com/entr0pia/MyLegadoSource/master/bookSource.json', { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      for (const book of data.slice(0, 15)) {
        const u = book.bookSourceUrl;
        if (u && u.startsWith('http')) allCandidateItems.push({ url: u, originalTitle: book.bookSourceName || '小说站点', categoryId: 1 });
      }
    }
  } catch (e) { }

  // 2. 影视/游戏类等等...（为了演示，这里取回之前写好的爬虫逻辑）
  try {
    const res = await fetch('https://www.bilibili.com/v/popular/rank/all', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const html = await res.text();
      const regex = /href="(\/\/www\.bilibili\.com\/video\/[a-zA-Z0-9]+)"[^>]*>[\s\S]*?class="title">([^<]+)<\/a>/g;
      let match, count = 0;
      while ((match = regex.exec(html)) !== null && count < 10) {
        allCandidateItems.push({ url: `https:${match[1]}`, originalTitle: match[2], categoryId: 2 });
        count++;
      }
    }
  } catch (e) { }

  console.log(`🟡 [2/4] 获取 ${allCandidateItems.length} 条数据，开始清洗...`);

  const uniqueCandidates = [];
  const seenDomains = new Set();
  
  for (const item of allCandidateItems) {
    if (!item.url) continue;
    let hostname = '';
    try {
      hostname = new URL(item.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch (e) { continue; }
    
    if (seenDomains.has(hostname)) continue;
    seenDomains.add(hostname);
    
    const existing = await DB.prepare('SELECT id FROM sites WHERE registrable_domain = ?').bind(hostname).first();
    if (existing) continue; 
    
    uniqueCandidates.push({ 
      url: `https://${hostname}/`, // 强制只抓主域名，避免死链
      hostname: hostname, 
      originalTitle: item.originalTitle, 
      categoryId: item.categoryId 
    });
  }

  console.log(`🟡 [3/4] 净化后剩余 ${uniqueCandidates.length} 个。开始极严验证...`);

  const itemsToVerify = uniqueCandidates.slice(0, 20);
  let insertedCount = 0;
  
  for (let i = 0; i < itemsToVerify.length; i += 5) {
    const batch = itemsToVerify.slice(i, i + 5);
    await Promise.all(batch.map(async (item) => {
      const seoData = await fetchSeoInfo(item.url);
      
      // 验证不通过，或者没抓到有效数据
      if (!seoData) {
        console.log(`⚠️ 拦截死链: ${item.hostname}`);
        return;
      }
      
      const finalTitle = seoData.title || item.originalTitle;
      const finalDesc = seoData.description || '精选泛娱乐站点';
      
      try {
        await DB.prepare(`INSERT INTO sites (url, registrable_domain, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, 'active')`).bind(item.url, item.hostname, finalTitle, finalDesc, item.categoryId).run();
        await DB.prepare(`INSERT INTO submissions (user_id, url, registrable_domain, title, description, category_id, status) VALUES (999, ?, ?, ?, ?, ?, 'published')`).bind(item.url, item.hostname, finalTitle, finalDesc, item.categoryId).run();
        insertedCount++;
        console.log(`✅ 入库: [${finalTitle}] ${item.hostname}`);
      } catch (dbErr) { }
    }));
  }
  console.log(`🏁 [4/4] 任务结束！本轮新增 ${insertedCount} 个优质站点。`);
}

// ================= 最严苛的验证工具 =================
async function fetchSeoInfo(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // 放宽到4秒
    
    const res = await fetch(url, { 
      method: 'GET', 
      redirect: 'follow', 
      signal: controller.signal, 
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' } 
    });
    clearTimeout(timeoutId);
    
    // 放宽一点：允许 200、301、302、403(反爬)
    if (![200, 301, 302, 403].includes(res.status)) {
      return null;
    }

    const html = await res.text();
    
    let title = '', description = '';
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim().substring(0, 50);
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i);
    if (descMatch) description = descMatch[1].trim().substring(0, 150);

    // 依然保留标题黑名单，防止把重定向页/拦截页当标题
    const badWords = ['Redirecting', '403 Forbidden', '404 Not Found', 'Just a moment', 'Blocked', 'Access Denied', 'Site Not Found'];
    if (badWords.some(w => title.toLowerCase().includes(w.toLowerCase()))) {
      return null;
    }

    // 如果遇到 403 且抓不到标题，就用域名作为标题放行
    if (res.status === 403 && !title) {
      return { title: '', description: '需人机验证访问' }; 
    }

    return { title, description };
  } catch (err) { 
    return null; 
  }
}