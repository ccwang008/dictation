const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('playwright-core');

const BASE = process.env.BASE || 'http://localhost:8080/index.html';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REAL_FOLDER = process.env.LISTENINGHUB_TEST_REAL_FOLDER;
const STATIC = process.env.LISTENINGHUB_TEST_STATIC === '1';
const BOOK = '走遍美国MP3';
const audio = join(__dirname, '..', 'audio', 'voa', '8002695.mp3');
const gb18030 = Buffer.concat([
  Buffer.from('[00:01.00]Hello there.\n[00:01.00]'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
  Buffer.from('\n[00:02.00]Good morning.\n[00:03.00]See you later.\n'),
]);

async function run() {
  const temp = await fs.mkdtemp(join(tmpdir(), 'listeninghub-textbooks-'));
  let browser;
  try {
    const folder = join(temp, BOOK);
    await fs.mkdir(folder);
    await fs.mkdir(join(folder, 'extra'));
    for (const name of ['u01-10.mp3', 'u20-3.mp3', 'u26-31.mp3', 'extra/separate.mp3']) {
      await fs.copyFile(audio, join(folder, name));
    }
    await fs.writeFile(join(folder, 'u01-10.LRC'), gb18030);
    await fs.writeFile(join(folder, 'separate.lrc'), gb18030);
    await fs.writeFile(join(folder, 'u20-3.lrc'), 'A transcript without timestamps.\nAnother line.');
    if (REAL_FOLDER) {
      await fs.copyFile(join(REAL_FOLDER, 'u01-1.mp3'), join(folder, 'u01-1.mp3'));
      await fs.copyFile(join(REAL_FOLDER, 'u01-1.lrc'), join(folder, 'u01-1.lrc'));
    } else {
      await fs.copyFile(audio, join(folder, 'u01-1.mp3'));
      await fs.writeFile(join(folder, 'u01-1.lrc'), gb18030);
    }

    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (STATIC) await page.route('**/api/state', route => route.fulfill({ status: 404 }));
    const mine = async () => {
      await page.getByRole('navigation').getByText('开始练习', { exact: true }).click();
      await page.getByRole('button', { name: '我的素材', exact: true }).click();
    };
    await page.goto(BASE);
    await mine();
    await page.getByRole('button', { name: '导入文件夹', exact: true }).click();
    const folderDialog = page.getByRole('dialog', { name: '导入文件夹', exact: true });
    await folderDialog.locator('input[webkitdirectory]').setInputFiles(folder);
    assert.equal(await folderDialog.getByRole('textbox', { name: '新教材名称' }).inputValue(), BOOK);
    const submitFolder = () => folderDialog.getByRole('button', { name: '导入', exact: true }).click();
    const results = page.getByRole('dialog', { name: '文件夹导入结果' });
    const expectCounts = async text => {
      await results.getByText(text, { exact: true }).waitFor();
    };
    await submitFolder();
    await expectCounts('成功 2 篇 · 跳过 3 项 · 失败 1 项');
    await results.getByText('u26-31.mp3 缺少同名字幕', { exact: true }).waitFor();
    await results.getByText('separate.lrc 缺少同名音频', { exact: true }).waitFor();
    await results.getByText('separate.mp3 缺少同名字幕', { exact: true }).waitFor();
    await results.getByRole('listitem').filter({ hasText: 'u20-3' }).getByText(/带时间轴/).waitFor();
    await results.getByRole('button', { name: '返回导入' }).click();
    await submitFolder();
    await expectCounts('成功 0 篇 · 跳过 5 项 · 失败 1 项');
    assert.equal(await results.getByText('该教材下已有同名课文', { exact: true }).count(), 2);
    await results.getByRole('button', { name: '完成', exact: true }).click();

    const book = page.getByRole('button', { name: new RegExp(`^${BOOK}\\s+\\d+ 篇$`) });
    await book.waitFor();
    assert.equal(await book.getAttribute('aria-expanded'), 'false');
    const search = page.getByPlaceholder('搜索教材 / 标题…');
    const titles = page.locator('aside .group.cursor-pointer h3');
    await search.fill('u01-10');
    assert.deepEqual(await titles.allTextContents(), ['u01-10']);
    await search.fill(BOOK);
    assert.deepEqual(await titles.allTextContents(), ['u01-1', 'u01-10']);
    await search.clear();
    assert.equal(await book.getAttribute('aria-expanded'), 'false');
    await book.click();
    await search.fill('u01-10');
    await search.clear();
    assert.equal(await book.getAttribute('aria-expanded'), 'true');

    await page.getByRole('button', { name: '导入音频 + 字幕' }).click();
    const single = page.getByRole('dialog', { name: '导入自己的听力素材' });
    const select = single.getByLabel('教材', { exact: true });
    await select.selectOption({ label: '新建教材' });
    await single.getByRole('textbox', { name: '新教材名称' }).fill('新教材试填');
    await select.selectOption({ label: BOOK });
    await single.locator('input[accept^="audio"]').setInputFiles(audio);
    await single.locator('input[accept^=".lrc"]').setInputFiles(join(folder, 'u01-10.LRC'));
    const title = single.getByRole('textbox', { name: '标题', exact: true });
    assert.equal(await title.inputValue(), '8002695');
    await title.fill('u01-2');
    await single.getByRole('button', { name: '导入', exact: true }).click();
    const validation = page.getByRole('dialog', { name: '声音与字幕自动修正' });
    if (STATIC) await validation.getByText(/音文校验需要本地服务/).waitFor();
    else await validation.getByRole('button', { name: '开始听写', exact: true }).waitFor();
    await validation.getByRole('button', { name: '关闭', exact: true }).click();
    assert.deepEqual(await titles.allTextContents(), ['u01-1', 'u01-2', 'u01-10']);

    await page.reload();
    await mine();
    await book.waitFor();
    assert.equal(await book.getAttribute('aria-expanded'), 'false');
    await book.click();
    assert.deepEqual(await titles.allTextContents(), ['u01-1', 'u01-2', 'u01-10']);
    const records = await page.evaluate(async book => {
      const { materials } = await import('./js/lib/materials.js');
      return (await materials.list()).filter(entry => entry.textbook === book);
    }, BOOK);
    assert.equal(records.length, 3);
    const first = records.find(item => item.title === 'u01-1');
    assert.equal(first.sentences[0].en, REAL_FOLDER ? 'Excuse me. My name is Richard Stewart.' : 'Hello there.');
    assert.ok(first.duration > 0);
    assert.equal(records.find(item => item.title === 'u01-10').sentences[0].zh, '中文');
    if (STATIC) {
      const bytes = await page.evaluate(async id => {
        const { materialsDB } = await import('./js/lib/idb.js');
        return [...new Uint8Array(await (await materialsDB.getSubtitle(id)).arrayBuffer())];
      }, first.id);
      assert.deepEqual(Buffer.from(bytes), await fs.readFile(join(folder, 'u01-1.lrc')));
    } else {
      assert.equal(first.validation.status, 'passed');
      if (process.env.LISTENINGHUB_TEST_MEDIA) {
        const media = process.env.LISTENINGHUB_TEST_MEDIA;
        const original = await fs.readFile(join(folder, 'u01-1.lrc'));
        const kept = await Promise.all((await fs.readdir(media)).map(dir => fs.readFile(join(media, dir, 'subtitles.lrc')).catch(() => null)));
        assert.ok(kept.some(bytes => bytes?.equals(original)));
      }
    }
    assert.deepEqual(errors, []);
    console.log(`PASS 教材分组、搜索、单篇和批量导入、重复重试、字幕编码与持久化 (${STATIC ? 'IndexedDB' : 'SQLite'}${REAL_FOLDER ? '，实测 u01-1' : ''})`);
  } finally {
    await browser?.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
