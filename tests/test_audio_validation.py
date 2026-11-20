import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('audio_validation', Path(__file__).parents[1] / 'scripts/audio/validate.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def word(text, start, end, p=.99):
    return dict(word=text, start=start, end=end, probability=p)


class AudioValidationTests(unittest.TestCase):
    def test_actual_words_required_not_just_valid_timestamps(self):
        sentences = [dict(id=1, en='Open the door.', t0=0, t1=2)]
        result = module.align_report(sentences, [word('Unrelated', .2, .5), word('speech', .6, 1)], 3)
        self.assertEqual(result[0]['status'], 'review')
        self.assertLess(result[0]['coverage'], .5)

    def test_safe_alignment_repairs_boundaries_and_uses_only_silence_for_padding(self):
        sentences = [dict(id=1, en='Hello there.', t0=0, t1=2.5), dict(id=2, en='Good morning.', t0=2.5, t1=4)]
        words = [word('Hello', .4, .7), word('there.', .8, 1.1), word('Good', 1.3, 1.6), word('morning.', 1.7, 2)]
        result = module.align_report(sentences, words, 4)
        self.assertTrue(all(row['status'] == 'verified' for row in result))
        self.assertLessEqual(result[0]['t1'], result[1]['t0'])
        self.assertLessEqual(result[0]['t0'], .4)
        self.assertGreaterEqual(result[1]['t1'], 2)
        self.assertTrue(all(row['changed'] for row in result))

    def test_numbers_and_apostrophes(self):
        self.assertEqual(module.tokens('It’s 5.45. Number 1.'), module.tokens("It's five forty-five. Number one."))
        self.assertEqual(module.tokens('555'), module.tokens('five five five'))

    def test_low_confidence_and_long_word_intervals_require_review(self):
        for words in [[word('Hello', .1, .4, .3)], [word('Hello', .1, 2)]]:
            rows = module.align_report([dict(id=1, en='Hello.', t0=.1, t1=2.1)], words, 3)
            self.assertEqual(rows[0]['status'], 'review')

    def test_out_of_range_and_duplicate_ids_do_not_pass(self):
        sentences = [dict(id=1, en='Hello.', t0=0, t1=10), dict(id=1, en='Bye.', t0=1, t1=2)]
        rows = module.align_report(sentences, [word('Hello.', .1, .4), word('Bye.', 1.1, 1.4)], 3)
        self.assertTrue(all(row['status'] == 'review' for row in rows))

    def test_distant_repeated_phrase_cannot_be_certified(self):
        rows = module.align_report([dict(id=1, en='Thank you.', t0=1, t1=2)],
                                   [word('Thank', 20, 20.3), word('you.', 20.4, 20.7)], 25)
        self.assertEqual(rows[0]['status'], 'review')
        self.assertEqual(rows[0]['t0'], 1)

    def test_overlapping_speech_requires_review(self):
        sentences = [dict(id=1, en='First word.', t0=0, t1=1), dict(id=2, en='Second word.', t0=1, t1=2)]
        words = [word('First', .1, .4), word('word.', .5, 1.2), word('Second', 1, 1.3), word('word.', 1.4, 1.7)]
        self.assertTrue(all(r['status'] == 'review' for r in module.align_report(sentences, words, 3)))


    def test_repeated_phrase_uses_one_contiguous_occurrence(self):
        words = [word('Number', 1, 1.2),word('one',1.2,1.4),word('train',1.4,1.6),
                 word('Number',3,3.2),word('one',3.2,3.4),word('train',3.4,3.6),word('thanks',3.6,3.8)]
        match = module.word_match('Number one train thanks.', words)
        self.assertEqual(match['first']['start'], 3)
        self.assertEqual(match['last']['end'], 3.8)
        repeated=[word('Thank',1,1.2),word('you',1.3,1.5),word('Thank',3,3.2),word('you',3.3,3.5)]
        self.assertEqual(module.word_match('Thank you.',repeated,anchor=3)['first']['start'],3)

    def test_forced_text_without_independent_recognition_is_not_a_repair(self):
        self.assertIsNone(module.repair_bounds(dict(en='Nonexistent words.'), None,
            [word('Nonexistent',1,1.3),word('words',1.3,1.6)]))

    def test_zero_duration_word_can_be_repaired_using_matching_context(self):
        local = module.word_match('I know.', [word('I',1,1),word('know',1,1.4)])
        guided = [word('I',.98,1.02),word('know',1.02,1.42)]
        self.assertIsNotNone(module.repair_bounds(dict(en='I know.'), local, guided))

    def test_unrecoverable_row_does_not_block_padding_of_following_good_rows(self):
        rows=[dict(id=i,en='Test.',t0=a,t1=b,status=status,original=dict(t0=a,t1=b),reasons=[])
              for i,a,b,status in [(1,1,2,'verified'),(2,1.5,3,'repaired'),(3,2.5,2.9,'verified')]]
        result=module.finish_repairs(rows,4)
        self.assertEqual(result[1]['status'],'excluded')
        self.assertEqual(result[2]['status'],'verified')
        self.assertLessEqual(result[0]['t1'],result[2]['t0'])


if __name__ == '__main__':
    unittest.main()
