// 听力模块：素材目录 / 真人音频分段播放 / 训练流程 / 听写 / 跟读 / 复述 / 本地导入
import { SegmentPlayer } from '../lib/segment-player.js?v=20261120-auto-repair';
import { compareLessonNames, fileTitle, normalizeTextbook, prepareMaterial, scanMaterialFolder, unclassified } from '../lib/material-import.js';
import { materials as materialStore } from '../lib/materials.js';
import { requestAPI, useSqlite } from '../lib/storage.js';
import { fetchJSON, loadJSON, saveJSON, diffWords, formatRelative } from '../lib/utils.js';
import * as T from './training.js';
import { useAudioValidation } from './use-audio-validation.js?v=20261120-auto-repair';

const { ref, reactive, computed, watch, nextTick, shallowRef } = Vue;
const PREF_KEY = 'lh_listen_prefs';
const epCache = new Map();
const favoritesPath = 'dictation/favorites';
const favoritePath = (episodeId, sentenceId) => `${favoritesPath}/${encodeURIComponent(episodeId)}/${sentenceId}`;
const favoriteDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const favoritesUnavailable = '请启动 ListeningHub 本地服务后使用句子收藏。';
const favoriteErrorMessage = error => error instanceof TypeError ? favoritesUnavailable : error.message;

