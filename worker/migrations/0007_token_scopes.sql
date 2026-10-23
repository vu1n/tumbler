-- A token carries its ceiling: the minted scopes it may hold beyond reads (JSON array, `*` = any;
-- NULL = reads only). Inside it a child is minted at once; outside it the request is refused. It
-- replaces per-request approval, so standing approvals and the Huddles asks behind them go.
ALTER TABLE tokens ADD COLUMN scopes TEXT;
DROP TABLE approvals;
DROP TABLE grant_asks;
