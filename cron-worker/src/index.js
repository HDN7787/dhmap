export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutomatedPipeline(env));
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/trigger') {
      await runAutomatedPipeline(env);
      return new Response('✅ 泛娱乐垂直矩阵采集完成', { status: 200 });
    }
    return new Response('运行中', { status: 200 });
  }
};

async function runAutomatedPipeline(env) {
  const { DB } = env;
  if (!DB) return console.error('❌ 找不到 D1 数据库绑定');

  console.log('🟢 [1/6] 垂直泛娱乐矩阵启动...');
  let allCandidateItems = [];

  // ================= 引擎 1：小说（开源书源 - 精选） =================
  try {
    console.log('📖 抓取小说书源...');
    const res = await fetch('https://raw.githubusercontent.com/entr0pia/MyLegadoSource/master/bookSource.json', { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      for (const book of data.slice(0, 20)) {
        const u = book.bookSourceUrl;
        if (u && u.startsWith('http')) {
          allCandidateItems.push({ url: u, originalTitle: book.bookSourceName || '小说站点', categoryId: 1 });
        }
      }
    }
  } catch (e) { console.error('❌ 小说源异常'); }

  // ================= 引擎 2：影视（豆瓣电影 Top250 网页版） =================
  try {
    console.log('🎬 抓取豆瓣 Top250...');
    const res = await fetch('https://movie.douban.com/top250', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const html = await res.text();
      // 正则提取豆瓣条目链接
      const regex = /href="(https:\/\/movie\.douban\.com\/subject\/\d+\/)"[^>]*>[\s\S]*?<span class="title">([^<]+)<\/span>/g;
      let match, count = 0;
      while ((match = regex.exec(html)) !== null && count < 15) {
        allCandidateItems.push({ url: match[1], originalTitle: match[2], categoryId: 2 });
        count++;
      }
    }
  } catch (e) { console.error('❌ 豆瓣异常'); }

  // ================= 引擎 3：音乐（网易云热门歌手页） =================
  try {
    console.log('🎵 抓取网易云热门榜单...');
    const res = await fetch('https://music.163.com/discover/artist', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const html = await res.text();
      // 抓取歌手页链接
      const regex = /href="(\/artist\?id=\d+)"[^>]*>([^<]+)<\/a>/g;
      let match, count = 0;
      while ((match = regex.exec(html)) !== null && count < 15) {
        allCandidateItems.push({ url: `https://music.163.com${match[1]}`, originalTitle: `${match[2]} - 音乐`, categoryId: 3 });
        count++;
      }
    }
  } catch (e) { console.error('❌ 音乐异常'); }

  // ================= 引擎 4：游戏（游民星空 + 3DM） =================
  try {
    console.log('🎮 抓取游戏门户...');
    // 游民星空
    const res1 = await fetch('https://www.gamersky.com/', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
    if (res1.ok) {
      const html = await res1.text();
      const regex = /href="(https?:\/\/www\.gamersky\.com\/[a-z]+\/\d+\.shtml)"[^>]*>([^<]+)<\/a>/g;
      let match, count = 0;
      while ((match = regex.exec(html)) !== null && count < 10) {
        allCandidateItems.push({ url: match[1], originalTitle: match[2], categoryId: 4 });
        count++;
      }
    }
    // 3DM
    const res2 = await fetch('https://www.3dmgame.com/', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
    if (res2.ok) {
      const html = await res2.text();
      const regex = /href="(https?:\/\/www\.3dmgame\.com\/news\/\d+\.html)"[^>]*>([^<]+)<\/a>/g;
      let match, count = 0;
      while ((match = regex.exec(html)) !== null && count < 10) {
        allCandidateItems.push({ url: match[1], originalTitle: match[2], categoryId: 4 });
        count++;
      }
    }
  } catch (e) { console.error('❌ 游戏异常'); }

  // ================= 引擎 5：B站排行（补充影视/游戏） =================
  try {
    console.log('📺 抓取 B站排行榜...');
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
  } catch (e) { console.error('❌ B站异常'); }

  console.log(`🟡 [2/6] 获取 ${allCandidateItems.length} 条数据，进行黑名单与去重清洗...`);

  // ================= 核心：极限清洗与防大厂子域刷屏 =================
  const uniqueCandidates = [];
  const seenDomains = new Set();
  
  for (const item of allCandidateItems) {
    if (!item.url) continue;
    let hostname = '';
    try {
      hostname = new URL(item.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch (e) { continue; }
    
    // 🚫 拦截大厂无意义子域，防止刷屏
    const badSubdomains = [
      'z.qqzone.com', 'browser.qq.com', 'guanjia.qq.com', 'cloud.tencent.com',
      'im.qq.com', 'fm.qq.com', 'weiyun.com', 'pan.baidu.com', 'tieba.baidu.com',
      'music.163.com', 'movie.douban.com' // 这些主站直接收录，不收录里面的具体条目
    ];
    if (badSubdomains.includes(hostname)) continue;

    // 如果是具体的豆瓣电影条目、B站视频、网易云音乐，强制截断回主站
    if (hostname === 'movie.douban.com') hostname = 'douban.com';
    if (hostname === 'music.163.com') hostname = 'music.163.com'; // 网易云保留
    if (hostname === 'www.bilibili.com') hostname = 'bilibili.com';

    if (seenDomains.has(hostname)) continue;
    seenDomains.add(hostname);
    
    // 查库
    const existing = await DB.prepare('SELECT id FROM sites WHERE registrable_domain = ?').bind(hostname).first();
    if (existing) continue; 
    
    uniqueCandidates.push({ 
      url: `https://${hostname}/`, // 强制回退到主域名首页，防止收录具体文章死链
      hostname: hostname, 
      originalTitle: item.originalTitle, 
      categoryId: item.categoryId 
    });
  }

  console.log(`🟡 [3/6] 清洗后剩余 ${uniqueCandidates.length} 个新域名，开始抓取 SEO...`);

  // ================= 验证、SEO抓取、入库 =================
  const itemsToVerify = uniqueCandidates.slice(0, 25);
  let insertedCount = 0;
  
  for (let i = 0; i < itemsToVerify.length; i += 5) {
    const batch = itemsToVerify.slice(i, i + 5);
    await Promise.all(batch.map(async (item) => {
      const seoData = await fetchSeoInfo(item.url);
      if (!seoData) return;
      
      const finalTitle = seoData.title || item.originalTitle;
      const finalDesc = seoData.description || '精选泛娱乐站点';
      
      try {
        await DB.prepare(`INSERT INTO sites (url, registrable_domain, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, 'active')`).bind(item.url, item.hostname, finalTitle, finalDesc, item.categoryId).run();
        await DB.prepare(`INSERT INTO submissions (user_id, url, registrable_domain, title, description, category_id, status) VALUES (999, ?, ?, ?, ?, ?, 'published')`).bind(item.url, item.hostname, finalTitle, finalDesc, item.categoryId).run();
        insertedCount++;
        console.log(`✅ 入库: [${finalTitle}] ${item.hostname} (分类:${item.categoryId})`);
      } catch (dbErr) { }
    }));
  }
  console.log(`🏁 [4/6] 任务结束！本轮成功新增 ${insertedCount} 个站点。`);
}

// ================= 工具函数 =================
async function fetchSeoInfo(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timeoutId);
    if (![200, 201, 202, 204, 301, 302, 304, 401, 403, 429].includes(res.status)) return null;
    if (!res.headers.get('content-type')?.includes('text/html')) return { title: '', description: '' }; 
    const html = await res.text();
    let title = '', description = '';
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim().substring(0, 50);
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i);
    if (descMatch) description = descMatch[1].trim().substring(0, 150);
    return { title, description };
  } catch (err) { return null; }
}