export function useListening(ctx) {
  const prefs = loadJSON(PREF_KEY, {});
  const savePrefs = () => saveJSON(PREF_KEY, {
    rate: rate.value, showZh: showZh.value, loop: loop.value, pauseEach: pauseEach.value,
  });

  // ── 目录 ────────────────────────────────────────────────────────────────────
  const catalog = ref([]);          // VOA 精选
  const materials = ref([]);        // 用户导入
  const materialsError = ref('');
  const catalogSource = ref('');
  const catalogError = ref('');
  const tab = ref('voa');           // voa | review | mine
  const search = ref('');
  const category = ref('all');
  const level = ref('all');
  const openTextbooks = reactive(new Set());
  const trainVersion = ref(0);      // 训练状态变化时递增，驱动重新计算
  const bump = () => { trainVersion.value++; };

  async function loadCatalog() {
    try {
      const idx = await fetchJSON('data/listening/index.json');
      catalog.value = idx.episodes.map(e => ({ ...e, kind: 'voa' }));
      catalogSource.value = idx.source;
    } catch (e) {
      catalogError.value = '素材目录加载失败，请检查网络后刷新';
    }
    await loadMaterials();
  }

  async function loadMaterials() {
    materialsError.value = '';
    try {
      const list = await materialStore.list();
      materials.value = list.sort((a, b) => b.createdAt - a.createdAt).map(m => ({
        id: m.id, title: m.title, titleZh: '', program: '我的素材', category: 'Mine', level: '',
        textbook: normalizeTextbook(m.textbook),
        duration: m.duration, wpm: m.wpm || 0, sentenceCount: m.sentences.length, kind: 'local', date: '', validation: m.validation,
      }));
    } catch (error) { materialsError.value = error.message || '无法读取我的素材'; }
  }

  const categories = computed(() => {
    const seen = new Set();
    return catalog.value.filter(e => !seen.has(e.program) && seen.add(e.program)).map(e => ({ key: e.program, program: e.program }));
  });

  const statusOf = id => { trainVersion.value; return T.status(id); };

  const filtered = computed(() => {
    trainVersion.value;
    let list = tab.value === 'mine' ? materials.value : catalog.value;
    if (tab.value === 'review') {
      const due = new Set(T.dueIds());
      list = [...catalog.value, ...materials.value].filter(e => due.has(e.id));
    }
    if (tab.value === 'voa') {
      if (category.value !== 'all') list = list.filter(e => e.program === category.value);
      if (level.value !== 'all') list = list.filter(e => e.level === level.value);
    }
    const q = search.value.trim().toLowerCase();
    if (q) list = list.filter(e => {
      const collection = tab.value === 'mine' ? e.textbook || unclassified : e.program;
      return `${e.title} ${e.titleZh || ''} ${collection}`.toLowerCase().includes(q);
    });
    return list;
  });

  const textbookNames = computed(() => [...new Set(materials.value.map(m => m.textbook).filter(Boolean))].sort(compareLessonNames));
  const materialSections = computed(() => {
    if (tab.value !== 'mine') return [{ key: tab.value, episodes: filtered.value }];
    const groups = new Map();
    for (const episode of filtered.value) {
      if (!groups.has(episode.textbook)) groups.set(episode.textbook, []);
      groups.get(episode.textbook).push(episode);
    }
    const searching = Boolean(search.value.trim());
    const names = [...textbookNames.value, ''];
    return names.filter(name => groups.has(name)).map(name => ({
      key: name, title: name || unclassified, expanded: searching || openTextbooks.has(name),
      episodes: groups.get(name).sort((a, b) => compareLessonNames(a.title, b.title)),
    }));
  });
  function toggleTextbook(name) {
    if (search.value.trim()) return;
    if (openTextbooks.has(name)) openTextbooks.delete(name);
    else openTextbooks.add(name);
  }

  const dueCount = computed(() => { trainVersion.value; return T.dueIds().length; });
  const learnedCount = computed(() => {
    trainVersion.value;
    return Object.values(T.allStates()).filter(s => s.learnedAt).length;
  });

  // ── 播放器 ──────────────────────────────────────────────────────────────────
  const player = new SegmentPlayer();
  const current = shallowRef(null);   // 当前篇完整数据
  const loading = ref(false);
  const loadError = ref('');
  const playing = ref(false);
  const time = ref(0);
  const duration = ref(0);
  const activeIdx = ref(-1);
  const mode = ref('idle');           // idle | range | continuous
  const rate = ref(prefs.rate || 1);
  const loop = ref(!!prefs.loop);
  const pauseEach = ref(!!prefs.pauseEach);
  const showZh = ref(prefs.showZh !== false);
  const revealText = ref(false);      // 盲听阶段临时显示文稿
  const audioError = ref('');
  let objectUrl = '';
  let pausedAtIdx = -1;

  player.setRate(rate.value);
  player.on('state', v => { playing.value = v; });
  player.on('meta', d => { duration.value = d; });
  player.on('error', e => {
    if (e && e.name === 'NotAllowedError') return;
    audioError.value = '音频加载失败，请检查网络或稍后重试';
  });
  player.on('ended', () => {
    if (current.value) ctx.recordEpisodeCompleted(current.value.id);
    mode.value = 'idle';
  });
  player.on('time', onTime);

  const sentences = computed(() => current.value?.sentences || []);
  const activeSentence = computed(() => sentences.value[activeIdx.value] || null);
  const train = computed(() => { trainVersion.value; return current.value ? T.getState(current.value.id) : null; });
  const hardSet = computed(() => new Set(train.value?.hard || []));
  const inReview = computed(() => !!(train.value?.learnedAt && train.value.nextReviewAt && train.value.nextReviewAt <= Date.now()));
  const stageKey = ref('intensive');  // 当前展示的训练阶段

  const validationUI = useAudioValidation({ current, player, async onApproved(id) {
    const metadata = await materialStore.get(id);
    if (current.value?.id === id) {
      const audio = await materialStore.audioURL(id, metadata.validation.revision);
      resetDictation();
      current.value = { ...current.value, ...metadata, audio };
      player.load(audio);
    }
    await loadMaterials();
  } });
  watch(validationUI.validationReady, ready => { if (!ready) resetDictation(); });
  async function beginValidatedDictation() {
    if (validationUI.validation.check?.status !== 'passed') return;
    const id = validationUI.validation.id;
    validationUI.closeValidation();
    await openEpisode({ id, kind: 'local' });
    setStage('dictation');
  }

  function findIdx(t) {
    const list = sentences.value;
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].t0 <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function onTime(t) {
    time.value = t;
    if (mode.value !== 'continuous') return;
    const idx = findIdx(t);
    if (idx !== activeIdx.value && idx >= 0) {
      activeIdx.value = idx;
      ctx.recordSentencePlayed(current.value?.id);
    }
    const s = sentences.value[idx];
    if (pauseEach.value && s && t >= s.t1 - 0.03 && pausedAtIdx !== idx) {
      pausedAtIdx = idx;
      player.pause();
    }
  }

  async function resolveEpisode(meta) {
    if (meta.kind === 'local') {
      const m = await materialStore.get(meta.id);
      const audio = await materialStore.audioURL(meta.id, m?.validation?.status === 'passed' ? m.validation.revision : '');
      if (!m || !audio) throw new Error('本地素材不存在');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = audio.startsWith('blob:') ? audio : '';
      return { ...meta, ...m, audio, audioRef: `idb:${meta.id}`, glossary: [], credits: [] };
    }
    if (!epCache.has(meta.id)) epCache.set(meta.id, fetchJSON(`data/listening/episodes/${meta.id}.json`));
    const ep = await epCache.get(meta.id);
    return { ...ep, kind: 'voa', audioRef: ep.audio };
  }

  async function openEpisode(meta) {
    if (current.value?.id === meta.id) return;
    player.stop();
    resetDictation();
    closeShadow();
    resetRetell();
    loading.value = true;
    loadError.value = '';
    audioError.value = '';
    try {
      const ep = await resolveEpisode(meta);
      current.value = ep;
      dictationAnswers.value = loadJSON(dictationKey(ep.id), {});
      duration.value = ep.duration || 0;
      time.value = 0;
      mode.value = 'idle';
      revealText.value = false;
      player.load(ep.audio);
      const st = T.getState(ep.id);
      dictationMode.value = preferredDictationMode.value;
      const last = st.lastSentence ? ep.sentences.findIndex(s => s.id === st.lastSentence) : -1;
      activeIdx.value = last;
      if (st.learnedAt && st.nextReviewAt && st.nextReviewAt <= Date.now()) stageKey.value = 'blind';
      else if (dictationAnswers.value.resume?.active) {
        stageKey.value = 'dictation';
        startDictation(dictationMode.value, false);
      } else stageKey.value = T.STAGES[Math.min(st.stage, T.STAGES.length - 1)].key;
      if (window.innerWidth < 1024) ctx.onEpisodeOpened && ctx.onEpisodeOpened();
    } catch (e) {
      loadError.value = String(e.message || e);
    } finally {
      loading.value = false;
    }
  }

  function closeEpisode() {
    player.stop();
    resetDictation();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = '';
    current.value = null;
  }

  function playSentence(s, opts = {}) {
    if (!s || !current.value) return;
    audioError.value = '';
    mode.value = 'range';
    activeIdx.value = sentences.value.indexOf(s);
    T.touch(current.value.id, s.id);
    ctx.recordSentencePlayed(current.value.id);
    return player.playRange(s.t0, s.t1, { loop: opts.loop ?? loop.value, onEnd: opts.onEnd });
  }

  function playContinuous(fromIdx) {
    if (!current.value) return;
    audioError.value = '';
    const idx = fromIdx ?? (activeIdx.value >= 0 ? activeIdx.value : 0);
    const s = sentences.value[idx];
    mode.value = 'continuous';
    pausedAtIdx = -1;
    activeIdx.value = idx;
    if (s) T.touch(current.value.id, s.id);
    return player.playFrom(s ? s.t0 : 0);
  }

  function playAll() {
    if (dictation.value.active) return selectDictQuestion(0);
    pauseEach.value = false;
    return playContinuous(0);
  }

  function togglePlay() {
    if (!current.value) return;
    if (dictation.value.active) {
      focusDictInput();
      if (playing.value) return player.pause();
      const s = dictSentence.value;
      if (mode.value === 'range' && player.range?.t0 === s?.t0 && player.range?.t1 === s?.t1) return player.resume();
      return dictPlay();
    }
    if (playing.value) return player.pause();
    if (mode.value === 'range' && player.range) return player.resume();
    if (mode.value === 'continuous') {
      pausedAtIdx = -1;
      const next = pauseEach.value ? Math.min(activeIdx.value + 1, sentences.value.length - 1) : null;
      if (pauseEach.value && next != null && time.value >= (sentences.value[activeIdx.value]?.t1 ?? 0) - 0.05) return playContinuous(next);
      return player.resume();
    }
    if (activeSentence.value) return playSentence(activeSentence.value);
    return playContinuous(0);
  }

  function step(delta) {
    if (dictation.value.active) return dictMove(delta);
    if (!sentences.value.length) return;
    const idx = Math.max(0, Math.min(sentences.value.length - 1, (activeIdx.value < 0 ? -1 : activeIdx.value) + delta));
    if (mode.value === 'continuous') return playContinuous(idx);
    return playSentence(sentences.value[idx]);
  }

  function replay() {
    if (dictation.value.active) return dictPlay();
    if (activeSentence.value) playSentence(activeSentence.value);
  }

  function seekRatio(e) {
    if (!duration.value) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration.value;
    if (dictation.value.active) {
      const queue = dictation.value.queue;
      let pos = 0;
      for (let i = 0; i < queue.length; i++) {
        const sentence = sentences.value.find(s => s.id === queue[i]);
        if (sentence.t0 <= t) pos = i;
        else break;
      }
      return selectDictQuestion(pos);
    }
    mode.value = 'continuous';
    pausedAtIdx = -1;
    if (playing.value) player.playFrom(t); else { player.seek(t); time.value = t; activeIdx.value = findIdx(t); }
  }

  function setRate(r) {
    rate.value = r;
    player.setRate(r);
    savePrefs();
  }

  watch([showZh, loop, pauseEach], savePrefs);
  watch(loop, v => { if (player.range) player.range.loop = v; });
  watch(activeIdx, idx => {
    const s = sentences.value[idx];
    if (!s || mode.value !== 'continuous') return;
    nextTick(() => {
      const el = document.getElementById(`sent-${s.id}`);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  });

  // ── 训练阶段 ────────────────────────────────────────────────────────────────
  function setStage(key) {
    const previous = stageKey.value;
    if (previous === 'dictation' && key !== previous) {
      saveDictationResume(false);
      resetDictation();
    }
    stageKey.value = key;
    revealText.value = false;
    if (key === 'dictation') startDictation(previous === key ? dictationMode.value : preferredDictationMode.value);
    if (key === 'retell') resetRetell();
  }

  function completeStage() {
    if (!current.value) return;
    if (stageKey.value === 'dictation' && !validationUI.validationReady.value) return validationUI.openValidation(current.value);
    const id = current.value.id;
    const before = T.getState(id);
    const idx = T.STAGES.findIndex(s => s.key === stageKey.value);
    if (idx >= before.stage) T.setStage(id, idx);
    const st = T.completeStage(id);
    if (stageKey.value === 'blind') ctx.recordEpisodeCompleted(id);
    if (stageKey.value === 'dictation') {
      saveDictationResume(false);
      resetDictation();
    }
    bump();
    if (st.stage >= T.STAGES.length) {
      ctx.toast(before.learnedAt ? '本阶段完成' : `首学完成！${formatRelative(st.nextReviewAt)}进行第 1 轮复习`);
      stageKey.value = 'retell';
    } else {
      stageKey.value = T.STAGES[st.stage].key;
      if (stageKey.value === 'dictation') startDictation(preferredDictationMode.value);
    }
  }

  function finishReview() {
    if (!current.value) return;
    const st = T.completeReview(current.value.id);
    bump();
    ctx.toast(st.nextReviewAt ? `第 ${st.reviewIdx} 轮复习完成，${formatRelative(st.nextReviewAt)}再来` : '7 轮复习全部完成，这篇已经掌握了 🎉');
  }

  function toggleHard(s) {
    if (!current.value || !s) return;
    T.toggleHard(current.value.id, s.id);
    bump();
  }

  function resetProgress() {
    if (!current.value) return;
    resetDictation();
    dictationAnswers.value = {};
    saveJSON(dictationKey(current.value.id), {});
    T.resetEpisode(current.value.id);
    stageKey.value = 'blind';
    bump();
  }

  const keywords = computed(() => {
    const ep = current.value;
    if (!ep) return [];
    if (ep.glossary?.length) return ep.glossary.map(g => g.term);
    const stop = new Set('the a an and or but of to in on at for with from by as is are was were be been it this that these those he she they we you i his her their our its not have has had will would can could said says about into over after before more most than then there which who what when where how also just very some many such other'.split(' '));
    const freq = new Map();
    ep.sentences.forEach(s => s.en.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).forEach(w => {
      if (w.length > 4 && !stop.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
    }));
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);
  });

  // ── 听写 ────────────────────────────────────────────────────────────────────
  const dictationMode = ref('all');
  const dictationRounds = reactive({ all: { active: false }, hard: { active: false } });
  const dictation = computed(() => dictationRounds[dictationMode.value]);
  const dictationAnswers = ref({});
  const dictHint = ref(false);
  const dictationKey = id => `lh_dictation_${id}`;
  const dictationSentences = computed(() => {
    const excluded = new Set(current.value?.dictationExcluded || []);
    return sentences.value.filter(s => !excluded.has(s.id));
  });
  const dictHardIds = computed(() => dictationSentences.value.filter(s => hardSet.value.has(s.id)).map(s => s.id));
  const preferredDictationMode = computed(() => dictationAnswers.value.resume?.mode ?? (dictHardIds.value.length ? 'hard' : 'all'));
  const dictSentence = computed(() => {
    const round = dictation.value;
    return round.active ? sentences.value.find(s => s.id === round.queue[round.pos]) : null;
  });
  const dictAnswer = computed(() => dictationAnswers.value[dictationMode.value]?.[dictSentence.value?.id]);
  const dictInput = computed({
    get: () => dictAnswer.value?.draft ?? dictAnswer.value?.input ?? '',
    set(input) {
      const answer = dictAnswer.value;
      if (!answer) return;
      answer.draft = input === answer.input ? undefined : input;
      saveDictAnswer();
    },
  });
  const dictResult = computed(() => {
    const answer = dictAnswer.value;
    return answer?.score != null && !answer.rewriting ? diffWords(dictSentence.value.en, answer.input) : null;
  });
  const dictHasErrors = computed(() => dictResult.value?.diff.some(word => !word.ok) ?? false);
  const dictTranslations = reactive(loadJSON('lh_sentence_translations', {}));
  const dictTranslationRequests = reactive({});
  const dictTranslation = computed(() => dictSentence.value?.zh || dictTranslations[dictSentence.value?.en] || '');
  const dictTranslationState = computed(() => dictTranslationRequests[dictSentence.value?.en] || '');
  async function translateDictSentence() {
    const en = dictSentence.value?.en;
    if (!dictResult.value || !en || dictTranslation.value || dictTranslationRequests[en] === 'loading') return;
    dictTranslationRequests[en] = 'loading';
    try {
      const zh = await ctx.translateToChinese(en);
      if (!zh) throw new Error('Translation unavailable');
      dictTranslations[en] = zh;
      saveJSON('lh_sentence_translations', dictTranslations);
      dictTranslationRequests[en] = '';
    } catch {
      dictTranslationRequests[en] = 'error';
    }
  }
  watch(() => dictResult.value ? dictSentence.value?.en : null, en => {
    if (en) translateDictSentence();
  });
  const dictCanSubmit = computed(() => {
    const answer = dictAnswer.value;
    return Boolean(dictInput.value.trim()) && (!dictResult.value || (dictHasErrors.value && answer.draft != null));
  });
  const dictAnswerUnfinished = answer => answer?.score == null || answer.rewriting;

  function dictRowStatus(id) {
    const answer = dictationAnswers.value[dictationMode.value]?.[id];
    if (answer?.rewriting) return '重写中';
    if (answer?.draft != null) return '有草稿';
    return answer?.score != null ? '已批改' : '未作答';
  }

  function startDictation(selection = dictationMode.value, autoplay = true) {
    if (!current.value) return;
    if (!validationUI.validationReady.value) {
      validationUI.openValidation(current.value);
      return;
    }
    const switching = selection !== dictationMode.value;
    if (dictation.value.active) {
      if (!switching) return focusDictInput(true);
      stopDictationAudio();
    }
    dictationMode.value = selection;
    if (!dictation.value.active) {
      const queue = selection === 'hard' ? [...dictHardIds.value] : dictationSentences.value.map(s => s.id);
      if (!queue.length) return saveDictationResume(true);
      const answers = dictationAnswers.value[selection];
      const savedPosition = queue.indexOf(dictationAnswers.value.resume?.[selection]);
      const firstUnanswered = queue.findIndex(id => dictAnswerUnfinished(answers?.[id]));
      const pos = savedPosition >= 0 ? savedPosition : (firstUnanswered >= 0 ? firstUnanswered : queue.length - 1);
      dictationRounds[selection] = { active: true, queue, pos, finished: false };
    }
    openDictQuestion(autoplay);
  }
  function saveDictationResume(active) {
    const key = dictationKey(current.value.id);
    const saved = loadJSON(key, {});
    const resume = { ...saved.resume, active, mode: dictationMode.value };
    const s = dictSentence.value;
    if (s) resume[dictationMode.value] = s.id;
    dictationAnswers.value.resume = resume;
    saveJSON(key, { ...saved, resume });
  }
  function saveDictAnswer() {
    const key = dictationKey(current.value.id);
    const saved = loadJSON(key, {});
    (saved[dictationMode.value] ??= {})[dictSentence.value.id] = dictAnswer.value;
    saveJSON(key, saved);
  }
  function openDictQuestion(autoplay = true) {
    const s = dictSentence.value;
    const answers = dictationAnswers.value[dictationMode.value] ??= {};
    answers[s.id] ??= { input: '', score: null };
    dictHint.value = false;
    saveDictationResume(true);
    if (autoplay) dictPlay(rate.value, true);
    else {
      activeIdx.value = sentences.value.indexOf(s);
      time.value = s.t0;
      focusDictInput(true);
    }
  }
  function focusDictInput(scroll = false) {
    nextTick(() => {
      const input = document.getElementById('dictation-input');
      input?.focus({ preventScroll: true });
      if (scroll) input?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  function dictPlay(r = rate.value, scroll = false) {
    if (!validationUI.validationReady.value) return validationUI.openValidation(current.value);
    const s = dictSentence.value;
    if (!s) return;
    player.pause();
    player.setRate(r);
    playSentence(s, { loop: false, onEnd: () => player.setRate(rate.value) });
    focusDictInput(scroll);
  }
  function toggleDictHint() {
    if (!dictSentence.value || dictResult.value) return;
    dictHint.value = !dictHint.value;
    focusDictInput();
  }
  function dictSubmit() {
    const answer = dictAnswer.value;
    const s = dictSentence.value;
    if (!s || !dictCanSubmit.value) return;
    answer.input = dictInput.value;
    answer.score = diffWords(s.en, answer.input).score;
    delete answer.draft;
    delete answer.rewriting;
    dictation.value.finished = false;
    saveDictAnswer();
    if (answer.score < 80 && !hardSet.value.has(s.id)) toggleHard(s);
    focusDictInput(true);
  }
  function dictRewrite() {
    dictAnswer.value.rewriting = true;
    saveDictAnswer();
    dictation.value.finished = false;
    dictHint.value = false;
    dictPlay();
  }
  function selectDictQuestion(pos) {
    const round = dictation.value;
    if (!round.active || pos < 0 || pos >= round.queue.length) return;
    if (round.pos === pos) return dictPlay(rate.value, true);
    round.pos = pos;
    openDictQuestion();
  }
  function dictMove(delta) {
    selectDictQuestion(dictation.value.pos + delta);
  }
  function dictNext() {
    const round = dictation.value;
    if (!round.active) return;
    if (round.pos < round.queue.length - 1) return dictMove(1);
    if (round.finished) return;
    const answers = dictationAnswers.value[dictationMode.value];
    const nextUnanswered = round.queue.findIndex(id => dictAnswerUnfinished(answers[id]));
    if (nextUnanswered >= 0) return dictMove(nextUnanswered - round.pos);
    const scores = round.queue.map(id => answers[id].score);
    const avg = Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
    round.finished = true;
    stopDictationAudio();
    focusDictInput();
    ctx.toast(`听写完成，平均 ${avg} 分`);
  }
  function stopDictationAudio() {
    player.stop();
    player.setRate(rate.value);
  }
  function closeDictation() {
    if (!dictation.value.active) return;
    saveDictationResume(false);
    dictationRounds[dictationMode.value] = { active: false };
    stopDictationAudio();
  }
  function resetDictation() {
    if (dictation.value.active) stopDictationAudio();
    dictationRounds.all = { active: false };
    dictationRounds.hard = { active: false };
  }

  // ── 听写收藏 ────────────────────────────────────────────────────────────────
  const favorites = reactive({ items: [], pending: new Set(), loading: false, loadError: '', removeError: '' });
  const favoriteActionError = ref(null);
  const dictFavoritePath = computed(() => current.value && dictSentence.value
    ? favoritePath(current.value.id, dictSentence.value.id)
    : '');
  const dictFavoriteSaved = computed(() => favorites.items.some(item =>
    item.episodeId === current.value?.id && item.sentenceId === dictSentence.value?.id));
  const dictFavoritePending = computed(() => favorites.pending.has(dictFavoritePath.value));
  const dictFavoriteError = computed(() => favoriteActionError.value?.path === dictFavoritePath.value
    ? favoriteActionError.value.message
    : '');
  let favoriteRevision = 0;

  async function loadFavorites() {
    if (!useSqlite || favorites.loading) return;
    favorites.loading = true;
    favorites.loadError = '';
    try {
      // A completed write may have made an in-flight list response stale.
      let revision;
      let result;
      do {
        revision = favoriteRevision;
        result = await requestAPI(favoritesPath);
      } while (revision !== favoriteRevision);
      favorites.items = result.favorites;
    } catch (error) {
      favorites.loadError = favoriteErrorMessage(error);
    } finally {
      favorites.loading = false;
    }
  }

  async function updateFavorite(path, method) {
    favorites.pending.add(path);
    try {
      const item = await requestAPI(path, { method });
      favoriteRevision++;
      const items = favorites.items.filter(entry => favoritePath(entry.episodeId, entry.sentenceId) !== path);
      if (method === 'PUT') {
        items.unshift(item);
        items.sort((a, b) => b.savedAt - a.savedAt);
      }
      favorites.items = items;
    } finally {
      favorites.pending.delete(path);
    }
  }

  async function toggleDictFavorite() {
    const path = dictFavoritePath.value;
    if (!useSqlite || !path || favorites.pending.has(path)) return;
    const saved = dictFavoriteSaved.value;
    favoriteActionError.value = null;
    try {
      await updateFavorite(path, saved ? 'DELETE' : 'PUT');
    } catch (error) {
      const action = saved ? '取消收藏' : '收藏';
      favoriteActionError.value = { path, message: `${action}失败。${favoriteErrorMessage(error)}` };
    }
  }

  async function removeFavorite(item) {
    const path = favoritePath(item.episodeId, item.sentenceId);
    if (favorites.pending.has(path)) return;
    favorites.removeError = '';
    try {
      await updateFavorite(path, 'DELETE');
    } catch (error) {
      favorites.removeError = favoriteErrorMessage(error);
    }
  }

  watch([stageKey, current], ([stage, episode]) => {
    if (stage === 'dictation' && episode) loadFavorites();
  });

  // ── 跟读 ────────────────────────────────────────────────────────────────────
  const shadow = reactive({ active: false, sentenceId: null, recording: false, url: '', error: '', comparing: false });
  const shadowSentence = computed(() => sentences.value.find(s => s.id === shadow.sentenceId) || null);
  let recorder = null;
  let chunks = [];
  let recStream = null;
  const recAudio = new Audio();

  async function startRecorder(onDone) {
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return '无法访问麦克风，请在浏览器地址栏允许麦克风权限';
    }
    chunks = [];
    recorder = new MediaRecorder(recStream);
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      recStream.getTracks().forEach(t => t.stop());
      onDone(URL.createObjectURL(blob));
    };
    recorder.start();
    return '';
  }
  function stopRecorder() { if (recorder && recorder.state !== 'inactive') recorder.stop(); }

  function openShadow(s) {
    const target = s || activeSentence.value || sentences.value[0];
    if (!target) return;
    closeShadow();
    Object.assign(shadow, { active: true, sentenceId: target.id, recording: false, url: '', error: '' });
    playSentence(target, { loop: false });
  }
  function shadowNav(delta) {
    const i = sentences.value.findIndex(s => s.id === shadow.sentenceId) + delta;
    if (i >= 0 && i < sentences.value.length) openShadow(sentences.value[i]);
  }
  async function shadowRecord() {
    if (shadow.recording) { stopRecorder(); shadow.recording = false; return; }
    player.pause();
    if (shadow.url) URL.revokeObjectURL(shadow.url);
    shadow.url = '';
    shadow.error = await startRecorder(url => { shadow.url = url; });
    shadow.recording = !shadow.error;
  }
  function shadowPlayMine() {
    if (!shadow.url) return;
    recAudio.src = shadow.url;
    recAudio.play().catch(() => {});
  }
  function shadowCompare() {
    const s = shadowSentence.value;
    if (!s || !shadow.url) return;
    playSentence(s, { loop: false, onEnd: () => setTimeout(shadowPlayMine, 300) });
  }
  function closeShadow() {
    if (shadow.recording) stopRecorder();
    if (shadow.url) URL.revokeObjectURL(shadow.url);
    Object.assign(shadow, { active: false, sentenceId: null, recording: false, url: '', error: '' });
  }

  // ── 复述 ────────────────────────────────────────────────────────────────────
  const retell = reactive({ recording: false, url: '', error: '', reveal: false, seconds: 0 });
  let retellTimer = 0;
  async function retellRecord() {
    if (retell.recording) {
      stopRecorder();
      retell.recording = false;
      clearInterval(retellTimer);
      return;
    }
    player.pause();
    if (retell.url) URL.revokeObjectURL(retell.url);
    retell.url = '';
    retell.seconds = 0;
    retell.error = await startRecorder(url => { retell.url = url; });
    retell.recording = !retell.error;
    if (retell.recording) retellTimer = setInterval(() => { retell.seconds++; }, 1000);
  }
  function retellPlay() {
    if (!retell.url) return;
    recAudio.src = retell.url;
    recAudio.play().catch(() => {});
  }
  function resetRetell() {
    if (retell.recording) stopRecorder();
    clearInterval(retellTimer);
    if (retell.url) URL.revokeObjectURL(retell.url);
    Object.assign(retell, { recording: false, url: '', error: '', reveal: false, seconds: 0 });
  }

  // ── 难句本 ──────────────────────────────────────────────────────────────────
  const hardItems = ref([]);
  async function loadHardItems() {
    const list = T.hardList();
    const all = [...catalog.value, ...materials.value];
    const out = [];
    for (const { epId, sentenceId } of list) {
      const meta = all.find(e => e.id === epId);
      if (!meta) continue;
      try {
        const ep = meta.kind === 'local' ? await materialStore.get(epId) : await (epCache.get(epId) || (epCache.set(epId, fetchJSON(`data/listening/episodes/${epId}.json`)), epCache.get(epId)));
        const s = ep?.sentences.find(x => x.id === sentenceId);
        if (s) out.push({ meta, sentence: s });
      } catch { /* 忽略 */ }
    }
    hardItems.value = out;
  }
  async function playHardItem(item) {
    await openEpisode(item.meta);
    const s = sentences.value.find(x => x.id === item.sentence.id);
    stageKey.value = 'intensive';
    if (s) playSentence(s);
  }
  watch(tab, v => {
    if (v === 'review') loadHardItems();
    if (v === 'mine') loadMaterials();
  });

  // ── 导入本地素材 ────────────────────────────────────────────────────────────
  const importer = reactive({
    open: false, mode: 'single', audio: null, sub: null, title: '', textbookChoice: '', newTextbook: '',
    groups: [], report: null, processed: 0, error: '', busy: false,
  });
  function openImporter(mode = 'single') {
    Object.assign(importer, {
      open: true, mode, audio: null, sub: null, title: '', textbookChoice: '', newTextbook: '',
      groups: [], report: null, processed: 0, error: '', busy: false,
    });
  }
  function pickAudio(file) {
    const previousTitle = importer.audio ? fileTitle(importer.audio.name) : '';
    importer.audio = file || null;
    if (!importer.title || importer.title === previousTitle) importer.title = file ? fileTitle(file.name) : '';
  }
  function pickFolder(files) {
    const { name, groups } = scanMaterialFolder(files);
    importer.groups = groups;
    importer.report = null;
    importer.error = groups.length ? '' : '文件夹里没有支持的音频或字幕文件';
    const textbook = normalizeTextbook(name);
    importer.textbookChoice = !textbook || textbookNames.value.includes(textbook) ? textbook : null;
    importer.newTextbook = importer.textbookChoice === null ? textbook : '';
  }
  async function importFolder(textbook) {
    const knownTitles = new Set((await materialStore.list())
      .filter(item => normalizeTextbook(item.textbook) === textbook).map(item => item.title.trim()));
    const report = { added: 0, skipped: 0, failed: 0, items: [] };
    function record(group, status, reason = '') {
      report[status]++;
      report.items.push({ path: group.path, status, reason });
      importer.processed++;
    }
    for (const group of importer.groups) {
      const [audio] = group.audio;
      const [subtitle] = group.subtitle;
      if (group.audio.length > 1 || group.subtitle.length > 1) {
        record(group, 'skipped', '有多个同名音频或字幕，无法确定配对');
        continue;
      }
      if (!audio || !subtitle) {
        record(group, 'skipped', audio ? `${audio.name} 缺少同名字幕` : `${subtitle.name} 缺少同名音频`);
        continue;
      }
      const title = fileTitle(audio.name).trim();
      if (knownTitles.has(title)) {
        record(group, 'skipped', '该教材下已有同名课文');
        continue;
      }
      try {
        const metadata = await prepareMaterial(audio, subtitle, { title, textbook });
        await materialStore.put(metadata, audio, subtitle);
        knownTitles.add(metadata.title);
        record(group, 'added');
      } catch (error) {
        record(group, 'failed', error.message || '保存失败');
      }
    }
    importer.report = report;
    await loadMaterials();
  }
  async function saveImport() {
    if (importer.busy) return;
    const textbook = normalizeTextbook(importer.textbookChoice ?? importer.newTextbook);
    if (importer.textbookChoice === null && !textbook) { importer.error = '请输入教材名称，或选择未分类'; return; }
    const folder = importer.mode === 'folder';
    if (folder && !importer.groups.length) { importer.error = '请选择包含音频和字幕的文件夹'; return; }
    if (!folder && (!importer.audio || !importer.sub)) { importer.error = '请同时选择音频和字幕文件'; return; }
    importer.busy = true;
    importer.error = '';
    importer.processed = 0;
    try {
      if (folder) {
        if (navigator.locks) await navigator.locks.request('listeninghub-folder-import', () => importFolder(textbook));
        else await importFolder(textbook);
        return;
      }
      const { audio, sub, title } = importer;
      const metadata = await prepareMaterial(audio, sub, { title, textbook });
      await materialStore.put(metadata, audio, sub);
      await loadMaterials();
      importer.open = false;
      tab.value = 'mine';
      ctx.toast(`已导入 ${metadata.sentences.length} 句${useSqlite ? '，正在自动修正声音与字幕' : ''}`);
      await validationUI.openValidation(metadata);
    } catch (e) {
      importer.error = String(e.message || e);
    } finally {
      importer.busy = false;
    }
  }
  async function removeMaterial(meta) {
    if (!confirm(`删除「${meta.title}」？音频和字幕会从本机移除。`)) return;
    try {
      await materialStore.remove(meta.id);
      if (current.value?.id === meta.id) closeEpisode();
      saveJSON(dictationKey(meta.id), {});
      T.resetEpisode(meta.id);
      bump();
      await loadMaterials();
    } catch (error) {
      ctx.toast(error.message || '无法删除素材');
    }
  }

  // ── 快捷键 ──────────────────────────────────────────────────────────────────
  let dictHintShiftTarget = null;
  function cancelDictHintShortcut() {
    dictHintShiftTarget = null;
  }
  function onKey(e) {
    const shiftTarget = dictHintShiftTarget;
    cancelDictHintShortcut();
    if (!current.value) return false;
    if (dictation.value.active) {
      if (e.isComposing) return false;
      if (e.key === 'Shift' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.type === 'keyup') {
          if (shiftTarget === e.target) toggleDictHint();
        } else if (!e.repeat) {
          dictHintShiftTarget = e.target;
        }
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.target.closest('button')) {
        e.preventDefault();
        if (e.repeat) return true;
        if (dictCanSubmit.value) {
          dictSubmit();
        } else if (dictResult.value && dictAnswer.value.draft == null) {
          dictNext();
        }
        return true;
      }
      if (e.key === 'Tab' && !e.shiftKey && e.target.tagName === 'TEXTAREA') {
        e.preventDefault();
        dictPlay();
        return true;
      }
      return false;
    }
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return false;
    const k = e.key.toLowerCase();
    if (e.key === ' ') { e.preventDefault(); togglePlay(); return true; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); return true; }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); return true; }
    if (k === 'r') { replay(); return true; }
    if (k === 'l') { loop.value = !loop.value; return true; }
    if (k === 'h' && activeSentence.value) { toggleHard(activeSentence.value); return true; }
    if (k === 'z') { showZh.value = !showZh.value; return true; }
    return false;
  }

  function wordContext(sentence) {
    const ep = current.value;
    if (!ep || !sentence) return {};
    return { epId: ep.id, epTitle: ep.title, sentenceId: sentence.id, en: sentence.en, t0: sentence.t0, t1: sentence.t1, audioRef: ep.audioRef };
  }

  function stopAll() { player.pause(); }

  return {
    ...validationUI, beginValidatedDictation,
    // 目录
    catalog, materials, materialsError, useSqlite, catalogSource, catalogError, tab, search, category, level, categories, filtered,
    materialSections, textbookNames, toggleTextbook, statusOf, dueCount, learnedCount, loadCatalog, trainVersion,
    // 播放
    current, loading, loadError, audioError, playing, time, duration, activeIdx, activeSentence, sentences, mode,
    rate, loop, pauseEach, showZh, revealText, openEpisode, closeEpisode, playSentence, playContinuous, playAll,
    togglePlay, step, replay, seekRatio, setRate, stopAll,
    // 训练
    STAGES: T.STAGES, REVIEW_HOURS: T.REVIEW_HOURS, stageKey, setStage, completeStage, finishReview, train, hardSet,
    inReview, toggleHard, resetProgress, keywords,
    // 听写 / 跟读 / 复述
    dictationMode, dictation, dictationSentences, dictHardIds, dictSentence, dictAnswer, dictInput, dictResult, dictHasErrors, dictCanSubmit, dictHint,
    dictTranslation, dictTranslationState, translateDictSentence,
    startDictation, dictRowStatus, selectDictQuestion, dictPlay, toggleDictHint, dictSubmit, dictRewrite, dictMove, dictNext, closeDictation,
    favorites, favoritesUnavailable, loadFavorites, toggleDictFavorite, removeFavorite,
    dictFavoriteSaved, dictFavoritePending, dictFavoriteError,
    favoritePending: item => favorites.pending.has(favoritePath(item.episodeId, item.sentenceId)),
    formatFavoriteDate: time => favoriteDate.format(time),
    shadow, shadowSentence, openShadow, shadowNav, shadowRecord, shadowPlayMine, shadowCompare, closeShadow,
    retell, retellRecord, retellPlay, resetRetell,
    // 难句 / 导入
    hardItems, loadHardItems, playHardItem,
    importer, openImporter, pickAudio, pickFolder, saveImport, removeMaterial,
    onKey, cancelDictHintShortcut, wordContext, formatRelative,
  };
}

// 保持已保存的本地素材引用格式，实际音频由当前存储后端提供。
export async function resolveAudioRef(ref) {
  if (!ref) return '';
  if (!ref.startsWith('idb:')) return ref;
  return materialStore.audioURL(ref.slice(4));
}
