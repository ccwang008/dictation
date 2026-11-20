import { apiURL, requestAPI, useSqlite } from '../lib/storage.js';
import { SegmentPlayer } from '../lib/segment-player.js?v=20261120-auto-repair';
const { reactive, computed, nextTick } = Vue;

export function useAudioValidation({ current, player, onApproved }) {
  const validation = reactive({ open: false, id: '', title: '', check: null, error: '', saving: false, heard: {}, playingId: null });
  const previewPlayer = new SegmentPlayer();
  const rowsToReview = computed(() => validation.check?.report?.rows.filter(row => ['review', 'excluded'].includes(row.status)) || []);
  const validationReady = computed(() => current.value?.kind !== 'local' || current.value?.validation?.status === 'passed');
  const validationAudio = computed(() => validation.id && validation.check?.report
    ? apiURL(`materials/${encodeURIComponent(validation.id)}/validation/audio?v=${validation.check.revision}`) : '');
  const label = state => ({ passed: '音文自动修正完成', queued: '等待自动修正', running: '正在自动修正音文', review: '等待自动修正', failed: '音文自动修正失败', unchecked: '音文尚未修正' }[state] || '音文尚未修正');
  let timer = 0;
  let session = 0;
  const applied = new Set();
  const path = id => `materials/${encodeURIComponent(id)}/validation`;
  const boundsKey = row => `${row.id}:${row.t0}:${row.t1}`;
  const validationCanConfirm = row => validation.heard[row.id] === boundsKey(row) && !validation.saving;

  function stopValidationPreview() { previewPlayer.stop(); validation.playingId = null; }
  previewPlayer.on('error', () => { validation.error = '无法播放校验音频，请重试。'; validation.playingId = null; });
  function closeValidation() {
    validation.open = false;
    session++;
    clearTimeout(timer);
    stopValidationPreview();
    document.getElementById('validation-full-audio')?.pause();
  }
  async function accept(check, id, ticket) {
    if (ticket !== session || validation.id !== id) return;
    validation.check = check;
    if (current.value?.id === id) current.value = { ...current.value, validation: { ...check, report: undefined } };
    const appliedKey = `${id}:${check.revision}:${check.ready}:${check.excluded}:${check.corrected}`;
    if (check.status === 'passed' && !applied.has(appliedKey)) {
      await onApproved(id);
      applied.add(appliedKey);
    }
    if (validation.open && ticket === session && ['queued', 'running'].includes(check.status)) {
      clearTimeout(timer);
      timer = setTimeout(() => refreshValidation(id, ticket), 1000);
    }
  }
  async function refreshValidation(id = validation.id, ticket = session) {
    try {
      const check = await requestAPI(path(id));
      if (ticket === session) validation.error = '';
      await accept(check, id, ticket);
    } catch (error) {
      if (ticket !== session) return;
      validation.error = error.message;
      clearTimeout(timer);
    }
  }
  async function openValidation(material) {
    closeValidation();
    const ticket = session;
    player.pause();
    Object.assign(validation, { open: true, id: material.id, title: material.title, check: null, error: '', saving: false, heard: {} });
    nextTick(() => document.getElementById('validation-close')?.focus());
    if (!useSqlite) {
      validation.error = '音文校验需要本地服务，请通过 http://localhost:8080 打开项目。';
      return;
    }
    await refreshValidation(material.id, ticket);
  }
  async function retryValidation() {
    if (validation.saving) return;
    const id = validation.id, ticket = session;
    validation.saving = true; validation.error = ''; validation.heard = {};
    player.stop(); stopValidationPreview();
    try {
      const check = await requestAPI(path(id), { method: 'POST' });
      await accept(check, id, ticket);
    } catch (error) { if (ticket === session) validation.error = error.message; }
    finally { if (ticket === session) validation.saving = false; }
  }
  function playValidationRow(row) {
    const duration = validation.check?.report?.duration || 0;
    if (!Number.isFinite(row.t0) || !Number.isFinite(row.t1) || row.t0 < 0 || row.t1 <= row.t0 || row.t1 > duration+.05) {
      validation.error = '请先填写有效的起止时间，结束时间须大于开始时间且不超过音频时长。';
      return;
    }
    validation.error = '';
    document.getElementById('validation-full-audio')?.pause();
    player.pause(); stopValidationPreview();
    const key = boundsKey(row), ticket = session;
    validation.playingId = row.id;
    previewPlayer.load(validationAudio.value);
    previewPlayer.setRate(1);
    previewPlayer.playRange(row.t0, row.t1, { onEnd() {
      if (ticket === session) { validation.heard[row.id] = key; validation.playingId = null; }
    } });
  }
  async function confirmValidationRow(row) {
    if (!validationCanConfirm(row)) return;
    const id = validation.id, ticket = session;
    validation.saving = true; validation.error = '';
    stopValidationPreview();
    try {
      const check = await requestAPI(path(id) + '/review', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: validation.check.revision, sentenceId: row.id, t0: row.t0, t1: row.t1, confirmed: true }) });
      await accept(check, id, ticket);
    } catch (error) { if (ticket === session) validation.error = error.message; }
    finally { if (ticket === session) validation.saving = false; }
  }
  return { validation, rowsToReview, validationReady, validationAudio, validationLabel: label,
    validationCanConfirm, openValidation, closeValidation, refreshValidation, retryValidation, playValidationRow,
    confirmValidationRow, stopValidationPreview };
}
