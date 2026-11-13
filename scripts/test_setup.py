"""Tests for the opt-in Stop hook that setup.sh wires into ~/.claude/settings.json."""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SETUP = Path(__file__).resolve().parent / "setup.sh"
SOURCE = "owner/repo/scripts/session_log_sync.py"
# A stand-in for `tumbler run -k KEY -- sh -c FETCH`: runs FETCH with a fake key and curl on PATH.
FAKE_TUMBLER = """#!/bin/sh
[ "$1 $2 $4" = "run -k --" ] || exit 64
key=$3; shift 4
export "$key=fake-token-value"
exec "$@"
"""


class SetupHookTest(unittest.TestCase):
    def merge(self, home, **env):
        """Runs the settings.json merge from setup.sh, as setup.sh runs it, with HOME set to home."""
        code = re.search(r"python3 - <<'PY'.*?\n(import .*?)\nPY\n", SETUP.read_text(), re.S).group(1)
        env = {**os.environ, "HOME": str(home), "SESSION_LOG_HOOK_KEY": "GH_TOKEN", **env}
        return subprocess.run([sys.executable, "-I", "-c", code], env=env, capture_output=True, text=True)

    def settings(self, home):
        return json.loads((home / ".claude" / "settings.json").read_text())

    def command(self, home):
        return self.settings(home)["hooks"]["Stop"][-1]["hooks"][0]["command"]

    def fake_bin(self, d, curl_body):
        """PATH with the fake tumbler and a curl that records its argv and stdin, then prints curl_body."""
        bin_ = Path(d) / "bin"
        bin_.mkdir()
        (bin_ / "tumbler").write_text(FAKE_TUMBLER)
        (bin_ / "curl").write_text(f'#!/bin/sh\necho "$@" > {d}/curl.argv\ncat > {d}/curl.stdin\nprintf %s {curl_body!r}\n')
        for f in bin_.iterdir():
            f.chmod(0o755)
        return f"{bin_}:{os.environ['PATH']}"

    def test_rerun_keeps_other_hooks_and_adds_ours_once(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            (home / ".claude").mkdir()
            # Commands that merely mention the file are someone else's and stay.
            others = [{"type": "command", "command": "echo other"},
                      {"type": "command", "command": "python3 ~/.claude/hooks/session_log_sync.py hook"}]
            (home / ".claude" / "settings.json").write_text(json.dumps({"hooks": {"Stop": [{"matcher": "x", "hooks": others}]}}))
            self.assertEqual(self.merge(home, SESSION_LOG_HOOK=SOURCE).returncode, 0)
            ours = self.command(home)
            stop = self.settings(home)["hooks"]["Stop"]
            stop[0]["hooks"].append({"type": "command", "command": ours})  # ours, sharing an entry
            (home / ".claude" / "settings.json").write_text(json.dumps({"hooks": {"Stop": stop}}))
            self.assertEqual(self.merge(home, SESSION_LOG_HOOK=SOURCE).returncode, 0)
            stop = self.settings(home)["hooks"]["Stop"]
            self.assertEqual(stop, [{"matcher": "x", "hooks": others}, {"hooks": [{"type": "command", "command": ours}]}])

    def test_a_bad_source_or_key_is_refused(self):
        for env in [{"SESSION_LOG_HOOK": "owner/repo"}, {"SESSION_LOG_HOOK": "o/r/x.py; rm -rf ~"},
                    {"SESSION_LOG_HOOK": SOURCE, "SESSION_LOG_HOOK_KEY": "GH_TOKEN; id"}]:
            with tempfile.TemporaryDirectory() as d:
                r = self.merge(Path(d), **env)
                self.assertNotEqual(r.returncode, 0, env)
                self.assertFalse((Path(d) / ".claude" / "settings.json").exists())

    def test_fetches_through_tumbler_and_hands_the_hook_its_stdin(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d) / "a home; with $pace"
            marker = Path(d) / "ran"
            body = f"import pathlib, sys; pathlib.Path({str(marker)!r}).write_text(sys.argv[1] + ' ' + sys.stdin.read())"
            self.assertEqual(self.merge(home, SESSION_LOG_HOOK=SOURCE).returncode, 0)
            r = subprocess.run(["bash", "-c", self.command(home)], cwd=d, input='{"transcript_path": "/t"}',
                               env={**os.environ, "PATH": self.fake_bin(d, body)}, capture_output=True, text=True)
            self.assertEqual(marker.read_text(), 'hook {"transcript_path": "/t"}', r.stderr)
            argv, stdin = (Path(d) / "curl.argv").read_text(), (Path(d) / "curl.stdin").read_text()
            self.assertIn("https://api.github.com/repos/owner/repo/contents/scripts/session_log_sync.py", argv)
            self.assertNotIn("fake-token-value", argv)  # the token goes through curl's stdin config only
            self.assertEqual(stdin, 'header = "authorization: Bearer fake-token-value"\n')
            hooks = home / ".claude" / "hooks"
            self.assertEqual(sorted(f.name for f in hooks.iterdir()), ["session_log_sync.py"])

    def test_an_empty_fetch_keeps_the_last_copy(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d) / "home"
            self.assertEqual(self.merge(home, SESSION_LOG_HOOK=SOURCE).returncode, 0)
            hook = home / ".claude" / "hooks" / "session_log_sync.py"
            hook.write_text(f"open({str(Path(d) / 'ran')!r}, 'w').write('old')")
            subprocess.run(["bash", "-c", self.command(home)], cwd=d, input="{}",
                           env={**os.environ, "PATH": self.fake_bin(d, "")}, text=True, check=True)
            self.assertEqual((Path(d) / "ran").read_text(), "old")
            self.assertEqual(sorted(f.name for f in hook.parent.iterdir()), ["session_log_sync.py"])


if __name__ == "__main__":
    unittest.main()
