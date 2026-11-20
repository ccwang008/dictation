const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8080/index.html';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '..');
const TMP = require('os').tmpdir();

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const out = [];
  const ok = (n, c, x = '') => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}  ${x}`);

  // 构造一份 LRC（用已有 VOA 篇的时间轴模拟用户导入，中英双语）
  const ep = JSON.parse(fs.readFileSync(`${ROOT}/data/listening/episodes/voa-8002695.json`, 'utf8'));
  const ts = t => `[${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}]`;
  const lrc = ep.sentences.slice(0, 8).map((s, i) => `${ts(s.t0)}${s.en}${i === 7 ? '' : `\n${ts(s.t0)}${s.zh || '中文'}`}`).join('\n');
  let translationCalls = 0;
  const generatedTranslation = '这是自动翻译的第八句。';
  await page.route('https://api.mymemory.translated.net/get?**', async route => {
    translationCalls++;
    if (translationCalls === 1) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({ json: { responseStatus: 200, responseData: { translatedText: generatedTranslation } } });
  });
  fs.writeFileSync(path.join(TMP, 'lh-test.lrc'), lrc);

  await page.goto(BASE);
  await page.click('nav >> text=开始练习');
  await page.click('aside >> text=我的素材');
  await page.click('text=导入音频 + 字幕');
  await page.setInputFiles('input[accept^="audio"]', `${ROOT}/audio/voa/8002695.mp3`);
  await page.setInputFiles('input[accept^=".lrc"]', path.join(TMP, 'lh-test.lrc'));
  await page.click('button:has-text("导入") >> nth=-1');
  const validationDialog = page.getByRole('dialog', { name: '声音与字幕自动修正' });
  await validationDialog.getByRole('button', { name: '开始听写', exact: true }).waitFor();
  await validationDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForTimeout(1500);
  const mats = await page.evaluate(() => window.__LH__.L.materials.map(m => ({ t: m.title, n: m.sentenceCount })));
  ok('导入 MP3 + 双语 LRC', mats.length === 1 && mats[0].n === 8, JSON.stringify(mats));
  const useSqlite = await page.evaluate(() => window.__LH__.L.useSqlite);
  if (process.env.LISTENINGHUB_TEST_MEDIA) {
    const media = process.env.LISTENINGHUB_TEST_MEDIA;
    const folders = fs.readdirSync(media);
    ok('音频和原字幕原样落盘', useSqlite && folders.length === 1 &&
      fs.readFileSync(path.join(media, folders[0], 'subtitles.lrc'), 'utf8') === lrc &&
      fs.readFileSync(path.join(media, folders[0], 'audio.mp3')).equals(fs.readFileSync(`${ROOT}/audio/voa/8002695.mp3`)));
  }

  await page.getByRole('button', { name: /未分类.*篇/ }).click();
  await page.locator('aside .group.cursor-pointer').first().click();
  await page.waitForTimeout(800);
  await page.click('button:has-text("精听")');
  await page.click('#sent-2 span.font-mono >> nth=0');
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => { const L = window.__LH__.L; return { playing: L.playing, idx: L.activeIdx, time: L.time, t0: L.sentences[1].t0, zh: L.sentences[1].zh, src: L.current.audio }; });
  const audioSource = useSqlite ? /\/api\/materials\/[^/]+\/audio(?:\?.*)?$/.test(st.src) : st.src.startsWith('blob:');
  ok('本地素材按 LRC 时间轴播放', st.playing && st.idx === 1 && st.time >= st.t0 && audioSource && st.zh, JSON.stringify(st));
  if (useSqlite) {
    const range = await page.request.get(st.src, { headers: { Range: 'bytes=0-63' } });
    ok('已导入音频支持 HTTP Range', range.status() === 206 && (await range.body()).length === 64);
  }

  // 听写范围切换，覆盖没有难句、自动入难句本和返回时恢复进度。
  await page.click('button:has-text("听写") >> nth=0');
  const scope = page.getByRole('group', { name: '听写范围' });
  const all = scope.getByRole('button', { name: '全部' });
  const hard = scope.getByRole('button', { name: '难句' });
  const dictInput = page.getByRole('textbox', { name: '听写答案' });
  const dictNav = page.getByRole('group', { name: '听写题目' });
  const dictList = page.getByRole('list', { name: '听写句子' });
  const dictRows = dictList.getByRole('listitem');
  const dictRowButton = number => dictList.getByRole('button', { name: new RegExp(`^第 ${number} 题`) });
  const historyButton = page.getByRole('button', { name: '历史收藏' });
  const history = page.getByRole('dialog', { name: '历史收藏' });
  const saveFavorite = page.getByRole('button', { name: '收藏当前句', pressed: false });
  const savedFavorite = page.getByRole('button', { name: '收藏当前句', pressed: true });
  const localFavorite = history.getByRole('listitem').filter({ hasText: ep.sentences[1].en,
    has: page.getByRole('heading', { name: mats[0].t, exact: true }),
  });
  const hasDictFocus = () => dictInput.evaluate(input => input === document.activeElement);
  const dictInputInView = () => dictInput.evaluate(input => {
    const bounds = input.getBoundingClientRect();
    const area = input.closest('.overflow-y-auto').getBoundingClientRect();
    return input === document.activeElement && bounds.top >= area.top - 1 && bounds.bottom <= area.bottom + 1 &&
      bounds.left >= area.left && bounds.right <= area.right;
  });
  const hintWraps = locator => locator.evaluate(hint => {
    const range = document.createRange();
    range.selectNodeContents(hint);
    return range.getClientRects().length > 1 && hint.scrollWidth <= hint.clientWidth + 1;
  });
  const initial = await page.evaluate(() => {
    const L = window.__LH__.L;
    return { queue: L.dictation.queue, ids: L.sentences.map(s => s.id), idx: L.activeIdx };
  });
  ok('没有难句时默认按原文顺序全文听写', await all.getAttribute('aria-pressed') === 'true' && initial.idx === 0 && JSON.stringify(initial.queue) === JSON.stringify(initial.ids));
  const rowLayout = await dictRows.evaluateAll(rows => rows.map(row => {
    const button = row.querySelector('button');
    return { label: button.firstElementChild.textContent.trim(), top: row.getBoundingClientRect().top };
  }));
  ok('全文听写一行一句按题号纵向排列，未作答的行隐藏原文', rowLayout.length === initial.ids.length &&
    rowLayout.every((row, index) => row.label === `第 ${index + 1} 题` && (index === 0 || row.top > rowLayout[index - 1].top)) &&
    await dictInput.count() === 1 && await dictRowButton(1).getAttribute('aria-current') === 'step' &&
    await dictList.getByText(ep.sentences[1].en, { exact: true }).count() === 0);
  ok('进入听写时自动聚焦输入框', await hasDictFocus());
  const timeline = page.getByTitle('跳到对应听写题并播放本句');
  const timelineBox = await timeline.boundingBox();
  const seekRatio = await page.evaluate(() => {
    const L = window.__LH__.L;
    return (L.sentences[4].t0 + 1) / L.duration;
  });
  await timeline.click({ position: { x: timelineBox.width * seekRatio, y: timelineBox.height / 2 } });
  await page.waitForFunction(() => {
    const L = window.__LH__.L;
    return L.dictation.pos === 4 && L.activeIdx === 4 && L.mode === 'range' && L.playing &&
      L.time >= L.dictSentence.t0 && L.time < L.dictSentence.t1;
  });
  ok('点击听写进度条同步切题，并且只播放当前句', await dictRowButton(5).getAttribute('aria-current') === 'step' && await hasDictFocus());
  await page.getByRole('button', { name: '▶ 从头听写', exact: true }).click();
  await page.waitForFunction(() => {
    const L = window.__LH__.L;
    return L.dictation.pos === 0 && L.activeIdx === 0 && L.mode === 'range' && L.playing &&
      L.time >= L.dictSentence.t0 && L.time < L.dictSentence.t1;
  });
  ok('从头听写同步回到第一题，不启动整篇播放', await dictRowButton(1).getAttribute('aria-current') === 'step');
  await dictInput.fill(ep.sentences[0].en);
  await dictInput.press('Shift');
  const originalHint = page.getByRole('status', { name: '' }).filter({ hasText: ep.sentences[0].en });
  ok('单按 Shift 显示本题原文并保留草稿和焦点', await originalHint.isVisible() && await dictInput.inputValue() === ep.sentences[0].en && await hasDictFocus());
  ok('桌面下长原文提示自动换行', await hintWraps(originalHint));
  await dictInput.press('Shift');
  ok('再次单按 Shift 收起原文', !await originalHint.isVisible());
  await dictInput.press('Shift+A');
  await dictInput.press('Shift+Enter');
  await dictInput.press('1');
  ok('Shift 组合键保留大写和换行，数字 1 正常输入', !await originalHint.isVisible() && await dictInput.inputValue() === ep.sentences[0].en + 'A\n1');
  await dictInput.fill(ep.sentences[0].en);
  await dictInput.press('Shift');
  await page.getByRole('button', { name: '收起原文（Shift）' }).click();
  ok('点击可收起提示并返回输入框', !await originalHint.isVisible() && await hasDictFocus());
  await page.getByRole('button', { name: /慢放/ }).click();
  ok('慢放后自动聚焦输入框', await hasDictFocus());
  await hard.press('Enter');
  await page.waitForSelector('text=这篇还没有难句');
  await page.waitForFunction(() => !window.__LH__.L.playing);
  await all.click();
  ok('从空难句切回全部，保留草稿', await dictInput.inputValue() === ep.sentences[0].en);
  await page.evaluate(() => { window.__LH__.L.showZh = false; });
  await dictInput.press('Enter');
  const answerRegion = page.getByRole('region', { name: '听写答案与翻译' });
  ok('正确答案提交后停在本题，并显示原文和译文，忽略中文开关',
    await dictRowButton(1).getAttribute('aria-current') === 'step' &&
    await answerRegion.getByText(ep.sentences[0].en, { exact: true }).isVisible() &&
    await answerRegion.getByText(ep.sentences[0].zh || '中文', { exact: true }).isVisible() &&
    !await dictInput.isEditable() && await hasDictFocus() && translationCalls === 0);
  await dictInput.press('Enter');
  await page.waitForFunction(() => {
    const L = window.__LH__.L;
    return L.activeIdx === 1 && L.playing && L.time >= L.dictSentence.t0 && L.time < L.dictSentence.t1;
  });
  ok('查看答案后再次 Enter 进入下一行并聚焦', await page.getByText('第 2 / 8 题').isVisible() &&
    await dictRowButton(2).getAttribute('aria-current') === 'step' && await dictRowButton(1).getByText('已批改').isVisible() &&
    await dictInput.inputValue() === '' && await hasDictFocus());
  await dictInput.fill('unrelated answer');
  await dictInput.press('Enter');
  ok('错误答案按 Enter 后留在本题，可继续修改', await page.getByText('第 2 / 8 题').isVisible() && await page.getByText('unrelated', { exact: true }).isVisible() && await dictInput.isEditable() && await hasDictFocus());
  ok('错误答案同样显示原文和中文译文', await answerRegion.getByText(ep.sentences[1].en, { exact: true }).isVisible() &&
    await answerRegion.getByText(ep.sentences[1].zh || '中文', { exact: true }).isVisible());
  if (useSqlite) {
    const favoriteRoute = '**/api/dictation/favorites/**';
    await page.route(favoriteRoute, route => route.fulfill({ status: 503, json: { error: '模拟写入失败' } }));
    await saveFavorite.click();
    await page.getByRole('alert').filter({ hasText: '模拟写入失败' }).waitFor();
    ok('收藏失败显示错误，可重新提交', await saveFavorite.isEnabled());
    await page.unroute(favoriteRoute);
    await saveFavorite.click();
    await savedFavorite.waitFor();
    await historyButton.click();
    await localFavorite.waitFor();
    const savedAt = await localFavorite.locator('time').getAttribute('datetime');
    ok('收藏导入素材的原句、标题与收藏时间', await localFavorite.count() === 1 &&
      await localFavorite.getByRole('heading', { name: mats[0].t }).isVisible() && Number.isFinite(Date.parse(savedAt)));
    await page.keyboard.press('Escape');
    await history.waitFor({ state: 'hidden' });
    ok('按 Esc 只关闭历史收藏，保留当前句及输入', await dictInput.inputValue() === 'unrelated answer' &&
      await page.getByText('第 2 / 8 题').isVisible());

    await page.route(favoriteRoute, route => route.fulfill({ status: 503, json: { error: '模拟取消失败' } }));
    await savedFavorite.click();
    await page.getByRole('alert').filter({ hasText: '取消收藏失败' }).waitFor();
    ok('取消收藏失败时保留实心星，可重试', await savedFavorite.isEnabled() &&
      await savedFavorite.locator('svg').getAttribute('fill') === 'currentColor');
    await page.unroute(favoriteRoute);
    await savedFavorite.click();
    await saveFavorite.waitFor();
    const emptyStar = await saveFavorite.locator('svg').getAttribute('fill') === 'none';
    await historyButton.click();
    await page.waitForFunction(() => !window.__LH__.L.favorites.loading);
    ok('点击实心星取消收藏，变回空心星并移出历史收藏', emptyStar && !await localFavorite.isVisible());
    await history.getByRole('button', { name: '关闭' }).click();
    await saveFavorite.click();
    await savedFavorite.waitFor();
  }
  await hard.click();
  await page.waitForFunction(() => {
    const L = window.__LH__.L;
    const s = L.dictSentence;
    return L.playing && L.time >= s.t0 && L.time < s.t1;
  });
  const hardRound = await page.evaluate(() => {
    const L = window.__LH__.L;
    return { queue: L.dictation.queue, idx: L.activeIdx };
  });
  ok('难句听写只播放已标记的原文句子', await hard.getAttribute('aria-pressed') === 'true' && hardRound.queue.length === 1 && hardRound.queue[0] === initial.ids[1] && hardRound.idx === 1);
  ok('切到难句后列表只显示筛选出的题目', await dictRows.count() === 1 && await dictRowButton(1).getAttribute('aria-expanded') === 'true');
  const hardInputBeforeSeek = await dictInput.inputValue();
  await timeline.click({ position: { x: timelineBox.width * 0.8, y: timelineBox.height / 2 } });
  await page.waitForFunction(() => {
    const L = window.__LH__.L;
    return L.dictSentence.id === L.dictation.queue[0] && L.activeIdx === 1 && L.mode === 'range' && L.playing &&
      L.time >= L.dictSentence.t0 && L.time < L.dictSentence.t1;
  });
  ok('难句模式拖动进度条仍播放筛选中的当前题', await dictInput.inputValue() === hardInputBeforeSeek);
  if (useSqlite) ok('全部和难句共用收藏状态', await savedFavorite.isEnabled());
  await dictInput.fill(ep.sentences[1].en);
  await dictInput.press('Enter');
  ok('最后一题提交后先显示答案和译文', await dictInput.inputValue() === ep.sentences[1].en && !await dictInput.isEditable() &&
    await answerRegion.isVisible() && !await page.evaluate(() => window.__LH__.L.dictation.finished));
  await page.getByRole('button', { name: '完成', exact: true }).click();
  ok('查看末题答案后点击完成', await page.getByText('听写完成，平均 100 分').isVisible());
  await all.click();
  const wrongWord = page.getByText('unrelated', { exact: true });
  const resubmit = page.getByRole('button', { name: '重新提交' });
  ok('切回全文听写时恢复答案和批改，错题仍可编辑', await page.getByText('第 2 / 8 题').isVisible() && await wrongWord.isVisible() && await dictInput.isEditable());
  await page.getByRole('button', { name: '上一题', exact: true }).click();
  await page.waitForFunction(() => {
    const L = window.__LH__.L;
    return L.activeIdx === 0 && L.playing && L.time >= L.dictSentence.t0 && L.time < L.dictSentence.t1;
  });
  ok('用播放器回看上一题时保留答案及批改', await dictInput.inputValue() === ep.sentences[0].en && !await dictInput.isEditable() && await page.getByText('第 1 / 8 题').isVisible());
  await dictNav.getByText('下一句 →', { exact: true }).click();
  ok('未修改时无需重复提交', await resubmit.isDisabled());
  await dictInput.fill(`${ep.sentences[1].en} mistakenextra`);
  ok('修改答案时保留上次批改', await wrongWord.isVisible() && await page.getByText('上次批改').isVisible());
  await resubmit.click();
  ok('重新提交后更新批改，多写单词仍可修改', !await wrongWord.isVisible() && await page.getByText('mistakenextra', { exact: true }).isVisible() && await dictInput.isEditable() && await hasDictFocus());
  await dictInput.fill(ep.sentences[1].en);
  await dictInput.press('Enter');
  ok('修改正确后重新提交仍停留展示答案', await page.getByText('第 2 / 8 题').isVisible() && !await dictInput.isEditable() && await answerRegion.isVisible());
  await dictInput.press('Enter');
  ok('修正答案查看后按 Enter 进入下一题', await page.getByText('第 3 / 8 题').isVisible() && await hasDictFocus());
  await dictNav.getByText('← 上一句', { exact: true }).click();
  await page.getByRole('button', { name: '重写' }).click();
  ok('重写保留原答案并自动聚焦输入框', await dictInput.inputValue() === ep.sentences[1].en && await dictInput.isEditable() && await hasDictFocus());
  await page.getByRole('button', { name: '提交检查' }).click();
  ok('点击提交答对后同样停留显示答案和译文', await dictRowButton(2).getAttribute('aria-current') === 'step' && await answerRegion.isVisible() && await hasDictFocus());
  await dictNav.getByText('下一句 →', { exact: true }).click();
  await dictInput.fill('partially typed draft');
  await dictRowButton(8).click();
  await page.waitForFunction(() => {
    const L = window.__LH__.L;
    return L.activeIdx === 7 && L.playing && L.time >= L.dictSentence.t0 && L.time < L.dictSentence.t1;
  });
  ok('点击题号可直接跳到该行并播放，原行显示草稿状态', await dictRowButton(8).getAttribute('aria-current') === 'step' &&
    await dictRowButton(3).getByText('有草稿').isVisible() && await dictInputInView());
  await dictInput.fill(ep.sentences[7].en);
  await dictInput.press('Enter');
  await answerRegion.getByRole('button', { name: '重试翻译' }).waitFor();
  ok('没有中文时自动请求翻译，失败可重试且不影响答案', translationCalls === 1 &&
    await dictRowButton(8).getAttribute('aria-current') === 'step' && await answerRegion.getByText(ep.sentences[7].en, { exact: true }).isVisible());
  await answerRegion.getByRole('button', { name: '重试翻译' }).click();
  await answerRegion.getByText(generatedTranslation, { exact: true }).waitFor();
  ok('重试成功显示生成的译文', translationCalls === 2);
  await dictInput.press('Enter');
  ok('查看末题答案后回到第一道待补做的题，恢复草稿', await dictRowButton(3).getAttribute('aria-current') === 'step' &&
    await dictInput.inputValue() === 'partially typed draft');

  // 刷新后继续练习。
  await page.reload();
  await page.click('nav >> text=开始练习');
  if (useSqlite) {
    await historyButton.click();
    await localFavorite.waitFor();
    ok('刷新后未开始听写即可查看历史收藏', await localFavorite.isVisible() && !await dictInput.isVisible());
    await history.getByRole('button', { name: '关闭' }).click();
  }
  await page.click('aside >> text=我的素材');
  await page.waitForTimeout(500);
  const n2 = await page.evaluate(() => window.__LH__.L.materials.length);
  ok('刷新后本地素材仍在', n2 === 1);
  await page.getByRole('button', { name: /未分类.*篇/ }).click();
  await page.locator('aside .group.cursor-pointer').first().click();
  ok('重新打开素材时恢复题目和草稿，定位但不自动播放', await all.getAttribute('aria-pressed') === 'true' &&
    await dictRowButton(3).getAttribute('aria-current') === 'step' && await dictInput.inputValue() === 'partially typed draft' &&
    await hasDictFocus() && await page.evaluate(() => !window.__LH__.L.playing));
  await dictRowButton(8).click();
  await answerRegion.getByText(generatedTranslation, { exact: true }).waitFor();
  ok('刷新后回看已批改句子保留自动译文，无需重复请求', translationCalls === 2);
  await dictRowButton(3).click();
  await dictNav.getByText('← 上一句', { exact: true }).click();
  ok('刷新后保留最后一次提交的修正', await dictInput.inputValue() === ep.sentences[1].en && !await dictInput.isEditable());
  await dictNav.getByText('← 上一句', { exact: true }).click();
  ok('刷新后已提交的答案和批改仍可查看', await dictInput.inputValue() === ep.sentences[0].en && !await dictInput.isEditable());
  if (useSqlite) {
    const id = await page.evaluate(() => window.__LH__.L.current.id);
    const fresh = await browser.newContext();
    const cleanPage = await fresh.newPage();
    try {
      await cleanPage.goto(BASE);
      await cleanPage.click('nav >> text=开始练习');
      await cleanPage.click('aside >> text=我的素材');
      await cleanPage.getByRole('button', { name: /未分类.*篇/ }).click();
      await cleanPage.locator('aside .group.cursor-pointer').first().click();
      const review = await cleanPage.getByRole('textbox', { name: '听写答案' }).inputValue();
      ok('新浏览器会话读取同一 SQLite 进度', review === ep.sentences[0].en);
    } finally {
      await fresh.close();
    }

    // 模拟旧版浏览器仅保留解析后的字幕和音频。
    const legacyId = 'local-legacy-demo';
    await page.evaluate(async ({ id, legacyId }) => {
      const { materialsDB } = await import('./js/lib/idb.js');
      const meta = await (await fetch('./api/materials/' + id)).json();
      const audio = await (await fetch('./api/materials/' + id + '/audio')).blob();
      await materialsDB.put({ ...meta, id: legacyId, subtitleName: undefined }, audio);
      localStorage.setItem('lh_dictation_' + legacyId, JSON.stringify({ all: { 1: { input: 'old answer', score: 0 } } }));
    }, { id, legacyId });
    await page.reload();
    await page.waitForFunction(id => window.__LH__?.L.materials.some(material => material.id === id), legacyId);
    const migratedSubtitle = await page.request.get(new URL('./api/materials/' + legacyId + '/subtitle', BASE).href);
    const databaseState = await (await page.request.get(new URL('./api/state', BASE).href)).json();
    ok('旧版素材和进度自动迁移，按时间轴重建 VTT', (await migratedSubtitle.text()).startsWith('WEBVTT') &&
      JSON.parse(databaseState.entries['lh_dictation_' + legacyId].value).all[1].input === 'old answer');
    await page.request.delete(new URL('./api/materials/' + legacyId, BASE).href);
    await page.reload();
    await page.waitForFunction(id => window.__LH__?.L.materials.some(material => material.id === id), id);
    ok('已删除的旧素材不会重复迁移', !await page.evaluate(id => window.__LH__.L.materials.some(material => material.id === id), legacyId));
    await page.click('nav >> text=开始练习');
  }

  // 词形还原匹配词光：rescued → rescue
  await page.click('aside >> text=VOA 精选');
  await page.locator('aside .group.cursor-pointer', { hasText: 'Australian Navy' }).first().click();
  await page.waitForTimeout(800);
  await page.click('button:has-text("精听")');
  await page.locator('#sent-1 .word-token', { hasText: 'rescued' }).click();
  await page.waitForSelector('text=加入生词本');
  const p = await page.evaluate(() => { const s = window.__LH__; return { w: s.popup.atlas?.word, cefr: s.popup.atlas?.atlas?.cefr, img: s.popupImg, tip: s.popup.atlas?.atlas?.tip?.slice(0, 30) }; });
  ok('rescued → 词光 rescue（插画+辨析）', p.w === 'rescue' && p.img, JSON.stringify(p));
  await page.keyboard.press('Escape');

  if (useSqlite) {
    await page.click('button:has-text("听写") >> nth=0');
    const voaSentence = await page.evaluate(() => window.__LH__.L.dictSentence.en);
    await saveFavorite.click();
    await savedFavorite.waitFor();
    await historyButton.click();
    const voaFavorite = history.getByRole('listitem').filter({ has: page.getByRole('heading', { name: ep.title, exact: true }) });
    await voaFavorite.waitFor();
    const titles = await history.getByRole('heading', { level: 3 }).allTextContents();
    ok('历史收藏汇总 VOA 与导入素材，最新在前', await voaFavorite.getByText(voaSentence, { exact: true }).isVisible() &&
      titles.includes(mats[0].t) && titles.indexOf(ep.title) < titles.indexOf(mats[0].t));
    await voaFavorite.getByRole('button', { name: '移除' }).click();
    await voaFavorite.waitFor({ state: 'hidden' });
    await localFavorite.getByRole('button', { name: '移除' }).click();
    await localFavorite.waitFor({ state: 'hidden' });
    await history.getByRole('button', { name: '关闭' }).click();
    ok('移除收藏同步恢复当前题的收藏按钮', await saveFavorite.isEnabled());
  }

  // 字幕解析单测：SRT
  const srt = await page.evaluate(async () => {
    const m = await import('./js/lib/subtitles.js');
    return m.parseSubtitles('1\n00:00:01,000 --> 00:00:03,500\nHello world.\n你好世界。\n\n2\n00:00:04,000 --> 00:00:06,000\n<i>Second</i> line\n', 'a.srt');
  });
  ok('SRT 双语解析', srt.length === 2 && srt[0].zh === '你好世界。' && srt[1].en === 'Second line' && srt[0].t1 === 3.5, JSON.stringify(srt));

  const diff = await page.evaluate(async () => {
    const m = await import('./js/lib/utils.js');
    return m.diffWords('The 44-year-old adventurer began his trip alone in October.', 'the 44 year old adventure began trip alone in october');
  });
  ok('听写 LCS 比对', diff.total === 11 && diff.correct === 9, `${diff.correct}/${diff.total}`);

  await page.setViewportSize({ width: 390, height: 740 });
  if (await page.locator('aside').first().isVisible()) await page.getByTitle('素材列表').click();
  if (!useSqlite) await page.click('button:has-text("听写") >> nth=0');
  await all.click();
  await dictRowButton(1).click();
  await dictInput.press('Shift');
  ok('窄屏下长原文提示自动换行', await hintWraps(dictRows.first().getByRole('status')));
  const lastMobileRow = dictRows.last();
  await lastMobileRow.getByRole('button', { name: /^第 \d+ 题/ }).click();
  ok('窄屏跳到列表底部后当前输入框滚动到可见范围',
    await lastMobileRow.getByRole('textbox', { name: '听写答案' }).isVisible() && await dictInputInView());
  ok('无运行时错误', errors.length === 0, errors.join(' | '));
  console.log(out.join('\n'));
  await browser.close();
  process.exit(out.every(l => l.startsWith('PASS')) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
