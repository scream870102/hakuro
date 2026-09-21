import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
import app


class AppTests(unittest.TestCase):
    def test_external_config(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'secret.env'
            for frozen in (False, True):
                with self.subTest(frozen=frozen), patch.object(app.sys, 'frozen', frozen, create=True), patch.object(app.sys, 'executable', str(Path(folder) / 'Lyrics.exe')), patch.object(app, '__file__', str(Path(folder) / 'app.py')):
                    for content in ('abc123\n', '\ufeffSPOTIFY_CLIENT_ID="abc123"\n', "# comment\nCLIENT_ID='abc123'\n", 'clientId=abc123\nUNRELATED=ignored'):
                        path.write_text(content, encoding='utf-8')
                        self.assertEqual(app.read_client_id(), 'abc123')
                    for content in ('', '# comment', 'SPOTIFY_CLIENT_ID=', 'abc 123', 'abc\ndef', 'SPOTIFY_CLIENT_ID=abc\nCLIENT_ID=def', 'OTHER=value', 'SPOTIFY_CLIENT_ID="abc', '中文'):
                        path.write_text(content, encoding='utf-8')
                        with self.assertRaises(ValueError):
                            app.read_client_id()
                    path.unlink()
                    with self.assertRaisesRegex(ValueError, 'secret.env'):
                        app.read_client_id()

    def test_config_failure_does_not_start_auth(self):
        window = Mock()
        window.connecting = False
        window.spotify = None
        with patch.object(app, 'TRUSTSTORE_AVAILABLE', True), patch.object(app, 'read_client_id', side_effect=ValueError('missing config')), patch.object(app.messagebox, 'showerror') as error, patch.object(app.threading, 'Thread') as thread:
            app.App.connect(window)
            error.assert_called_once()
            thread.assert_not_called()

    def test_auth_error_survives_delayed_callback(self):
        window = Mock()
        window.connecting = False
        window.spotify = None
        with patch.object(app, 'Spotify') as spotify:
            spotify.return_value.connect_session.side_effect = RuntimeError('test authorization failed')
            app.App.auth(window, 'abc123')
            window.events.put.assert_called_once_with(('auth_error', 'test authorization failed'))
            window.after.assert_not_called()

    def test_window_startup(self):
        self.assertTrue(app.TRUSTSTORE_AVAILABLE)
        window = app.App(auto_connect=False)
        try:
            window.withdraw()
            window.update()
            self.assertEqual(window.title(), 'Spotify Original Lyrics')
        finally:
            window.close()


if __name__ == '__main__':
    unittest.main()
