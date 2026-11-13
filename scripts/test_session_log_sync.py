"""Tests for the transcript redaction the session log sync hook applies before upload."""

import io
import json
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


if __name__ == "__main__":
    unittest.main()
