export default {
  async scheduled(event, env, ctx) {
    console.log('[cron] ⏰ 定时任务触发，时间:', new Date().toISOString());
    ctx.waitUntil(runAutomatedPipeline(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger') {
      console.log('[cron] 🚀 手动强制触发采集流程...');
      await runAutomatedPipeline(env);
      return new Response('✅ 四大采集引擎执行完毕，请查看 D1 数据库或 Cloudflare 日志。', { status: 200 });
    }
    return new Response('导航map 全自动印钞机运行中。访问 /trigger 手动触发。', { status: 200 });
  }
};

// ============================================================================
// 核心调度管道：统筹调度四种采集方式
// ============================================================================
async function runAutomatedPipeline(env) {
  const { DB } = env;
  if (!DB) return console.error('[cron] 致命错误：缺少 D1 数据库绑定');

  // 存储本轮抓到的所有待验证网址
  let allCandidateItems = [];

  // 1. 采集 RSS 源
  try {
    const rssItems = await collectRSS();
    allCandidateItems.push(...rssItems);
  } catch (e) { console.warn('[RSS] 采集失败:', e.message); }

  // 2. 采集 GitHub 开源书签仓库
  try {
    const githubItems = await collectGitHubRepos();
    allCandidateItems.push(...githubItems);
  } catch (e) { console.warn('[GitHub] 采集失败:', e.message); }

  // 3. 网页 DOM 爬虫 (抓取 GitHub Trending)
  try {
    const scrapeItems = await collectWebScraping();
    allCandidateItems.push(...scrapeItems);
  } catch (e) { console.warn('[WebScrape] 采集失败:', e.message); }

  // 4. 搜索引擎发现 API (需配置 SEARCH_API_KEY)
  try {
    const searchItems = await collectSearchAPI(env);
    allCandidateItems.push(...searchItems);
  } catch (e) { console.warn('[SearchAPI] 采集失败:', e.message); }

  console.log(`[cron] 📦 四大引擎共收集到 ${allCandidateItems.length} 个候选网址。`);

  // 去重与格式化
  const uniqueCandidates = [];
  const seenDomains = new Set();

  for (const item of allCandidateItems) {
    if (!item.url || !item.url.startsWith('http')) continue;
    
    let hostname = '';
    try {
      const u = new URL(item.url);
      hostname = u.hostname.replace(/^www\./, '');
      // 过滤内网和无效域名
      if (hostname.includes('127.0.0.1') || hostname === 'localhost' || !hostname.includes('.')) continue;
    } catch (e) { continue; }

    // 内存去重
    if (seenDomains.has(hostname)) continue;
    seenDomains.add(hostname);

    // 数据库去重
    const existing = await DB.prepare('SELECT id FROM sites WHERE registrable_domain = ?').bind(hostname).first();
    if (existing) continue;

    uniqueCandidates.push({ 
      url: item.url, 
      hostname, 
      title: item.title || hostname, 
      description: item.description || '自动采集收录',
      categoryId: item.categoryId || 7 // 默认归入其他
    });
  }

  // 限制单次最高处理 30 个（防止超时），剩下的下次采集再处理
  const itemsToVerify = uniqueCandidates.slice(0, 30);
  console.log(`[cron] 🔍 去除重复后剩余 ${uniqueCandidates.length} 个，本轮将验证前 ${itemsToVerify.length} 个。`);

  // 并发验证并入库 (每批 5 个)
  let insertedCount = 0;
  for (let i = 0; i < itemsToVerify.length; i += 5) {
    const batch = itemsToVerify.slice(i, i + 5);
    await Promise.all(batch.map(async (item) => {
      const isAlive = await verifyUrl(item.url);
      if (isAlive) {
        try {
          await DB.prepare(`
            INSERT INTO sites (url, registrable_domain, title, description, category_id, status)
            VALUES (?, ?, ?, ?, ?, 'active')
          `).bind(item.url, item.hostname, item.title, item.description, item.categoryId).run();
          insertedCount++;
          console.log(`[cron] ✅ 验证成功并入库: ${item.hostname}`);
        } catch (dbErr) { /* 忽略并发插入冲突 */ }
      } else {
        console.log(`[cron] ⚠️ 验证失败(死链/超时): ${item.hostname}`);
      }
    }));
  }

  console.log(`[cron] 🏁 本轮自动化采集结束。成功新增: ${insertedCount} 个可访问网站。`);
}

// ============================================================================
// 引擎 1：RSS/Atom 订阅源解析
// ============================================================================
async function collectRSS() {
  const feeds = [
    { url: 'https://sspai.com/feed', cat: 5 },        // 少数派 (工具)
    { url: 'https://www.ithome.com/rss/', cat: 6 },   // IT之家 (新闻)
  ];
  let items = [];
  for (const feed of feeds) {
    const res = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const xml = await res.text();
    // 简单正则提取 <link> 标签内的 URL
    const regex = /<link>(https?:\/\/[^<]+)<\/link>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const url = match[1];
      if (url.includes('.xml') || url === feed.url) continue; // 跳过订阅源本身
      items.push({ url, title: '最新资讯', description: '来自RSS的优质资讯', categoryId: feed.cat });
    }
  }
  return items;
}

