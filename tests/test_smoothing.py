"""Unit tests for the smoothing state machine (hysteresis + min duration)."""

from __future__ import annotations

from breathing_monitor.core.smoothing import LipStateSmoother, SmoothingConfig
from breathing_monitor.core.types import LipState


def make_smoother(**overrides) -> LipStateSmoother:
    cfg = SmoothingConfig(
        open_threshold=0.35,
        close_threshold=0.28,
        min_open_seconds=0.3,
        min_closed_seconds=0.3,
    )
    for k, v in overrides.items():
        setattr(cfg, k, v)
    return LipStateSmoother(cfg)


def test_config_rejects_inverted_thresholds():
    import pytest

    with pytest.raises(ValueError):
        SmoothingConfig(open_threshold=0.2, close_threshold=0.3)


def test_bootstrap_emits_initial_change():
    s = make_smoother()
    state, change = s.update(0.0, 0.5)  # first reading, clearly open
    assert state is LipState.OPEN
    assert change is not None
    assert change.from_state is LipState.UNKNOWN
    assert change.to_state is LipState.OPEN


def test_min_duration_blocks_brief_flicker():
    s = make_smoother()
    s.update(0.0, 0.10)  # bootstrap CLOSED
    # A single high frame shouldn't flip before the 0.3s hold elapses.
    state, change = s.update(0.1, 0.50)
    assert state is LipState.CLOSED
    assert change is None
    # Drop back down before the hold completes -> still closed, no change.
    state, change = s.update(0.2, 0.10)
    assert state is LipState.CLOSED
    assert change is None


def test_sustained_change_confirms_after_hold():
    s = make_smoother()
    s.update(0.0, 0.10)  # bootstrap CLOSED
    s.update(0.1, 0.50)  # candidate OPEN begins
    s.update(0.3, 0.50)  # 0.2s held, not yet
    state, change = s.update(0.45, 0.50)  # 0.35s held >= 0.3
    assert state is LipState.OPEN
    assert change is not None
    assert change.to_state is LipState.OPEN


def test_hysteresis_prevents_chatter_between_thresholds():
    s = make_smoother()
    s.update(0.0, 0.50)  # OPEN
    # MAR in the dead-band (between close=0.28 and open=0.35) must NOT close.
    state, change = s.update(1.0, 0.30)
    assert state is LipState.OPEN
    assert change is None


def test_face_loss_holds_state_and_cancels_pending():
    s = make_smoother()
    s.update(0.0, 0.10)   # CLOSED
    s.update(0.1, 0.50)   # candidate OPEN begins
    # Face lost mid-hold -> pending cancelled, state held.
    state, change = s.update(0.2, None)
    assert state is LipState.CLOSED
    assert change is None
    # Even a frame just after the original hold window won't confirm, because
    # the pending candidate was reset by the face-loss frame.
    state, change = s.update(0.45, 0.50)
    assert state is LipState.CLOSED
    assert change is None


def test_durations_tile_the_timeline():
    s = make_smoother(min_open_seconds=0.0, min_closed_seconds=0.0)
    s.update(0.0, 0.10)          # CLOSED at t=0
    _, change = s.update(2.0, 0.50)  # -> OPEN, closed was held ~2s
    assert change is not None
    assert abs(change.prev_duration - 2.0) < 1e-6
