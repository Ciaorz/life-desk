const fs = require('fs');
const path = require('path');
const DATA = 'E:/自制软件/生活后台/clean/data';
const jread = p => JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8'));
const jwrite = (p, o) => { fs.mkdirSync(path.dirname(path.join(DATA, p)), { recursive: true }); fs.writeFileSync(path.join(DATA, p), JSON.stringify(o, null, 2)); };
const mv = (from, to) => { fs.mkdirSync(path.dirname(path.join(DATA, to)), { recursive: true }); fs.renameSync(path.join(DATA, from), path.join(DATA, to)); };
const rm = p => { try { const fp = path.join(DATA, p); if (fs.existsSync(fp)) { const st = fs.statSync(fp); if (st.isDirectory()) fs.rmSync(fp, { recursive: true, force: true }); else fs.unlinkSync(fp); } } catch (e) { console.log('rm fail', p, e.message); } };

const ip = jread('ip/ip-data.json');
const series = jread('series/series-data.json');
const ipRow = ip.rows[0];
const serRow = series.rows[0];

ipRow.IP图像[0].imageUrl = 'data/images/ip/宝可梦-封面/ip-0001.jpg';
serRow.系列封面[0].imageUrl = 'data/images/ip/宝可梦/30周年151金属徽章-封面/series-0001.jpg';

jwrite('ip/宝可梦-data.json', { schema: 2, cat: 'ip', module: 'ip', rows: [ipRow] });
jwrite('ip/宝可梦/30周年151金属徽章-data.json', { schema: 2, cat: 'series', module: 'series', rows: [serRow] });

mv('images/ip-封面/ip-0001.jpg', 'images/ip/宝可梦-封面/ip-0001.jpg');
mv('images/series-封面/series-0001.jpg', 'images/ip/宝可梦/30周年151金属徽章-封面/series-0001.jpg');

rm('ip/ip-data.json');
rm('series/series-data.json');
rm('images/ip-封面');
rm('images/series-封面');

const idx = jread('lifedesk.json');
idx.shards.ip = { module: 'ip', dirShard: true, dir: 'ip', coverDir: 'ip' };
idx.shards.series = { module: 'series', dirShard: true, dir: 'series', coverDir: '系列' };
jwrite('lifedesk.json', idx);

// 重置图片去重索引，避免旧 rel 指向已删除文件
rm('images/_index.json');

console.log('DONE');
console.log('ip file:', JSON.stringify(ipRow.IP图像));
console.log('series file:', JSON.stringify(serRow.系列封面));
