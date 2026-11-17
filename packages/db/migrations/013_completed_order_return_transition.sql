-- 013_completed_order_return_transition.sql — allow the return state
-- machine out of `completed` (Build-03 Objective 2; Arch-02 §6.2).
--
-- Migration 004's `prevent_completed_order_change()` rejects EVERY update
-- to a completed order. That contradicts Arch-02 §6.2's own state machine
-- (`completed` → `partially_returned` → `returned` after a refund) — with
-- the 004 trigger in place no return could ever change the order status.
-- This migration replaces the function with the same immutability rule
-- plus exactly the two transitions the state machine defines:
--   * completed → partially_returned | returned
--   * partially_returned → returned
-- Every other UPDATE to a completed / partially_returned / returned order
-- (amounts, totals, any other status) and every DELETE of one is still
-- rejected with the same '... is immutable' message, so the Build-02
-- trigger tests (total change and DELETE on a completed order) still hold.
-- A returned order is terminal: no transition out of `returned` exists.

CREATE OR REPLACE FUNCTION prevent_completed_order_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('completed', 'partially_returned', 'returned') THEN
      RAISE EXCEPTION 'Completed order % is immutable', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE: the only permitted transitions out of the completed states
  -- are the return transitions Arch-02 §6.2 defines. Anything else is
  -- still immutable.
  IF OLD.status = 'completed' THEN
    IF NEW.status IN ('partially_returned', 'returned') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Completed order % is immutable', OLD.id;
  END IF;
  IF OLD.status = 'partially_returned' THEN
    IF NEW.status = 'returned' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Partially returned order % is immutable except for transition to returned', OLD.id;
  END IF;
  IF OLD.status = 'returned' THEN
    RAISE EXCEPTION 'Returned order % is immutable', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