// ============================================================================
// 引擎 2：GitHub 开源书签仓库抓取 (通过 API)
// ============================================================================
async function collectGitHubRepos() {
  let items = [];
  // 搜索 GitHub 上热门的导航/书签类仓库
  const res = await fetch('https://api.github.com/search/repositories?q=topic:bookmark&sort=stars&order=desc&per_page=5', {
    headers: { 'User-Agent': 'NavMap-Bot', 'Accept': 'application/vnd.github.v3+json' }
  });
  if (!res.ok) return items;
  const data = await res.json();
  
  for (const repo of data.items) {
    // 这里只是把仓库主页收录进来，如果想深挖，还可以请求 repo 的 README.md 然后提取里面的链接
    items.push({
      url: repo.html_url,
      title: repo.name,
      description: repo.description || 'GitHub开源导航项目',
      categoryId: 5 // 工具
    });
  }
  return items;
}

// ============================================================================
// 引擎 3：网页 DOM 爬虫 (使用 Cloudflare 原生 HTMLRewriter)
// ============================================================================
async function collectWebScraping() {
  let items = [];
  // 目标：爬取 GitHub Trending 页面的热门仓库
  const res = await fetch('https://github.com/trending?since=daily', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) return items;

  // HTMLRewriter 是 Cloudflare 的神器，可以在流式响应中直接解析并提取 DOM 节点
  const rewriter = new HTMLRewriter().on('article.Box-row h2 a', {
    element(element) {
      const href = element.getAttribute('href');
      if (href) {
        items.push({
          url: `https://github.com${href}`,
          title: href.replace(/^\//, ''), // 例如 "facebook/react"
          description: '今日GitHub Trending热门项目',
          categoryId: 5
        });
      }
    }
  });

  // 触发解析（由于是流式，必须 await text() 或 arrayBuffer() 让解析过程走完）
  await rewriter.transform(res).text();
  return items;
}

// ============================================================================
// 引擎 4：搜索引擎发现 API (Bing / Serper)
// ============================================================================
async function collectSearchAPI(env) {
  let items = [];
  const apiKey = env.SEARCH_API_KEY;
  if (!apiKey) return items; // 没配 Key 直接跳过

  // 示例：调用 Serper.dev (Google Search API) 搜索长尾词
  const query = '在线免费小说阅读网站';
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ q: query, num: 10 })
  });

  if (!res.ok) return items;
  const data = await res.json();
  
  if (data.organic) {
    for (const result of data.organic) {
      items.push({
        url: result.link,
        title: result.title,
        description: result.snippet || '搜索引擎发现',
        categoryId: 1 // 因为是搜小说，所以放入小说分类
      });
    }
  }
  return items;
}

// ============================================================================
// 存活验证引擎 (容忍 401, 403, 429)
// ============================================================================
async function verifyUrl(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000); // 6 秒超时
    
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });
    
    clearTimeout(timeoutId);
    
    // 只要服务器有响应，哪怕是反爬拦截(403)或限流(429)，都说明网站没死
    const validCodes = [200, 201, 202, 204, 301, 302, 304, 401, 403, 429];
    return validCodes.includes(res.status);
  } catch (err) {
    return false;
  }
}