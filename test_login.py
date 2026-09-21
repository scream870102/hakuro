import io
import json
import unittest
import urllib.error
from unittest.mock import patch, MagicMock
import app


class LoginTests(unittest.TestCase):
    def test_cached_session_skips_browser(self):
        spotify = app.Spotify('dummy')
        with patch.object(app, 'load_refresh_token', return_value='cached'), patch.object(spotify, 'refresh') as refresh, patch.object(spotify, 'authorize') as authorize:
            spotify.connect_session()
            refresh.assert_called_once()
            authorize.assert_not_called()

    def test_first_run_and_revoked_session_authorize(self):
        for cached in (None, 'revoked'):
            spotify = app.Spotify('dummy')
            with self.subTest(cached=cached), patch.object(app, 'load_refresh_token', return_value=cached), patch.object(spotify, 'refresh', side_effect=app.LoginRequired()), patch.object(spotify, 'authorize') as authorize:
                spotify.connect_session()
                authorize.assert_called_once()

    def test_network_failure_does_not_open_browser_or_overwrite_cache(self):
        spotify = app.Spotify('dummy')
        with patch.object(app, 'load_refresh_token', return_value='cached'), patch.object(spotify, 'refresh', side_effect=urllib.error.URLError('offline')), patch.object(spotify, 'authorize') as authorize, patch.object(app, 'save_refresh_token') as save:
            with self.assertRaises(urllib.error.URLError):
                spotify.connect_session()
            authorize.assert_not_called()
            save.assert_not_called()

    def test_invalid_grant_classified_but_server_failure_is_not(self):
        for code, body, expected in ((400, {'error': 'invalid_grant'}, app.LoginRequired), (500, {'error': 'server_error'}, urllib.error.HTTPError)):
            spotify = app.Spotify('dummy')
            spotify.refresh_token = 'cached'
            error = urllib.error.HTTPError('https://example.test', code, 'test', {}, io.BytesIO(json.dumps(body).encode()))
            with self.subTest(code=code), patch.object(app.urllib.request, 'urlopen', side_effect=error), self.assertRaises(expected):
                spotify.refresh()

    def test_rotated_refresh_token_is_saved_and_storage_failure_is_nonfatal(self):
        spotify = app.Spotify('dummy')
        with patch.object(app, 'save_refresh_token') as save:
            spotify.accept_token({'access_token': 'access', 'refresh_token': 'rotated'})
            save.assert_called_once_with('dummy', 'rotated')
        with patch.object(app, 'save_refresh_token', side_effect=OSError('unwritable')):
            spotify.accept_token({'access_token': 'new-access'})
        self.assertEqual(spotify.refresh_token, 'rotated')
        self.assertEqual(spotify.access_token, 'new-access')
        self.assertIn('could not be saved', spotify.cache_warning)

    def test_auto_connect_scheduled_and_dark_widgets(self):
        with patch.object(app.threading.Thread, 'start'), patch.object(app.App, 'connect') as connect:
            window = app.App()
            try:
                window.withdraw()
                self.assertIsNotNone(window.auto_timer)
                window.after_cancel(window.auto_timer)
                window.auto_connect()
                connect.assert_called_once_with(automatic=True)
                self.assertEqual(window.cget('background'), '#121212')
                self.assertEqual(window.text.cget('background'), '#181818')
                self.assertEqual(window.text.tag_cget('current', 'background'), '#1d4831')
                self.assertEqual(app.ttk.Style(window).lookup('TButton', 'background'), '#282828')
            finally:
                window.close()

    def test_duplicate_connection_is_ignored(self):
        with patch.object(app.threading.Thread, 'start'):
            window = app.App(auto_connect=False)
        try:
            window.withdraw()
            window.connecting = True
            with patch.object(app, 'read_client_id') as read:
                window.connect()
                read.assert_not_called()
        finally:
            window.close()


if __name__ == '__main__':
    unittest.main()
