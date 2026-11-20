// Deterministic worker for HTTP/UI integration tests. Production uses local speech recognition.
async function validationRunner({ metadata, onProgress, signal }) {
  onProgress({ progress: 30, message: '测试音频识别中' });
  await new Promise(resolve => setTimeout(resolve, 150));
  if (signal.aborted) throw new Error('Cancelled');
  if (metadata.title === '校验失败测试') throw new Error('测试语音识别失败，请重试');
  return {
    schema: 2, duration: metadata.duration, model: 'test-fixture',
    rows: metadata.sentences.map((s, i) => ({
      id: s.id, en: s.en, original: { t0: s.t0, t1: s.t1 }, t0: metadata.title.startsWith('自动修正') || metadata.title.startsWith('修正部分') ? s.t0+.08 : s.t0, t1: metadata.title.startsWith('自动修正') || metadata.title.startsWith('修正部分') ? s.t1+.08 : s.t1,
      coverage: i === 1 && metadata.title === '校验需要复核' ? .5 : 1,
      recognized: s.en, status: i === 1 && metadata.title === '修正部分无法识别' ? 'excluded' : metadata.title === '自动修正测试' || metadata.title === '修正部分无法识别' ? 'repaired' : i === 1 && metadata.title === '校验需要复核' ? 'review' : 'verified',
      reasons: i === 1 && metadata.title === '校验需要复核' ? ['句尾定位不确定，需要试听确认'] : [], changed: metadata.title.startsWith('自动修正') || metadata.title.startsWith('修正部分'),
    })),
  };
}
module.exports = { validationRunner };
