import json
import time
import unittest
import urllib.error
from unittest.mock import patch, MagicMock

import app
from lyrics_sources import LyricsResult


def playback(track='one', progress=0, playing=True):
    return {'item': {'id': track, 'name': track, 'artists': [{'name': 'Artist'}], 'album': {'name': 'Album'}, 'duration_ms': 120000}, 'progress_ms': progress, 'is_playing': playing}


class ClockTests(unittest.TestCase):
    def test_play_pause_seek_and_duration(self):
        clock = app.PlaybackClock()
        clock.update(1000, True, 10000, 20)
        self.assertEqual(clock.current(21.5), 2500)
        clock.update(2500, False, 10000, 21.5)
        self.assertEqual(clock.current(30), 2500)
        clock.update(500, True, 10000, 30)
        self.assertEqual(clock.current(31), 1500)
        clock.update(9900, True, 10000, 31)
        self.assertEqual(clock.current(32), 10000)

    def test_missing_progress_and_stale_samples(self):
        clock = app.PlaybackClock()
        clock.update(None, True, 10000, 0)
        self.assertEqual(clock.current(3), 0)
        clock.update(1000, True, 100000, 0)
        self.assertEqual(clock.current(50), 6000)

    def test_line_boundaries_and_seek_back(self):
        cues = [(1000, 'a'), (2000, 'b')]
        self.assertEqual(app.active_line(cues, 999), -1)
        self.assertEqual(app.active_line(cues, 1000), 0)
        self.assertEqual(app.active_line(cues, 2000), 1)
        self.assertEqual(app.active_line(cues, 1500), 0)
        self.assertEqual(app.active_line([], 999), -1)


class WindowTests(unittest.TestCase):
    def setUp(self):
        # Keep lookups deterministic and offline; test queue production separately.
        with patch.object(app.threading.Thread, 'start'):
            self.window = app.App()
        self.window.withdraw()

    def tearDown(self):
        self.window.close()

    def tick(self):
        self.window.after_cancel(self.window.timer)
        self.window.tick()

    def test_timed_highlight_pause_seek_and_follow_toggle(self):
        window = self.window
        window.apply_playback(playback(progress=1500, playing=False), time.monotonic())
        result = LyricsResult(text='a\nb', source='test', cues=[(1000, '中文\n翻譯'), (2000, '日本語')])
        window.show_lyrics(window.generation, 'one', result)
        self.tick()
        self.assertEqual(window.highlighted, 0)
        self.assertEqual(tuple(map(str, window.text.tag_ranges('current'))), ('1.0', '3.0'))
        window.apply_playback(playback(progress=2500, playing=False), time.monotonic())
        self.tick()
        self.assertEqual(window.highlighted, 1)
        window.follow.set(False)
        window.follow_changed()
        with patch.object(window.text, 'see') as see:
            self.tick()
            see.assert_not_called()
        window.apply_playback(playback(progress=500, playing=False), time.monotonic())
        self.tick()
        self.assertEqual(window.highlighted, -1)
        self.assertEqual(window.text.tag_ranges('current'), ())

    def test_stale_result_and_pending_song_are_discarded(self):
        window = self.window
        window.apply_playback(playback('one'), time.monotonic())
        old_generation = window.generation
        window.apply_playback(playback('two'), time.monotonic())
        self.assertEqual(window.requests.get_nowait()[1], 'two')
        window.show_lyrics(old_generation, 'one', LyricsResult(text='old', source='test', cues=[]))
        self.assertNotIn('old', window.text.get('1.0', 'end'))
        window.show_lyrics(window.generation, 'two', LyricsResult(text='new', source='test', cues=[]))
        self.assertEqual(window.text.get('1.0', 'end').strip(), 'new')
        self.assertIn('no timeline', window.source.get())

    def test_reload_same_song_and_no_playback_invalidate_results(self):
        window = self.window
        window.apply_playback(playback(), time.monotonic())
        old_generation = window.generation
        result = LyricsResult(text='old', source='test', cues=[])
        window.show_lyrics(old_generation, 'one', result)
        window.clear()
        window.apply_playback(playback(), time.monotonic())
        window.show_lyrics(old_generation, 'one', result)
        self.assertEqual(window.text.get('1.0', 'end').strip(), 'Loading lyrics...')
        window.apply_playback(None, time.monotonic())
        self.assertEqual(window.text.get('1.0', 'end').strip(), '')
        self.assertEqual(window.clock.current(), 0)


class SpotifyTests(unittest.TestCase):
    def test_refreshes_expired_access_token(self):
        spotify = app.Spotify('dummy-client')
        spotify.access_token = 'expired'
        spotify.refresh_token = 'dummy-refresh'
        token_response = MagicMock()
        token_response.__enter__.return_value.read.return_value = json.dumps({'access_token': 'renewed'}).encode()
        song_response = MagicMock()
        song_response.__enter__.return_value.status = 200
        song_response.__enter__.return_value.read.return_value = json.dumps(playback()).encode()
        expired = urllib.error.HTTPError('https://example.test', 401, 'expired', {}, None)
        with patch.object(app.urllib.request, 'urlopen', side_effect=[expired, token_response, song_response]) as request:
            self.assertEqual(spotify.current()['item']['id'], 'one')
            self.assertIn(b'grant_type=refresh_token', request.call_args_list[1].args[0].data)
            self.assertEqual(request.call_args_list[2].args[0].get_header('Authorization'), 'Bearer renewed')
        self.assertEqual(spotify.refresh_token, 'dummy-refresh')


if __name__ == '__main__':
    unittest.main()
