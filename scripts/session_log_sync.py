#!/usr/bin/env python3
"""Copy a Claude cloud session's transcript to R2 after every turn, redacted and gzipped.

tumbler's setup (scripts/setup.sh) installs this as ~/.claude/hooks/session_log_sync.py and wires it
as a Stop hook that refreshes it from the broker's /session-log-sync.py before each run.
The container is reclaimed without warning, so every turn re-uploads the whole transcript over the
same object: R2 always holds the session up to its last finished turn.

  hook      (the Stop hook) reads the hook's JSON on stdin, starts `bg` detached and exits 0 at once,
            so a turn never waits on or fails because of it.
  bg        runs `upload` under `tumbler run` with every tumbler key loaded, so each one's exact
            value can be redacted, and the bucket scope on the Cloudflare key.
  upload    redacts, gzips, uploads.

Objects, in bucket claude-session-logs:
  sessions/YYYY/MM/DD/<session-id>.jsonl.gz                 the transcript (date: its first event)
  sessions/YYYY/MM/DD/<session-id>/subagents/<name>.jsonl.gz each subagent's transcript
  sessions/YYYY/MM/DD/<session-id>.meta.json                what, where, when, without unzipping
Failures go to ~/.claude/session-log-sync.log with enough context to debug.
"""
import datetime
import fcntl
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

BUCKET = "claude-session-logs"
SCOPE = f"r2:{BUCKET}"  # tumbler scope holding read/write on this one bucket, nothing account-wide
TUMBLER_NAMES = "SESSION_LOG_SYNC_KEYS"  # env var listing the tumbler key names loaded for redaction
HOME = Path.home()
LOG = HOME / ".claude" / "session-log-sync.log"
STATE = HOME / ".claude" / "session-log-sync.state.json"
SEEN = HOME / ".claude" / "session-log-sync.secrets.json"  # 0600, never uploaded: every secret value this container has had
REPOS = Path(os.environ.get("REPOS_ROOT", "/home/user"))

# Token shapes redacted wherever they appear, on top of every secret-looking env value.
PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}"),
    re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_\-]{32,}"),
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
    re.compile(r"(?i)(\bauthorization\b[\"']?\s*[:=]\s*[\"']?(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=\-]{8,}"),
]
# Whole name parts only: GIT_AUTHOR_EMAIL is not a secret, TS_AUTHKEY and GITHUB_PAT are.
SECRET_NAME = re.compile(r"(?:^|_)(?:[A-Z0-9]*KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|PAT)(?:_|$)", re.I)
# Every known secret is redacted whatever its length. One shorter than this is matched only as a whole
# token, so a short value can't shred ordinary words; flag-like values aren't secrets and stay.
WHOLE_TOKEN_BELOW = 12
NOT_SECRET = {"", "true", "false", "yes", "no", "on", "off", "0", "1"}
CURL_TIMEOUT = ["--connect-timeout", "10", "--max-time", "120"]  # a stalled request must never hold the lock


def log(msg):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(f"{datetime.datetime.now(datetime.timezone.utc).isoformat()} {msg}\n")


def secret_values(env):
    """(name, value) for every tumbler key and every env var whose name looks secret, longest first
    so a value containing another redacts whole."""
    tumbler = set(filter(None, env.get(TUMBLER_NAMES, "").split(",")))
    pairs = {(k, v) for k, v in env.items()
             if k != TUMBLER_NAMES and v.strip().lower() not in NOT_SECRET and (k in tumbler or SECRET_NAME.search(k))}
    return sorted(pairs, key=lambda p: -len(p[1]))


def remember(secrets):
    """Adds secrets to SEEN and returns everything it holds, longest first. Each upload redacts the whole
    transcript again, so a key that has since rotated (a re-minted child token, a replaced static key)
    must stay redacted after it leaves the env."""
    try:
        seen = {tuple(p) for p in json.loads(SEEN.read_text())}
    except FileNotFoundError:
        seen = set()
    merged = seen | set(secrets)
    if merged != seen:
        SEEN.parent.mkdir(parents=True, exist_ok=True)
        tmp = SEEN.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(sorted(merged), f)
        os.replace(tmp, SEEN)
    return sorted(merged, key=lambda p: (-len(p[1]), p))


def redact(text, secrets):
    """Returns (text, count). A value also appears JSON-escaped in JSONL, so both spellings go."""
    count = 0
    for name, value in secrets:
        for spelled in {value, json.dumps(value)[1:-1]}:
            if len(spelled) >= WHOLE_TOKEN_BELOW:
                if spelled in text:
                    count += text.count(spelled)
                    text = text.replace(spelled, f"[REDACTED:{name}]")
            else:
                text, n = re.subn(rf"(?<![A-Za-z0-9]){re.escape(spelled)}(?![A-Za-z0-9])", f"[REDACTED:{name}]", text)
                count += n
    for pat in PATTERNS:
        def sub(m):
            # An Authorization header keeps its scheme; everything else goes whole.
            return (m.group(1) if m.re.groups else "") + "[REDACTED]"
        text, n = pat.subn(sub, text)
        count += n
    return text, count


