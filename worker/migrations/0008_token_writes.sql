-- What a token may write, beyond what it reads: `global`, a project, `project/env`, `*` or `*/env`
-- (JSON array; NULL = writes nothing). `tumbler put` saves static keys within it. Every token made
-- before this writes nothing, so nothing that reads today can write tomorrow.
ALTER TABLE tokens ADD COLUMN writes TEXT;
