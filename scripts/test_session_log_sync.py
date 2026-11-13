"""Tests for the transcript redaction the session log sync hook applies before upload."""

import gzip
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import session_log_sync as sls  # noqa: E402

FAKE = "fake-value-0123456789abcdef"  # never a real key


class SecretValuesTest(unittest.TestCase):
    def test_tumbler_keys_and_secret_looking_names_only(self):
        env = {"PLAIN_THING": FAKE, "MY_API_KEY": FAKE + "1", "HUDDLES_CREDENTIAL": FAKE + "2",
               "GIT_AUTHOR_EMAIL": "someone@example.invalid", "SHORT_TOKEN": "abc", "FLAG_TOKEN": "true",
               "GITHUB_APP_ID": "1234567890123", "PIN": "4321", sls.TUMBLER_NAMES: "GITHUB_APP_ID,PIN"}
        names = {n for n, _ in sls.secret_values(env)}
        self.assertEqual(names, {"MY_API_KEY", "HUDDLES_CREDENTIAL", "GITHUB_APP_ID", "PIN", "SHORT_TOKEN"})

    def test_longest_first(self):
        env = {"A_TOKEN": FAKE, "B_TOKEN": FAKE + "-longer"}
        self.assertEqual([n for n, _ in sls.secret_values(env)], ["B_TOKEN", "A_TOKEN"])


class RedactTest(unittest.TestCase):
    def test_exact_value_and_its_json_escaped_spelling(self):
        pem = "line-one-0123456789\nline-two-0123456789"
        text = json.dumps({"out": f"x {FAKE} y {pem}"})
        out, n = sls.redact(text, [("PEM_KEY", pem), ("API_TOKEN", FAKE)])
        self.assertNotIn(FAKE, out)
        self.assertNotIn("line-one", out)
        self.assertIn("[REDACTED:API_TOKEN]", out)
        self.assertIn("[REDACTED:PEM_KEY]", out)
        self.assertEqual(n, 2)

    def test_short_secret_is_redacted_as_a_whole_token_only(self):
        out, n = sls.redact('{"pw": "hunter2", "note": "hunter22 xhunter2"}', [("DB_PASSWORD", "hunter2")])
        self.assertEqual(out, '{"pw": "[REDACTED:DB_PASSWORD]", "note": "hunter22 xhunter2"}')
        self.assertEqual(n, 1)

    def test_jsonl_stays_valid_when_a_numeric_secret_is_redacted(self):
        text = json.dumps({"input": {"pin": 4321, "n": 7, "ok": True}, "out": "pin 4321"}) + "\nnot json 4321\n"
        out, n = sls.redact_jsonl(text, [("PIN", "4321")])
        first, second = out.splitlines()
        self.assertEqual(json.loads(first), {"input": {"pin": "[REDACTED:PIN]", "n": 7, "ok": True}, "out": "pin [REDACTED:PIN]"})
        self.assertEqual(second, "not json [REDACTED:PIN]")
        self.assertEqual(n, 3)
        self.assertTrue(out.endswith("\n"))

    def test_meta_is_redacted_too(self):
        meta = {"repos": [{"name": "r", "branch": f"wip/{FAKE}", "head": "ghp_" + "a" * 36}], "bytes": {"t": 4321}}
        out = sls.redacted_meta(meta, [("API_TOKEN", FAKE)]).decode()
        self.assertNotIn(FAKE, out)
        self.assertNotIn("ghp_", out)
        self.assertEqual(json.loads(out)["repos"][0]["branch"], "wip/[REDACTED:API_TOKEN]")

    def test_unicode_line_separators_inside_an_event_stay_in_it(self):
        text = json.dumps({"out": "a\u2028b\u0085c"}, ensure_ascii=False) + "\n"
        out, _ = sls.redact_jsonl(text, [])
        self.assertEqual(out.count("\n"), 1)
        self.assertEqual(json.loads(out), {"out": "a\u2028b\u0085c"})

    def test_token_shapes(self):
        samples = ["ghp_" + "a" * 36, "github_pat_" + "b" * 50, "sk-ant-" + "c" * 30, "AKIA" + "D" * 16,
                   "eyJ" + "e" * 12 + ".eyJ" + "f" * 12 + "." + "g" * 12,
                   "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"]
        for s in samples:
            out, n = sls.redact(f"before {s} after", [])
            self.assertEqual(out, "before [REDACTED] after", s)
            self.assertEqual(n, 1)

    def test_authorization_header_keeps_its_scheme(self):
        out, _ = sls.redact('-H "Authorization: Bearer abcdefgh12345678"', [])
        self.assertEqual(out, '-H "Authorization: Bearer [REDACTED]"')

    def test_ordinary_text_is_untouched(self):
        text = "the sky is blue; run `tumbler keys` and git push"
        self.assertEqual(sls.redact(text, []), (text, 0))


class LayoutTest(unittest.TestCase):
    def test_date_comes_from_the_first_timestamped_event(self):
        text = "not json\n" + json.dumps({"type": "x"}) + "\n" + json.dumps({"timestamp": "2026-11-13T19:53:48Z"})
        self.assertEqual(sls.first_date(text), ["2026", "11", "13"])


class StateTest(unittest.TestCase):
    def test_a_corrupt_or_missing_state_is_a_cache_miss(self):
        with tempfile.TemporaryDirectory() as d:
            state = Path(d) / "s.json"
            with mock.patch.object(sls, "STATE", state):
                self.assertEqual(sls.read_state(), {})
                state.write_text('{"half')
                self.assertEqual(sls.read_state(), {})
                state.write_text('{"a": [1, 2]}')
                self.assertEqual(sls.read_state(), {"a": [1, 2]})