def jsonl_lines(text):
    """JSONL splits at "\\n" only: str.splitlines() would also split at U+2028 and the like inside a string."""
    lines = text.split("\n")
    return lines[:-1] if lines and lines[-1] == "" else lines


def curl(args, secret_lines, body=None):
    """Runs curl with its credentials in a config read from stdin, never in argv where `ps` shows them.
    A body goes through a private temp file, since stdin carries the config."""
    if any(c in v for _, v in secret_lines for c in '"\\\r\n'):
        raise RuntimeError("a credential holds a character curl's config can't carry")
    config = "".join(f'{k} = "{v}"\n' for k, v in secret_lines)
    tmp = None
    try:
        if body is not None:
            fd, tmp = tempfile.mkstemp()  # mode 0600, readable only by this user
            with os.fdopen(fd, "wb") as f:
                f.write(body)
            args = [*args, "--data-binary", f"@{tmp}"]
        return subprocess.run(["curl", "-sS", *CURL_TIMEOUT, "-K", "-", *args], input=config.encode(), capture_output=True)
    finally:
        if tmp:
            os.unlink(tmp)


def redact_jsonl(text, secrets):
    """Redacts each event's decoded values and re-serializes it, so every line stays valid JSON: a
    string is redacted as text, and a number equal to a secret becomes the marker string. A line that
    isn't JSON is redacted as text."""
    count = 0
    by_value = {v: n for n, v in secrets}

    def walk(v):
        nonlocal count
        if isinstance(v, str):
            out, n = redact(v, secrets)
            count += n
            return out
        if isinstance(v, (int, float)) and not isinstance(v, bool) and str(v) in by_value:
            count += 1
            return f"[REDACTED:{by_value[str(v)]}]"
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {walk(k): walk(x) for k, x in v.items()}
        return v

    lines = []
    for line in jsonl_lines(text):
        try:
            lines.append(json.dumps(walk(json.loads(line)), ensure_ascii=False, separators=(",", ":")))
        except ValueError:
            out, n = redact(line, secrets)
            count += n
            lines.append(out)
    return "\n".join(lines) + ("\n" if text.endswith("\n") else ""), count


def redacted_meta(meta, secrets):
    """The meta object as uploaded: redacted like a transcript event, since repo and branch names
    come straight from disk."""
    line, _ = redact_jsonl(json.dumps(meta), secrets)
    return json.dumps(json.loads(line), indent=1).encode()


def first_date(text):
    for line in jsonl_lines(text):
        try:
            ts = json.loads(line).get("timestamp")
        except (ValueError, AttributeError):
            continue
        if ts:
            return ts[:10].split("-")
    return datetime.date.today().isoformat().split("-")


def meta_for(session_id, text, redactions, sizes):
    models, times = set(), []
    for line in jsonl_lines(text):
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("timestamp"):
            times.append(ev["timestamp"])
        model = (ev.get("message") or {}).get("model") if isinstance(ev.get("message"), dict) else None
        if model:
            models.add(model)
    repos = []
    for d in sorted(REPOS.iterdir()) if REPOS.is_dir() else []:
        if (d / ".git").exists():
            git = lambda *a: subprocess.run(["git", "-C", str(d), *a], capture_output=True, text=True).stdout.strip()
            repos.append({"name": d.name, "branch": git("rev-parse", "--abbrev-ref", "HEAD"), "head": git("rev-parse", "HEAD")})
    return {
        "session_id": session_id,
        "remote_session_id": os.environ.get("CLAUDE_CODE_REMOTE_SESSION_ID"),
        "claude_code_version": os.environ.get("CLAUDE_CODE_VERSION"),
        "first_event": min(times) if times else None,
        "last_event": max(times) if times else None,
        "models": sorted(models),
        "repos": repos,
        "bytes": sizes,
        "redactions": redactions,
        "uploaded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


def put(account, key_id, secret, key, body, content_type):
    """PUT one object through R2's S3 API (SigV4 via curl). Raises with curl's status on failure."""
    r = curl(["--fail-with-body", "-X", "PUT", "--aws-sigv4", "aws:amz:auto:s3", "-H", f"content-type: {content_type}",
              "-H", f"x-amz-content-sha256: {hashlib.sha256(body).hexdigest()}",
              f"https://{account}.r2.cloudflarestorage.com/{BUCKET}/{key}"],
             [("user", f"{key_id}:{secret}")], body)
    if r.returncode:
        raise RuntimeError(f"PUT {key} failed (curl {r.returncode}): {r.stderr.decode()[-300:]} {r.stdout.decode()[-300:]}")


def s3_credentials(env):
    """R2's S3 credentials for an API token: its id, and the SHA-256 of its value."""
    token, account = env["CLOUDFLARE_API_TOKEN"], env["CLOUDFLARE_ACCOUNT_ID"]
    r = curl([f"https://api.cloudflare.com/client/v4/accounts/{account}/tokens/verify"],
             [("header", f"authorization: Bearer {token}")])
    try:
        token_id = json.loads(r.stdout)["result"]["id"]
    except (ValueError, KeyError, TypeError):
        raise RuntimeError(f"token verify gave no id (curl {r.returncode}, {len(r.stdout)} bytes)")
    return account, token_id, hashlib.sha256(token.encode()).hexdigest()


def read_state():
    """Upload stamps by session. A missing or unreadable state is a cache miss: the next upload redoes it."""
    try:
        state = json.loads(STATE.read_text())
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def upload(transcript):
    transcript = Path(transcript)
    session_id = transcript.stem
    with STATE.with_suffix(".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # turns can end faster than an upload; they queue, never overlap
        files = [transcript] + sorted((transcript.parent / session_id / "subagents").glob("*.jsonl"))
        stamp = {str(f): [f.stat().st_size, f.stat().st_mtime] for f in files}
        state = read_state()
        if state.get(session_id) == stamp:
            return
        secrets = remember(secret_values(os.environ))
        account, key_id, secret = s3_credentials(os.environ)
        text, redactions = redact_jsonl(transcript.read_text(errors="replace"), secrets)
        y, m, d = first_date(text)
        base = f"sessions/{y}/{m}/{d}/{session_id}"
        sizes = {"transcript": len(text)}
        put(account, key_id, secret, f"{base}.jsonl.gz", gzip.compress(text.encode()), "application/gzip")
        for f in files[1:]:
            sub, n = redact_jsonl(f.read_text(errors="replace"), secrets)
            redactions += n
            sizes[f.name] = len(sub)
            put(account, key_id, secret, f"{base}/subagents/{f.stem}.jsonl.gz", gzip.compress(sub.encode()), "application/gzip")
        meta = meta_for(session_id, text, redactions, sizes)
        put(account, key_id, secret, f"{base}.meta.json", redacted_meta(meta, secrets), "application/json")
        state[session_id] = stamp
        tmp = STATE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state))
        os.replace(tmp, STATE)  # atomic: an interrupted write never leaves a half-written state


