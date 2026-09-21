import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import token_store as store


@unittest.skipUnless(os.name == "nt", "requires real Windows DPAPI")
class TokenStoreTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="spotify-token-test-")
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / "cache" / "session.bin"
        self.path_patch = patch.object(store, "_cache_path", return_value=self.path)
        self.path_patch.start()
        self.addCleanup(self.path_patch.stop)

    def test_real_dpapi_roundtrip_encrypted_and_client_bound(self):
        token = "dummy-refresh-token-never-a-real-credential"
        store.save_refresh_token("dummy-client", token)
        raw = self.path.read_bytes()
        self.assertNotIn(token.encode(), raw)
        self.assertNotIn(b"dummy-client", raw)
        self.assertEqual(store.load_refresh_token("dummy-client"), token)
        self.assertIsNone(store.load_refresh_token("different-client"))
        payload = json.loads(store._dpapi(raw, "dummy-client", decrypt=True))
        self.assertEqual(set(payload), {"client_id", "refresh_token"})

    def test_missing_corrupt_and_tampered_return_none(self):
        self.assertIsNone(store.load_refresh_token("dummy-client"))
        self.path.parent.mkdir()
        self.path.write_bytes(b"corrupt")
        self.assertIsNone(store.load_refresh_token("dummy-client"))
        store.save_refresh_token("dummy-client", "dummy-refresh")
        raw = bytearray(self.path.read_bytes())
        raw[-1] ^= 0xFF
        self.path.write_bytes(raw)
        self.assertIsNone(store.load_refresh_token("dummy-client"))

    def test_atomic_overwrite(self):
        store.save_refresh_token("dummy-client", "first-dummy-token")
        real_replace = os.replace
        with patch.object(store.os, "replace", wraps=real_replace) as replace:
            store.save_refresh_token("dummy-client", "second-dummy-token")
        replace.assert_called_once()
        self.assertEqual(Path(replace.call_args.args[0]).parent, self.path.parent)
        self.assertEqual(store.load_refresh_token("dummy-client"), "second-dummy-token")
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_failed_replace_preserves_old_token_and_cleans_temp(self):
        store.save_refresh_token("dummy-client", "old-dummy-token")
        with patch.object(store.os, "replace", side_effect=OSError("simulated")):
            with self.assertRaises(OSError):
                store.save_refresh_token("dummy-client", "new-dummy-token")
        self.assertEqual(store.load_refresh_token("dummy-client"), "old-dummy-token")
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_decryption_failure_and_invalid_payload_are_ignored(self):
        store.save_refresh_token("dummy-client", "dummy-token")
        with patch.object(store, "_dpapi", side_effect=OSError("simulated")):
            self.assertIsNone(store.load_refresh_token("dummy-client"))
        for payload in (b"[]", b"not json", b'{"client_id":"dummy-client","refresh_token":7}'):
            with patch.object(store, "_dpapi", return_value=payload):
                self.assertIsNone(store.load_refresh_token("dummy-client"))

    def test_empty_token_rejected_without_touching_cache(self):
        with self.assertRaises(ValueError):
            store.save_refresh_token("dummy-client", "")
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