class CurlTest(unittest.TestCase):
    def test_credentials_go_through_stdin_never_argv(self):
        with mock.patch("subprocess.run") as run:
            sls.curl(["https://example.invalid/x"], [("header", f"authorization: Bearer {FAKE}")], b"body")
        argv, kwargs = run.call_args[0][0], run.call_args[1]
        self.assertNotIn(FAKE, " ".join(argv))
        self.assertIn(FAKE, kwargs["input"].decode())
        self.assertEqual(argv[argv.index("-K") + 1], "-")

    def test_a_credential_curl_config_cant_carry_is_refused(self):
        with self.assertRaises(RuntimeError):
            sls.curl(["https://example.invalid/x"], [("user", 'a"b')])


class HookTest(unittest.TestCase):
    def test_bad_input_logs_and_starts_nothing(self):
        with mock.patch.object(sls, "log") as log, mock.patch("subprocess.Popen") as popen, \
                mock.patch("sys.stdin", io.StringIO("{}")):
            sls.hook()
        popen.assert_not_called()
        self.assertIn("no transcript_path", log.call_args[0][0])

    def test_starts_bg_detached_and_returns(self):
        with mock.patch("subprocess.Popen") as popen, mock.patch.object(sls, "LOG", Path("/dev/null")), \
                mock.patch("sys.stdin", io.StringIO(json.dumps({"transcript_path": "/t/s.jsonl"}))):
            sls.hook()
        args, kwargs = popen.call_args
        self.assertEqual(args[0][-2:], ["bg", "/t/s.jsonl"])
        self.assertTrue(kwargs["start_new_session"])


class RotationTest(unittest.TestCase):
    """Every upload redacts the whole transcript again, so a rotated key must stay redacted."""

    def test_a_key_that_left_the_env_is_still_redacted_on_the_next_upload(self):
        old, new = FAKE + "-old-child", FAKE + "-new-child"
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            transcript = home / "s.jsonl"
            transcript.write_text(json.dumps({"timestamp": "2026-11-13T00:00:00Z", "out": f"token {old}"}) + "\n")
            bodies = []

            def fake_put(account, key_id, secret, key, body, content_type):
                bodies.append(gzip.decompress(body).decode() if key.endswith(".gz") else body.decode())

            def upload_with(token):
                env = {"CLOUDFLARE_API_TOKEN": token, "CLOUDFLARE_ACCOUNT_ID": "acct", sls.TUMBLER_NAMES: "CLOUDFLARE_API_TOKEN"}
                with mock.patch.dict(os.environ, env, clear=True), \
                        mock.patch.object(sls, "s3_credentials", return_value=("acct", "id", "s")), \
                        mock.patch.object(sls, "put", fake_put):
                    sls.upload(transcript)

            with mock.patch.object(sls, "STATE", home / "state.json"), mock.patch.object(sls, "SEEN", home / "seen.json"), \
                    mock.patch.object(sls, "REPOS", home):
                upload_with(old)
                with transcript.open("a") as f:
                    f.write(json.dumps({"out": f"rotated to {new}"}) + "\n")
                upload_with(new)
            for body in bodies:
                self.assertNotIn(old, body)
                self.assertNotIn(new, body)
            self.assertEqual(bodies[-2].count("[REDACTED:CLOUDFLARE_API_TOKEN]"), 2)  # the second transcript
            self.assertEqual((home / "seen.json").stat().st_mode & 0o777, 0o600)

    def test_a_corrupt_seen_file_stops_the_upload(self):
        with tempfile.TemporaryDirectory() as d:
            seen = Path(d) / "seen.json"
            seen.write_text("{half")
            with mock.patch.object(sls, "SEEN", seen), self.assertRaises(ValueError):
                sls.remember([("A_TOKEN", FAKE)])


class SetupMergeTest(unittest.TestCase):
    """The settings.json merge in setup.sh, run against a settings file that already has hooks."""

    def run_merge(self, home):
        script = (Path(__file__).parent / "setup.sh").read_text()
        code = re.search(r"python3 - <<'PY'.*?\n(.*?)\nPY\n", script, re.S).group(1)
        env = {**os.environ, "HOME": str(home), "HOOK": f"{home}/.claude/hooks/session_log_sync.py",
               "TUMBLER_URL": "https://broker.invalid"}
        subprocess.run([sys.executable, "-I", "-c", code], env=env, check=True)
        return json.loads((home / ".claude" / "settings.json").read_text())

    def test_rerun_keeps_other_hooks_and_adds_ours_once(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            (home / ".claude").mkdir()
            other = {"type": "command", "command": "echo other"}
            (home / ".claude" / "settings.json").write_text(json.dumps({"hooks": {"Stop": [
                {"matcher": "x", "hooks": [other, {"type": "command", "command": "python3 old/session_log_sync.py hook"}]},
                {"hooks": [{"type": "command", "command": "python3 session_log_sync.py hook"}]}]}}))
            self.run_merge(home)
            stop = self.run_merge(home)["hooks"]["Stop"]
            self.assertEqual(stop[0], {"matcher": "x", "hooks": [other]})
            self.assertEqual(len(stop), 2)
            self.assertIn("session_log_sync.py", stop[1]["hooks"][0]["command"])


if __name__ == "__main__":
    unittest.main()
