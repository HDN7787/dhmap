export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutomatedPipeline(env));
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/trigger') {
      await runAutomatedPipeline(env);
      return new Response('✅ 二级域名采集完毕', { status: 200 });
    }
    return new Response('导航map 自动引擎运行中', { status: 200 });
  }
};

async function runAutomatedPipeline(env) {
  const { DB } = env;
  if (!DB) return;

  console.log('[cron] 🚀 开始采集 (已开启二级域名支持)...');
  let allCandidateItems = [];

  // 采集源
  try { allCandidateItems.push(...await collectRSS()); } catch (e) { }
  try { allCandidateItems.push(...await collectGitHubRepos()); } catch (e) { }
  try { allCandidateItems.push(...await collectAwesomeLists()); } catch (e) { }
  try { allCandidateItems.push(...await collectExternalNavs()); } catch (e) { }

  // --- 去重与过滤 ---
  const uniqueCandidates = [];
  const seenDomains = new Set();
  
  for (const item of allCandidateItems) {
    if (!item.url || !item.url.startsWith('http')) continue;
    
    let hostname = '';
    try {
      const u = new URL(item.url);
      // 【核心改变】保留完整的二级/三级域名，只去掉 www
      hostname = u.hostname.toLowerCase().replace(/^www\./, '');
      
      // 过滤黑名单（防止无意义的长串二级域名和测试站）
      const blacklist = ['localhost', '127.0.0.1', 'vercel.app', 'netlify.app', 'herokuapp.com', 'github.io', 'gitbook.io'];
      if (blacklist.some(b => hostname.endsWith(b))) continue;
      
      // 过滤极长或包含特殊字符的恶意子域
      if (hostname.length > 40 || !hostname.includes('.') || /^[0-9.]+$/.test(hostname)) continue;
      
    } catch (e) { continue; }
    
    if (seenDomains.has(hostname)) continue;
    seenDomains.add(hostname);
    
    // 查重：现在的对比标准是完整域名
    const existing = await DB.prepare('SELECT id FROM sites WHERE registrable_domain = ?').bind(hostname).first();
    if (existing) continue;
    
    uniqueCandidates.push({ 
      url: item.url, 
      hostname, // 这里存的就是完整的 y.qq.com
      title: item.title || hostname, 
      description: item.description || '自动采集收录', 
      categoryId: item.categoryId || 7 
    });
  }

  console.log(`[cron] 🎯 获得 ${uniqueCandidates.length} 个唯一域名，本批验证 20 个...`);

  const itemsToVerify = uniqueCandidates.slice(0, 20);
  let insertedCount = 0;
  
  for (let i = 0; i < itemsToVerify.length; i += 10) {
    const batch = itemsToVerify.slice(i, i + 10);
    await Promise.all(batch.map(async (item) => {
      const isAlive = await verifyUrl(item.url);
      if (isAlive) {
        try {
          // 写入 sites 表，registrable_domain 字段存完整的二级域名
          await DB.prepare(`INSERT INTO sites (url, registrable_domain, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, 'active')`).bind(item.url, item.hostname, item.title, item.description, item.categoryId).run();
          // 写入流水
          await DB.prepare(`INSERT INTO submissions (user_id, url, registrable_domain, title, description, category_id, status) VALUES (999, ?, ?, ?, ?, ?, 'published')`).bind(item.url, item.hostname, item.title, item.description, item.categoryId).run();
          insertedCount++;
        } catch (e) { }
      }
    }));
  }
  console.log(`[cron] ✅ 本批新增活站: ${insertedCount} 个`);

  // SEO 修正
  const { results: sitesToUpdate } = await DB.prepare(`
    SELECT id, url FROM sites WHERE description IN ('自动采集收录', '暂无描述', '') OR category_id = 7 ORDER BY id DESC LIMIT 10
  `).all();

  for (const site of sitesToUpdate) {
    try {
      const seoInfo = await fetchSeoInfo(site.url);
      if (seoInfo.title || seoInfo.description) {
        await DB.prepare(`UPDATE sites SET title = COALESCE(?, title), description = COALESCE(?, description), category_id = ?, updated_at = datetime('now') WHERE id = ?`)
          .bind(seoInfo.title || null, seoInfo.description || null, seoInfo.categoryId, site.id).run();
      }
    } catch (e) { }
  }
}

// ================== 采集引擎 ==================
async function collectRSS() {
  const feeds = [{ url: 'https://sspai.com/feed', cat: 5 }, { url: 'https://www.ithome.com/rss/', cat: 6 }];
  let items = [];
  for (const feed of feeds) {
    try {
      const xml = await (await fetch(feed.url)).text();
      const regex = /<link>(https?:\/\/[^<]+)<\/link>/g;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        if (!match[1].includes('.xml') && match[1] !== feed.url) items.push({ url: match[1], title: '最新资讯', description: 'RSS资讯', categoryId: feed.cat });
      }
    } catch (e) {}
  }
  return items;
}
async function collectGitHubRepos() {
  let items = [];
  try {
    const res = await fetch('https://api.github.com/search/repositories?q=topic:bookmark&sort=stars&order=desc&per_page=5');
    if (res.ok) {
      const data = await res.json();
      for (const repo of data.items) items.push({ url: repo.html_url, title: repo.name, description: repo.description || 'GitHub开源导航', categoryId: 5 });
    }
  } catch (e) {}
  return items;
}
async function collectAwesomeLists() {
  let items = [];
  try {
    const text = await (await fetch('https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md')).text();
    const regex = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
    let match, count = 0;
    while ((match = regex.exec(text)) !== null && count < 20) {
      if (!match[2].includes('github.com')) {
        items.push({ url: match[2], title: match[1], description: 'Awesome精选', categoryId: 5 });
        count++;
      }
    }
  } catch (e) {}
  return items;
}
async function collectExternalNavs() {
  let items = [];
  try {
    const res = await fetch('https://raw.githubusercontent.com/jaywcjlove/FED/master/data.json');
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.sites || []);
      for (const item of list) {
        if (item.url) items.push({ url: item.url, title: item.name, description: item.des || '', categoryId: 5 });
      }
    }
  } catch (e) {}
  return items;
}

// ================== 辅助工具 ==================
async function verifyUrl(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timeoutId);
    return [200, 201, 202, 204, 301, 302, 304, 401, 403, 429].includes(res.status);
  } catch (err) { return false; }
}
async function fetchSeoInfo(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.headers.get('content-type')?.includes('text/html')) return {};
    const html = await res.text();
    let title = '', description = '';
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim().substring(0, 50);
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i);
    if (descMatch) description = descMatch[1].trim().substring(0, 150);
    
    let categoryId = 7; 
    const text = title + ' ' + description;
    if (/小说|阅读|novel/i.test(text)) categoryId = 1;
    else if (/影视|电影|视频|tv/i.test(text)) categoryId = 2;
    else if (/音乐|歌|music/i.test(text)) categoryId = 3;
    else if (/游戏|电竞|game/i.test(text)) categoryId = 4;
    else if (/新闻|资讯|news/i.test(text)) categoryId = 6;
    else if (/工具|开发|软件|api/i.test(text)) categoryId = 5;

    clearTimeout(timeoutId);
    return { title, description, categoryId };
  } catch (err) {
    clearTimeout(timeoutId);
    return {};
  }
}