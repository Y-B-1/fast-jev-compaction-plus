import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("installer", Path(__file__).resolve().parents[1] / "scripts/install-codex.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_early_compaction_preserves_a_stricter_limit(self):
        class Server:
            def __init__(self, limit):
                self.limit = limit
                self.writes = []
            def request(self, method, params):
                if method == "config/read":
                    return {"config": {"model_auto_compact_token_limit": self.limit}}
                self.writes.append(params)
                self.limit = params["value"]
                return {}
        for initial, expected in ((None, 150000), (200000, 150000), (90000, 90000)):
            with self.subTest(initial=initial):
                server = Server(initial)
                installer.early_compaction(server)
                self.assertEqual(server.limit, expected)
                self.assertEqual(len(server.writes), int(initial != expected))

    def runtime(self, root):
        (root / "bin").mkdir()
        (root / "bin/codex").write_bytes(b"test runtime")
        (root / "codex-package.json").write_text(json.dumps({"layoutVersion": 1, "version": "0.159.0-jev.0", "target": "aarch64-apple-darwin", "entrypoint": "bin/codex"}))
        digest = hashlib.sha256(b"test runtime").hexdigest()
        (root / "SHA256SUMS").write_text(digest + "  codex-runtime/bin/codex\n")

    def test_runtime_rejects_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.runtime(root)
            self.assertEqual(installer.check_runtime(root), root / "bin/codex")
            (root / "bin/codex").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "checksum"):
                installer.check_runtime(root)

    def test_runtime_rejects_wrong_architecture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.runtime(root)
            (root / "codex-package.json").write_text('{"layoutVersion":1,"target":"x86_64-apple-darwin","entrypoint":"bin/codex"}')
            with self.assertRaisesRegex(ValueError, "ARM64"):
                installer.check_runtime(root)

    def test_credentials_only_typesafe(self):
        installer.check_credentials({"provider": "typesafe", "apiKey": "synthetic-test-key"})
        for credentials in (
            {"provider": "openrouter", "apiKey": "synthetic-test-key"},
            {"provider": "typesafe", "apiKey": "sk-or-synthetic"},
            {"provider": "typesafe", "apiKey": " "},
        ):
            with self.assertRaises(ValueError):
                installer.check_credentials(credentials)

    def test_link_preserves_regular_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.write_text("user work")
            with self.assertRaises(ValueError):
                installer.link(root / "source", target)
            self.assertEqual(target.read_text(), "user work")

    def test_trust_only_reviewed_plugin_hooks(self):
        class Server:
            def __init__(self):
                self.calls = []
                self.hooks = [{"pluginId": "fast-jev-compaction@fast-jev-compaction", "eventName": event, "handlerType": "command", "sourcePath": "/fixture/plugin/hooks/codex.json", "command": '"/fixture/plugin/bin/codex-hook"', "key": event + '."key"', "currentHash": "sha256:test"} for event in installer.EVENTS]
                self.hooks.append({"pluginId": "unrelated", "eventName": "stop"})
            def request(self, method, params):
                self.calls.append((method, params))
                return {"data": [{"hooks": self.hooks, "errors": []}]} if method == "hooks/list" else {}
        server = Server()
        installer.trust_hooks(server)
        writes = [params for method, params in server.calls if method == "config/value/write"]
        self.assertEqual(len(writes), 8)
        self.assertTrue(all("unrelated" not in item["keyPath"] for item in writes))
        server.hooks[0]["command"] = "unexpected"
        server.calls.clear()
        with self.assertRaises(ValueError):
            installer.trust_hooks(server)
        self.assertEqual(len(server.calls), 3)


if __name__ == "__main__":
    unittest.main()
