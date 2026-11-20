"""Local speech/subtitle validation. Writes a report; never changes source files."""
import argparse
import difflib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys

SCHEMA = 2
SMALL = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen']
TENS = ['', '', 'twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety']


def tokens(text):
    result = []
    text = re.sub(r'\b[BCDFGHJKLMNPQRSTVWXYZ]{2,4}\b', lambda m: ' '.join(m.group()), text)
    for token in re.findall(r'[a-z]+|[0-9]+', text.lower().replace('’', "'")):
        if token.isdigit():
            n = int(token)
            if len(token) >= 3:
                result.extend(SMALL[int(d)] for d in token)
            elif n < 20:
                result.append(SMALL[n])
            else:
                result.append(TENS[n // 10])
                if n % 10:
                    result.append(SMALL[n % 10])
        else:
            if token == 'anytime':
                result.extend(['any', 'time'])
            elif re.fullmatch('m{2,}', token):
                result.append('mm')
            else:
                result.append('zero' if token == 'oh' else token)
    return result


def structural_issues(sentences, duration):
    issues = {}
    ids = set()
    previous = -1
    for s in sentences:
        errors = []
        a, b = s.get('t0'), s.get('t1')
        if not all(isinstance(t, (int, float)) and math.isfinite(t) for t in [a, b]):
            errors.append('字幕时间无效')
        elif a < 0 or b <= a or b > duration + .05:
            errors.append('字幕时间超出音频范围或片段为空')
        elif a < previous:
            errors.append('字幕时间顺序错误')
        if isinstance(a, (int, float)):
            previous = a
        if s['id'] in ids:
            errors.append('句子编号重复')
        ids.add(s['id'])
        if not tokens(s.get('en', '')):
            errors.append('没有可比对的英文原文')
        if errors:
            issues[s['id']] = errors
    return issues


def align_report(sentences, words, duration):
    """Conservative alignment: uncertain endpoints must be listened to by a person."""
    ref, owners, heard, word_indices = [], [], [], []
    for s in sentences:
        ts = tokens(s['en'])
        ref.extend(ts)
        owners.extend([s['id']] * len(ts))
    for i, w in enumerate(words):
        ts = tokens(w['word'])
        heard.extend(ts)
        word_indices.extend([i] * len(ts))
    mapping = {}
    matcher = difflib.SequenceMatcher(None, ref, heard, autojunk=False)
    for a, b, count in matcher.get_matching_blocks():
        for k in range(count):
            mapping[a + k] = word_indices[b + k]
    structural = structural_issues(sentences, duration)
    rows = []
    cursor = 0
    for s in sentences:
        count = len(tokens(s['en']))
        indices = list(range(cursor, cursor + count))
        cursor += count
        hits = [mapping[i] for i in indices if i in mapping]
        coverage = len(hits) / max(1, count)
        reasons = list(structural.get(s['id'], []))
        a, b = s['t0'], s['t1']
        recognized = ''
        if not hits or coverage < .90:
            reasons.append('音频识别结果与原文不够一致，可能漏词、错配或有重叠说话')
        if hits:
            first, last = words[min(hits)], words[max(hits)]
            recognized = ' '.join(w['word'].strip() for w in words[min(hits):max(hits)+1])
            endpoints = indices and indices[0] in mapping and indices[-1] in mapping
            confidence = min(first.get('probability', 0), last.get('probability', 0))
            # A long word interval often includes silence or an unrelated utterance.
            plausible = (0.02 <= first['end'] - first['start'] <= .9 and
                         0.02 <= last['end'] - last['start'] <= 1.2)
            if not endpoints or confidence < .65 or not plausible:
                reasons.append('句首或句尾定位不确定，需要试听确认')
            if abs(first['start'] - a) > max(3, (b-a)*.5):
                reasons.append('识别位置与原字幕相距较远，不能自动确认是同一句')
            if not reasons:
                a, b = first['start'], last['end']
        rows.append(dict(id=s['id'], en=s['en'], original=dict(t0=s['t0'], t1=s['t1']),
                         t0=round(a, 2), t1=round(b, 2), coverage=round(coverage, 3),
                         recognized=recognized, status='review' if reasons else 'verified', reasons=reasons))
    # Do not certify a boundary if neighboring speech cannot be separated reliably.
    for i, row in enumerate(rows):
        if row['status'] != 'verified':
            continue
        for neighbor in rows[max(0, i-1):i] + rows[i+1:i+2]:
            if (neighbor['id'] != row['id'] and neighbor['status'] == 'verified' and
                min(row['t1'], neighbor['t1']) - max(row['t0'], neighbor['t0']) > .04):
                row['status'] = 'review'
                row['reasons'].append('相邻句子的语音边界重叠，需要试听确认')
                neighbor['status'] = 'review'
                neighbor['reasons'].append('相邻句子的语音边界重叠，需要试听确认')
    speech_ranges = [(row['t0'], row['t1']) for row in rows]
    for i, row in enumerate(rows):
        if row['status'] == 'verified':
            a, b = speech_ranges[i]
            previous = speech_ranges[i-1][1] if i else 0
            following = speech_ranges[i+1][0] if i+1 < len(rows) else duration
            row['t0'] = round(max(0, a-.10, (a+previous)/2), 2) if previous <= a else round(a, 2)
            row['t1'] = round(min(duration, b+.12, (b+following)/2), 2) if b <= following else round(b, 2)
        row['changed'] = any(abs(row[k] - row['original'][k]) > .04 for k in ['t0', 't1'])
    return rows


def progress(message, percent):
    print(json.dumps(dict(message=message, progress=percent), ensure_ascii=False), flush=True)


def word_match(text, words, anchor=None):
    reference = tokens(text)
    if not reference:
        return None
    best = None
    # Contiguous candidates prevent matching the beginning of one repeated phrase
    # to the end of its next occurrence.
    for lo in range(len(words)):
        heard, indices = [], []
        for hi in range(lo, min(len(words), lo + len(reference)*2+4)):
            ts = tokens(words[hi]['word'])
            heard.extend(ts)
            indices.extend([hi]*len(ts))
            if len(heard) > len(reference)*1.6+2:
                break
            mapping = {}
            for a, b, size in difflib.SequenceMatcher(None, reference, heard, autojunk=False).get_matching_blocks():
                for k in range(size):
                    mapping[a+k] = indices[b+k]
            if not mapping:
                continue
            score = 2*len(mapping)/(len(reference)+len(heard))
            proximity = abs(words[min(mapping.values())]['start']-anchor) if anchor is not None else 0
            if best is None or score > best[0] or score == best[0] and proximity < best[2]:
                first, last = min(mapping.values()), max(mapping.values())
                best = (score, dict(coverage=len(mapping)/len(reference),
                                    endpoints=0 in mapping and len(reference)-1 in mapping,
                                    words=words[first:last+1], first=words[first], last=words[last]), proximity)
    return best[1] if best else None


def repair_bounds(row, local, guided):
    """Independent recognition must support a forced alignment; never certify text by force alone."""
    import statistics
    if not local:
        return None
    heard = local['words']
    first, last = local['first'], local['last']
    confidence = statistics.mean(w.get('probability', 0) for w in heard)
    guide_confidence = statistics.mean(w.get('probability', 0) for w in guided) if guided else 0
    same_start = guided and tokens(guided[0]['word']) == tokens(first['word'])
    same_end = guided and tokens(guided[-1]['word']) == tokens(last['word'])
    recognition_ok = local['endpoints'] and local['coverage'] >= .88 and confidence >= .70
    contextual_ok = local['coverage'] >= .60 and guide_confidence >= .72 and same_start and same_end
    short_ok = (len(tokens(row['en'])) <= 2 and local['endpoints'] and local['coverage'] == 1 and
                confidence >= .4 and guide_confidence >= .15 and guided and
                abs(first['start']-guided[0]['start']) < .15 and abs(last['end']-guided[-1]['end']) < .15)
    if not (recognition_ok or contextual_ok or short_ok):
        return None
    # Recognition gives the outer boundaries; guided text recovers omitted names and weak words.
    chosen = heard if recognition_ok or short_ok else guided
    durations = [w['end']-w['start'] for w in chosen if .04 < w['end']-w['start'] < .9]
    typical = statistics.median(durations) if durations else .25
    head, tail = chosen[0], chosen[-1]
    start, end = head['start'], tail['end']
    if head['end']-start > .9:
        start = head['end'] - min(.65, max(.25, typical*2))
    if end-tail['start'] > 1.2:
        end = tail['start'] + min(.8, max(.35, typical*2))
    # A high-confidence guided boundary can repair a weak/elongated recognition endpoint.
    if guided and guide_confidence >= .7:
        if head.get('probability', 0) < .45 and .02 <= guided[0]['end']-guided[0]['start'] <= .9:
            start = guided[0]['start']
        if tail.get('probability', 0) < .45 and .02 <= guided[-1]['end']-guided[-1]['start'] <= 1.2:
            end = guided[-1]['end']
    if start < 0 or end-start < .10 or end-start > max(10, len(tokens(row['en']))*1.5):
        return None
    return round(start, 3), round(end, 3)


def guided_sentence(model, samples, sentences, index):
    from faster_whisper.audio import pad_or_trim
    from faster_whisper.tokenizer import Tokenizer
    tokenizer = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task='transcribe', language='en')
    lo, hi = max(0, index-1), min(len(sentences), index+2)
    duration = len(samples)/16000
    def window():
        a = max(0, sentences[lo]['t0']-1.0)
        last = sentences[hi-1]
        b = min(duration, last['t1']+.8, last['t0']+max(3.5, len(tokens(last['en']))*.8+1.5))
        return a, b
    start, end = window()
    while end-start > 29.5 and (lo < index or hi > index+1):
        left_gap = sentences[index]['t0']-sentences[lo]['t0'] if lo < index else -1
        right_gap = sentences[hi-1]['t0']-sentences[index]['t0'] if hi > index+1 else -1
        if left_gap > right_gap:
            lo += 1
        else:
            hi -= 1
        start, end = window()
    end = min(end, start+29.5)
    if end <= start:
        return [], start, end
    chunk = samples[int(start*16000):int(end*16000)]
    features = model.feature_extractor(chunk)
    encoded = model.encode(pad_or_trim(features))
    all_tokens, owners = [], []
    for s in sentences[lo:hi]:
        ts = tokenizer.encode(' '+s['en'])
        all_tokens.extend(ts)
        owners.extend([s['id']]*len(ts))
    aligned = model.find_alignment(tokenizer, [all_tokens], encoded, round(len(chunk)/160))[0]
    result, cursor = [], 0
    for word in aligned:
        owner = owners[min(cursor, len(owners)-1)]
        cursor += len(word['tokens'])
        if owner == sentences[index]['id'] and tokens(word['word']):
            result.append(dict(word=word['word'].strip(), start=float(word['start'])+start,
                               end=float(word['end'])+start, probability=float(word['probability'])))
    return result, start, end


def finish_repairs(rows, duration):
    """Pad only into silence. Unrecoverable rows remain visible but never enter dictation."""
    eligible = [row for row in rows if row['status'] in ['verified', 'repaired', 'confirmed']]
    previous = None
    for current in eligible:
        if previous is None:
            previous = current
            continue
        overlap = previous['t1']-current['t0']
        if overlap > .25:
            # Resolve against independently detected speech instead of silently cutting words.
            current['status'] = 'excluded'
            current['reasons'] = ['语音与前一句重叠，自动修复无法分离，暂不加入听写']
            continue
        elif overlap > 0:
            boundary = round((previous['t1']+current['t0'])/2, 3)
            previous['t1'] = current['t0'] = boundary
        previous = current
    playable = [row for row in rows if row['status'] in ['verified', 'repaired', 'confirmed']]
    speech = [(row['t0'], row['t1']) for row in playable]
    for i, row in enumerate(playable):
        a, b = speech[i]
        prev_end = speech[i-1][1] if i else 0
        next_start = speech[i+1][0] if i+1 < len(playable) else duration
        row['t0'] = round(max(0, a-.10, (a+prev_end)/2), 2)
        row['t1'] = round(min(duration, b+.12, (b+next_start)/2), 2)
    for row in rows:
        row['changed'] = row['status'] != 'excluded' and any(abs(row[k]-row['original'][k]) > .04 for k in ['t0','t1'])
    return rows


def auto_repair(rows, sentences, words, duration, model, samples, notify=None):
    # A consistent global subtitle offset can be repaired before searching individual phrases.
    import statistics
    offsets = []
    reference, ownership, heard, word_index = [], [], [], []
    for i, sentence in enumerate(sentences):
        ts = tokens(sentence['en'])
        reference.extend(ts)
        ownership.extend([i]*len(ts))
    for i, w in enumerate(words):
        ts = tokens(w['word'])
        heard.extend(ts)
        word_index.extend([i]*len(ts))
    mapping = {}
    for a, b, size in difflib.SequenceMatcher(None, reference, heard, autojunk=False).get_matching_blocks():
        for k in range(size):
            mapping[a+k] = word_index[b+k]
    grouped = {}
    for i, owner in enumerate(ownership):
        grouped.setdefault(owner, []).append(i)
    for i, indices in grouped.items():
        if len(indices) >= 5 and indices[0] in mapping and indices[-1] in mapping:
            coverage = sum(k in mapping for k in indices)/len(indices)
            if coverage >= .95:
                offsets.append(words[mapping[indices[0]]]['start']-sentences[i]['t0'])
    shift = statistics.median(offsets) if len(offsets) >= 3 else 0
    if abs(shift) < .3 or offsets and statistics.median(abs(v-shift) for v in offsets) > .8:
        shift = 0
    hints = [{**s, 't0':max(0,s['t0']+shift), 't1':min(duration,s['t1']+shift)} for s in sentences]
    # Recalculate all candidate bounds from words to avoid padding twice.
    for i, (row, source) in enumerate(zip(rows, sentences)):
        if not tokens(source['en']):
            row['status'] = 'excluded'
            continue
        hint = hints[i]
        limit = max(6, len(tokens(source['en']))*.9+3)
        nearby = [w for w in words if w['start'] >= hint['t0']-3 and w['end'] <= min(duration, max(hint['t1'],hint['t0']+2)+2, hint['t0']+limit)]
        local = word_match(source['en'], nearby, hint['t0'])
        guided = []
        if row['status'] == 'review':
            if notify:
                notify(f'正在自动修复第 {i+1}/{len(rows)} 句', 85+int((i+1)/len(rows)*13))
            guided, start, end = guided_sentence(model, samples, hints, i)
            # Re-recognize only this small context if the first pass omitted a phrase.
            if end > start and (not local or local['coverage'] < .88 or not local['endpoints']):
                chunk = samples[int(start*16000):int(end*16000)]
                segments, _ = model.transcribe(chunk, language='en', word_timestamps=True, beam_size=8,
                                               condition_on_previous_text=False)
                focused = []
                for segment in segments:
                    focused.extend(dict(word=w.word.strip(), start=w.start+start, end=w.end+start,
                                        probability=w.probability) for w in segment.words or [])
                alternative = word_match(source['en'], focused, hint['t0'])
                if alternative and (not local or alternative['coverage'] > local['coverage'] or
                                    alternative['endpoints'] and not local['endpoints']):
                    local = alternative
        bounds = repair_bounds(row, local, guided)
        if not bounds and guided:
            # Quiet numbers and short replies can be lost inside a longer context.
            # Try the individual utterance, keeping forced-alignment evidence as a guard.
            guide_score = statistics.mean(w.get('probability', 0) for w in guided)
            short_evidence = (len(tokens(source['en'])) <= 2 and local and local['endpoints'] and
                              local['coverage'] == 1 and local['first'].get('probability',0) >= .4)
            if guide_score >= .4 or short_evidence and guide_score >= .15:
                a = max(0, hint['t0']-.8)
                b = min(duration, hint['t1']+.8, a+25)
                if b > a:
                    segments, _ = model.transcribe(samples[int(a*16000):int(b*16000)], language='en',
                        word_timestamps=True, beam_size=8, condition_on_previous_text=False, initial_prompt=source['en'])
                    focused = []
                    for segment in segments:
                        focused.extend(dict(word=w.word.strip(), start=w.start+a, end=w.end+a,
                                            probability=w.probability) for w in segment.words or [])
                    alternative = word_match(source['en'], focused, hint['t0'])
                    candidate = repair_bounds(row, alternative, guided)
                    if candidate:
                        local, bounds = alternative, candidate
        if bounds:
            row['t0'], row['t1'] = bounds
            row['status'] = 'repaired' if row['status'] == 'review' else 'verified'
            row['repairMethod'] = 'context-and-speech' if guided else 'speech-word-timestamps'
            row['reasons'] = []
            row['recognized'] = ' '.join(w['word'] for w in local['words'])
        else:
            row['status'] = 'excluded'
            row['reasons'] = ['已尝试语音重识别和上下文对齐，仍无法可靠修复，暂不加入听写']
    return finish_repairs(rows, duration)


def validate(audio_path, metadata_path, output_dir, model_path):
    import numpy as np
    from faster_whisper import WhisperModel
    output_dir.mkdir(parents=True, exist_ok=True)
    meta = json.loads(metadata_path.read_text())
    progress('正在解码音频并检查实际时长', 5)
    playback = output_dir / 'playback.wav'
    command = [os.environ.get('FFMPEG', 'ffmpeg'), '-v', 'warning', '-y', '-i', str(audio_path),
               '-map', '0:a:0', '-c:a', 'pcm_s16le', str(playback)]
    decode = subprocess.run(command, capture_output=True, text=True, timeout=300)
    if decode.returncode != 0 or not playback.exists():
        raise RuntimeError('音频无法完整解码，请更换音频文件。')
    samples_bytes = subprocess.run([os.environ.get('FFMPEG', 'ffmpeg'), '-v', 'error', '-i', str(playback),
                                   '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'],
                                  capture_output=True, check=True, timeout=300).stdout
    samples = np.frombuffer(samples_bytes, dtype=np.float32)
    duration = len(samples) / 16000
    if duration <= 0:
        raise RuntimeError('音频没有可播放的内容。')
    if duration > 7200:
        raise RuntimeError('请将超过两小时的音频拆分后再校验。')
    # Cache recognition, not the verdict: each subtitle revision is compared again.
    digest = hashlib.sha256(audio_path.read_bytes()).hexdigest()
    cache_path = output_dir.parent / ('words-v1-' + digest + '.json')
    model = None
    if cache_path.exists():
        words = json.loads(cache_path.read_text())
    else:
        if not model_path.is_dir():
            raise RuntimeError('语音校验模型尚未安装，请运行 npm run setup:audio-check 后重试。')
        progress('正在识别音频中的英文内容', 15)
        model = WhisperModel(str(model_path), device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
        segments, _ = model.transcribe(samples, language='en', word_timestamps=True, beam_size=5,
                                       condition_on_previous_text=False)
        words = []
        for segment in segments:
            words.extend(dict(word=w.word.strip(), start=w.start, end=w.end, probability=w.probability)
                         for w in segment.words or [])
            progress('正在识别并核对字幕', min(85, 15 + round(segment.end / duration * 70)))
        if not words:
            raise RuntimeError('未能识别英文语音，请检查音频内容或音量。')
        cache_path.write_text(json.dumps(words, ensure_ascii=False))
    progress('正在自动校准每句的起止时间', 85)
    rows = align_report(meta['sentences'], words, duration)
    if model is None:
        model = WhisperModel(str(model_path), device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
    rows = auto_repair(rows, meta['sentences'], words, duration, model, samples, progress)
    report = dict(schema=SCHEMA, duration=duration, rows=rows,
                  decodedWarning=bool(decode.stderr.strip()),
                  durationDrift=round(duration - meta['duration'], 3),
                  model='faster-whisper/base.en',
                  message='已自动修复切句与播放时间轴；无法可靠修复的句子已单独列出，原始文件保留。')
    (output_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False))
    progress('音文比对完成', 100)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--metadata', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    args = parser.parse_args()
    try:
        validate(args.audio, args.metadata, args.output, args.model)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
