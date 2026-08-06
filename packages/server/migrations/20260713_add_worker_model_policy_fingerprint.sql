-- Binds an adoptable worker lease to the effective instance model policy/config used at spawn.
-- Existing leases remain NULL and are conservatively replaced during adoption.
ALTER TABLE worker_leases ADD COLUMN model_policy_fingerprint text;