def hook():
    try:
        event = json.load(sys.stdin)
        transcript = event["transcript_path"]
    except (ValueError, KeyError, TypeError) as e:
        log(f"hook: no transcript_path in the hook input ({type(e).__name__})")
        return
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as out:
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "bg", transcript],
                         stdin=subprocess.DEVNULL, stdout=out, stderr=out, start_new_session=True)


def bg(transcript):
    r = subprocess.run(["tumbler", "keys"], capture_output=True, text=True)
    names = [n for n in r.stdout.split() if re.fullmatch(r"[A-Z_][A-Z0-9_]*", n)]
    if r.returncode or "CLOUDFLARE_API_TOKEN" not in names:
        raise RuntimeError(f"tumbler keys failed or lacks CLOUDFLARE_API_TOKEN (exit {r.returncode}): {r.stderr[-300:]}")
    # Its own cwd, so tumbler's first-run .tumbler lands here and never in a repo.
    cwd = HOME / ".claude" / "session-log-sync"
    cwd.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, TUMBLER_NAMES: ",".join(names)}
    # The upload runs with the bucket scope, which swaps in a different CLOUDFLARE_API_TOKEN: record the
    # session's own default values first, so the token the session itself used is redacted too.
    r = subprocess.run(["tumbler", "run", "-k", ",".join(names), "--", sys.executable, os.path.abspath(__file__), "remember"],
                       cwd=cwd, stdin=subprocess.DEVNULL, env=env)
    if r.returncode:
        raise RuntimeError(f"tumbler run (remember) exited {r.returncode}")
    r = subprocess.run(["tumbler", "run", "-k", ",".join(names), "--scope", SCOPE, "--",
                        sys.executable, os.path.abspath(__file__), "upload", transcript],
                       cwd=cwd, stdin=subprocess.DEVNULL, env=env)
    if r.returncode:
        raise RuntimeError(f"tumbler run exited {r.returncode} (scope {SCOPE})")


def main():
    if sys.argv[1:2] == ["upload"] and len(sys.argv) == 3:
        try:
            upload(sys.argv[2])
        except Exception as e:  # logged for the next agent to find; the session carries on regardless
            log(f"upload {sys.argv[2]}: {type(e).__name__}: {e}")
            sys.exit(1)
    elif sys.argv[1:2] == ["bg"] and len(sys.argv) == 3:
        try:
            bg(sys.argv[2])
        except Exception as e:
            log(f"bg {sys.argv[2]}: {type(e).__name__}: {e}")
            sys.exit(1)
    elif sys.argv[1:] == ["remember"]:
        try:
            remember(secret_values(os.environ))
        except Exception as e:
            log(f"remember: {type(e).__name__}: {e}")
            sys.exit(1)
    elif sys.argv[1:] == ["hook"]:
        try:
            hook()
        except Exception as e:
            log(f"hook: {type(e).__name__}: {e}")
    else:
        sys.exit("usage: session_log_sync.py hook | upload TRANSCRIPT")


if __name__ == "__main__":
    main()
