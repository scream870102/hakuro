import base64
import unittest
from unittest.mock import patch
import lyrics_sources as sources


class LyricsTests(unittest.TestCase):
    def test_lrc_tags_offset_merge_and_blank(self):
        raw = '[ar:Test]\n[00:02.50][00:01.005]one\n[00:02.50]translation\n[00:02.50]one\n[00:04]\n[offset:+500]'
        self.assertEqual(sources.parse_lrc(raw), [(505, 'one'), (2000, 'one\ntranslation'), (3500, '')])

    def test_lrc_negative_offset_and_invalid(self):
        self.assertEqual(sources.parse_lrc('[offset:-100]\n[00:00.1]a\n[00:70]bad\n[ti:test]'), [(200, 'a')])
        self.assertEqual(sources.parse_lrc('plain lyrics'), [])
        self.assertEqual(sources.parse_lrc('[offset:900]\n[00:00.1]a'), [(0, 'a')])

    def test_matching_requires_artist_duration_and_version(self):
        match = lambda title, artist, duration: sources._matches('Ａ Song', ['Singer'], 180000, title, [artist], duration)
        self.assertTrue(match('a song', 'SINGER', 182000))
        self.assertFalse(match('A Song (Live)', 'Singer', 180000))
        self.assertFalse(match('A Song', 'Cover Artist', 180000))
        self.assertFalse(match('A Song', 'Singer', 185000))
        self.assertFalse(match('A Song', 'Singer', None))

    def test_chinese_matching_converts_only_comparison(self):
        self.assertTrue(sources._matches('說好的幸福呢', ['周杰倫'], 256000,
                                        '说好的幸福呢', ['周杰伦'], 257000))
        self.assertTrue(sources._matches('晴天', ['周杰倫'], 269000,
                                        '晴天', ['周杰伦'], 269000))
        self.assertFalse(sources._matches('晴天', ['周杰倫'], 269000,
                                         '晴天 (Live)', ['周杰伦'], 269000))
        self.assertFalse(sources._matches('晴天', ['周杰倫'], 269000,
                                         '晴天', ['Zhou Jielun'], 269000))
        original = '[00:01]說好的幸福呢'
        result = sources._result(original, 'test')
        self.assertEqual(result.text, '說好的幸福呢')
        self.assertEqual(result.cues, [(1000, '說好的幸福呢')])

    def test_routing_prefers_synced_to_plain(self):
        with patch.object(sources, '_lrclib', return_value=sources.LyricsResult('plain', 'LRCLIB', [])), \
             patch.object(sources, '_netease', return_value=sources.LyricsResult('sync', 'NetEase', [(1000, 'sync')])), \
             patch.object(sources, '_qqmusic') as qq:
            result = sources.fetch_lyrics('Song', ['Singer'], 'Album', 180000)
        self.assertEqual(result.source, 'NetEase')
        qq.assert_not_called()

    def test_failures_preserve_plain_fallback(self):
        with patch.object(sources, '_lrclib', side_effect=TimeoutError), \
             patch.object(sources, '_netease', return_value=sources.LyricsResult('plain', 'NetEase', [])), \
             patch.object(sources, '_qqmusic', side_effect=ValueError):
            result = sources.fetch_lyrics('Song', ['Singer'], 'Album', 180000)
        self.assertEqual(result.text, 'plain')
        self.assertEqual(result.errors, ('LRCLIB: TimeoutError', 'QQ Music: ValueError'))

    def test_lrclib_synced_and_identity(self):
        data = {'trackName': 'Song', 'artistName': 'Singer', 'duration': 180,
                'syncedLyrics': '[00:01]sync', 'plainLyrics': 'plain'}
        with patch.object(sources, '_json', return_value=data):
            self.assertEqual(sources._lrclib('Song', ['Singer'], 'Album', 180000).cues, [(1000, 'sync')])
            self.assertEqual(sources._lrclib('Other', ['Singer'], 'Album', 180000).text, '')

    def test_netease_search_then_lyric(self):
        search = {'code': 200, 'result': {'songs': [
            {'id': 1, 'name': 'Song', 'artists': [{'name': 'Other'}], 'duration': 180000},
            {'id': 2, 'name': 'Song', 'artists': [{'name': 'Singer'}], 'duration': 180000}]}}
        with patch.object(sources, '_json', side_effect=[search, {'code': 200, 'lrc': {'lyric': '[00:01]original'}}]) as request:
            result = sources._netease('Song', ['Singer'], 'Album', 180000)
        self.assertEqual(result.cues, [(1000, 'original')])
        self.assertEqual(request.call_args.args[1]['id'], 2)

    def test_qq_schema_base64_and_rejection(self):
        search = {'code': 0, 'data': {'song': {'list': [
            {'songmid': 'mid', 'songname': 'Song', 'singer': [{'name': 'Singer'}], 'interval': 180}]}}}
        lyric = {'code': 0, 'lyric': base64.b64encode(b'[00:01]original').decode()}
        with patch.object(sources, '_json', side_effect=[search, lyric]):
            self.assertEqual(sources._qqmusic('Song', ['Singer'], 'Album', 180000).cues, [(1000, 'original')])
        with patch.object(sources, '_json', return_value={'code': 403}):
            with self.assertRaises(ValueError):
                sources._qqmusic('Song', ['Singer'], 'Album', 180000)


if __name__ == '__main__':
    unittest.main()
